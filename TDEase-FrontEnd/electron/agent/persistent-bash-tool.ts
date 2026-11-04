/**
 * PersistentBashTool — the model-facing `bash` tool over the owner-scoped PTY
 * seam (the TDEase port of `@deepseek-ai/dsh-tool-bash-persistent`).
 *
 * State — exported variables and functions — persists across calls for the
 * owning agent session. Each command starts from the Workspace root unless
 * it supplies an explicit per-call cwd. Each command is framed with
 * unique start/end markers (`printf '<start>'; eval -- '<cmd>'; status=$?;
 * printf '<end>$status'`) and completion is read from the terminal scrollback,
 * so a command is "done" exactly when its end marker appears, not when the
 * send-wait happens to settle. Non-zero exits are REPORTED as structured
 * results (`[exit code: N]` + details.exitCode), never thrown — DSH's
 * "reported, not errored" philosophy, which the PTC reliability work (O1) made
 * script-facing too.
 *
 * Lifecycle: one session per owner, created lazily on the first command,
 * serialized (one command at a time), interrupted + reset on timeout or
 * cancellation, disposed with the owner's PtyTerminalService.
 */

import { TerminalError, type PtyTerminalService } from './pty-terminal'
import { createBashPtyBackend, type BashPtyConfig } from './pty-bash-backend'
import { commandOutput, markers, partialOutput, promptCompleted, quoteForBash, renderCaptured, SHELL_PROMPT, wrapCommand } from './terminal-protocol'

const SHELL_RESET_MESSAGE = 'The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.'
const TIMEOUT_CODE = 'PERSISTENT_BASH_TIMEOUT'
// 2026-10-14: the model-facing 300 s raise ceiling was removed — the wait now
// caps at the per-spawn config (default 120 s); long work belongs to jobs.
const SCROLLBACK_PAGE_LINES = 1_000
const POLL_INTERVAL_MS = 25

export interface PersistentBashToolOptions {
  /** The owner-scoped terminal registry for this agent session. */
  readonly terminals: PtyTerminalService
  /** Owning agent session id. */
  readonly owner: string
  /** Base environment for the spawned shell (TDEase bash runtime env). */
  readonly env: () => NodeJS.ProcessEnv
  /** Session workspace root — the shell's initial working directory. */
  readonly workspaceRoot: string
  /** Per-command deadline; default 120s (TDEase bash convention). */
  readonly timeoutMs?: number
  /** Rendered output cap in chars; default 12_000. */
  readonly maxOutputChars?: number
  /** Bash backend config (rows/cols/limits). */
  readonly config?: BashPtyConfig
}

export interface PersistentBashResult {
  /** Command output with status markers appended (model-facing text). */
  readonly text: string
  /** Non-zero exit code, when the command exited with one. */
  readonly exitCode?: number
  /** True when the command hit its deadline and the shell was reset. */
  readonly timedOut?: boolean
  /** True when scrollback dropped output. */
  readonly truncated?: boolean
  /** True when the shell was reset for this call (timeout/abort/exit). */
  readonly reset?: boolean
}

// ── Per-owner shell state ────────────────────────────────────────────────────

interface ShellState {
  /** The session-id promise: pending while spawning, then the resolved id. It
   *  stays set for the life of the shell so every later call reuses it; reset()
   *  deletes it to force a fresh spawn. */
  pending?: Promise<string>
  live?: string
}

