import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSessionEvent } from '@/agent/events'
import { useAgentStore } from './agent'

const STORAGE_KEY = 'tdease.agent.sessions.v2'
const ACTIVE_SESSION_STORAGE_KEY = 'tdease.agent.active-session.v1'

function turnStarted(turnId: string, message: string, seq: number) {
  return createSessionEvent(
    {
      type: 'turn.started', turn_id: turnId, user_message: message,
      prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture/model', mindset: 'auto', authority: 'ask',
    },
    seq,
  )
}

describe('agent store persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('keeps session metadata and conversation facts out of localStorage', async () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()
    store.addMessage(session.id, 'user', 'identify proteoforms')
    const assistant = store.addMessage(session.id, 'assistant', '')
    store.appendText(session.id, assistant.id, 'looking now')

    await vi_flush()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(JSON.parse(localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)!)).toEqual({ ws_1: session.id })
  })

  it('history enters the store only through the log projection, not accumulated writes', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()
    store.addMessage(session.id, 'user', 'stale local content')

    const replaced = store.replaceSessionProjection(session.id, [turnStarted('t1', 'from the log', 1)])

    expect(replaced).toBe(true)
    expect(store.active?.messages).toEqual([{ id: 'turn:t1:user', role: 'user', content: 'from the log' }])
  })

  it('context occupancy is UNKNOWN (null) until Node pushes a live snapshot', () => {
    // A real session's settlement usage is a turn-sum for cost accounting — it
    // is deliberately NOT what the gauge reads anymore. Even with a settlement
    // reporting 125k input tokens, the gauge stays null until a context:changed
    // push lands.
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()
    store.replaceSessionProjection(session.id, [
      turnStarted('t2', 'go', 1),
      createSessionEvent(
        { type: 'turn.completed', turn_id: 't2', outcome: 'resolved', usage: { input_tokens: 125_070, output_tokens: 28_588, tool_calls: 42, wall_clock_ms: 855_907 } },
        2,
      ),
    ])

    expect(store.contextTokensUsed).toBeNull()
    expect(store.contextCacheHitRate).toBeNull()
  })

  it('patchContextUsage drives the occupancy readout from the live push', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()

    store.patchContextUsage(session.id, { tokens: 11_200, cache: { read: 8_000, write: 1_500, uncached: 1_700 } })
    expect(store.contextTokensUsed).toBe(11_200)
    expect(store.contextCacheHitRate).toBeCloseTo(8_000 / (8_000 + 1_500 + 1_700))

    // A null push (post-compaction) clears occupancy back to unknown.
    store.patchContextUsage(session.id, { tokens: null, cache: null })
    expect(store.contextTokensUsed).toBeNull()
    expect(store.contextCacheHitRate).toBeNull()
  })

  it('replaceSessionProjection preserves the pushed contextUsage across loadHistory', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()
    store.patchContextUsage(session.id, { tokens: 11_000, cache: null })

    store.replaceSessionProjection(session.id, [turnStarted('t1', 'go', 1)])

    expect(store.active?.contextUsage).toEqual({ tokens: 11_000, cache: null })
    expect(store.contextTokensUsed).toBe(11_000)
  })

  it('the prompt queue is FIFO: dequeue takes the head, remove drops by position', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()

    expect(store.dequeuePrompt(session.id)).toBeUndefined()
    store.enqueuePrompt(session.id, 'first')
    store.enqueuePrompt(session.id, 'second')
    expect(store.active?.queuedPrompts).toEqual(['first', 'second'])

    expect(store.dequeuePrompt(session.id)).toBe('first')
    store.removeQueuedPrompt(session.id, 0)
    expect(store.active?.queuedPrompts).toEqual([])
    expect(store.dequeuePrompt(session.id)).toBeUndefined()
  })

  it('queued prompts survive a workspace metadata re-hydration of a live session', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const session = store.createSession()
    store.enqueuePrompt(session.id, 'typed ahead')

    store.hydrateWorkspaceSessions([
      { version: 1, id: session.id, title: '', createdAt: session.createdAt, updatedAt: session.updatedAt, archived: false, mindset: 'explorer' },
    ])

    expect(store.active?.queuedPrompts).toEqual(['typed ahead'])
  })
})

async function vi_flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
