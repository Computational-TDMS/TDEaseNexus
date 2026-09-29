/**
 * Orchestration runtime — executes a JavaScript orchestration script whose
 * `agent()` / `parallel()` / `pipeline()` / `phase()` calls fan work out across
 * the existing subagent registry, with journaled resume by positional call index.
 *
 * First Principle: an orchestration script is NOT a new agent engine. It is a
 * thin deterministic shell over the existing `createSubagentRegistry`. Each
 * `agent(prompt)` call routes to `subagents.spawn` + `subagents.wait`; the
 * script's only job is to express the *topology* of a fan-out (who runs in
 * parallel, who depends on whom, when to synthesize) so that topology becomes
 * inspectable, editable, and resumable instead of improvised inside one turn.
 *
 * No VM sandbox. Determinism comes from the journal (`workflow-journal.ts`):
 * completed `agent()` calls are cached by `(callIndex, promptHash)` and replayed
 * verbatim on `resumeFromRunId`, so an unchanged prompt never re-spawns its
 * subagent. Safety is unchanged — every spawned subagent still goes through the
 * permission gateway, cwd containment, and tool-surface narrowing it always has.
 *
 * Execution is a single `AsyncFunction` whose parameters ARE the global surface
 * the script may use: `agent, parallel, pipeline, phase, log, budget, args, cwd`.
 * A script that reaches for `Date` / `require` / `fs` is simply not provided
 * them by name; the runtime does not enforce their absence, the journal does not
 * care, and the cached results remain reusable regardless.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type {
  OrchestrateCommandPort,
  OrchestrateRunStatus,
  OrchestrateWaitResult,
  SubagentCommandPort,
  SubagentResult,
  WorkflowRunInput,
} from '../../src/studio/commands/registry'
import {
  createWorkflowJournal,
  hashAgentCall,
  type WorkflowJournal,
} from './workflow-journal'

/** `AsyncFunction` is not a global; obtain its constructor once. */
const AsyncFunction = Object.getPrototypeOf(async function (): Promise<void> { /* sentinel */ }).constructor as {
  new (...args: string[]): (...args: unknown[]) => Promise<unknown>
}

const DEFAULT_MAX_AGENTS = 1000
const DEFAULT_CONCURRENCY = 16

/** The runtime-facing deps for one `runWorkflow` invocation. */
export interface WorkflowRuntimeDeps {
  subagents: SubagentCommandPort
  journal: WorkflowJournal
  /** Absolute Workspace root, exposed to the script as the read-only `cwd`. */
  cwd: string
  /** Fired when the script calls `phase(title)`. */
  onPhase?: (title: string) => void
  /** Fired before each `agent()` resolves; `cached` distinguishes replay vs fresh. */
  onAgentStart?: (index: number, prompt: string, cached: boolean) => void
  signal?: AbortSignal
}

/**
 * Execute one orchestration script. Returns the script's own return value (or
 * `undefined` when the script has no top-level `return`). The journal records
 * every settled `agent()` call so a later `resumeFromRunId` reuses the prefix.
 */
