/**
 * PtcRuntime — programmatic tool calling.
 *
 * The model writes one JavaScript script whose `tool(name, args)` calls execute
 * N gated tool invocations inside a single tool call, collapsing the
 * request/response round-trips a fan-out of JSON tool calls would otherwise
 * cost. This is tool *execution*, not subagent organization (that is
 * workflow-runtime) and not scientific computation (that is skills + the
 * native CLI): a PTC script composes the session's registered tools with
 * loops, conditionals, and in-memory joins.
 *
 * One policy gate, two entrances: every `tool()` call passes the same
 * ToolCallGate as a model-emitted call (data-access guards, deny-dominant
 * permission ceiling, 'ask' approval flow), then executes the SAME wrapped
 * tool object the session registered — containment and argument constraining
 * live in that wrapper, so a script cannot reach anything the direct path
 * could not. The callable set is exactly `canonicalTools` by name: no second
 * registry, no widened surface. Model-behavior guards (duplicate-call ledger,
 * loop notices) deliberately do not apply inside a script — the model already
 * wrote the loop on purpose.
 *
 * Realm isolation, not trust: the script body executes inside a `node:vm`
 * context whose only globals are two realm-local wrappers (`tool`, `log`).
 * No host object crosses the boundary — arguments and results travel as JSON
 * through a bootstrap that is deleted right after it runs — so a script that
 * reaches for `process`, `require`, or any constructor chain finds the VM's
 * own (empty) globals, never the main process's.
 *
 * No journal. Orchestrate replays `agent()` calls because spawning is
 * side-effect-free bookkeeping; a PTC script issues real tool calls whose
 * writes must never be silently replayed. Determinism is the script author's
 * business; the runtime provides two budgets instead: a wall clock (the tool
 * call must return) and a call count (a runaway loop must stop). A pure-JS
 * infinite loop cannot be interrupted mid-statement — the clock still turns
 * the tool call into a timeout error instead of hanging the turn — and an
 * in-flight `bash` child is aborted through the signal handed to execute.
 */

import vm from 'node:vm'

import type { SessionBinding } from './turn-definition'
import type { Observers } from './contracts'
import type { PtcCommandPort, PtcExecResult } from '../../src/studio/commands/registry'
import type { ProducedPathLedger, ToolCallGate } from './tool-call-gate'
import { redact } from './tool-call-gate'

/** One session-registered tool, already wrapped by the ToolGateway. */
export interface PtcToolLike {
  readonly name: string
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    ...rest: unknown[]
  ) => Promise<unknown>
}

/**
 * A shell outcome Pi's bash tool reports by throwing, reclassified as a
 * structured result — see docs/design/PTC-RELIABILITY.md O1. DSH's bash tool
 * philosophy ("non-zero exits are reported, not errored") applies to scripts:
 * a `grep` with no matches (exit 1) must be branchable, not kill the script.
 */
export interface ShellOutcomeResult {
  /** The command output without the trailing status marker. */
  text: string
  /** Non-zero exit code, when the shell exited with one. */
  exitCode?: number
  /** True when the command hit its timeout and was killed. */
  timedOut?: boolean
  /** True when the call was cancelled/aborted. */
  aborted?: boolean
}

export interface PtcRuntimeOptions {
  readonly binding: SessionBinding
  /**
   * The session's canonical tool list — the exact surface the model sees.
   * Lazy: the port is created before the tool build (so the command's
   * `enabled` gate can advertise `tdease.ptc.exec`), while the list only
   * exists once the gateway has assembled it.
   */
  readonly tools: () => ReadonlyArray<PtcToolLike>
  readonly gate: ToolCallGate
  readonly observers: Observers
  readonly producedPaths?: ProducedPathLedger
}

