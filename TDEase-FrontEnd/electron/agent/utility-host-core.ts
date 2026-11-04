/**
 * Host side of the agent utility-process relay, as a pure attachable session.
 *
 * createAgentHost() wires an AgentRuntime to a port in two phases (the push
 * callbacks exist before the runtime, but parent-session routing needs the
 * runtime — a late-bound accessor closes the cycle):
 *  - the returned `push` is handed to createAgentRuntime() by the entry;
 *  - attach(runtime) then dispatches RelayRequest messages to runtime methods
 *    (the entire ipcMain agent surface, unchanged in shape);
 *  - the runtime's RuntimePush fans out as RelayEvent messages — turnEvent
 *    additionally carries the PARENT session id, resolved child-side, because
 *    main's owner-map routing needs it and must not make a round-trip per event;
 *  - main-owned dependencies (workspace registry, model metadata,
 *    node-catalog install) are exposed as reverse calls over the port;
 *  - the usage ledger is proxied: the requestId is generated child-side (the
 *    ledger treats it as an opaque handle) and start/finish/recordError are
 *    replayed on main's single ledger instance in arrival order, so usage rows
 *    keep landing in the file the renderer's StatisticsPanel reads.
 *
 * utility-host.ts is the thin utilityProcess entry that adapts
 * process.parentPort to HostPort and constructs the runtime; everything here
 * is unit-testable against an in-memory port pair.
 */
import { randomUUID } from 'node:crypto'

import type { UsageLedger } from '../../src/ai/core/usage-ledger'
import type { AgentRuntime, BackendConnection } from './agent-runtime'
import type { RuntimePush } from './contracts'
import {
  clampForRelay,
  deserializeError,
  findRelayClampMarker,
  serializeError,
  type AgentDepMethod,
  type AgentPushKind,
  type RelayCall,
  type RelayMessage,
} from './utility-protocol'

/** Minimal ordered message port (utilityProcess parentPort, or a test double). */
export interface HostPort {
  post(message: unknown): void
  onMessage(listener: (message: unknown) => void): void
}

/** Reverse-call surface into main-owned state. backendConnection is a
 * snapshot request; see createAgentHost for the sync cache it feeds. */
export interface HostMainDeps {
  resolveWorkspaceRoot(workspaceId: string): Promise<string>
  backendConnection(): Promise<BackendConnection>
  resolveModelMeta?(providerId: string, modelId: string): Promise<unknown>
  nodeCatalogInstaller?(sourceDir: string): Promise<unknown>
  /** providerId → decrypted safeStorage keys (main-only capability). */
  credentialKeys?(): Promise<Record<string, string>>
}

export interface HostLogger {
  info(event: string, details?: unknown): void
  warn(event: string, details?: unknown): void
  error(event: string, details?: unknown): void
}

