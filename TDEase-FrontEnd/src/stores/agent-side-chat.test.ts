import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'
import { parseSessionMetadata } from '@/services/agent/agentSessionStorage'

// agent.ts imports the desktop bridges at module scope; keep them inert so the
// store under test never reaches Electron.
vi.mock('@/services/desktop/desktopBridge', () => ({
  desktopAgentBridge: () => undefined,
}))
vi.mock('@/services/workspace/desktopWorkspace', () => ({
  getDesktopFileOps: () => { throw new Error('no desktop bridge in tests') },
}))

describe('side chat session kernel', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('spawns a side session that never takes the active slot or the main lists', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const parent = store.createSession()

    const side = store.createSideSession(parent.id)

    expect(side.sideOf).toBe(parent.id)
    // The main view must not jump to the child.
    expect(store.activeId).toBe(parent.id)
    expect(store.active?.id).toBe(parent.id)
    // And neither main list shows it.
    expect(store.sessions.map((s) => s.id)).not.toContain(side.id)
    expect(store.archivedSessions.map((s) => s.id)).not.toContain(side.id)
    expect(store.sideSessionsOf(parent.id).map((s) => s.id)).toEqual([side.id])
  })

  it('refuses side-of-side and unknown parents', () => {
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const parent = store.createSession()
    const side = store.createSideSession(parent.id)

    expect(() => store.createSideSession(side.id)).toThrow(/side chats/)
    expect(() => store.createSideSession('s_missing')).toThrow(/unknown session/)
  })

  it('archiving the parent leaves its side sessions alone (independent lifecycles)', () => {
    // The side chat archives through its own panel's close; the parent's
    // archive is a list-level flag. Neither touches the other. (There is no
    // delete at all: archive is the only exit — a session's log is work the
    // user can never reproduce.)
    const store = useAgentStore()
    store.bindWorkspace('ws_1')
    const parent = store.createSession()
    const side = store.createSideSession(parent.id)

    store.archiveSession(parent.id)

    expect(store.archivedSessions.map((s) => s.id)).toContain(parent.id)
    expect(store.allSessions.some((s) => s.id === side.id)).toBe(true)
    expect(store.sideSessionsOf(parent.id).map((s) => s.id)).toEqual([side.id])
    expect(store.sideSessions[0]?.archived).toBeFalsy()
  })

  it('the store exposes no delete path for sessions', () => {
    // The removal is a product contract, not just a missing button: archive
    // is the only exit, so nothing — component, devtools, future code — can
    // reach an unrecoverable destroy through this store.
    const store = useAgentStore()
    expect((store as Record<string, unknown>).deleteSession).toBeUndefined()
  })

  it('metadata round-trips sideOf through the session record parser', () => {
    const base = {
      version: 1 as const,
      id: 's_child',
      title: 'Ask about selection',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      mindset: 'explorer' as const,
    }
    expect(parseSessionMetadata({ ...base, sideOf: 's_parent' }, 's_child').sideOf).toBe('s_parent')
    expect(parseSessionMetadata(base, 's_child').sideOf).toBeUndefined()
    // An empty/invalid sideOf is rejected rather than silently detaching the child.
    expect(() => parseSessionMetadata({ ...base, sideOf: '' }, 's_child')).toThrow(/sideOf/)
    expect(() => parseSessionMetadata({ ...base, sideOf: '../escape' }, 's_child')).toThrow(/sideOf/)
  })
})