// Wall clock, aligned with the bash tool's defaults/ceiling: one PTC call is
// one turn-sized commitment, not a background run (long work belongs to
// tdease.job.start or a skill script).
export const PTC_DEFAULT_TIMEOUT_MS = 120_000
export const PTC_MAX_TIMEOUT_MS = 300_000
// Call budget: the point of PTC is collapsing dozens of round-trips, not
// unbounded fan-out; a script needing more than this is doing batch work that
// belongs in a skill script over files.
export const PTC_MAX_CALLS = 200
// Context-boundary budget: only the script's RETURN (and its error path) ever
// enters the model's context, so it is capped at the bash tool's output
// convention (~12k chars). A script that wants to hand the model more than
// this is handing it a dump, not a digest — bulky artifacts belong in files
// (write via tool(), return paths + a summary). Inside the script, tool()
// results are NOT capped: digesting big data in script memory is the whole
// point of PTC.
export const PTC_MAX_RESULT_CHARS = 12_288
// log() is model-facing too (renderForAgent), so its aggregate is bounded as
// well — 200 entries × 500 chars would otherwise be a 100k-char side channel.
const MAX_LOG_ENTRIES = 200
const MAX_LOG_ENTRY_CHARS = 500
const MAX_LOG_CHARS = 4_096
const MAX_ERROR_STACK_CHARS = 2_000

/**
 * Pi's bash tool (createBashTool) throws on non-zero exit / timeout / abort
 * with stable trailing messages; the gateway passes those through. Scripts
 * must branch on these outcomes instead of dying, so the PTC entrance
 * reclassifies the three known markers into structured results. The markers
 * are internal, stable, and locked by ptc-runtime.e2e.test.ts — a Pi bump that
 * changes the wording fails the test first, not a production script.
 */
const SHELL_EXIT_MARKER = /(?:^|\n\n)Command exited with code (\d+)\s*$/
const SHELL_TIMEOUT_MARKER = /(?:^|\n\n)Command timed out after (\d+) seconds\s*$/
const SHELL_ABORT_MARKER = /(?:^|\n\n)Command aborted\s*$/

export function classifyShellOutcome(name: string, error: unknown): ShellOutcomeResult | undefined {
  if (name !== 'bash') return undefined
  const message = error instanceof Error ? error.message : String(error)
  const exit = SHELL_EXIT_MARKER.exec(message)
  if (exit) return { text: message.slice(0, exit.index), exitCode: Number(exit[1]) }
  const timeout = SHELL_TIMEOUT_MARKER.exec(message)
  if (timeout) return { text: message.slice(0, timeout.index), timedOut: true }
  const aborted = SHELL_ABORT_MARKER.exec(message)
  if (aborted) return { text: message.slice(0, aborted.index), aborted: true }
  return undefined
}

export function createPtcPort(options: PtcRuntimeOptions): PtcCommandPort {
  return {
    exec: (input) => execPtcScript(options, input),
  }
}

