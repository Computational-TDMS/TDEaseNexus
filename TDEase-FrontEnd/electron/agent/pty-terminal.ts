/**
 * PtyTerminalService — owner-scoped persistent PTY registry (the TDEase port
 * of `@deepseek-ai/dsh-terminal`'s TerminalSessionService).
 *
 * Backends own terminal mechanics (node-pty allocation, escape sanitizing,
 * scrollback, readiness); this service owns ids, publication, owner scoping
 * and awaited cleanup. One service instance lives per agent session (created
 * in AgentRuntime.bindSession, disposed in AgentRuntime.dispose), so the
 * "owner" of every session it holds is exactly that agent session.
 *
 * API surface mirrors DSH so the port stays comparable:
 *   spawn(owner, request, signal?) -> published snapshot + motd
 *   startSend(owner, id, request)  -> exclusive interactive send
 *   read(owner, id, request?)      -> bounded scrollback page
 *   signal(owner, id, signal)      -> deliver a signal to the session
 *   kill(owner, id, reason)        -> close and remove after quiescent cleanup
 *   list(owner)                    -> fresh snapshots
 *   disposeAll()                   -> close everything (runtime teardown)
 */

export type TerminalWaitReason = 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit'

export type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

export type TerminalSessionStatus =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null; signal: string | null }

export interface TerminalSendRequest {
  /** UTF-8 text to write. */
  text: string
  /** Whether to write the backend's Enter sequence after `text`. */
  submit: boolean
  /** Cancellation for the wait; backends also interrupt the foreground command. */
  signal?: AbortSignal
}

export interface TerminalSendRead {
  /** Output produced since the previous operation read. */
  delta: string
  /** Whether unread operation output was dropped by the backend's bound. */
  truncated: boolean
}

export interface TerminalSendResult {
  /** Bounded rendered terminal delta remaining at settlement. */
  viewport: string
  /** Why the wait returned; this does not imply arbitrary child-process exit. */
  waitReason: TerminalWaitReason
  /** Top-level session status observed at settlement. */
  sessionStatus: TerminalSessionStatus
  /** Whether output was dropped from the operation or retained scrollback. */
  truncated: boolean
}

export interface TerminalSendOperation {
  /** Resolves after readiness, timeout, cancellation, or top-level process exit. */
  done: Promise<TerminalSendResult>
  /** Consume output produced since the prior call. */
  readOutput(): TerminalSendRead
  /** Request an interrupt; returns false after the operation settled. */
  cancel(): boolean
}

export interface TerminalReadRequest {
  /** Offset from the newest retained line; defaults are backend-owned. */
  offset?: number
  /** Requested line count; backend limits still apply. */
  count?: number
}

export interface TerminalReadResult {
  /** Retained text in chronological order. */
  text: string
  /** Number of lines currently retained. */
  totalLines: number
  /** Inclusive newest-relative offset of the first returned line. */
  lineBegin: number
  /** Exclusive newest-relative offset after the returned page. */
  lineEnd: number
  /** Whether older retained output or the requested result exceeded a bound. */
  truncated: boolean
}

export interface TerminalSignalResult {
  /** True only after the backend delivered the signal. */
  delivered: true
  /** Process group that received the signal, when the backend can name it. */
  targetPgid?: number
}

export interface TerminalSessionSnapshot {
  /** Registry-minted identity used by every operation. */
  sessionId: string
  /** Backend type that created the session. */
  type: string
  /** Top-level process id when the backend has one. */
  pid?: number
  /** Current top-level process status. */
  status: TerminalSessionStatus
}

export interface TerminalBackendSession {
  /** Backend type that created the session. */
  readonly type: string
  /** Initial bounded terminal output captured before publication. */
  readonly motd: string
  /** Top-level process id when one exists. */
  readonly pid?: number
  /** Start one exclusive send operation. */
  startSend(request: TerminalSendRequest): TerminalSendOperation
  /** Read one bounded page from retained scrollback. */
  read(request: TerminalReadRequest): TerminalReadResult
  /** Signal the session (POSIX: foreground group; Windows: control chars). */
  signal(signal: TerminalSignal): Promise<TerminalSignalResult>
  /** Observe top-level process status. */
  status(): TerminalSessionStatus
  /** Idempotently close the captured owned process and await quiescence. */
  close(reason: string): Promise<void>
}

export interface TerminalSpawnRequest {
  /** Registered backend type. */
  type: string
  /** Optional initial working directory interpreted by the backend. */
  cwd?: string
}

export interface TerminalBackendSpawnSpec extends TerminalSpawnRequest {
  /** Registry-minted session identity. */
  sessionId: string
  /** Cancellation of unpublished backend setup. */
  signal?: AbortSignal
}

export interface TerminalBackend {
  /** Stable type selected by `TerminalSpawnRequest.type`. */
  readonly type: string
  /** Create an unpublished session or reject after cleaning partial resources. */
  spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession>
}

export interface TerminalSpawnResult extends TerminalSessionSnapshot {
  /** Initial bounded output captured before publication. */
  motd: string
}