export interface AgentHostOptions {
  port: HostPort
  logger?: HostLogger
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export function createAgentHost(options: AgentHostOptions): {
  push: RuntimePush
  ledger: UsageLedger
  /** Sync read of the latest backend-connection snapshot. */
  backendConnection: () => BackendConnection
  /** Sync decrypted-key read (latest credentialKeys snapshot). */
  credentialKey: (providerId: string) => string | null
  /** Reverse RPC into main-owned state (workspace registry, model metadata…). */
  call(method: AgentDepMethod, args: unknown[]): Promise<unknown>
  attach(runtime: AgentRuntime): { dispose(): void }
} {
  const { port } = options
  const logger: HostLogger = options.logger ?? consoleLogger
  let nextCallId = 1
  const pendingCalls = new Map<number, PendingCall>()
  let backendSnapshot: BackendConnection | null = null
  // Same snapshot pattern as backendSnapshot: refreshed ahead of every host
  // request so the registry's SYNC resolve() sees the user's latest key edit
  // (safeStorage lives only in main; the utility child asks, never reads).
  let credentialSnapshot: Record<string, string> = {}
  let parentSessionOf: ((childSessionId: string) => string | undefined) | null = null

  function callMain(method: AgentDepMethod, args: unknown[]): Promise<unknown> {
    const id = nextCallId++
    return new Promise((resolve, reject) => {
      pendingCalls.set(id, { resolve, reject })
      port.post({ t: 'call', id, m: method, a: args } satisfies RelayCall)
    })
  }

  /** F7: snapshot refreshes are AWAITED (bounded by REFRESH_TIMEOUT_MS) ahead
   * of each host request. Failure scenario they close: the old fire-and-forget
   * refresh raced the dispatch — bindSession/prompt ran against a stale backend
   * URL or stale credentials right after the user edited Settings, because the
   * request was dispatched in the same tick the refresh was still in flight. */
  function refreshBackendConnection(): Promise<void> {
    return settleWithinTimeout(
      callMain('backendConnection', [])
        .then((snapshot) => { backendSnapshot = snapshot as BackendConnection }),
      'backendConnection',
      logger,
    )
  }

  function refreshCredentialKeys(): Promise<void> {
    return settleWithinTimeout(
      callMain('credentialKeys', [])
        .then((snapshot) => { if (snapshot && typeof snapshot === 'object') credentialSnapshot = snapshot as Record<string, string> }),
      'credentialKeys',
      logger,
    )
  }

  function pushEvent(kind: AgentPushKind, args: unknown[]): void {
    const clamped = clampForRelay({ t: 'ev', k: kind, a: args })
    if (clamped.truncated) logger.warn('agent-host.push-clamped', { kind, dropped: clamped.dropped })
    port.post(clamped.value)
  }

  const push: RuntimePush = {
    turnEvent: (sessionId, event) => {
      // Parent routing resolved child-side: main's owner map only knows parent
      // sessions, and a per-event reverse lookup would be async.
      pushEvent('turnEvent', [sessionId, event, parentSessionOf?.(sessionId)])
    },
    runsInvalidated: (workspaceId) => pushEvent('runsInvalidated', [workspaceId]),
    subagents: (sessionId, snapshot) => pushEvent('subagents', [sessionId, snapshot]),
    jobs: (sessionId, snapshot) => pushEvent('jobs', [sessionId, snapshot]),
    sessionRuns: (sessionId, snapshot) => pushEvent('sessionRuns', [sessionId, snapshot]),
    view: (sessionId, envelope) => pushEvent('view', [sessionId, envelope]),
    contextUsage: (sessionId, usage) => pushEvent('contextUsage', [sessionId, usage]),
  }

  const ledger: UsageLedger = {
    // requestId is an opaque handle end to end; generating it child-side keeps
    // start() synchronous while the op replays on main's ledger in order.
    start: (meta) => {
      const handle = { requestId: randomUUID(), startedAt: new Date().toISOString() }
      sendLedger('start', [handle, meta])
      return handle
    },
    finish: (requestId, result) => { sendLedger('finish', [requestId, result]); return null },
    recordError: (requestId, error, status, result) => {
      sendLedger('recordError', [requestId, error instanceof Error ? error.message : String(error), status, result])
      return null
    },
    list: () => [],
    subscribe: () => () => undefined,
    clear: () => undefined,
    flush: () => undefined,
  }

  function sendLedger(op: 'start' | 'finish' | 'recordError', args: unknown[]): void {
    const clamped = clampForRelay({ t: 'ledger', op, a: args })
    if (clamped.truncated) logger.warn('agent-host.ledger-clamped', { op })
    port.post(clamped.value)
  }

  function respond(id: number, ok: boolean, value: unknown): void {
    if (!ok) {
      port.post({ t: 'res', id, ok: false, e: serializeError(value) })
      return
    }
    const clamped = clampForRelay(value)
    if (clamped.truncated) logger.warn('agent-host.response-clamped', { id, dropped: clamped.dropped })
    port.post({ t: 'res', id, ok: true, v: clamped.value })
  }

  function attach(runtime: AgentRuntime): { dispose(): void } {
    parentSessionOf = (childSessionId) => runtime.parentSessionOf(childSessionId)

    async function dispatch(method: string, args: unknown[]): Promise<unknown> {
      const target = (runtime as unknown as Record<string, (...callArgs: unknown[]) => unknown>)[method]
      if (typeof target !== 'function') throw new Error(`agent-host: unknown method ${String(method)}`)
      return target.apply(runtime, args)
    }

    port.onMessage((raw) => {
      const message = raw as RelayMessage
      if (!message || typeof message !== 'object' || typeof message.t !== 'string') return
      if (message.t === 'req') {
        // F4: request args clamped by main's sender carry a tombstone —
        // answer with an error instead of dispatching corrupt input.
        if (findRelayClampMarker(message.a)) {
          respond(message.id, false, new Error('Agent utility relay truncated the request arguments; refusing corrupt data'))
          return
        }
        // Refresh the backend snapshot ahead of every request: bindSession and
        // run dispatch read it synchronously inside the child. Credential keys
        // ride the same refresh so a Settings key edit applies from the next
        // turn on, exactly like a plaintext settings.json edit always did.
        // F7: both refreshes are AWAITED (with a timeout) so the request never
        // dispatches on the stale snapshot it was supposed to replace.
        void Promise.all([refreshBackendConnection(), refreshCredentialKeys()])
          .then(() => dispatch(message.m, message.a))
          .then((value) => respond(message.id, true, value))
          .catch((error: unknown) => respond(message.id, false, error))
        return
      }
      if (message.t === 'cres') {
        const pending = pendingCalls.get(message.id)
        if (!pending) return
        pendingCalls.delete(message.id)
        // F4: a clamped reverse-call result is corrupt — reject it.
        if (message.ok && findRelayClampMarker(message.v)) {
          pending.reject(new Error('Agent utility relay truncated the reverse-call result; refusing corrupt data'))
          return
        }
        if (message.ok) pending.resolve(message.v)
        else pending.reject(deserializeError(message.e, `agent-host reverse call failed`))
      }
    })

    return {
      dispose() {
        for (const pending of pendingCalls.values()) {
          pending.reject(new Error('agent-host session disposed'))
        }
        pendingCalls.clear()
      },
    }
  }

  // Seed the backend snapshot immediately; until it lands the sync read throws
  // exactly like main's backendConnectionInfo() does before the backend is up.
  void refreshBackendConnection()
  void refreshCredentialKeys()

  return {
    push,
    ledger,
    backendConnection: () => {
      if (!backendSnapshot) throw new Error('Backend connection is not ready')
      return backendSnapshot
    },
    credentialKey: (providerId: string) => credentialSnapshot[providerId] ?? null,
    call: callMain,
    attach,
  }
}

const consoleLogger: HostLogger = {
  info: () => undefined,
  warn: (event, details) => console.warn(`[agent-host] ${event}`, details ?? ''),
  error: (event, details) => console.error(`[agent-host] ${event}`, details ?? ''),
}

/** F7 bound for snapshot refreshes: a hung main must not hang the request. */
const REFRESH_TIMEOUT_MS = 5_000

/** Resolve when the refresh settles OR the timeout fires — whichever first.
 *  Failures (and timeouts) are logged, never thrown: the request then runs on
 *  the last good snapshot, which is the pre-F7 behavior as a fallback. */
function settleWithinTimeout(work: Promise<void>, dep: string, logger: HostLogger): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('agent-host.refresh-timeout', { dep, timeoutMs: REFRESH_TIMEOUT_MS })
      resolve()
    }, REFRESH_TIMEOUT_MS)
    work.then(
      () => { clearTimeout(timer); resolve() },
      (error) => {
        clearTimeout(timer)
        logger.warn('agent-host.refresh-failed', { dep, error })
        resolve()
      },
    )
  })
}
