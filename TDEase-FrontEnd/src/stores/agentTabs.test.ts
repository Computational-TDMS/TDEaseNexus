import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentTabsStore } from './agentTabs'

describe('useAgentTabsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts empty with no active tab', () => {
    const store = useAgentTabsStore()
    expect(store.tabs).toHaveLength(0)
    expect(store.activeId).toBeNull()
    expect(store.active).toBeNull()
  })

  it('opens a file tab and selects it', () => {
    const store = useAgentTabsStore()
    const id = store.open(
      { kind: 'agent-file', workspaceId: 'ws-1' as never, path: 'results/plot.png' as never },
      { title: 'plot.png' },
    )
    expect(store.tabs).toHaveLength(1)
    expect(store.activeId).toBe(id)
    expect(store.active?.title).toBe('plot.png')
  })

  it('singleton kinds collapse: opening subagents twice keeps one tab', () => {
    const store = useAgentTabsStore()
    const a = store.open({ kind: 'agent-files' }, { title: 'Subagents' })
    const b = store.open({ kind: 'agent-files' }, { title: 'Subagents' })
    expect(a).toBe(b)
    expect(store.tabs).toHaveLength(1)
  })

  it('two different files are two tabs', () => {
    const store = useAgentTabsStore()
    store.open({ kind: 'agent-file', workspaceId: 'ws-1' as never, path: 'a.png' as never }, { title: 'a' })
    store.open({ kind: 'agent-file', workspaceId: 'ws-1' as never, path: 'b.png' as never }, { title: 'b' })
    expect(store.tabs).toHaveLength(2)
  })

  it('select focuses a tab and updates MRU', () => {
    const store = useAgentTabsStore()
    const a = store.open({ kind: 'agent-plan' }, { title: 'Plan' })
    const b = store.open({ kind: 'agent-files' }, { title: 'Subagents' })
    expect(store.activeId).toBe(b)
    store.select(a)
    expect(store.activeId).toBe(a)
    expect(store.mru[0]).toBe(a)
  })

  it('close falls back to the most-recently-focused remaining tab', () => {
    const store = useAgentTabsStore()
    const a = store.open({ kind: 'agent-plan' }, { title: 'Plan' })
    const b = store.open({ kind: 'agent-files' }, { title: 'Subagents' })
    store.close(b)
    expect(store.tabs).toHaveLength(1)
    expect(store.activeId).toBe(a)
  })

  it('close with no remaining tab leaves no active', () => {
    const store = useAgentTabsStore()
    const a = store.open({ kind: 'agent-plan' }, { title: 'Plan' })
    store.close(a)
    expect(store.tabs).toHaveLength(0)
    expect(store.activeId).toBeNull()
  })

  it('reset clears everything (session switch)', () => {
    const store = useAgentTabsStore()
    store.open({ kind: 'agent-plan' }, { title: 'Plan' })
    store.open({ kind: 'agent-files' }, { title: 'Subagents' })
    store.reset()
    expect(store.tabs).toHaveLength(0)
    expect(store.activeId).toBeNull()
    expect(store.mru).toHaveLength(0)
  })

  it('orderedTabs is in open order', () => {
    const store = useAgentTabsStore()
    const a = store.open({ kind: 'agent-plan' }, { title: 'Plan' })
    const b = store.open({ kind: 'agent-files' }, { title: 'Subagents' })
    const c = store.open({ kind: 'agent-evidence' }, { title: 'Evidence' })
    expect(store.orderedTabs.map((t) => t.id)).toEqual([a, b, c])
  })
})

describe('useAgentTabsStore — capsule/host toggle logic', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('empty store ⇒ capsule state (no tabs)', () => {
    const store = useAgentTabsStore()
    expect(store.tabs.length > 0).toBe(false) // → capsule renders
  })

  it('opening a tab ⇒ host state (tabs present)', () => {
    const store = useAgentTabsStore()
    store.open({ kind: 'agent-files' }, { title: 'Subagents' })
    expect(store.tabs.length > 0).toBe(true) // → host renders
  })

  it('closing the last tab ⇒ returns to capsule state', () => {
    const store = useAgentTabsStore()
    const id = store.open({ kind: 'agent-files' }, { title: 'Subagents' })
    expect(store.tabs.length > 0).toBe(true)
    store.close(id)
    expect(store.tabs.length > 0).toBe(false) // → capsule renders again
  })
})
