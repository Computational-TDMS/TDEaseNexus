import type {
  EvidenceEntityProjection,
  EvidenceProjection,
  EvidenceRelationProjection,
  EvidenceTurnProjection,
  EvidenceVerificationProjection,
} from '@/services/workspace/workspaceEvidence'
import type { JsonValue, SessionEvent, TurnOutcome } from './vocabulary'

export type ScientificOpsStatus =
  | 'idle'
  | 'exploring'
  | 'blocked'
  | 'resolved'
  | 'halted'
  | 'failed'
  | 'cancelled'

export type ScientificOpsSource =
  | { kind: 'session-event'; sessionId: string; seq: number; turnId: string }
  | { kind: 'run-file'; path: string }
  | { kind: 'evidence'; path: string; claimRef: string }

export interface RunFileFact {
  path: string
  runPath: string
  role?: 'input' | 'output' | 'unknown'
  sha256?: string
  size?: number
}

export interface ScientificOpsInput {
  sessionId: string
  events: ReadonlyArray<SessionEvent>
  evidence: ReadonlyArray<EvidenceProjection>
  runFiles: ReadonlyArray<RunFileFact>
}

export type ExplorationItem =
  | {
      kind: 'question'
      text: string
      mindset: string
      source: Extract<ScientificOpsSource, { kind: 'session-event' }>
    }
  | {
      kind: 'activity'
      callId: string
      toolName: string
      status: 'running' | 'completed' | 'failed'
      resultRef?: string
      error?: { code: string; message: string }
      source: Extract<ScientificOpsSource, { kind: 'session-event' }>
    }

export interface ScientificEvidenceItem {
  projection: EvidenceProjection
  observedInSession: boolean
  source: Extract<ScientificOpsSource, { kind: 'evidence' }>
}

export type ScientificReasoningItem =
  | {
      kind: 'interpretation'
      text: string
      source: Extract<ScientificOpsSource, { kind: 'session-event' }>
    }
  | {
      kind: 'claim-transition'
      relation: EvidenceRelationProjection
      relatedClaimPresent: boolean
      source: Extract<ScientificOpsSource, { kind: 'evidence' }>
    }

export interface ClaimProvenanceView {
  path: string
  claimRef: string
  activity: EvidenceProjection['activity']
  entities: ReadonlyArray<EvidenceEntityProjection>
  relations: ReadonlyArray<EvidenceRelationProjection>
  verification: EvidenceVerificationProjection
  turn?: EvidenceTurnProjection
  source: Extract<ScientificOpsSource, { kind: 'evidence' }>
}

export interface RunFileView extends RunFileFact {
  citedBy: ReadonlyArray<string>
  source: Extract<ScientificOpsSource, { kind: 'run-file' }>
}

export interface ScientificOpsProjection {
  sessionId: string
  activeTurnId?: string
  status: ScientificOpsStatus
  exploration: ReadonlyArray<ExplorationItem>
  evidence: ReadonlyArray<ScientificEvidenceItem>
  reasoning: ReadonlyArray<ScientificReasoningItem>
  provenance: ReadonlyArray<ClaimProvenanceView>
  runFiles: ReadonlyArray<RunFileView>
  metrics: {
    toolCalls: number
    claimTransitions: number
    wallClockMs: number
  }
}

interface MutableActivity extends Omit<Extract<ExplorationItem, { kind: 'activity' }>, 'source'> {
  requestSeq: number
  turnId: string
  sourceSeq: number
}

interface TurnState {
  turnId: string
  settled?: ScientificOpsStatus
}

/**
 * Builds a disposable scientific-operations view from already loaded facts.
 * It intentionally has no ports: callers perform validation and I/O before
 * invoking it.
 */
