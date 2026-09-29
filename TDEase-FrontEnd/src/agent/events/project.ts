import type {
  AgentChatMessage,
  TextBlock,
  ThinkingBlock,
  ToolCall,
  ToolGroupBlock,
  ToolResultPreview,
} from '@/stores/chat-types'

import type { JsonObject, JsonValue, SessionEvent, SessionError, TurnOutcome, TurnUsage } from './vocabulary'

/**
 * How one turn ended, derived solely from its terminal event. This is the
 * projection's own vocabulary (not a renderer-side re-derivation): the
 * transcript's settle-fold, outcome blocks and the context readout all read
 * it straight off `SessionProjection.settlements`.
 */
export type TurnSettlement =
  | { kind: 'completed'; outcome: TurnOutcome; usage: TurnUsage; blocked?: BlockedDetail }
  | { kind: 'failed'; error: SessionError }
  | { kind: 'cancelled' }

interface BlockedDetail {
  reason: string
  needed: string
  /**
   * Choice answers the model offered alongside the question
   * (`reportBlocked`'s optional `options`), so the UI can render one-tap
   * replies. Sanitized: trimmed, non-empty, at most 4 × 200 chars.
   */
  options?: string[]
}

/** Disposable UI state reconstructed from the ordered session event prefix. */
export interface SessionProjection {
  eventCount: number
  messages: ReadonlyArray<AgentChatMessage>
  /** One settlement per settled turn, keyed by turn id. */
  settlements: ReadonlyMap<string, TurnSettlement>
  /**
   * The exact event slice this projection was built from, verbatim. Lets a
   * caller derive turn-scoped facts this projection does not itself carry
   * without a second, competing persisted model.
   */
  events: ReadonlyArray<SessionEvent>
}

/**
 * Incremental projection fold. `projectSessionEvents` folds a whole event
 * array at once; a caller that receives events as an APPEND-ONLY suffix (the
 * settle path reads the log it has already projected up to N) keeps ONE
 * projector per session, folds each suffix into it, and snapshots — the
 * per-turn cost is O(suffix), not O(full history). Folding is append-only by
 * construction: every event pushes, nothing rewrites an earlier message
 * position, so a snapshot's message prefix never changes after the fact.
 */
export interface SessionProjector {
  /**
   * Consume one event. Throws when `seq` is not the projector's next expected
   * sequence (the projector state and the event slice have diverged — the
   * caller must rebuild from the full log, never continue folding).
   */
  fold(event: SessionEvent): void
  /**
   * A point-in-time view of everything folded so far. The arrays/maps are
   * copies: the snapshot is stable against later folds, while the projector
   * retains its internal fold state (and its live message objects) for the
   * next suffix.
   */
  snapshot(): SessionProjection
}

interface ProjectedAct {
  message: AgentChatMessage
}

/**
 * A pending approval awaiting its tool call (or its resolution). An approval
 * used to project as its OWN `permission` block alongside the tool's
 * `tool_group` row — so a replayed approved tool rendered TWICE (a bulky card
 * plus a tool row, both carrying the same name + args). It now folds into the
 * ToolCall (`tool.approval`) once both the request and the resolution are
 * known; the renderer shows the call once with the decision inline.
 */
interface PendingApproval {
  reason: string
  decision?: 'approved' | 'declined'
}

interface ProjectedTurn {
  currentAct?: ProjectedAct
  toolsByCall: Map<string, ToolCall>
  approvalsByCall: Map<string, PendingApproval>
}

/**
 * Projects durable, settled facts into the legacy chat and activity view model.
 * This never consults wall clock, local storage, or provider-specific events.
 */