async function execPtcScript(
  options: PtcRuntimeOptions,
  input: { script: string; timeout?: number; signal?: AbortSignal },
): Promise<PtcExecResult> {
  const toolsByName = new Map(options.tools().map((tool) => [tool.name, tool]))
  const requested = Number.isFinite(input.timeout) && (input.timeout as number) > 0
    ? (input.timeout as number) * 1_000
    : PTC_DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(requested, PTC_MAX_TIMEOUT_MS)

  const controller = new AbortController()
  const clock = setTimeout(() => controller.abort(), timeoutMs)
  // The tool call's abort (user stop / budget halt) fires the same controller
  // the timeout uses, so in-flight tool() sub-calls abort too — but is
  // reported as an abort, not a timeout.
  let upstreamAborted = false
  const onUpstreamAbort = (): void => {
    upstreamAborted = true
    controller.abort()
  }
  input.signal?.addEventListener('abort', onUpstreamAbort, { once: true })
  let calls = 0
  const callLog: Array<{ name: string; ok: boolean }> = []
  const logLines: string[] = []
  let logChars = 0
  let logDropped = false
  let sequence = 0

  const log = (...values: unknown[]): void => {
    if (logLines.length >= MAX_LOG_ENTRIES) return
    const text = values
      .map((value) => (typeof value === 'string' ? value : safeJson(value)))
      .join(' ')
    const line = text.length > MAX_LOG_ENTRY_CHARS ? `${text.slice(0, MAX_LOG_ENTRY_CHARS)}…` : text
    if (logChars + line.length > MAX_LOG_CHARS) {
      if (!logDropped) {
        logDropped = true
        logLines.push('…[log truncated — keep log() lines for progress, not data]')
      }
      return
    }
    logChars += line.length
    logLines.push(line)
  }

  const tool = async (name: unknown, args?: unknown): Promise<{ text: string; details?: unknown; exitCode?: number; timedOut?: boolean; aborted?: boolean }> => {
    if (typeof name !== 'string' || !toolsByName.has(name)) {
      throw new Error(
        `tool(): unknown tool ${safeJson(name)}. The callable set is exactly the tools this session registers.`,
      )
    }
    if (controller.signal.aborted) throw new Error('ptc.exec timed out')
    if (args !== undefined && (typeof args !== 'object' || Array.isArray(args))) {
      throw new Error(`tool(${name}): args must be an object`)
    }
    calls += 1
    if (calls > PTC_MAX_CALLS) {
      throw new Error(`ptc.exec call budget exhausted (${PTC_MAX_CALLS} tool() calls)`)
    }
    const callArgs = (args ?? {}) as Record<string, unknown>
    const callId = `ptc-${++sequence}`
    const decision = await options.gate.check(name, callArgs, callId)
    if (decision) throw new Error(`tool(${name}) blocked: ${decision.block}`)

    const target = toolsByName.get(name)!
    let result: unknown
    try {
      result = await target.execute(callId, callArgs, controller.signal)
    } catch (error) {
      // DSH-style shell outcomes: a non-zero exit, timeout, or abort is a
      // REPORTED outcome with structured fields, not a thrown failure — the
      // script branches on `r.exitCode` / `r.timedOut` instead of dying (see
      // docs/design/PTC-RELIABILITY.md O1). Only genuine infrastructure
      // failures keep the throw path below.
      const reported = classifyShellOutcome(name, error)
      if (reported !== undefined) {
        callLog.push({ name, ok: true })
        options.observers.auditTool(
          options.binding.sessionId,
          callId,
          name,
          redact(callArgs),
          redact(reported),
          true,
        )
        return reported
      }
      callLog.push({ name, ok: false })
      options.observers.auditTool(
        options.binding.sessionId,
        callId,
        name,
        redact(callArgs),
        redact(error instanceof Error ? { message: error.message } : { message: String(error) }),
        false,
      )
      throw error instanceof Error
        ? new Error(`tool(${name}) failed: ${error.message}`)
        : new Error(`tool(${name}) failed: ${String(error)}`)
    }
    callLog.push({ name, ok: true })
    const normalized = normalizeResult(result)
    // Lift structured outcome fields (exitCode/timedOut/...) from details to
    // the top level so scripts branch on `r.exitCode` uniformly — whether the
    // shell tool reported (persistent bash) or a legacy throw was classified.
    const lifted = liftStructuredOutcome(normalized.details)
    options.observers.auditTool(
      options.binding.sessionId,
      callId,
      name,
      redact(callArgs),
      redact(normalized),
      true,
    )
    // Only write/edit calls produce paths. Read/list calls are observations;
    // recording their arguments would turn a broad read into a ledger grant.
    if (name === 'write' || name === 'edit') {
      for (const target_path of [callArgs.path, callArgs.file_path]) {
        if (typeof target_path === 'string' && target_path.trim()) options.producedPaths?.note(target_path)
      }
    }
    return { ...normalized, ...lifted }
  }

  try {
    // The script runs inside a bare `node:vm` context — never the main
    // process's global scope. The bootstrap below is the ONLY thing that ever
    // sees the host bridge functions: it wraps them in realm-local `tool`/
    // `log` and then deletes itself, so no host object (whose `.constructor`
    // chain would reach the host `Function` constructor, and with it
    // `process`/`require`) is reachable from script code. Arguments and
    // results cross the boundary as JSON strings only.
    const sandbox: Record<string, unknown> = {
      __dispatch: (name: string, argsJson: string, resolve: (json: string) => void, reject: (message: string) => void): void => {
        void (async () => {
          try {
            const result = await tool(name, JSON.parse(argsJson))
            resolve(jsonOf(result))
          } catch (error) {
            reject(errorMessageOf(error))
          }
        })()
      },
      __log: (line: string): void => log(line),
    }
    const context = vm.createContext(sandbox)
    vm.runInContext([
      // The IIFE parameters are true closure bindings: after the trailing
      // deletes, the host functions are reachable ONLY through the wrapper
      // closures — a global reference would resolve late (at call time) and
      // break the moment it is deleted.
      ';(function (__dispatch, __log) {',
      '  globalThis.tool = (name, args) => new Promise((resolve, reject) => {',
      '    __dispatch(String(name), JSON.stringify(args ?? {}),',
      '      (json) => resolve(JSON.parse(json)),',
      '      (message) => reject(new Error(message)))',
      '  })',
      '  globalThis.log = (...values) => __log(values.map(',
      '    (value) => (typeof value === \'string\' ? value : JSON.stringify(value, null, 2))).join(\' \'))',
      '})(__dispatch, __log)',
      'delete globalThis.__dispatch',
      'delete globalThis.__log',
    ].join('\n'), context)
    const fn = vm.runInContext(`(async () => {\n${input.script}\n})`, context) as () => Promise<unknown>
    const settled = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(
          new Error(upstreamAborted ? 'ptc.exec aborted' : `ptc.exec timed out after ${timeoutMs / 1000}s`),
        ), { once: true })
      }),
    ])
    const serialized = typeof settled === 'string' ? settled : safeJson(settled)
    return {
      ok: true,
      result: truncateMiddle(serialized),
      calls: callLog,
      log: logLines,
    }
  } catch (error) {
    // Errors arrive from the VM realm — `instanceof Error` is false there —
    // so read the fields defensively instead of trusting the prototype.
    const message = errorMessageOf(error)
    const stack = typeof (error as { stack?: unknown } | null)?.stack === 'string'
      ? `\n${(error as { stack: string }).stack.slice(-MAX_ERROR_STACK_CHARS)}`
      : ''
    return {
      ok: false,
      error: truncateMiddle(`${message}${stack}`),
      calls: callLog,
      log: logLines,
      timedOut: /timed out/.test(message),
      aborted: /aborted/.test(message) && !/timed out/.test(message),
    }
  } finally {
    clearTimeout(clock)
    input.signal?.removeEventListener('abort', onUpstreamAbort)
  }
}

