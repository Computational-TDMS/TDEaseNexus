/**
 * The trajectory projection — the session log re-folded as one row per turn,
 * showing exactly what the deepseek-style trajectory view shows: the user
 * prompt, every provider request (model, thinking level, and the digests of
 * what that request actually saw), every tool call with its outcome and
 * approval, and the settlement.
 *
 * Pure derivation over the same canonical events as `project.ts` (the chat
 * view). Neither projection consults the other and neither holds state: one
 * vocabulary, N derived maps. Requests carry content-addressed digests — the
 * snapshot bodies live beside the log in `snapshots/<digest>.md` and are
 * loaded lazily by the reader, never embedded in the projection.
 */
import type { SessionEvent, SessionError } from './vocabulary'
import type { TurnSettlement } from './project'

/** One provider request as the trajectory shows it. */
export interface TrajectoryRequestRow {
  seq: number
  /** 1-based within the owning turn (the atom's own `request_seq`). */
  requestSeq: number
  model: string
  thinkingLevel: string
  systemPromptDigest: string
  contextDigest: string
  activeToolsDigest: string
}

export interface TrajectoryToolRow {
  seq: number
  callId: string
  name: string
  /** Absent while the call is still open (replaying a live prefix). */
  ok?: boolean
  error?: SessionError
  approval?: { decision: 'approved' | 'declined'; reason: string }
}

export interface TrajectoryTurnRow {
  turnId: string
  /** Inclusive event-sequence range this turn occupies in the log. */
  seqStart: number
  seqEnd: number
  userMessage: string
  promptSnapshotDigest: string
  model: string
  mindset: string
  authority: string
  requests: ReadonlyArray<TrajectoryRequestRow>
  tools: ReadonlyArray<TrajectoryToolRow>
  /** Recorded thinking segments in seq order (preview = hover fuel). */
  thinking: ReadonlyArray<{ seq: number; preview: string }>
  /** Settled assistant messages in seq order. */
  messages: ReadonlyArray<{ seq: number; preview: string }>
  /** Null until the turn's terminal event lands (live prefix replay). */
  settlement: TurnSettlement | null
}

export interface TrajectoryProjection {
  turns: ReadonlyArray<TrajectoryTurnRow>
  totalEvents: number
  totalRequests: number
  totalToolCalls: number
}

export function projectTrajectory(events: ReadonlyArray<SessionEvent>): TrajectoryProjection {
  const turns: TrajectoryTurnRow[] = []
  const byId = new Map<string, TrajectoryTurnRow>()
  // The reportBlocked question, carried onto the settlement exactly as the
  // chat projection carries it (project.ts) — one fold rule, two projections.
  let lastBlocked: { reason: string; needed: string } | undefined
  let previousSeq = 0

  for (const event of events) {
    const expectedSeq = previousSeq + 1
    if (event.seq !== expectedSeq) {
      throw new Error(`Trajectory projection requires contiguous sequence numbers; expected ${expectedSeq}, received ${event.seq}`)
    }
    previousSeq = event.seq

    switch (event.type) {
      case 'turn.started': {
        if (byId.has(event.turn_id)) throw new Error(`Trajectory projection received duplicate turn.started for ${event.turn_id}`)
        const row: TrajectoryTurnRow = {
          turnId: event.turn_id,
          seqStart: event.seq,
          seqEnd: event.seq,
          userMessage: event.user_message,
          promptSnapshotDigest: event.prompt_snapshot_digest,
          model: event.model,
          mindset: event.mindset,
          authority: event.authority,
          requests: [],
          tools: [],
          thinking: [],
          messages: [],
          settlement: null,
        }
        turns.push(row)
        byId.set(event.turn_id, row)
        break
      }
      case 'model.request.prepared': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        mutableRequests(row).push({
          seq: event.seq,
          requestSeq: event.request_seq,
          model: event.model,
          thinkingLevel: event.thinking_level,
          systemPromptDigest: event.system_prompt_digest,
          contextDigest: event.context_digest,
          activeToolsDigest: event.active_tools_digest,
        })
        break
      }
      case 'thinking.recorded': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        mutableThinking(row).push({ seq: event.seq, preview: previewOf(event.content) })
        break
      }
      case 'message.completed': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        mutableMessages(row).push({ seq: event.seq, preview: previewOf(event.content) })
        break
      }
      case 'tool.requested': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        if (event.name === 'tdease.session.reportBlocked') {
          const args = event.args as Record<string, unknown>
          lastBlocked = {
            reason: typeof args.reason === 'string' ? args.reason : '',
            needed: typeof args.needed === 'string' ? args.needed : '',
          }
        }
        mutableTools(row).push({ seq: event.seq, callId: event.call_id, name: event.name })
        break
      }
      case 'approval.requested': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        toolByCall(mutableTools(row), event.call_id, event.seq).approvalReason = event.basis
        break
      }
      case 'approval.resolved': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        const decision = event.decision === 'approved' ? 'approved' : event.decision === 'declined' ? 'declined' : undefined
        const tool = toolByCall(mutableTools(row), event.call_id, event.seq)
        if (decision) tool.approval = { decision, reason: tool.approvalReason ?? '' }
        break
      }
      case 'tool.completed': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        const tool = toolByCall(mutableTools(row), event.call_id, event.seq)
        tool.ok = event.ok
        if (!event.ok) tool.error = event.error
        break
      }
      case 'card.created': {
        turnFor(byId, event.turn_id).seqEnd = event.seq
        break
      }
      case 'turn.completed': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        row.settlement = { kind: 'completed', outcome: event.outcome, usage: event.usage, blocked: event.outcome === 'blocked' ? lastBlocked : undefined }
        break
      }
      case 'turn.failed': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        row.settlement = { kind: 'failed', error: event.error }
        break
      }
      case 'turn.cancelled': {
        const row = turnFor(byId, event.turn_id)
        row.seqEnd = event.seq
        row.settlement = { kind: 'cancelled' }
        break
      }
    }
  }

  let totalRequests = 0
  let totalToolCalls = 0
  for (const row of turns) {
    totalRequests += row.requests.length
    totalToolCalls += row.tools.length
  }
  return { turns, totalEvents: events.length, totalRequests, totalToolCalls }
}

function turnFor(byId: ReadonlyMap<string, TrajectoryTurnRow>, turnId: string): TrajectoryTurnRow {
  const row = byId.get(turnId)
  if (!row) throw new Error(`Trajectory projection received an event for unknown turn ${turnId}`)
  return row
}

interface MutableTool extends TrajectoryToolRow {
  approvalReason?: string
}

/** Find-or-create by call_id; a completion without its request still gets a row. */
function toolByCall(tools: MutableTool[], callId: string, seq: number): MutableTool {
  let tool = tools.find((item) => item.callId === callId)
  if (!tool) {
    tool = { seq, callId, name: 'unknown' }
    tools.push(tool)
  }
  return tool
}

function mutableRequests(row: TrajectoryTurnRow): TrajectoryRequestRow[] {
  return row.requests as TrajectoryRequestRow[]
}

function mutableTools(row: TrajectoryTurnRow): MutableTool[] {
  return row.tools as MutableTool[]
}

function mutableThinking(row: TrajectoryTurnRow): { seq: number; preview: string }[] {
  return row.thinking as { seq: number; preview: string }[]
}

function mutableMessages(row: TrajectoryTurnRow): { seq: number; preview: string }[] {
  return row.messages as { seq: number; preview: string }[]
}

/** First ~160 single-line characters — hover fuel, never the body itself. */
function previewOf(content: string): string {
  const flat = content.replaceAll(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}