export function createSessionProjector(): SessionProjector {
  const messages: AgentChatMessage[] = []
  const settlements = new Map<string, TurnSettlement>()
  const turns = new Map<string, ProjectedTurn>()
  const folded: SessionEvent[] = []
  let previousSeq = 0
  // The question `tdease.session.reportBlocked` asked, carried onto the
  // settlement when the turn completes blocked (AGENT-LOOP.md §3).
  let lastBlocked: BlockedDetail | undefined

  const project: SessionProjector = {
    fold(event: SessionEvent): void {
      const expectedSeq = previousSeq + 1
      if (event.seq !== expectedSeq) {
        throw new Error(`Session projection requires contiguous sequence numbers; expected ${expectedSeq}, received ${event.seq}`)
      }
      previousSeq = event.seq
      folded.push(event)

      switch (event.type) {
        case 'turn.started': {
          if (turns.has(event.turn_id)) throw new Error(`Session projection received duplicate turn.started for ${event.turn_id}`)
          turns.set(event.turn_id, {
            toolsByCall: new Map(),
            approvalsByCall: new Map(),
          })
          messages.push({ id: userMessageId(event.turn_id), role: 'user', content: event.user_message })
          break
        }
        case 'thinking.recorded': {
          const act = actFor(turns, messages, event.turn_id)
          // Chronological placement: thinking attaches where it was recorded,
          // merging only with an immediately preceding thinking block. It must
          // NOT jump to the front of the act — a mid-turn reasoning step belongs
          // beside the tool calls it reasoned about.
          const blocks = act.message.blocks!
          const last = blocks[blocks.length - 1]
          if (last?.type === 'thinking') {
            last.text += `\n\n${event.content}`
            break
          }
          const thinking: ThinkingBlock = {
            type: 'thinking', id: `event:${event.seq}`, text: event.content, sealed: true,
            ...(event.duration_ms !== undefined ? { durationMs: event.duration_ms } : {}),
          }
          blocks.push(thinking)
          break
        }
        case 'tool.requested': {
          const turn = turnFor(turns, event.turn_id)
          const act = actFor(turns, messages, event.turn_id)
          if (event.name === 'tdease.session.reportBlocked') {
            const args = event.args as Record<string, unknown>
            const options = Array.isArray(args.options)
              ? args.options
                .filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
                .map((option) => option.trim().slice(0, 200))
                .slice(0, 4)
              : []
            lastBlocked = {
              reason: typeof args.reason === 'string' ? args.reason : '',
              needed: typeof args.needed === 'string' ? args.needed : '',
              ...(options.length ? { options } : {}),
            }
          }
          const tool: ToolCall = {
            id: `event:${event.seq}`,
            name: event.name,
            args: cloneArgs(event.args),
            done: false,
            success: false,
            status: 'running',
          }
          // Fold an already-resolved approval into the tool call if its
          // resolution landed before tool.requested in the log (decision is set).
          // An unresolved pending approval waits for approval.resolved, which
          // patches the tool by call_id.
          const pending = turn.approvalsByCall.get(event.call_id)
          if (pending?.decision) tool.approval = { decision: pending.decision, reason: pending.reason }
          toolGroupFor(act, event.seq).tools.push(tool)
          turn.toolsByCall.set(event.call_id, tool)
          break
        }
        case 'approval.requested': {
          const turn = turnFor(turns, event.turn_id)
          turn.approvalsByCall.set(event.call_id, { reason: event.basis })
          // Nothing attaches to the tool yet: ToolApproval is a SETTLED record
          // (it carries the decision), so we wait for approval.resolved before
          // folding it in. The reason is buffered on the pending record and
          // applied — whichever order — in approval.resolved or tool.requested.
          break
        }
        case 'approval.resolved': {
          const turn = turnFor(turns, event.turn_id)
          const decision = event.decision === 'approved' ? 'approved' : event.decision === 'declined' ? 'declined' : undefined
          const pending = turn.approvalsByCall.get(event.call_id)
          if (pending) pending.decision = decision
          // Settle the decision on the tool call wherever it lives. The approval
          // may resolve before tool.requested (decision buffered on the pending
          // record, applied when the tool arrives) or after (patched here).
          if (decision) {
            const tool = turn.toolsByCall.get(event.call_id)
            if (tool) {
              tool.approval = { decision, reason: tool.approval?.reason ?? pending?.reason }
            }
          }
          break
        }
        case 'tool.completed': {
          const turn = turnFor(turns, event.turn_id)
          const act = actFor(turns, messages, event.turn_id)
          const tool = turn.toolsByCall.get(event.call_id) ?? missingTool(act, event.seq)
          tool.done = true
          tool.success = event.ok
          tool.status = event.ok ? 'succeeded' : 'failed'
          tool.error = event.ok ? undefined : event.error.message
          tool.resultPreview = event.ok ? toolResultPreview(event.result) : undefined
          turn.toolsByCall.set(event.call_id, tool)
          break
        }
        case 'message.completed': {
          const act = actFor(turns, messages, event.turn_id)
          const text: TextBlock = { type: 'text', id: `event:${event.seq}`, text: event.content }
          act.message.blocks!.push(text)
          break
        }
        case 'card.created':
          turnFor(turns, event.turn_id)
          break
        case 'model.request.prepared':
          // Replay/audit metadata only: records what one provider request actually
          // saw (digests + model + thinking). Not a chat or activity fact — a
          // dynamic mid-run context/tools/model change must not surface as a
          // transcript row, only as a replayable snapshot.
          turnFor(turns, event.turn_id)
          break
        case 'turn.completed': {
          const turn = turnFor(turns, event.turn_id)
          sweepInterruptedTools(turn)
          settlements.set(event.turn_id, {
            kind: 'completed',
            outcome: event.outcome,
            usage: event.usage,
            blocked: event.outcome === 'blocked' ? lastBlocked : undefined,
          })
          break
        }
        case 'turn.failed': {
          const turn = turnFor(turns, event.turn_id)
          sweepInterruptedTools(turn)
          settlements.set(event.turn_id, { kind: 'failed', error: event.error })
          break
        }
        case 'turn.cancelled': {
          const turn = turnFor(turns, event.turn_id)
          sweepInterruptedTools(turn)
          settlements.set(event.turn_id, { kind: 'cancelled' })
          break
        }
        case 'context.compacted': {
          // Session-scoped: it owns no turn, so it becomes its own standalone
          // message — the transcript's compacted divider — at the exact position
          // the compaction happened in the log.
          messages.push({
            id: `event:${event.seq}`,
            role: 'assistant',
            blocks: [{
              type: 'compaction',
              id: `event:${event.seq}`,
              reason: event.reason,
              ...(event.tokens_before !== undefined ? { tokensBefore: event.tokens_before } : {}),
              ...(event.tokens_after !== undefined ? { tokensAfter: event.tokens_after } : {}),
            }],
          })
          break
        }
      }
    },
    snapshot(): SessionProjection {
      return {
        eventCount: folded.length,
        messages: [...messages],
        settlements: new Map(settlements),
        events: [...folded],
      }
    },
  }
  return project
}

