/**
 * Tests for the extracted session-metadata delta persistence (audit
 * candidate 6): only the session whose durable fields moved is rewritten —
 * one title edit must not rewrite every session.json on disk.
 */
import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionMetadataPersistence } from './useSessionMetadataPersistence'
import { useAgentStore } from '@/stores/agent'
import type { WorkspaceTextBridge } from '@/services/agent/agentSessionStorage'

function fakeBridge() {
  const writes: Array<{ sessionId: string; body: Record<string, unknown> }> = []
  const bridge = {
    writeTextAtomic: vi.fn(async (_root: string, relative: string, body: string) => {
      const id = relative.split('/')[2]
      writes.push({ sessionId: id, body: JSON.parse(body) })
    }),
  } as unknown as WorkspaceTextBridge & { writeTextAtomic: ReturnType<typeof vi.fn> }
  return { bridge, writes }
}

describe('useSessionMetadataPersistence', () => {
  it('writes each new session once, then only the session whose fields moved', async () => {
    setActivePinia(createPinia())
    const agent = useAgentStore()
    agent.bindWorkspace('ws-1')
    const { bridge, writes } = fakeBridge()
    const workspacePath = ref<string | undefined>('/ws')
    useSessionMetadataPersistence(workspacePath, () => bridge)

    agent.createSession()
    agent.createSession()
    agent.updateSessionTitle(agent.sessions[0].id, 'alpha')
    await nextTick()
    await vi.waitFor(() => { expect(writes.length).toBe(2) })
    expect(writes.map((w) => w.sessionId).sort()).toEqual(agent.sessions.map((s) => s.id).sort())
    expect(writes.find((w) => w.sessionId === agent.sessions[0].id)!.body.title).toBe('alpha')

    // One title edit → exactly one more write, for that session only.
    writes.length = 0
    agent.updateSessionTitle(agent.sessions[0].id, 'beta')
    await nextTick()
    await vi.waitFor(() => { expect(writes.length).toBe(1) })
    expect(writes[0].sessionId).toBe(agent.sessions[0].id)
    expect(writes[0].body.title).toBe('beta')

    // An unrelated reactive change (a NON-durable field moves, records
    // recompute but every durable value is equal) writes nothing.
    writes.length = 0
    agent.sessions[0].untitled = false
    await nextTick()
    expect(writes.length).toBe(0)
  })

  it('writes nothing without a workspace path', async () => {
    setActivePinia(createPinia())
    const agent = useAgentStore()
    agent.bindWorkspace('ws-1')
    const { bridge, writes } = fakeBridge()
    const workspacePath = ref<string | undefined>(undefined)
    useSessionMetadataPersistence(workspacePath, () => bridge)
    agent.createSession()
    await nextTick()
    expect(writes.length).toBe(0)
  })
})