/** Host-side serialization for values crossing into the VM (circular-safe). */
function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return JSON.stringify({ text: safeJson(value) })
  }
}

/** `errorMessage` for any realm: prototype chains do not survive the VM boundary. */
function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}

/** pi AgentToolResult → the plain shape a script consumes. */
function normalizeResult(result: unknown): { text: string; details: unknown } {
  if (result && typeof result === 'object' && 'content' in result) {
    const content = (result as { content?: unknown }).content
    const text = Array.isArray(content)
      ? content.map((block) => (block && typeof block === 'object' && 'text' in block
        ? String((block as { text?: unknown }).text ?? '')
        : '')).join('')
      : String(content ?? '')
    return { text, details: (result as { details?: unknown }).details }
  }
  return { text: safeJson(result), details: undefined }
}

const STRUCTURED_OUTCOME_KEYS = ['exitCode', 'signal', 'timedOut', 'aborted', 'truncated'] as const

/**
 * Lift structured outcome fields from a tool result's `details` to the top
 * level (`r.exitCode`, `r.timedOut`, ...). The persistent bash tool reports
 * non-zero exits in details; scripts must branch on them without parsing
 * prose.
 */
function liftStructuredOutcome(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {}
  const record = details as Record<string, unknown>
  const lifted: Record<string, unknown> = {}
  for (const key of STRUCTURED_OUTCOME_KEYS) {
    if (record[key] !== undefined) lifted[key] = record[key]
  }
  return lifted
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Keep the head and tail; a script's return is usually summarized at its end. */
function truncateMiddle(text: string): string {
  if (text.length <= PTC_MAX_RESULT_CHARS) return text
  const half = Math.floor(PTC_MAX_RESULT_CHARS / 2)
  return `${text.slice(0, half)}\n…[truncated ${text.length - PTC_MAX_RESULT_CHARS} chars]…\n${text.slice(-half)}`
}