export function projectScientificOps(input: ScientificOpsInput): ScientificOpsProjection {
  validateSessionId(input.sessionId)
  const questions: ExplorationItem[] = []
  const interpretations: ScientificReasoningItem[] = []
  const activities = new Map<string, MutableActivity>()
  const turns = new Map<string, TurnState>()
  const observedEvidencePaths = new Set<string>()
  let latestTurn: TurnState | undefined
  let previousSeq = 0
  let toolCalls = 0
  let wallClockMs = 0

  for (const event of input.events) {
    if (event.seq !== previousSeq + 1) {
      throw new Error(`Scientific Ops requires contiguous session events; expected ${previousSeq + 1}, received ${event.seq}`)
    }
    previousSeq = event.seq

    switch (event.type) {
      case 'turn.started': {
        if (turns.has(event.turn_id)) throw new Error(`Duplicate turn.started for ${event.turn_id}`)
        const turn = { turnId: event.turn_id }
        turns.set(event.turn_id, turn)
        latestTurn = turn
        questions.push({
          kind: 'question',
          text: event.user_message,
          mindset: event.mindset,
          source: eventSource(input.sessionId, event),
        })
        break
      }
      case 'tool.requested': {
        requireTurn(turns, event.turn_id)
        if (activities.has(event.call_id)) throw new Error(`Duplicate tool call id: ${event.call_id}`)
        toolCalls += 1
        activities.set(event.call_id, {
          kind: 'activity',
          callId: event.call_id,
          toolName: event.name,
          status: 'running',
          requestSeq: event.seq,
          turnId: event.turn_id,
          sourceSeq: event.seq,
        })
        break
      }
      case 'tool.completed': {
        requireTurn(turns, event.turn_id)
        const activity = activities.get(event.call_id)
        if (!activity) throw new Error(`Tool completion has no request: ${event.call_id}`)
        activity.status = event.ok ? 'completed' : 'failed'
        activity.sourceSeq = event.seq
        if (event.ok) {
          const resultRef = resultPath(event.result)
          if (resultRef) activity.resultRef = resultRef
          if (activity.toolName === 'tdease.evidence.write' && resultRef?.endsWith('.prov.json')) {
            observedEvidencePaths.add(resultRef)
          }
        } else {
          activity.error = { ...event.error }
        }
        break
      }
      case 'message.completed':
        requireTurn(turns, event.turn_id)
        interpretations.push({
          kind: 'interpretation',
          text: event.content,
          source: eventSource(input.sessionId, event),
        })
        break
      case 'turn.completed': {
        const turn = requireTurn(turns, event.turn_id)
        settle(turn, event.outcome)
        wallClockMs += event.usage.wall_clock_ms
        break
      }
      case 'turn.failed':
        settle(requireTurn(turns, event.turn_id), 'failed')
        break
      case 'turn.cancelled':
        settle(requireTurn(turns, event.turn_id), 'cancelled')
        break
      case 'thinking.recorded':
      case 'approval.requested':
      case 'approval.resolved':
      case 'card.created':
        requireTurn(turns, event.turn_id)
        break
    }
  }

  const evidenceByPath = new Map<string, EvidenceProjection>()
  for (const projection of input.evidence) {
    if (evidenceByPath.has(projection.path)) throw new Error(`Duplicate Evidence projection: ${projection.path}`)
    evidenceByPath.set(projection.path, cloneEvidence(projection))
  }
  const evidenceItems = [...evidenceByPath.values()].map((projection): ScientificEvidenceItem => ({
    projection,
    observedInSession: observedEvidencePaths.has(projection.path),
    source: evidenceSource(projection),
  }))
  const transitions = evidenceItems.flatMap((item) => item.projection.relations.map((relation): ScientificReasoningItem => ({
    kind: 'claim-transition',
    relation: { ...relation },
    relatedClaimPresent: evidenceByPath.has(relation.claimPath),
    source: item.source,
  })))
  const provenance = evidenceItems.map((item): ClaimProvenanceView => ({
    path: item.projection.path,
    claimRef: item.projection.claim.ref,
    activity: { ...item.projection.activity },
    entities: item.projection.entities.map((entity) => ({ ...entity })),
    relations: item.projection.relations.map((relation) => ({ ...relation })),
    verification: { ...item.projection.verification },
    ...(item.projection.turn ? { turn: { ...item.projection.turn } } : {}),
    source: item.source,
  }))
  const runFiles = input.runFiles.map((file): RunFileView => ({
    ...file,
    citedBy: evidenceItems
      .filter((item) => item.projection.entities.some((entity) => entity.path === file.path))
      .map((item) => item.projection.path),
    source: { kind: 'run-file', path: file.path },
  }))
  const exploration = [
    ...questions,
    ...[...activities.values()]
      .sort((left, right) => left.requestSeq - right.requestSeq)
      .map((activity): ExplorationItem => ({
        kind: 'activity',
        callId: activity.callId,
        toolName: activity.toolName,
        status: activity.status,
        ...(activity.resultRef ? { resultRef: activity.resultRef } : {}),
        ...(activity.error ? { error: { ...activity.error } } : {}),
        source: {
          kind: 'session-event',
          sessionId: input.sessionId,
          seq: activity.sourceSeq,
          turnId: activity.turnId,
        },
      })),
  ]
  const status = latestTurn ? latestTurn.settled ?? 'exploring' : 'idle'
  const result: ScientificOpsProjection = {
    sessionId: input.sessionId,
    ...(status === 'exploring' && latestTurn ? { activeTurnId: latestTurn.turnId } : {}),
    status,
    exploration,
    evidence: evidenceItems,
    reasoning: [...interpretations, ...transitions],
    provenance,
    runFiles,
    metrics: {
      toolCalls,
      claimTransitions: transitions.length,
      wallClockMs,
    },
  }
  return deepFreeze(result)
}

