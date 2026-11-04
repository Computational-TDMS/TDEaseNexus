/**
 * BashPtyBackend — the TDEase port of `@deepseek-ai/dsh-terminal-bash`: a
 * persistent interactive bash session over node-pty with escape sanitizing,
 * bounded scrollback, exclusive send operations and prompt-marker readiness.
 *
 * Windows note: ConPTY has no POSIX process groups, so readiness is decided by
 * the private prompt marker (OSC 133 `;D;` with the controlled PS1 tail) plus
 * output-idle time — the foreground-process-group checks DSH performs on POSIX
 * are deliberately absent here. Interrupts are delivered as control characters
 * (`\x03` = SIGINT) through the terminal input, which bash's job control turns
 * into a foreground SIGINT.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { constants as osConstants } from 'node:os'
import type { IPty } from 'node-pty'
import { assignChildToJob } from '../windows-job.cjs'
import { planBashSandbox } from './sandbox'

// This module sits on the main.ts startup chain (agent-runtime → tool-gateway
// → persistent-bash-tool), so a top-level import loaded the native node-pty
// (ConPTY DLL init) before any window existed. esbuild bundles this file to
// CJS with `node-pty` external, which would hoist a static import back to
// module scope — so the only load that actually defers is a plain `require`
// on the spawn path. Type-only imports are erased and cost nothing.
let ptyModule: typeof import('node-pty') | null = null
function loadPty(): typeof import('node-pty') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native-module load; see above
  return (ptyModule ??= require('node-pty') as typeof import('node-pty'))
}

import { TerminalError, type TerminalBackend, type TerminalBackendSession, type TerminalBackendSpawnSpec, type TerminalReadRequest, type TerminalReadResult, type TerminalSendOperation, type TerminalSendRequest, type TerminalSendResult, type TerminalSessionStatus, type TerminalSignal, type TerminalSignalResult } from './pty-terminal'
import { BoundedTextBuffer, CONTROLLED_PROMPT, quoteForBash, TerminalSanitizer, utf8Tail } from './terminal-protocol'

// Windows ConPTY can transiently fail AttachConsole when several Git Bash
// instances are created from the same host console. Keep only the fragile
// spawn/initialization window exclusive; established shells remain concurrent.
let bashStartupTail: Promise<void> = Promise.resolve()

async function withSerializedBashStartup<T>(operation: () => Promise<T>): Promise<T> {
  const previous = bashStartupTail
  let release!: () => void
  bashStartupTail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface BashPtyConfig {
  /** Bash executable (default: Git Bash on Windows, /bin/bash on POSIX). */
  shellPath?: string
  rows?: number
  cols?: number
  scrollbackLines?: number
  scrollbackMaxBytes?: number
  maxReadBytes?: number
  pollIntervalMs?: number
  exactProbeAfterMs?: number
  idleSilenceMs?: number
  handoffGraceMs?: number
  timeoutMs?: number
  disposeGraceMs?: number
}

export function resolveBashConfig(config: BashPtyConfig): Required<BashPtyConfig> {
  const resolved = {
    shellPath: config.shellPath ?? resolveBashPath(),
    rows: config.rows ?? 40,
    cols: config.cols ?? 160,
    scrollbackLines: config.scrollbackLines ?? 10_000,
    scrollbackMaxBytes: config.scrollbackMaxBytes ?? 4 * 1024 * 1024,
    maxReadBytes: config.maxReadBytes ?? 256 * 1024,
    pollIntervalMs: config.pollIntervalMs ?? 50,
    exactProbeAfterMs: config.exactProbeAfterMs ?? 150,
    idleSilenceMs: config.idleSilenceMs ?? 3_000,
    handoffGraceMs: config.handoffGraceMs ?? 500,
    timeoutMs: config.timeoutMs ?? 30_000,
    disposeGraceMs: config.disposeGraceMs ?? 3_000,
  }
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`pty-bash: ${name} must be a positive safe integer`)
    }
  }
  if (resolved.maxReadBytes > resolved.scrollbackMaxBytes) {
    throw new Error('pty-bash: maxReadBytes must not exceed scrollbackMaxBytes')
  }
  return resolved
}

/** Resolve a bash executable: the bundled vendor Git on Windows, then Git Bash known locations, /bin/bash on POSIX. */
export function resolveBashPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const candidates: string[] = []
    // Packaged: bash is shipped in resources/vendor/git so a clean machine
    // (no Git for Windows) still gets a full sandbox shell. Prefer it over
    // any machine Git for determinism; dev (no resources/vendor/git) falls
    // through to the machine's own Git Bash.
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, 'vendor', 'git', 'usr', 'bin', 'bash.exe'))
    }
    candidates.push(
      join(programFiles, 'Git', 'bin', 'bash.exe'),
      join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    )
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return 'bash'
  }
  if (existsSync('/bin/bash')) return '/bin/bash'
  return 'bash'
}