/** Error carrying a stable terminal error code. */
export class TerminalError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'TerminalError'
    this.code = code
  }
}

interface SessionRecord {
  id: string
  owner: string
  session: TerminalBackendSession
  active?: TerminalSendOperation
  closing?: Promise<void>
}

export class PtyTerminalService {
  private backends = new Map<string, TerminalBackend>()
  private sessions = new Map<string, SessionRecord>()
  private nextId = 0
  private disposing = false

  /** Register one backend type for this service instance. */
  registerBackend(backend: TerminalBackend): void {
    if (backend.type.length === 0) throw new Error('pty backend type must be non-empty')
    if (this.backends.has(backend.type)) {
      throw new TerminalError(`a PTY backend named "${backend.type}" is already registered`, 'DUPLICATE_BACKEND')
    }
    this.backends.set(backend.type, backend)
  }

  listBackends(): string[] {
    return [...this.backends.keys()]
  }

  /**
   * Create and publish one owner-scoped session after backend setup succeeds.
   * @param owner - the agent session that owns access and cleanup.
   * @param request - backend type plus optional cwd.
   * @param signal - cancellation of unpublished setup.
   */
  async spawn(owner: string, request: TerminalSpawnRequest, signal?: AbortSignal): Promise<TerminalSpawnResult> {
    if (this.disposing) throw new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING')
    signal?.throwIfAborted()
    const backend = this.backends.get(request.type)
    if (backend === undefined) throw new TerminalError(`no PTY backend registered for "${request.type}"`, 'NO_BACKEND')
    const sessionId = `pty-${++this.nextId}`
    const session = await backend.spawn({
      sessionId,
      type: request.type,
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      signal,
    })
    if (this.disposing) {
      await session.close('PTY service is disposing').catch(() => undefined)
      throw new TerminalError('PTY service is disposing', 'SERVICE_DISPOSING')
    }
    const record: SessionRecord = { id: sessionId, owner, session }
    this.sessions.set(sessionId, record)
    return {
      sessionId,
      type: request.type,
      ...(session.pid !== undefined ? { pid: session.pid } : {}),
      status: session.status(),
      motd: session.motd,
    }
  }

  hasOwnerActivity(owner: string): boolean {
    return [...this.sessions.values()].some((record) => record.owner === owner)
  }

  /** Start one exclusive interactive send on an owned session. */
  startSend(owner: string, id: string, request: TerminalSendRequest): TerminalSendOperation {
    const record = this.expectOwned(owner, id)
    if (record.closing !== undefined) throw new Error(`PTY session ${id} is closing`)
    if (record.active !== undefined) throw new TerminalError(`PTY session ${id} already has an active send`, 'SEND_ACTIVE')
    const operation = record.session.startSend(request)
    record.active = operation
    operation.done.then(
      () => { record.active = undefined },
      () => { record.active = undefined },
    )
    return operation
  }

  /** Read one bounded scrollback page from an owned session. */
  read(owner: string, id: string, request: TerminalReadRequest = {}): TerminalReadResult {
    return this.expectOwned(owner, id).session.read(request)
  }

  /** Deliver an allowed signal through an owned backend session. */
  signal(owner: string, id: string, signal: TerminalSignal): Promise<TerminalSignalResult> {
    return this.expectOwned(owner, id).session.signal(signal)
  }

  /** Close one owned session and remove it only after quiescent backend cleanup. */
  async kill(owner: string, id: string, reason = 'model request'): Promise<boolean> {
    const record = this.expectOwned(owner, id)
    if (record.closing !== undefined) {
      await record.closing
      return false
    }
    const closing = record.session.close(reason)
    record.closing = closing
    try {
      await closing
      this.sessions.delete(id)
      return true
    } catch (error) {
      record.closing = undefined
      throw error
    }
  }

  /** List fresh snapshots for exactly one owner. */
  list(owner: string): TerminalSessionSnapshot[] {
    return [...this.sessions.values()]
      .filter((record) => record.owner === owner)
      .map((record) => this.snapshot(record))
  }

  private expectOwned(owner: string, id: string): SessionRecord {
    const record = this.sessions.get(id)
    if (record === undefined) throw new TerminalError(`unknown PTY session ${id}`, 'NO_SESSION')
    if (record.owner !== owner) throw new TerminalError(`PTY session ${id} belongs to another owner`, 'FOREIGN_SESSION')
    return record
  }

  private snapshot(record: SessionRecord): TerminalSessionSnapshot {
    return {
      sessionId: record.id,
      type: record.session.type ?? 'unknown',
      ...(record.session.pid !== undefined ? { pid: record.session.pid } : {}),
      status: record.session.status(),
    }
  }

  /** Close every session (agent-session teardown). */
  async disposeAll(): Promise<void> {
    this.disposing = true
    const records = [...this.sessions.values()]
    const failures: unknown[] = []
    for (const record of records) {
      try {
        await record.session.close('PTY service disposed')
        this.sessions.delete(record.id)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'failed to dispose PTY sessions')
  }
}
