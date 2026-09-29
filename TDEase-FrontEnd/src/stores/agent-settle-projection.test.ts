import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSessionEvent, type EventInput } from '@/agent/events'
import { useAgentStore } from './agent'

function turnStarted(turnId: string, message: string): EventInput {
  return {
    type: 'turn.started', turn_id: turnId, user_message: message,
    prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
  }
}

function turnCompleted(turnId: string): EventInput {
  return { type: 'turn.completed', turn_id: turnId, outcome: 'resolved', usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0, wall_clock_ms: 1 } }
}

function event(input: EventInput, seq: number) {
  return createSessionEvent(input, seq)
}

/**
 * Two settled turns: turn 1 is the opened session's full projection; turn 2
 * arrives as the settle-time suffix. Seqs are absolute (the projector folds a
 * contiguous log).
 */
const TURN1 = [
  event(turnStarted('t1', 'first question'), 1),
  event({ type: 'message.completed', turn_id: 't1', role: 'assistant', content: 'first answer' }, 2),
  event(turnCompleted('t1'), 3),
]
const TURN2_SUFFIX = [
  event(turnStarted('t2', 'second question'), 4),
  event({ type: 'message.completed', turn_id: 't2', role: 'assistant', content: 'second answer' }, 5),
  event(turnCompleted('t2'), 6),
]

describe('agent store settle projection', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('settling a suffix swaps the live tail for the canonical replay, prefix intact by reference', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()

    expect(store.replaceSessionProjection(session.id, TURN1)).toBe(true)
    const prefixRefs = [...store.active!.messages]

    // Turn 2 streams live (StreamBuffer-shaped ids)…
    const liveUser = store.addMessage(session.id, 'user', 'second question')
    const liveAssistant = store.addMessage(session.id, 'assistant', '')
    store.appendText(session.id, liveAssistant.id, 'streaming…')

    // …then settles through the incremental path.
    expect(store.settleSessionProjection(session.id, TURN2_SUFFIX)).toBe(true)

    const messages = store.active!.messages
    // The live tail is gone; what replaced it is the canonical replay.
    expect(messages.some(m => m.id === liveUser.id || m.id === liveAssistant.id)).toBe(false)
    // The settled prefix survives OBJECT-IDENTICAL — the transcript's render
    // win is exactly this: no re-mount of history the settle did not touch.
    expect(messages.length).toBe(prefixRefs.length + 2)
    for (let i = 0; i < prefixRefs.length; i += 1) expect(messages[i]).toBe(prefixRefs[i])
    expect(messages[messages.length - 2]?.id).toBe('turn:t2:user')
    expect(messages[messages.length - 1]?.id).toBe('turn:t2:act:0')
    expect(store.active?.settlements.get('t2')?.kind).toBe('completed')
    expect(store.atomsOf(session.id)).toHaveLength(6)
  })

  it('an incremental settle equals a full reprojection of the same log', () => {
    const incrementalStore = useAgentStore()
    incrementalStore.bindWorkspace('ws_1')
    const incrementalSession = incrementalStore.createSession()
    incrementalStore.replaceSessionProjection(incrementalSession.id, TURN1)
    incrementalStore.addMessage(incrementalSession.id, 'user', 'second question')
    incrementalStore.settleSessionProjection(incrementalSession.id, TURN2_SUFFIX)

    const fullStore = useAgentStore()
    fullStore.bindWorkspace('ws_1')
    const fullSession = fullStore.createSession()
    fullStore.replaceSessionProjection(fullSession.id, [...TURN1, ...TURN2_SUFFIX])

    expect(incrementalStore.active?.messages).toEqual(fullStore.active?.messages)
    expect(incrementalStore.active?.settlements).toEqual(fullStore.active?.settlements)
    expect([...incrementalStore.atomsOf(incrementalSession.id)]).toEqual([...fullStore.atomsOf(fullSession.id)])
  })

  it('a sequence divergence refuses the settle, leaves state untouched, and retires the projector', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()
    store.replaceSessionProjection(session.id, TURN1)
    const before = [...store.active!.messages]

    // A suffix that does not continue the projected sequence (the caller's
    // horizon check missed a rewritten log) must be refused wholesale.
    expect(store.settleSessionProjection(session.id, TURN2_SUFFIX.slice(1))).toBe(false)
    expect(store.active!.messages).toEqual(before)
    for (let i = 0; i < before.length; i += 1) expect(store.active!.messages[i]).toBe(before[i])

    // The half-folded projector is discarded, not resumed from.
    expect(store.settleSessionProjection(session.id, TURN2_SUFFIX)).toBe(false)
    expect(store.active!.messages).toEqual(before)
  })

  it('an empty suffix is refused without touching state', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()
    store.replaceSessionProjection(session.id, TURN1)
    const before = [...store.active!.messages]

    expect(store.settleSessionProjection(session.id, [])).toBe(false)
    expect(store.active!.messages).toEqual(before)
  })

  it('settling names an untitled session from the suffix\'s first user message', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()
    expect(session.untitled).toBe(true)
    // Seed the projector with a log slice that carries NO user message (a
    // session-scoped compaction), so nothing has named the session yet.
    store.replaceSessionProjection(session.id, [event({ type: 'context.compacted', reason: 'manual', tokens_before: 1000, tokens_after: 100 }, 1)])

    expect(store.settleSessionProjection(session.id, [
      event(turnStarted('t1', 'identify the proteoforms'), 2),
      event(turnCompleted('t1'), 3),
    ])).toBe(true)

    expect(store.active?.untitled).toBe(false)
    expect(store.active?.title).toBe('identify the proteoforms')
  })

  it('a session without a retained projector refuses the settle (fallback territory)', () => {
    // A restored session settles only after its first full loadHistory built
    // the projector; without one, the incremental path must refuse — the
    // caller falls back to the full projection.
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()

    expect(store.settleSessionProjection(session.id, TURN1)).toBe(false)
    expect(store.active?.messages).toEqual([])
  })
})