export async function runWorkflow(
  input: WorkflowRunInput,
  deps: WorkflowRuntimeDeps,
): Promise<{ result: unknown; runId: string }> {
  const { subagents, journal, cwd, onPhase, onAgentStart, signal } = deps
  const maxAgents = input.maxAgents ?? DEFAULT_MAX_AGENTS
  // `concurrency` is honored by `parallel()` via a bounded queue; the default
  // mirrors pi-dynamic-workflows' clamp (16). Stored even though a single linear
  // script never reads it, so a script that asks for less parallelism gets it.
  const concurrency = Math.min(Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY), DEFAULT_CONCURRENCY)

  let callIndex = 0
  // Replay cursor: once an (index, promptHash) lookup misses, every later call
  // is treated as fresh. This is the pi-dynamic-workflows positional contract —
  // the orchestrator cannot know whether later prompts depended on an earlier
  // result, so it never trusts a cache entry past the first divergence.
  let replayBroken = false

  async function agent(prompt: unknown, options?: unknown): Promise<SubagentResult> {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('agent(prompt, options?) requires a non-empty string prompt')
    }
    if (callIndex >= maxAgents) {
      throw new Error(`orchestration exceeded maxAgents=${maxAgents}`)
    }
    const idx = callIndex++
    const opts = normalizeOptions(options)
    const promptHash = hashAgentCall(prompt, opts)

    if (!replayBroken) {
      const cached = journal.lookup(idx, promptHash)
      if (cached) {
        onAgentStart?.(idx, prompt, true)
        return cached.result as SubagentResult
      }
      replayBroken = true
    }
    onAgentStart?.(idx, prompt, false)

    if (signal?.aborted) throw new Error('orchestration aborted before spawn')

    const role = (opts?.role as string | undefined) ?? 'generic'
    const spawnInput = opts?.input as Record<string, unknown> | undefined
    const { subagentId } = await subagents.spawn({ role, task: prompt, input: spawnInput })
    if (signal?.aborted) {
      void subagents.cancel(subagentId).catch(() => undefined)
      throw new Error('orchestration aborted after spawn')
    }
    const [status] = await subagents.wait({ subagentIds: [subagentId] }, signal)
    if (signal?.aborted) throw new Error('orchestration aborted while waiting')
    if (!status.result) {
      // A child that settled blocked/cancelled carries no usable §6 envelope;
      // surface the error rather than caching an empty result.
      const detail = status.error ? ` (${status.error.code}: ${status.error.message})` : ''
      throw new Error(`agent call #${idx} (${role}) settled as ${status.state}${detail}`)
    }
    const result = status.result
    // Only fully-returned results enter the journal — a blocked call must re-run
    // on resume because its partial result is not reproducible from the prompt.
    if (status.state === 'returned') {
      journal.append({ index: idx, promptHash, result, state: 'returned' })
    }
    return result
  }

  async function parallel(thunks: unknown): Promise<unknown[]> {
    if (!Array.isArray(thunks)) throw new Error('parallel(thunks) requires an array of () => agent(...)')
    if (thunks.length === 0) return []
    return runBounded(thunks as ReadonlyArray<() => Promise<unknown>>, concurrency, (thunk) => thunk())
  }

  async function pipeline(items: unknown, ...stages: ReadonlyArray<unknown>): Promise<unknown[]> {
    if (!Array.isArray(items)) throw new Error('pipeline(items, ...stages) requires an array as its first argument')
    if (stages.length === 0) return [...items]
    let acc: ReadonlyArray<unknown> = [...items]
    for (const stage of stages) {
      if (typeof stage !== 'function') throw new Error('pipeline stages must be (item) => item functions')
      const fn = stage as (item: unknown, index: number) => unknown | Promise<unknown>
      acc = await runBounded(acc, concurrency, (item, index) => fn(item, index))
    }
    return [...acc]
  }

  function phase(title: unknown): void {
    if (typeof title !== 'string' || !title.trim()) throw new Error('phase(title) requires a non-empty string')
    onPhase?.(title)
  }

  function log(message: unknown): void {
    // Best-effort console mirror; the transcript already records tool calls.
    console.log('[orchestrate]', typeof message === 'string' ? message : JSON.stringify(message))
  }

  const budget = {
    total: maxAgents,
    spent: () => callIndex,
    remaining: () => Math.max(0, maxAgents - callIndex),
  }

  const fn = new AsyncFunction(
    'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'args', 'cwd',
    input.script,
  )
  const result = await fn(agent, parallel, pipeline, phase, log, budget, input.args, cwd)
  return { result, runId: journal.runId }
}

/**
 * Run an array of items through a mapper with a concurrency cap. Mirrors the
 * spawnGroup primitive: in-process children share one event loop, so "parallel"
 * means interleaved turns, not OS threads — the cap bounds how many prompts are
 * in flight, not how many subagents are bound.
 */
async function runBounded<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  mapper: (item: T, index: number) => unknown | Promise<unknown>,
): Promise<unknown[]> {
  const results = new Array<unknown>(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await mapper(items[index], index)
    }
  }
  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