// ── Send operation ───────────────────────────────────────────────────────────

class LocalSendOperation implements TerminalSendOperation {
  readonly done: Promise<TerminalSendResult>
  private readonly output: BoundedTextBuffer
  private readonly promise: Deferred<TerminalSendResult>
  private finished = false
  private cancellationRequested = false
  constructor(
    maxBytes: number,
    private readonly onCancel: () => void,
  ) {
    this.output = new BoundedTextBuffer(maxBytes)
    this.promise = deferred<TerminalSendResult>()
    this.done = this.promise.promise
  }

  get settled(): boolean {
    return this.finished
  }

  get cancelRequested(): boolean {
    return this.cancellationRequested
  }

  append(text: string): void {
    if (!this.finished) this.output.append(text)
  }

  settle(waitReason: TerminalSendResult['waitReason'], sessionStatus: TerminalSessionStatus, inheritedTruncation: boolean): void {
    if (this.finished) return
    this.finished = true
    const read = this.output.snapshot()
    this.promise.resolve({
      viewport: read.text,
      waitReason,
      sessionStatus,
      truncated: read.truncated || inheritedTruncation,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.promise.reject(error)
  }

  readOutput(): { delta: string; truncated: boolean } {
    return this.output.consume()
  }

  cancel(): boolean {
    if (this.finished) return false
    this.cancellationRequested = true
    this.onCancel()
    return true
  }
}

// ── Session ──────────────────────────────────────────────────────────────────

export class LocalPtySession implements TerminalBackendSession {
  readonly motd: string
  readonly pid?: number
  readonly type = 'bash'
  private readonly terminal: IPty
  private readonly config: Required<BashPtyConfig>
  private readonly sanitizer: TerminalSanitizer
  private readonly scrollback: BoundedTextBuffer
  private readonly decoder = new TextDecoder()
  private readonly outputEnded: Deferred<void>
  private readonly completion: Promise<void>
  private statusValue: TerminalSessionStatus = { kind: 'running' }
  private active?: LocalSendOperation
  private activeTimer?: ReturnType<typeof setTimeout>
  private activeDeadlineTimer?: ReturnType<typeof setTimeout>
  private polling = false
  private promptSeen = false
  private promptTextSeen = false
  private promptTail = ''
  private lastOutputAt = Date.now()
  private initializing = false
  private closing = false
  private closePromise?: Promise<void>
  private transportFailure?: Error
  private exited = false

  constructor(terminal: IPty, config: Required<BashPtyConfig>, motd: string) {
    this.terminal = terminal
    this.config = config
    this.pid = terminal.pid
    this.motd = motd
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes)
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    this.outputEnded = deferred<void>()
    this.completion = new Promise<void>((resolve) => {
      terminal.onExit(({ exitCode, signal }) => {
        this.handleExit(exitCode, signal)
        resolve()
      })
    })
    terminal.onData((data) => this.onTerminalData(data))
  }

  private handleExit(exitCode: number, signal?: number): void {
    if (this.exited) return
    this.exited = true
    this.appendOutput(this.sanitizer.flush())
    this.outputEnded.resolve()
    this.statusValue = {
      kind: 'exited',
      exitCode,
      signal: signal === undefined || signal === 0 ? null : signalName(signal),
    }
    this.settleActive('session_exit')
  }

  private onTerminalData(data: string): void {
    const text = this.decoder.decode(Buffer.from(data, 'utf8'), { stream: true })
    const sanitized = this.sanitizer.push(text)
    this.appendOutput(sanitized.text)
    if (sanitized.prompt) {
      this.promptSeen = true
      this.promptTail = ''
      this.lastOutputAt = Date.now()
    }
    if (this.promptSeen && sanitized.promptTail !== undefined) {
      const remaining = Math.max(0, CONTROLLED_PROMPT.length - this.promptTail.length)
      this.promptTail += sanitized.promptTail.slice(0, remaining)
      if (sanitized.promptTail.length > remaining) this.promptTail = `${CONTROLLED_PROMPT}\0`
      this.promptTextSeen = this.promptTail === CONTROLLED_PROMPT
    }
  }

  private appendOutput(text: string): void {
    if (text.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(text)
    this.active?.append(text)
  }

  /**
   * Capture startup output through the same readiness contract as later sends.
   */
  async initialize(signal?: AbortSignal): Promise<void> {
    this.initializing = true
    try {
      const result = await this.startSend({ text: '', submit: false, ...(signal !== undefined ? { signal } : {}) }).done
      if (result.waitReason === 'session_exit') throw new Error('PTY shell exited during startup')
      if (result.waitReason === 'timeout') throw new Error('PTY shell did not reach readiness before startup timeout')
    } catch (error) {
      signal?.throwIfAborted()
      throw error
    } finally {
      this.initializing = false
    }
  }

  startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closing) throw new Error('PTY session is closing')
    if (this.statusValue.kind === 'exited') throw new Error('PTY session has exited')
    if (this.active !== undefined) throw new TerminalError('PTY session already has an active send', 'SEND_ACTIVE')
    if (request.signal?.aborted === true) throw new Error('PTY send aborted before write')
    const operation = new LocalSendOperation(this.config.maxReadBytes, () => {
      this.interrupt()
    })
    this.active = operation
    this.resetReadinessEvidence()
    if (request.signal !== undefined) {
      const onAbort = (): void => { operation.cancel() }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.activeAbort = () => request.signal?.removeEventListener('abort', onAbort)
    }
    this.activeDeadlineTimer = setTimeout(() => {
      if (this.active === operation) this.settleActive('timeout')
    }, this.config.timeoutMs)
    void this.beginSend(operation, request)
    return operation
  }

