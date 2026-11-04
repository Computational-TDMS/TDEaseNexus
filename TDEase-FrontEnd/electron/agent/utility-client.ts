/**
 * Main-process client for the agent utilityProcess (electron/dist/agent-utility.cjs).
 *
 * Replaces main's in-process getAgentRuntime(): every agent ipcMain handler
 * calls through this typed client, so a node-pty native crash, a runaway loop
 * or an OOM in the agent runtime kills only the child — never the Electron
 * main process. The ipcMain channel names and payloads to the renderer are
 * UNCHANGED; the renderer does not know where the runtime lives.
 *
 * Responsibilities beyond request/response:
 *  - push fan-out: RelayEvent messages drive the same RuntimePush callbacks
 *    main used to pass to createAgentRuntime (owner-map routing stays in main);
 *    turnEvent arrives with the parent session id pre-resolved child-side;
 *  - reverse RPC: the child's main-owned deps (workspace registry, backend
 *    connection, model metadata, node-catalog install) dispatch here;
 *  - usage ledger: child-side ops replay onto main's single ledger instance,
 *    with the child-generated opaque requestId translated to the ledger's own;
 *  - supervision: on child exit, pending requests reject with a retryable
 *    error, the crash is logged through crashLog conventions, and the child is
 *    respawned (unless the app is quitting). After respawn, every session that
 *    was bound via agent:bind-session is rebound from its cached input, so the
 *    on-disk session store rehydrates the child and live owners keep working.
 *
 * The spawn function is injectable so supervision and protocol behavior are
 * unit-testable against a fake child (utility-relay.test.ts).
 */
import type { UsageLedger } from '../../src/ai/core/usage-ledger'
import type { AgentModelMetadata } from '../../src/contracts/agent-runtime'
import type { NodeInstallOutcome } from '../../src/studio/commands/registry'
import type { BackendConnection } from './agent-runtime'
import type {
  AgentBridgeResult,
  BindSessionInput,
  BoundSession,
  PromptInput,
  PromptResult,
  ResolveApprovalInput,
} from '../../src/contracts/agent-runtime'
import type { JobPeek, JobStatus, SubagentPeek, SubagentStatus } from '../../src/studio/commands/registry'
import type { RunSummary } from '../../src/studio/domain/run'
import {
  clampForRelay,
  deserializeError,
  findRelayClampMarker,
  serializeError,
  type AgentDepMethod,
  type AgentHostMethod,
  type RelayCall,
  type RelayMessage,
} from './utility-protocol'

/** Surface of Electron's UtilityProcess the client relies on (test-doubleable). */
export interface AgentChildLike {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  postMessage(message: unknown): void
  kill(): void
}

export interface AgentClientDeps {
  resolveWorkspaceRoot(workspaceId: string): Promise<string>
  backendConnection(): BackendConnection
  resolveModelMeta?(providerId: string, modelId: string): Promise<AgentModelMetadata | null>
  nodeCatalogInstaller?(sourceDir: string): Promise<NodeInstallOutcome>
  /** providerId → decrypted safeStorage keys (the child cannot use safeStorage). */
  credentialKeys?(): Record<string, string>
  /** Main's single ledger instance (usage-ledger:* IPC reads it). */
  usageLedger: UsageLedger
}

/** RuntimePush with the turnEvent parent hint the relay provides. */
export interface AgentClientPush {
  turnEvent(sessionId: string, event: unknown, parentSessionId?: string): void
  runsInvalidated?(workspaceId: string): void
  subagents?(sessionId: string, snapshot: ReadonlyArray<SubagentStatus>): void
  jobs?(sessionId: string, snapshot: ReadonlyArray<JobStatus>): void
  sessionRuns?(sessionId: string, snapshot: ReadonlyArray<RunSummary>): void
  view?(sessionId: string, envelope: unknown): void
  contextUsage?(sessionId: string, usage: unknown): void
}

export interface AgentClientLogger {
  info(event: string, details?: unknown): void
  warn(event: string, details?: unknown): void
  error(event: string, details?: unknown): void
}

