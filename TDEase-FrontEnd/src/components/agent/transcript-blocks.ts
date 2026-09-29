/**
 * Transcript block sequencing.
 *
 * Turns `agent/events/project.ts`'s `SessionProjection.messages` (one entry
 * per user turn and per model act — see `project.ts`'s `turn:<id>:user` /
 * `turn:<id>:act:<n>` ids) plus the same projection's `settlements` map into
 * one ordered, renderable block list. Every block traces to exactly one fact
 * `project.ts` produced (user/act messages, per-turn settlement, compaction
 * markers) — there is no block here that was not derived from the session
 * event log.
 */
import type { AgentChatMessage, CompactionBlock } from '@/stores/chat-types'
import type { TurnSettlement } from '@/agent/events'

export type TranscriptBlock =
  | {
    kind: 'user'
    id: string
    turnId: string
    message: AgentChatMessage
    /** A settled-but-unanswered turn keeps a quiet hint on its message. */
    settlementHint?: 'cancelled' | 'failed'
  }
  | { kind: 'act'; id: string; turnId: string; message: AgentChatMessage; settlement?: TurnSettlement }
  | { kind: 'outcome'; id: string; turnId: string; settlement: Extract<TurnSettlement, { kind: 'completed' }> }
  | { kind: 'failed'; id: string; turnId: string; settlement: Extract<TurnSettlement, { kind: 'failed' }> }
  | { kind: 'compaction'; id: string; block: CompactionBlock }

const ACT_ID = /^turn:(.+):act:(\d+)$/
const USER_ID = /^turn:(.+):user$/

/**
 * `messages` must be in the order `project.ts` produced them (already true
 * of `SessionProjection.messages`). `settlements` may be empty — a session
 * with no known settlement detail (e.g. one only ever loaded from the
 * legacy activity list) still renders its user/act messages correctly, it
 * simply carries no outcome/failure blocks.
 */
export function buildTranscriptBlocks(
  messages: ReadonlyArray<AgentChatMessage>,
  settlements: ReadonlyMap<string, TurnSettlement>,
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  let openTurnId: string | null = null
  let openUserBlock: Extract<TranscriptBlock, { kind: 'user' }> | null = null

  // `superseded` — a newer user turn follows this one, so its settlement is
  // history, not live feedback. SHOW-ONCE RULE, one life cycle for every
  // non-resolved settlement: its feedback (the full card — failed error
  // envelope, blocked question with one-tap options, halted continue — AND
  // the user-bubble cancelled/failed chip) renders ONLY while the turn is
  // the live tail. The moment a newer user message exists — projected or
  // still-live — the interaction is over and ALL of it leaves the transcript.
  // The record itself stays in the persisted event log (trajectory
  // inspector); the transcript keeps no debris of settled interactions.
  const closeTurn = (turnId: string, superseded: boolean) => {
    const settlement = settlements.get(turnId)
    if (!settlement) return
    if (settlement.kind === 'completed') {
      // A clean RESOLVED turn folds its work process inside the act
      // (ProcessFold carries the "✓ worked · time · N calls" summary line there), so it
      // emits no separate outcome block — that chip would just duplicate the
      // fold affordance. Blocked/halted still emit while live: they carry a
      // question / continue action that has no home inside the act.
      if (settlement.outcome !== 'resolved' && !superseded) {
        blocks.push({ kind: 'outcome', id: `turn:${turnId}:outcome`, turnId, settlement })
      }
    } else if (settlement.kind === 'failed' && !superseded) {
      blocks.push({ kind: 'failed', id: `turn:${turnId}:failed`, turnId, settlement })
    }
  }

  const hintFor = (turnId: string): 'cancelled' | 'failed' | undefined => {
    const kind = settlements.get(turnId)?.kind
    return kind === 'cancelled' || kind === 'failed' ? kind : undefined
  }

  // One motion for "the user moved on": close the open turn as superseded
  // (card gone) and strip its user bubble's settlement chip. The open-turn
  // slot clears too — the next turn id is not minted yet, and leaving the old
  // one in would make the loop-end tail close re-emit the card it just
  // retracted. Called for a PROJECTED new user message and — just as
  // important — for a LIVE one (msg-N): the previous feedback must vanish
  // the instant the user sends the next message, not when that turn settles.
  const supersedeOpenTurn = (): void => {
    if (!openTurnId) return
    closeTurn(openTurnId, true)
    if (openUserBlock) openUserBlock.settlementHint = undefined
    openTurnId = null
    openUserBlock = null
  }

  for (const message of messages) {
    // A compaction marker owns no turn and must never reach the classifiers
    // below: its `event:<seq>` id matches no turn scheme, and the role-based
    // fallback would render it as an empty act.
    const marker = message.blocks?.[0]
    if (marker?.type === 'compaction') {
      blocks.push({ kind: 'compaction', id: message.id, block: marker })
      continue
    }
    const userMatch = message.id.match(USER_ID)
    if (userMatch) {
      supersedeOpenTurn()
      const turnId = userMatch[1]
      openTurnId = turnId
      const block: Extract<TranscriptBlock, { kind: 'user' }> = {
        kind: 'user',
        id: message.id,
        turnId,
        message,
        settlementHint: hintFor(turnId),
      }
      blocks.push(block)
      openUserBlock = block
      continue
    }

    const actMatch = message.id.match(ACT_ID)
    if (actMatch) {
      const turnId = actMatch[1]
      // The act carries its turn's settlement directly — the renderer never
      // re-derives or re-looks-up what the projection already knows.
      blocks.push({ kind: 'act', id: message.id, turnId, message, settlement: settlements.get(turnId) })
      continue
    }

    // Any message outside the `turn:*:` id scheme. Two sources produce these:
    // `project.ts` may add one, and `stores/agent.ts`'s `addMessage` gives
    // every LIVE message a plain `msg-N` id, because the turn id does not
    // exist until the runtime has minted it.
    //
    // Classify by ROLE, not by id. This branch used to push `kind: 'act'`
    // unconditionally, so the user's own message -- which carries `content`
    // and no `blocks` -- was rendered by the act renderer as an empty block.
    // The message you just typed vanished from the conversation until a
    // reload re-projected it from the event log with a `turn:<id>:user` id.
    // The transcript showed the reply to a question it did not show.
    if (message.role === 'user') {
      // A live user message ends the previous turn's feedback NOW (the blocked
      // card must not outlive its own answer while the next turn is still
      // running) — but it must NOT wear that turn's settlement: it is a fresh
      // message whose turn id is not minted yet, so hintFor borrowing
      // `openTurnId` here once stamped a perfectly good new message with the
      // PREVIOUS turn's "cancelled" chip.
      supersedeOpenTurn()
      const turnId = openTurnId ?? message.id
      blocks.push({
        kind: 'user',
        id: message.id,
        turnId,
        message,
        // Key present with an explicit undefined so live and projected user
        // blocks share one shape — a live message never wears a settlement.
        settlementHint: undefined,
      })
      continue
    }
    // A live act (msg-N) belongs to a turn whose id has not been minted yet.
    // It carries no settlement — a streaming act never folds.
    blocks.push({ kind: 'act', id: message.id, turnId: message.id, message })
  }

  if (openTurnId) closeTurn(openTurnId, false)
  return blocks
}
