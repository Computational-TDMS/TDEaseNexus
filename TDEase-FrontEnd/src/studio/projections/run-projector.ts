import { EXECUTION_MODES, runStatusForEvent, type ExecutionMode, type ExecutionRange, type RunEvent, type RunStatus, type RunSummary } from '../domain/run'

export interface ProjectedExecutionRange extends ExecutionRange {
  queueSeq: number
  revisionId: string
  mode: ExecutionMode
}

export interface RunProjection {
  run: RunSummary
  lifecycleStatus: RunStatus | null
  currentRevisionId: string | null
  queuedMode: ExecutionMode | null
  queuedAtSeq: number | null
  ranges: ReadonlyArray<ProjectedExecutionRange>
}

type ProjectionState = {
  status: RunStatus | null
  currentRevisionId: string | null
  queuedMode: ExecutionMode | null
  queuedAtSeq: number | null
  pendingQueue: { seq: number; revisionId: string; mode: ExecutionMode } | null
  ranges: ReadonlyArray<ProjectedExecutionRange>
}

function requiredString(event: Pick<RunEvent, 'type' | 'data'>, field: string): string {
  const value = event.data?.[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${event.type} missing required data: ${field}`)
  }
  return value
}

function executionMode(event: Pick<RunEvent, 'type' | 'data'>): ExecutionMode {
  const mode = requiredString(event, 'mode')
  if (!(EXECUTION_MODES as ReadonlyArray<string>).includes(mode)) {
    throw new Error(`${event.type} has invalid execution mode: ${mode}`)
  }
  return mode as ExecutionMode
}

function advance(state: ProjectionState, event: Pick<RunEvent, 'type' | 'seq' | 'data'>): ProjectionState {
  if (event.type === 'run.submitted') {
    return { ...state, currentRevisionId: requiredString(event, 'revision_id') }
  }

  const status = runStatusForEvent(event.type)
  if (!status) return state
  const revisionId = requiredString(event, 'revision_id')

  if (event.type === 'run.queue_requested') {
    const mode = executionMode(event)
    const lastRange = state.ranges.at(-1)
    const running = lastRange != null && lastRange.terminalSeq == null
    return {
      ...state,
      // A request that arrives while an execution runs is pending behind it:
      // the projected status stays RUNNING until that range terminates.
      status: running ? state.status : status,
      currentRevisionId: revisionId,
      queuedMode: mode,
      queuedAtSeq: event.seq,
      pendingQueue: { seq: event.seq, revisionId, mode },
    }
  }

  if (event.type === 'run.started') {
    const mode = executionMode(event)
    if (!state.pendingQueue) throw new Error('run.started requires a preceding run.queue_requested')
    if (state.pendingQueue.revisionId !== revisionId || state.pendingQueue.mode !== mode) {
      throw new Error('run.started does not match its queue request')
    }
    const lastRange = state.ranges.at(-1)
    if (lastRange && lastRange.terminalSeq == null) throw new Error('run.started cannot overlap an open execution range')
    return {
      ...state,
      status,
      currentRevisionId: revisionId,
      queuedMode: null,
      queuedAtSeq: null,
      pendingQueue: null,
      ranges: [...state.ranges, {
        queueSeq: state.pendingQueue.seq,
        startSeq: event.seq,
        revisionId,
        mode,
        terminalSeq: null,
        terminalType: null,
      }],
    }
  }

  const last = state.ranges.at(-1)
  const hadOpenRange = last != null && last.terminalSeq == null
  const activeRevision = hadOpenRange ? last.revisionId : state.currentRevisionId
  if (activeRevision != null && revisionId !== activeRevision) {
    throw new Error(`${event.type} revision does not match the active revision`)
  }
  const ranges = hadOpenRange
    ? [...state.ranges.slice(0, -1), { ...last, terminalSeq: event.seq, terminalType: event.type }]
    : state.ranges
  if (hadOpenRange && state.pendingQueue) {
    // A definition was queued while this execution ran: the Run is queued for
    // it, not terminal. The finished execution keeps its own range. A queue
    // request with no execution in flight (pre-launch validation) keeps the
    // ordinary terminal projection below.
    return { ...state, status: 'QUEUED', ranges }
  }
  return { ...state, status, queuedMode: null, queuedAtSeq: null, pendingQueue: null, ranges }
}

export function applyRunEvent(projection: RunProjection, event: RunEvent): RunProjection {
  if (event.runId !== projection.run.id || event.seq <= projection.run.lastEventSeq) return projection

  const next = advance({
    status: projection.lifecycleStatus,
    currentRevisionId: projection.currentRevisionId,
    queuedMode: projection.queuedMode,
    queuedAtSeq: projection.queuedAtSeq,
    pendingQueue: projection.queuedMode && projection.currentRevisionId && projection.queuedAtSeq != null
      ? { seq: projection.queuedAtSeq, revisionId: projection.currentRevisionId, mode: projection.queuedMode }
      : null,
    ranges: projection.ranges,
  }, event)
  return {
    run: {
      ...projection.run,
      ...(next.status ? { status: next.status } : {}),
      ...(next.currentRevisionId ? { currentRevision: next.currentRevisionId } : {}),
      lastEventSeq: event.seq,
    },
    lifecycleStatus: next.status,
    currentRevisionId: next.currentRevisionId,
    queuedMode: next.queuedMode,
    queuedAtSeq: next.queuedAtSeq,
    ranges: next.ranges,
  }
}