export function createPersistentBashTool(options: PersistentBashToolOptions) {
  const config = {
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOutputChars: options.maxOutputChars ?? 12_000,
    backendType: 'bash',
  }
  const backend = createBashPtyBackend({ env: options.env(), config: options.config })
  if (!options.terminals.listBackends().includes('bash')) {
    options.terminals.registerBackend(backend)
  }
  const shells = new Map<string, ShellState>()

  const closeShell = async (owner: string, id: string, reason: string): Promise<void> => {
    if (!options.terminals.list(owner).some((snapshot) => snapshot.sessionId === id)) return
    await options.terminals.kill(owner, id, reason)
  }

  const reset = async (owner: string, reason: string): Promise<void> => {
    const state = shells.get(owner)
    shells.delete(owner)
    const id = state?.live
    if (id !== undefined) await closeShell(owner, id, reason)
  }

  const get = (owner: string, signal?: AbortSignal): Promise<string> => {
    const state = shells.get(owner) ?? {}
    shells.set(owner, state)
    if (state.pending !== undefined) return state.pending
    const tracked = (async () => {
      try {
        const spawned = await options.terminals.spawn(
          owner,
          { type: config.backendType, cwd: options.workspaceRoot },
          signal,
        )
        state.live = spawned.sessionId
        const result = await options.terminals.startSend(owner, spawned.sessionId, {
          text: `stty -echo; PS1=${quoteForBash(SHELL_PROMPT)}`,
          submit: true,
          signal,
        }).done
        if (result.sessionStatus.kind === 'exited' || result.waitReason === 'timeout') {
          throw new Error('persistent bash shell did not accept initialization')
        }
        return spawned.sessionId
      } catch (error) {
        await reset(owner, 'persistent bash initialization failed')
        throw error
      }
    })()
    state.pending = tracked
    return tracked
  }

  // One command at a time per owner: a persistent shell cannot run two
  // foreground commands concurrently.
  const queues = new Map<string, Promise<void>>()
  const serialized = async <T>(owner: string, operation: () => Promise<T>): Promise<T> => {
    const run = (queues.get(owner) ?? Promise.resolve()).then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    queues.set(owner, tail)
    try {
      return await run
    } finally {
      if (queues.get(owner) === tail) queues.delete(owner)
    }
  }

  const executeCommand = async (
    owner: string,
    command: string,
    timeoutMs: number,
    cwd: string | undefined,
    upstream: AbortSignal,
  ): Promise<PersistentBashResult> => {
    // Session creation (spawn + readiness) is NOT part of the command
    // deadline: a cold bash start must not count against a 2-second command
    // timeout. The deadline starts once the shell is ready.
    const id = await get(owner, upstream)
    const controller = new AbortController()
    const clock = setTimeout(() => controller.abort(new Error(TIMEOUT_CODE)), timeoutMs)
    const combined = AbortSignal.any([upstream, controller.signal])
    const timedOut = () => controller.signal.aborted && !upstream.aborted
    try {
      const marker = markers()
      // Keep shell state useful without making relative paths depend on the
      // previous command. Explicit cwd is scoped to this call only.
      const commandCwd = cwd ?? options.workspaceRoot
      // F3: cd failures must fail the call loudly. The old `cd X 2>/dev/null;
      // cmd` swallowed the error AND ran the command from a drifted cwd, so
      // relative operands acted on the wrong directory. Guarding with if/else
      // keeps the shell alive, surfaces cd's stderr, and reports a non-zero
      // status (the else branch's trailing `false`) with a clear message
      // instead of silently executing in the wrong place.
      const cdFailed = 'cd failed for the requested working directory; command not executed'
      // Newline separators (not `;`) so a command that itself ends in `;`
      // cannot produce a `;;` syntax error before the else branch.
      const inner = `if cd -- ${quoteForBash(commandCwd)}\nthen\n${command}\nelse\nprintf %s\\n ${quoteForBash(cdFailed)}: ${quoteForBash(commandCwd)} >&2\nfalse\nfi`
      const wrapped = wrapCommand(inner, marker)
      let first = true
      let fallback = ''
      let fallbackTruncated = false
      while (true) {
        let operation
        let result
        try {
          operation = options.terminals.startSend(owner, id, {
            text: first ? wrapped : '',
            submit: first,
            signal: combined,
          })
          first = false
          result = await operation.done
        } catch (error) {
          await reset(owner, 'persistent bash send failed')
          throw error
        }
        const incremental = operation.readOutput()
        // Accumulate, never reset: a quiet poll's `viewport` is the same
        // (empty) buffer `delta` just consumed — assigning it here would wipe
        // everything captured before the command went quiet, losing exactly
        // the long-output partial the fallback exists to preserve.
        fallback += incremental.delta
        fallbackTruncated ||= incremental.truncated || result.truncated
        const latest = options.terminals.read(owner, id, { offset: 0, count: SCROLLBACK_PAGE_LINES })
        if (timedOut()) {
          const partial = renderCaptured(
            partialOutput(retainedScrollback(options.terminals, owner, id, latest), marker, fallback, fallbackTruncated),
            undefined,
            config.maxOutputChars,
          )
          await reset(owner, 'persistent bash command timed out')
          return {
            text: [
              `Your command timed out after ${Math.round(timeoutMs / 1_000)} seconds. Below is partial output:`,
              partial,
              SHELL_RESET_MESSAGE,
              // Steer the retry away from re-hitting this cap: a killed call's
              // work is lost, so the same long command must relaunch as a job.
              'This timeout is a property of the bash tool, not of your command. For anything long-running (pipelines, builds, batch conversion, model runs), launch it with tdease.job.start and collect results with tdease.job.wait — jobs are not subject to this limit.',
            ].join('\n'),
            timedOut: true,
            truncated: fallbackTruncated,
            reset: true,
          }
        }
        if (combined.aborted) {
          await reset(owner, 'persistent bash command aborted')
          combined.throwIfAborted()
        }
        if (latest.text.includes(marker.end)) {
          const complete = commandOutput(retainedScrollback(options.terminals, owner, id, latest), marker)
          if (complete !== undefined) {
            return {
              text: renderCaptured(complete, complete.exitCode, config.maxOutputChars),
              exitCode: complete.exitCode,
              truncated: latest.truncated || fallbackTruncated,
            }
          }
        }
        if (result.sessionStatus.kind === 'exited') {
          const snapshot = retainedScrollback(options.terminals, owner, id, latest)
          const body = renderCaptured(partialOutput(snapshot, marker, fallback, fallbackTruncated), undefined, config.maxOutputChars)
          const exitMarker = result.sessionStatus.exitCode !== null
            ? `[shell exited: code ${result.sessionStatus.exitCode}]`
            : result.sessionStatus.signal !== null
              ? `[shell killed by signal: ${result.sessionStatus.signal}]`
              : '[shell exited]'
          await reset(owner, 'persistent bash shell exited')
          return {
            text: [body, exitMarker, SHELL_RESET_MESSAGE].filter((part) => part.length > 0).join('\n'),
            reset: true,
            truncated: fallbackTruncated,
          }
        }
        if (promptCompleted(result)) {
          const partial = partialOutput(retainedScrollback(options.terminals, owner, id, latest), marker, fallback, fallbackTruncated)
          return {
            text: renderCaptured(partial, undefined, config.maxOutputChars),
            truncated: fallbackTruncated,
          }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }
    } finally {
      clearTimeout(clock)
    }
  }

  return {
    async execute(
      _callId: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (command.length === 0) throw new Error('A shell command is required.')
      // The model cannot EXTEND the wait past the session ceiling: a longer
      // request clamps to it, so genuinely long work surfaces as a timeout
      // whose message redirects to tdease.job.start (2026-10-14; the P1 case
      // run held 3×200 s pipeline executions synchronously by raising this
      // arg 180→240→300 instead of starting jobs). Shorter requests are
      // honored so quick expected-fail probes stay cheap.
      const requested = Number.isFinite(args.timeout) && (args.timeout as number) > 0
        ? Math.round((args.timeout as number) * 1_000)
        : undefined
      const timeoutMs = requested !== undefined ? Math.min(requested, config.timeoutMs) : config.timeoutMs
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined
      const result = await serialized(options.owner, () => executeCommand(options.owner, command, timeoutMs, cwd, signal ?? new AbortController().signal))
      return {
        content: [{ type: 'text', text: result.text }],
        details: {
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
          ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
          ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
          ...(result.reset !== undefined ? { reset: result.reset } : {}),
        },
      }
    },
  }
}

/** Reassemble the whole retained scrollback by walking read() pages (DSH port). */
function retainedScrollback(
  terminals: PtyTerminalService,
  owner: string,
  id: string,
  latest = terminals.read(owner, id, { offset: 0, count: SCROLLBACK_PAGE_LINES }),
): { text: string; truncated: boolean } {
  const pages = latest.text.length === 0 ? [] : [latest.text]
  let offset = latest.lineEnd
  let truncated = latest.truncated
  while (true) {
    if (offset >= latest.totalLines) break
    const page = terminals.read(owner, id, { offset, count: SCROLLBACK_PAGE_LINES })
    truncated ||= page.truncated
    if (page.text.length > 0) pages.unshift(page.text)
    const next = nextScrollbackOffset(page, offset)
    if (next === undefined || next >= page.totalLines) break
    offset = next
  }
  return { text: pages.join('\n'), truncated }
}

function nextScrollbackOffset(page: { text: string; lineEnd: number }, offset: number): number | undefined {
  if (page.text.length === 0 || page.lineEnd <= offset) return undefined
  return page.lineEnd
}

export { TerminalError }