/** The turn-scoped members of the session vocabulary — the only events an
 *  activity/evidence/interpretation source can cite a turn for. The
 *  session-scoped `context.compacted` marker is deliberately excluded. */
type TurnScopedEvent = Extract<SessionEvent, { turn_id: string }>

function eventSource(sessionId: string, event: Pick<TurnScopedEvent, 'seq' | 'turn_id'>): Extract<ScientificOpsSource, { kind: 'session-event' }> {
  return { kind: 'session-event', sessionId, seq: event.seq, turnId: event.turn_id }
}

function evidenceSource(projection: EvidenceProjection): Extract<ScientificOpsSource, { kind: 'evidence' }> {
  return { kind: 'evidence', path: projection.path, claimRef: projection.claim.ref }
}

function requireTurn(turns: ReadonlyMap<string, TurnState>, turnId: string): TurnState {
  const turn = turns.get(turnId)
  if (!turn) throw new Error(`Scientific Ops event belongs to unknown turn: ${turnId}`)
  return turn
}

function settle(turn: TurnState, outcome: TurnOutcome | 'failed' | 'cancelled'): void {
  if (turn.settled) throw new Error(`Turn ${turn.turnId} has more than one terminal event`)
  turn.settled = outcome
}

function resultPath(result: JsonValue): string | undefined {
  if (!result || Array.isArray(result) || typeof result !== 'object') return undefined
  const path = (result as { readonly [key: string]: JsonValue }).path
  return typeof path === 'string' ? path : undefined
}

function cloneEvidence(value: EvidenceProjection): EvidenceProjection {
  return {
    ...value,
    claim: { ...value.claim },
    relatedClaims: value.relatedClaims.map((claim) => ({ ...claim })),
    entities: value.entities.map((entity) => ({ ...entity })),
    relations: value.relations.map((relation) => ({ ...relation })),
    activity: { ...value.activity },
    ...(value.adjudication ? { adjudication: { ...value.adjudication } } : {}),
    ...(value.turn ? { turn: { ...value.turn } } : {}),
    verification: { ...value.verification },
  }
}

function validateSessionId(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Scientific Ops session id is invalid')
}

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  return value
}