  private activeAbort?: () => void

  private async beginSend(operation: LocalSendOperation, request: TerminalSendRequest): Promise<void> {
    try {
      if (this.active !== operation || this.closing) return
      const input = `${request.text}${request.submit ? '\r' : ''}`
      if (input.length > 0 && !operation.cancelRequested) {
        this.resetReadinessEvidence()
        this.terminal.write(input)
      }
      if (operation.cancelRequested) return
      if (this.active === operation && operation.settled) {
        this.clearActive()
        return
      }
      if (this.active === operation && !this.closing) {
        this.schedulePoll(operation)
      }
    } catch (error) {
      if (this.active === operation && !this.closing) {
        if (operation.settled) this.clearActive()
        else this.failActive(error)
      }
    }
  }

  private resetReadinessEvidence(): void {
    this.lastOutputAt = Date.now()
    this.promptSeen = false
    this.promptTextSeen = false
    this.promptTail = ''
  }

  read(request: TerminalReadRequest): TerminalReadResult {
    const snapshot = this.scrollback.snapshot()
    const lines = snapshot.text.split('\n')
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('PTY read offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('PTY read count must be a positive safe integer')
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const bounded = utf8Tail(lines.slice(start, end).join('\n'), this.config.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closing) throw new Error('PTY session is closing')
    // ConPTY has no POSIX groups: interrupt the foreground command by writing
    // the control character bash's job control turns into a signal. Signals
    // without a control character terminate the whole session.
    switch (signal) {
      case 'SIGINT':
        this.terminal.write('\x03')
        break
      case 'SIGTSTP':
        this.terminal.write('\x1A')
        break
      default:
        this.terminal.kill()
    }
    return { delivered: true }
  }

  status(): TerminalSessionStatus {
    return this.statusValue
  }

  close(reason: string): Promise<void> {
    this.closing = true
    if (this.closePromise !== undefined) return this.closePromise
    const closing = this.closeOnce(reason).catch((error) => {
      this.closePromise = undefined
      this.failActive(error)
      throw error
    })
    this.closePromise = closing
    return closing
  }

  private async closeOnce(reason: string): Promise<void> {
    this.stopPolling()
    try {
      this.terminal.kill()
    } catch (error) {
      throw new Error(`PTY cleanup failed (${reason})`, { cause: error })
    }
    this.settleActive('session_exit')
    await Promise.race([this.completion, delay(this.config.disposeGraceMs)])
    await this.outputEnded.promise.catch(() => undefined)
    if (this.transportFailure !== undefined) throw this.transportFailure
  }

  private settleActive(waitReason: TerminalSendResult['waitReason'], retainOwnership = false): void {
    const operation = this.active
    if (operation === undefined) return
    const scrollbackTruncated = this.scrollback.snapshot().truncated
    if (retainOwnership) {
      this.stopPolling()
      this.activeAbort?.()
      this.activeAbort = undefined
    } else {
      this.clearActive()
    }
    operation.settle(waitReason, this.statusValue, scrollbackTruncated)
  }

  private clearActive(): void {
    const operation = this.active
    this.stopPolling()
    this.activeAbort?.()
    this.activeAbort = undefined
    this.active = undefined
    void operation
  }

  private failActive(error: unknown): void {
    const operation = this.active
    if (operation === undefined) return
    this.clearActive()
    operation.fail(error)
  }

  private interrupt(): void {
    void this.signal('SIGINT').catch(() => undefined)
  }

  private schedulePoll(operation: LocalSendOperation, delayMs: number = this.config.pollIntervalMs): void {
    if (this.active !== operation || this.polling) return
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = setTimeout(() => {
      this.activeTimer = undefined
      void this.pollReadiness(operation)
    }, delayMs)
  }

  private async pollReadiness(operation: LocalSendOperation): Promise<void> {
    if (this.active !== operation || this.polling) return
    this.polling = true
    try {
      if (this.statusValue.kind === 'exited') {
        this.settleActive('session_exit')
        return
      }
      const idleFor = Date.now() - this.lastOutputAt
      if (this.promptSeen && this.promptTextSeen && idleFor >= this.config.pollIntervalMs) {
        this.settleActive('stdin_read')
        return
      }
      const handoffGrace = this.promptSeen ? this.config.handoffGraceMs : 0
      if (idleFor >= this.config.idleSilenceMs + handoffGrace) {
        this.settleActive('inferred_idle')
        return
      }
    } catch (error) {
      if (this.active === operation && !this.closing) this.failActive(error)
    } finally {
      this.polling = false
      if (this.active === operation) this.schedulePoll(operation)
    }
  }

  private stopPolling(): void {
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer)
    this.activeTimer = undefined
    if (this.activeDeadlineTimer !== undefined) clearTimeout(this.activeDeadlineTimer)
    this.activeDeadlineTimer = undefined
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** node-pty numeric signal → POSIX name (the OS signal-number table). */
function signalName(number: number): string | null {
  for (const [name, value] of Object.entries(osConstants.signals)) {
    if (value === number) return name
  }
  return null
}

// ── Backend ──────────────────────────────────────────────────────────────────

export interface BashPtySpawnOptions {
  /** Base environment (the TDEase bash runtime env with uv/PATH/TDEASE_SYSTEM_ASSETS). */
  env?: Record<string, string | undefined>
  config?: BashPtyConfig
}

/**
 * Spawn an interactive bash on node-pty with the controlled prompt + OSC 133
 * readiness marker, and initialize it to its first prompt before publishing.
 */
export function createBashPtyBackend(options: BashPtySpawnOptions = {}): TerminalBackend {
  const config = resolveBashConfig(options.config ?? {})
  return {
    type: 'bash',
    async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
      spec.signal?.throwIfAborted()
      const env: Record<string, string> = {
        ...(options.env ?? {}),
        TERM: 'dumb',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        PS1: CONTROLLED_PROMPT,
        PROMPT_COMMAND: 'printf "\\033]133;D;%s\\007" "$?"',
        BASH_SILENCE_DEPRECATION_WARNING: '1',
        TDEASE_PTY_SESSION_ID: spec.sessionId,
      }
      // Defense in depth: when the platform offers an OS sandbox, the whole
      // session shell is born inside it (writes pinned to the Workspace + OS
      // temp, everything else read-only). Availability changes the box around
      // the command, never the command — with no sandbox this spawns exactly
      // as before (sandbox.ts).
      const sandbox = planBashSandbox({ workspaceRoot: spec.cwd ?? process.cwd() })
      if (sandbox) Object.assign(env, sandbox.env)
      const argv = [
        ...(sandbox ? sandbox.prefix : []),
        config.shellPath,
        '--noprofile',
        '--norc',
        '-i',
      ]
      let terminal: IPty
      try {
        terminal = await withSerializedBashStartup(async () => loadPty().spawn(argv[0], argv.slice(1), {
          name: 'dumb',
          rows: config.rows,
          cols: config.cols,
          cwd: spec.cwd ?? process.cwd(),
          env,
        }))
      } catch (error) {
        // The spawn itself failed: no onExit will ever fire, so release the
        // sandbox's temp resources here or the Seatbelt profile dir leaks per
        // failed spawn.
        sandbox?.dispose()
        throw error
      }
      // PTY shells are exactly the orphans taskkill sweeps miss — assign them
      // to the kill-on-close job so they die with the main process (no-op off
      // Windows or when the job could not be created).
      assignChildToJob(terminal.pid)
      // Release the sandbox's temp resources (the Seatbelt profile file) when
      // the shell exits, however it exits.
      if (sandbox) terminal.onExit(() => sandbox.dispose())
      const session = new LocalPtySession(terminal, config, '')
      try {
        await session.initialize(spec.signal)
        // Suppress command echo so scrollback stays pure output (marker
        // protocol slices cleanly); re-assert the controlled prompt.
        const op = session.startSend({ text: `stty -echo; PS1=${quoteForBash(CONTROLLED_PROMPT)}`, submit: true, ...(spec.signal !== undefined ? { signal: spec.signal } : {}) })
        const result = await op.done
        if (result.sessionStatus.kind === 'exited' || result.waitReason === 'timeout') {
          throw new Error('persistent bash shell did not accept initialization')
        }
        return session
      } catch (error) {
        try {
          await session.close('PTY startup failed')
        } catch {
          // Preserve the original startup error.
        }
        throw error
      }
    },
  }
}