/** Strip `undefined`-valued keys so the hash is stable across `{role:'a'}` vs `{role:'a',input:undefined}`. */
function normalizeOptions(options: unknown): Record<string, unknown> | undefined {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
    if (value !== undefined) out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

// ── Registry: the port surface the Agent command layer talks to ──────────────

interface OrchestrateRun {
  readonly runId: string
  state: 'running' | 'done' | 'failed'
  phase?: string
  readonly journal: WorkflowJournal
  readonly abortController: AbortController
  settle: Promise<OrchestrateWaitResult>
}

export interface OrchestrateRegistryOptions {
  subagents: SubagentCommandPort
  /** Absolute Workspace root for journal persistence. Absent = in-memory only. */
  workspaceRoot?: string
  parentSessionId: string
}

/**
 * The per-session orchestration port. One instance per bound parent session
 * (mirrors `createSubagentRegistry`); holds a `Map<runId, OrchestrateRun>` so
 * `run` returns immediately with a runId and `wait` blocks on settle.
 */
export function createOrchestrateRegistry(options: OrchestrateRegistryOptions): OrchestrateCommandPort & { cancelAll(): void } {
  const runs = new Map<string, OrchestrateRun>()

  function persistPath(runId: string): string | undefined {
    if (!options.workspaceRoot) return undefined
    return path.join(
      options.workspaceRoot, '.tdease', 'sessions', options.parentSessionId, 'workflows', `${runId}.json`,
    )
  }

  return {
    async run(input: WorkflowRunInput): Promise<{ runId: string }> {
      const runId = input.resumeFromRunId ?? `wf_${randomUUID()}`
      if (runs.has(runId)) {
        throw new Error(`orchestration run already in progress: ${runId}`)
      }
      const journal = createWorkflowJournal({
        runId,
        persistPath: persistPath(runId),
        resume: Boolean(input.resumeFromRunId),
      })
      const abortController = new AbortController()
      const record: OrchestrateRun = {
        runId,
        state: 'running',
        journal,
        abortController,
        settle: undefined as unknown as Promise<OrchestrateWaitResult>,
      }
      // Fire-and-forget: the run starts the moment the record exists, but
      // `run()` returns immediately with the runId; `wait()` is the join point.
      record.settle = (async (): Promise<OrchestrateWaitResult> => {
        try {
          const { result } = await runWorkflow(input, {
            subagents: options.subagents,
            journal,
            cwd: options.workspaceRoot ?? process.cwd(),
            signal: abortController.signal,
            onPhase: (title) => { record.phase = title },
          })
          record.state = 'done'
          return { result, runId, state: 'done' }
        } catch (error) {
          record.state = 'failed'
          return Promise.reject(error)
        }
      })()
      // Swallow the unhandled-rejection from a fire-and-forget run that nobody
      // `wait()`s on — the error is kept on `record` and surfaced via `status`.
      record.settle.catch(() => { /* error retained on record.state='failed' */ })
      runs.set(runId, record)
      return { runId }
    },

    async wait(runId: string, signal?: AbortSignal): Promise<OrchestrateWaitResult> {
      const record = runs.get(runId)
      if (!record) throw new Error(`No orchestration run: ${runId}`)
      if (!signal) return record.settle
      // A user stop settles the join at once: the run's own controller fires
      // (no further agent() spawns) and the wait rejects — the parent turn is
      // ending anyway, and Pi turns a thrown tool error into an error result,
      // never a dead loop.
      return new Promise<OrchestrateWaitResult>((resolve, reject) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
        }
        const onAbort = (): void => {
          finish()
          record.abortController.abort()
          reject(new Error('orchestration wait aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) { onAbort(); return }
        record.settle.then(
          (value) => { finish(); resolve(value) },
          (error) => { finish(); reject(error) },
        )
      })
    },

    /** Fire every running run's abort controller — the user-stop cascade
     *  (AgentRuntime.abort): stop new agent() spawns and let in-flight
     *  subagent.wait joins inside the script see their children cancelled. */
    cancelAll(): void {
      for (const record of runs.values()) {
        if (record.state === 'running') record.abortController.abort()
      }
    },

    status(runId: string): OrchestrateRunStatus {
      const record = runs.get(runId)
      if (!record) throw new Error(`No orchestration run: ${runId}`)
      const out: OrchestrateRunStatus = {
        runId,
        state: record.state,
        agentCount: record.journal.size,
      }
      if (record.phase) out.phase = record.phase
      return out
    },
  }
}