export interface AgentClientOptions {
  spawn(): AgentChildLike
  /** Opaque init config forwarded to the host entry verbatim. */
  init: Record<string, unknown>
  push: AgentClientPush
  deps: AgentClientDeps
  crashLog: AgentClientLogger
  isQuitting(): boolean
  /** Fired after a respawn when a cached bind has been replayed. */
  onSessionRebound?(sessionId: string, result: AgentBridgeResult<BoundSession>): void
  respawnDelayMs?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** The AgentRuntime method surface, async over the relay. */
export interface AgentRuntimeClient {
  bindSession(input: BindSessionInput): Promise<AgentBridgeResult<BoundSession>>
  prompt(input: PromptInput): Promise<AgentBridgeResult<PromptResult>>
  abort(sessionId: string): Promise<{ ok: true }>
  compact(sessionId: string): Promise<{ ok: true }>
  fork(sessionId: string, targetSessionId: string): Promise<{ ok: true }>
  dispose(sessionId: string): Promise<{ ok: true }>
  disposeAll(): Promise<{ ok: true }>
  resolveApproval(input: ResolveApprovalInput): Promise<{ ok: true }>
  listSubagents(sessionId: string): Promise<ReadonlyArray<SubagentStatus>>
  cancelSubagent(parentSessionId: string, subagentId: string): Promise<{ ok: true; result?: SubagentStatus['result'] }>
  peekSubagent(parentSessionId: string, subagentId: string, lines?: number): Promise<SubagentPeek>
  listJobs(sessionId: string): Promise<ReadonlyArray<JobStatus>>
  listSessionRuns(sessionId: string): Promise<ReadonlyArray<RunSummary>>
  cancelJob(parentSessionId: string, jobId: string): Promise<{ ok: true }>
  peekJob(parentSessionId: string, jobId: string, lines?: number): Promise<JobPeek>
  /** Whether the utility child has been spawned (quit-sweep eligibility). */
  started(): boolean
}

export function createAgentRuntimeClient(options: AgentClientOptions): AgentRuntimeClient {
  const { spawn, push, deps, crashLog } = options
  const respawnDelayMs = options.respawnDelayMs ?? 500
  // F6: crash respawn uses exponential backoff with jitter, capped, and a
  // consecutive-crash circuit breaker. Failure scenario this closes: a child
  // that crashes at boot used to respawn every 500 ms forever, replaying all
  // bound sessions each cycle — a log- and CPU-spinning loop with no exit.
  const RESPAWN_BACKOFF_CAP_MS = 30_000
  const MAX_CONSECUTIVE_CRASHES = 5

  let child: AgentChildLike | null = null
  let bootPromise: Promise<void> | null = null
  let nextRequestId = 1
  const pendingRequests = new Map<number, PendingRequest>()
  /** sessionId → the BindSessionInput that created it (respawn replay). */
  const boundInputs = new Map<string, BindSessionInput>()
  /** child-generated ledger handle → the real ledger requestId. */
  const ledgerHandles = new Map<string, string>()
  let respawnTimer: ReturnType<typeof setTimeout> | null = null
  const readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
  /** Consecutive child exits without a successfully served response in between. */
  let consecutiveCrashes = 0
  /** Circuit-breaker open: the child crashed MAX_CONSECUTIVE_CRASHES times in
   *  a row; no further respawn is attempted and every call fails fast. */
  let fatal = false

  function ensureChild(): Promise<void> {
    if (fatal) return Promise.reject(new Error('Agent utility process crashed repeatedly and was not respawned; restart the app to reset the agent runtime'))
    if (!bootPromise) bootPromise = boot()
    return bootPromise
  }

  function boot(): Promise<void> {
    const spawned = spawn()
    child = spawned
    spawned.on('message', (message) => onMessage(message))
    spawned.on('exit', (code) => onExit(code))
    // Register the ready waiter BEFORE the init post: an in-process test
    // double (or a suspiciously fast child) can answer synchronously.
    const ready = new Promise<void>((resolve, reject) => {
      readyWaiters.push({ resolve, reject })
    })
    const clampedInit = clampForRelay({ t: 'init', config: options.init })
    spawned.postMessage(clampedInit.value)
    return ready
  }

  function onMessage(raw: unknown): void {
    const message = raw as RelayMessage
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') return
    switch (message.t) {
      case 'ready': {
        const waiters = readyWaiters.splice(0)
        for (const waiter of waiters) waiter.resolve()
        break
      }
      case 'res': {
        const pending = pendingRequests.get(message.id)
        if (!pending) return
        pendingRequests.delete(message.id)
        // F4: a response the child's relay clamp tombstoned is corrupt —
        // reject instead of resolving with a silently shortened payload.
        if (message.ok && findRelayClampMarker(message.v)) {
          pending.reject(new Error('Agent utility relay truncated the response; refusing corrupt data'))
          return
        }
        if (message.ok) {
          // The child is healthy enough to serve requests — reset the F6
          // consecutive-crash streak.
          consecutiveCrashes = 0
          pending.resolve(message.v)
        }
        else pending.reject(deserializeError(message.e, 'agent utility request failed'))
        break
      }
      case 'ev': {
        // F4: clamped push data is corrupt; never dispatch it to routing.
        if (findRelayClampMarker(message.a)) {
          crashLog.error('agent-client.push-clamped-marker', { kind: message.k })
          return
        }
        dispatchPush(message.k, message.a)
        break
      }
      case 'call': {
        // F4: reverse-call args clamped by the child's sender are corrupt —
        // answer with an error instead of dispatching a truncated call.
        if (findRelayClampMarker(message.a)) {
          child?.postMessage({
            t: 'cres',
            id: message.id,
            ok: false,
            e: serializeError(new Error('Agent utility relay truncated reverse-call arguments; refusing corrupt data')),
          })
          return
        }
        void dispatchDep(message)
        break
      }
      case 'ledger':
        applyLedger(message.op, message.a)
        break
      default:
        break
    }
  }

  function dispatchPush(kind: string, args: unknown[]): void {
    try {
      switch (kind) {
        case 'turnEvent':
          push.turnEvent(args[0] as string, args[1], args[2] as string | undefined)
          break
        case 'runsInvalidated':
          push.runsInvalidated?.(args[0] as string)
          break
        case 'subagents':
          push.subagents?.(args[0] as string, args[1] as ReadonlyArray<SubagentStatus>)
          break
        case 'jobs':
          push.jobs?.(args[0] as string, args[1] as ReadonlyArray<JobStatus>)
          break
        case 'sessionRuns':
          push.sessionRuns?.(args[0] as string, args[1] as ReadonlyArray<RunSummary>)
          break
        case 'view':
          push.view?.(args[0] as string, args[1])
          break
        case 'contextUsage':
          push.contextUsage?.(args[0] as string, args[1])
          break
        default:
          crashLog.warn('agent-client.unknown-push', { kind })
      }
    } catch (error) {
      // A renderer-routing bug must never unwind into the message pump.
      crashLog.warn('agent-client.push-handler-failed', { kind, error })
    }
  }

  async function dispatchDep(message: RelayCall): Promise<void> {
    // Echo the child's call id — its pending map is keyed by it.
    const id = message.id
    try {
      let value: unknown
      switch (message.m) {
        case 'resolveWorkspaceRoot':
          value = await deps.resolveWorkspaceRoot(message.a[0] as string)
          break
        case 'backendConnection':
          value = deps.backendConnection()
          break
        case 'credentialKeys':
          if (!deps.credentialKeys) throw new Error('credentialKeys is not wired')
          value = deps.credentialKeys()
          break
        case 'resolveModelMeta':
          if (!deps.resolveModelMeta) throw new Error('resolveModelMeta is not wired')
          value = await deps.resolveModelMeta(message.a[0] as string, message.a[1] as string)
          break
        case 'nodeCatalogInstaller':
          if (!deps.nodeCatalogInstaller) throw new Error('nodeCatalogInstaller is not wired')
          value = await deps.nodeCatalogInstaller(message.a[0] as string)
          break
        default:
          throw new Error(`agent-client: unknown reverse call ${String(message.m satisfies AgentDepMethod)}`)
      }
      child?.postMessage({ t: 'cres', id, ok: true, v: value })
    } catch (error) {
      child?.postMessage({ t: 'cres', id, ok: false, e: serializeError(error) })
    }
  }

  function applyLedger(op: string, args: unknown[]): void {
    try {
      const ledger = deps.usageLedger
      if (op === 'start') {
        const [handle, meta] = args as [{ requestId: string }, Parameters<UsageLedger['start']>[0]]
        const real = ledger.start(meta)
        ledgerHandles.set(handle.requestId, real.requestId)
      } else if (op === 'finish') {
        const [requestId, result] = args as [string, Parameters<UsageLedger['finish']>[1]]
        ledger.finish(ledgerHandles.get(requestId) ?? requestId, result)
        ledgerHandles.delete(requestId)
      } else if (op === 'recordError') {
        const [requestId, message, status, result] = args as [string, string, 'error' | 'aborted', Parameters<UsageLedger['recordError']>[3]]
        ledger.recordError(ledgerHandles.get(requestId) ?? requestId, new Error(message), status, result)
        ledgerHandles.delete(requestId)
      }
    } catch (error) {
      // Accounting must never take down the relay.
      crashLog.warn('agent-client.ledger-op-failed', { op, error })
    }
  }

  async function call(method: AgentHostMethod, args: unknown[]): Promise<unknown> {
    // Teardown calls must pass even after quitting started — the before-quit
    // sweep itself runs disposeAll/dispose under appIsQuitting.
    const isTeardown = method === 'disposeAll' || method === 'dispose' || method === 'abort'
    if (options.isQuitting() && !isTeardown) throw new Error('App is quitting; agent runtime is unavailable')
    await ensureChild()
    const id = nextRequestId++
    const clamped = clampForRelay(args)
    // F5: never transmit clamped/dropped args as if intact. Failure scenario:
    // a prompt whose message was clamped at the relay cap used to arrive as a
    // silently truncated string — the model answered a different question and
    // nobody could tell. Dropped (tombstoned) args reject for EVERY method;
    // prompt/bindSession additionally reject on any truncation, because their
    // payloads are conversation truth and a shortened copy is corrupt.
    if (clamped.dropped) {
      crashLog.error('agent-client.request-dropped', { method })
      throw new Error(`agent-client: ${method} arguments exceeded the relay message cap and were dropped; refusing to send corrupt data`)
    }
    if (clamped.truncated && (method === 'prompt' || method === 'bindSession')) {
      crashLog.error('agent-client.request-truncated', { method })
      throw new Error(`agent-client: ${method} arguments were truncated by the relay clamp; refusing to send corrupt data`)
    }
    if (clamped.truncated) crashLog.warn('agent-client.request-clamped', { method, dropped: clamped.dropped })
    return new Promise<unknown>((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject })
      // The child can exit between the awaited ensureChild() above and this
      // synchronous post (its onExit already rejected the previous pending
      // set) — fail fast instead of posting into a dead process handle.
      if (!child) {
        pendingRequests.delete(id)
        reject(new Error('Agent utility process is not running'))
        return
      }
      child.postMessage({ t: 'req', id, m: method, a: clamped.value as unknown[] })
    })
  }

  function onExit(code: number): void {
    crashLog.error('agent-client.child-exit', { code, pending: pendingRequests.size })
    const error = new Error(`Agent utility process exited (code ${code})`)
    for (const pending of pendingRequests.values()) pending.reject(error)
    pendingRequests.clear()
    const waiters = readyWaiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
    child = null
    bootPromise = null
    // F8: settle in-flight ledger rows before dropping the handle map —
    // otherwise the turn's tokens vanish from stats and main's ledger pending
    // map leaks the entry forever (no child-side finish will ever arrive).
    for (const realRequestId of ledgerHandles.values()) {
      try {
        deps.usageLedger.recordError(
          realRequestId,
          new Error('Agent utility process exited before usage was reported'),
          'aborted',
        )
      } catch (settleError) {
        crashLog.warn('agent-client.ledger-settle-failed', { realRequestId, error: settleError })
      }
    }
    ledgerHandles.clear()
    if (options.isQuitting()) return
    // F6 circuit breaker: count crashes that happened without one successfully
    // served response in between; after the cap, stop respawning for good.
    consecutiveCrashes += 1
    if (consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      fatal = true
      crashLog.error('agent-client.fatal-no-respawn', {
        code,
        consecutiveCrashes,
        sessions: boundInputs.size,
        message: 'Agent utility process crashed repeatedly; giving up on respawn. Restart the app to reset the agent runtime.',
      })
      return
    }
    // F6: exponential backoff with jitter (base × 2^streak, capped, ×1..1.25
    // jitter) instead of a fixed delay — a crash loop must not hot-cycle.
    const delayMs = Math.round(
      Math.min(respawnDelayMs * 2 ** (consecutiveCrashes - 1), RESPAWN_BACKOFF_CAP_MS) * (1 + Math.random() * 0.25),
    )
    crashLog.info('agent-client.respawn-scheduled', { delayMs, consecutiveCrashes, sessions: boundInputs.size })
    if (respawnTimer) clearTimeout(respawnTimer)
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      void ensureChild()
        .then(() => replayBindings())
        .catch((respawnError) => crashLog.error('agent-client.respawn-failed', respawnError))
    }, delayMs)
  }

  async function replayBindings(): Promise<void> {
    for (const [sessionId, input] of boundInputs) {
      try {
        const result = (await call('bindSession', [input])) as AgentBridgeResult<BoundSession>
        options.onSessionRebound?.(sessionId, result)
        if (!result.ok) crashLog.warn('agent-client.rebind-failed', { sessionId, code: result.code })
      } catch (error) {
        crashLog.warn('agent-client.rebind-failed', { sessionId, error })
      }
    }
  }

  const client: AgentRuntimeClient = {
    bindSession: async (input) => {
      const result = (await call('bindSession', [input])) as AgentBridgeResult<BoundSession>
      if (result.ok) boundInputs.set(input.sessionId, input)
      return result
    },
    prompt: (input) => call('prompt', [input]) as Promise<AgentBridgeResult<PromptResult>>,
    abort: (sessionId) => call('abort', [sessionId]) as Promise<{ ok: true }>,
    compact: (sessionId) => call('compact', [sessionId]) as Promise<{ ok: true }>,
    fork: (sessionId, targetSessionId) => call('fork', [sessionId, targetSessionId]) as Promise<{ ok: true }>,
    dispose: async (sessionId) => {
      boundInputs.delete(sessionId)
      return call('dispose', [sessionId]) as Promise<{ ok: true }>
    },
    disposeAll: () => call('disposeAll', []) as Promise<{ ok: true }>,
    resolveApproval: (input) => call('resolveApproval', [input]) as Promise<{ ok: true }>,
    listSubagents: (sessionId) => call('listSubagents', [sessionId]) as Promise<ReadonlyArray<SubagentStatus>>,
    cancelSubagent: (parentSessionId, subagentId) =>
      call('cancelSubagent', [parentSessionId, subagentId]) as Promise<{ ok: true; result?: SubagentStatus['result'] }>,
    peekSubagent: (parentSessionId, subagentId, lines) =>
      call('peekSubagent', [parentSessionId, subagentId, lines]) as Promise<SubagentPeek>,
    listJobs: (sessionId) => call('listJobs', [sessionId]) as Promise<ReadonlyArray<JobStatus>>,
    listSessionRuns: (sessionId) => call('listSessionRuns', [sessionId]) as Promise<ReadonlyArray<RunSummary>>,
    cancelJob: (parentSessionId, jobId) => call('cancelJob', [parentSessionId, jobId]) as Promise<{ ok: true }>,
    peekJob: (parentSessionId, jobId, lines) =>
      call('peekJob', [parentSessionId, jobId, lines]) as Promise<JobPeek>,
    started: () => child !== null || bootPromise !== null,
  }
  return client
}