/** Batch form: project a whole event array in one pass. */
export function projectSessionEvents(events: ReadonlyArray<SessionEvent>): SessionProjection {
  const projector = createSessionProjector()
  for (const event of events) projector.fold(event)
  return projector.snapshot()
}

function turnFor(turns: ReadonlyMap<string, ProjectedTurn>, turnId: string): ProjectedTurn {
  const turn = turns.get(turnId)
  if (!turn) throw new Error(`Session projection received an event for unknown turn ${turnId}`)
  return turn
}

function actFor(
  turns: ReadonlyMap<string, ProjectedTurn>,
  messages: AgentChatMessage[],
  turnId: string,
): ProjectedAct {
  const turn = turnFor(turns, turnId)
  if (!turn.currentAct) {
    const message: AgentChatMessage = {
      id: `turn:${turnId}:act:0`,
      role: 'assistant',
      blocks: [],
    }
    turn.currentAct = { message }
    messages.push(message)
  }
  return turn.currentAct
}

/**
 * The tool group the NEXT tool belongs to: the act's last block when it is
 * already a tool group (a batch of consecutive calls shares one fold), else a
 * fresh group appended at the current end. This keeps every tool call at the
 * position it actually happened in the event stream — text, then the tools
 * that text triggered, then the follow-up text — instead of collapsing the
 * whole turn's calls into one group pinned above the first text block.
 */
function toolGroupFor(act: ProjectedAct, seq: number): ToolGroupBlock {
  const blocks = act.message.blocks!
  const last = blocks[blocks.length - 1]
  if (last?.type === 'tool_group') return last
  const group: ToolGroupBlock = { type: 'tool_group', id: `event:${seq}`, tools: [] }
  blocks.push(group)
  return group
}

function missingTool(act: ProjectedAct, seq: number): ToolCall {
  const tool: ToolCall = {
    id: `event:${seq}`,
    name: 'unknown',
    done: false,
    success: false,
    status: 'unknown',
  }
  toolGroupFor(act, seq).tools.push(tool)
  return tool
}

/**
 * Bounded output preview for a settled successful tool call (agentui tool-ui
 * output rules): explicit emptiness over silence, verbatim head under a
 * budget, verbatim total when cut. Structured results compress to compact
 * JSON first — the transcript previews; the model already consumed the full
 * value. The budget exists because a bash result can be megabytes: the store
 * holds the preview, never the payload.
 */
const TOOL_RESULT_PREVIEW_BUDGET = 800

function toolResultPreview(result: JsonValue): ToolResultPreview {
  if (result === null || result === '') return { text: '', truncated: false, totalChars: 0 }
  const text = typeof result === 'string' ? result : JSON.stringify(result) ?? ''
  const totalChars = text.length
  if (totalChars > TOOL_RESULT_PREVIEW_BUDGET) {
    return { text: text.slice(0, TOOL_RESULT_PREVIEW_BUDGET), truncated: true, totalChars }
  }
  return { text, truncated: false, totalChars }
}

/**
 * A turn's terminal event ends every open call with it: a tool the turn never
 * finished is CANCELLED, not eternally running (assistant-ui treats
 * cancellation as a first-class status, and the running dots would otherwise
 * tick forever on every replay of the session). The call's lifecycle is over,
 * so `done` flips true; `success` stays false — but cancelled is rendered as
 * its own neutral state, never counted as a failure.
 */
function sweepInterruptedTools(turn: ProjectedTurn): void {
  for (const tool of turn.toolsByCall.values()) {
    if (!tool.done) {
      tool.done = true
      tool.status = 'cancelled'
    }
  }
}


function cloneArgs(args: JsonObject): Record<string, unknown> {
  return { ...args }
}

function userMessageId(turnId: string): string {
  return `turn:${turnId}:user`
}

