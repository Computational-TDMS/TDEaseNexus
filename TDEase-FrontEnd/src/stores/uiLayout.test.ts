import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { UiStateRepository } from '@/studio/ports/ui-state-repository'
import { useUiLayoutStore } from './uiLayout'

function createFakeRepository(initial: Record<string, unknown> = {}): UiStateRepository {
  const store = new Map<string, unknown>(Object.entries(initial))
  return {
    read: <T>(_workspaceId: string, key: string, fallback: T): T => {
      return store.has(key) ? (store.get(key) as T) : fallback
    },
    write: <T>(_workspaceId: string, key: string, value: T): void => {
      store.set(key, value)
    },
    clear: (): void => {
      store.clear()
    },
  }
}

describe('useUiLayoutStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.documentElement.dataset.density = ''
  })

  it('has the defaults', () => {
    const store = useUiLayoutStore()
    expect(store.activePage).toBe('agent')
    expect(store.navigatorCollapsed).toBe(false)
    expect(store.panelVisible).toBe(false)
    expect(store.panelPosition).toBe('bottom')
    expect(store.panelMaximized).toBe(false)
    expect(store.agentSidebarCollapsed).toBe(true)
    expect(store.activeNavigatorSection).toBe('runs')
    expect(store.density).toBe('comfortable')
  })

  it('hydrates state from a fake repository', () => {
    const repo = createFakeRepository({
      activeNavigatorSection: 'files',
      density: 'compact',
      panelVisible: true,
      activityTab: 'logs',
      // A stored page exists from older builds; it must NOT win — every
      // hydrate/boot lands on the Agent page regardless.
      activePage: 'workbench',
      agentSidebarCollapsed: false,
      agentSidebarWidth: 400,
    })
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)

    expect(store.activeNavigatorSection).toBe('files')
    expect(store.density).toBe('compact')
    expect(store.panelVisible).toBe(true)
    expect(store.activityTab).toBe('logs')
    expect(store.activePage).toBe('agent')
    expect(store.agentSidebarCollapsed).toBe(false)
    expect(store.agentSidebarWidth).toBe(400)
  })

  it('migrates the legacy panel keys in place', () => {
    const repo = createFakeRepository({
      activityCollapsed: false,
      activityHeight: 300,
    })
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)

    expect(store.panelVisible).toBe(true)
    expect(store.panelSize).toBe(300)
  })

  it('falls back to defaults for missing keys during hydrate', () => {
    const repo = createFakeRepository({})
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)

    expect(store.activeNavigatorSection).toBe('runs')
    expect(store.activePage).toBe('agent')
  })

  it('falls back per field when persisted layout values violate the current schema', () => {
    const repo = createFakeRepository({
      // 'canvases' was a Navigator section in an older schema; it must fall
      // back to the default instead of surfacing a dead tab.
      activeNavigatorSection: 'canvases',
      density: 'dense',
      activityTab: 'console',
      panelPosition: 'left',
    })
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)

    expect(store.activeNavigatorSection).toBe('runs')
    expect(store.density).toBe('comfortable')
    expect(store.activityTab).toBe('runs')
    expect(store.panelPosition).toBe('bottom')
  })

  it('persist() writes current state back through the bound repository', () => {
    const repo = createFakeRepository()
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)
    store.setNavigatorWidth(380)
    store.setActiveNavigatorSection('wiki')
    store.setPanelPosition('right')
    store.setActivePage('workbench')
    store.persist()

    expect(repo.read('ws-1', 'navigatorWidth', 0)).toBe(380)
    expect(repo.read('ws-1', 'activeNavigatorSection', 'files')).toBe('wiki')
    expect(repo.read('ws-1', 'panelPosition', 'bottom')).toBe('right')
    // activePage is boot-time state, not persisted layout: it must never be
    // written (and thus never resurrected on the next entry).
    expect(repo.read('ws-1', 'activePage', 'not-persisted')).toBe('not-persisted')
  })

  it('persist() is a no-op before hydrate() has bound a workspace', () => {
    const store = useUiLayoutStore()
    expect(() => store.persist()).not.toThrow()
  })

  it('setDensity writes document.documentElement.dataset.density', () => {
    const store = useUiLayoutStore()
    store.setDensity('compact')
    expect(document.documentElement.dataset.density).toBe('compact')

    store.setDensity('comfortable')
    expect(document.documentElement.dataset.density).toBe('comfortable')
  })

  it('clamps panel size into the active axis range and re-clamps on position switch', () => {
    const store = useUiLayoutStore()
    store.setPanelSize(10)
    expect(store.panelSize).toBe(120)
    store.setPanelSize(9999)
    expect(store.panelSize).toBe(480)

    store.setPanelPosition('right')
    store.setPanelSize(9999)
    expect(store.panelSize).toBe(560)
  })

  it('togglePanelVisible flips the panel and drops a maximized state with it', () => {
    const store = useUiLayoutStore()
    store.togglePanelVisible()
    expect(store.panelVisible).toBe(true)
    store.togglePanelMaximized()
    expect(store.panelMaximized).toBe(true)

    store.togglePanelVisible()
    expect(store.panelVisible).toBe(false)
    expect(store.panelMaximized).toBe(false)
  })

  it('toggleAgentSidebar flips the Workbench right dock', () => {
    const store = useUiLayoutStore()
    expect(store.agentSidebarCollapsed).toBe(true)
    store.toggleAgentSidebar()
    expect(store.agentSidebarCollapsed).toBe(false)
    store.setAgentSidebarWidth(9999)
    expect(store.agentSidebarWidth).toBe(440)
  })

  it('captures a size ratio when a container size is given and persists it', () => {
    const repo = createFakeRepository()
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)
    store.setNavigatorWidth(380, 1000)
    store.setPanelSize(240, 800)
    store.setAgentSidebarWidth(320, 1280)
    store.persist()

    expect(repo.read('ws-1', 'navigatorWidthRatio', 0)).toBeCloseTo(0.38)
    expect(repo.read('ws-1', 'panelSizeRatio', 0)).toBeCloseTo(0.3)
    expect(repo.read('ws-1', 'agentSidebarWidthRatio', 0)).toBeCloseTo(0.25)
  })

  it('restores dock sizes proportionally from a stored ratio, then clamps', () => {
    // jsdom's window.innerWidth (1024) × 0.5 = 512 → clamped to the 420 max.
    const repo = createFakeRepository({ navigatorWidthRatio: 0.5 })
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)

    expect(store.navigatorWidth).toBe(420)
  })

  it('hydrate restores the ratio refs themselves so persist cannot clobber them', () => {
    const repo = createFakeRepository({ navigatorWidthRatio: 0.5, panelSizeRatio: 0.3 })
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)
    store.persist()

    expect(repo.read('ws-1', 'navigatorWidthRatio', 0)).toBeCloseTo(0.5)
    expect(repo.read('ws-1', 'panelSizeRatio', 0)).toBeCloseTo(0.3)
  })

  it('does not capture a ratio from a collapse artifact (px below the range minimum)', () => {
    // A sash snap emits size 0; clamped into the range it becomes 240 —
    // persisting that as the dock's proportion would corrupt the memory of
    // the expanded size the collapse is meant to preserve.
    const repo = createFakeRepository()
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)
    store.setNavigatorWidth(380, 1000)
    store.setNavigatorWidth(0, 1000)
    store.persist()

    expect(store.navigatorWidth).toBe(240)
    expect(repo.read('ws-1', 'navigatorWidthRatio', 0)).toBeCloseTo(0.38)
  })

  it('falls back to legacy px when the stored ratio is missing or out of range', () => {
    const repo = createFakeRepository({ navigatorWidth: 380, panelSizeRatio: 4.2 })
    const store = useUiLayoutStore()

    store.hydrate('ws-1', repo)

    expect(store.navigatorWidth).toBe(380)
    // An out-of-range ratio must not poison the refs (persist writes 0 back).
    store.setPanelSize(200, 1000)
    store.persist()
    expect(repo.read('ws-1', 'panelSizeRatio', 0)).toBeCloseTo(0.2)
  })

  it('direct collapse setters aim the same flags the toggles use', () => {
    const store = useUiLayoutStore()

    store.setNavigatorCollapsed(true)
    expect(store.navigatorCollapsed).toBe(true)

    store.togglePanelVisible()
    store.togglePanelMaximized()
    store.setPanelVisible(false)
    expect(store.panelVisible).toBe(false)
    expect(store.panelMaximized).toBe(false)
    store.setPanelVisible(true)
    expect(store.panelVisible).toBe(true)

    store.setAgentSidebarCollapsed(false)
    expect(store.agentSidebarCollapsed).toBe(false)
  })
})
