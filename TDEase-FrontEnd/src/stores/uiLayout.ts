// uiLayout — the Pinia layout projection for the Client shell.
//
// This is view state, not truth (STUDIO-FRONTEND-BUSINESS-LOGIC.md §15.6):
// pane widths, collapse flags, the active page and panel placement change no
// domain fact and the Agent has no reason to invoke them. Deleting it loses
// nothing but layout (§9.2) — so this store never registers a command and
// never imports `studio/commands`.
//
// Shell model: the two-page track (workbench / agent) driven by `activePage`
// and switched by the door handle; the Workbench page owns the Navigator
// column, the editor grid, the movable panel (bottom|right, maximizable) and
// the right-docked Agent sidebar.
//
// Dock size memory (px + proportion, restore, persist keys) lives in the
// deep module `./dockLayout` — one DockMemory per dock. This store composes
// them and owns the flags. The persisted-field inventory below is the ONE
// list: persist() writes it and `persistSignature` digests it (AppShell
// watches the signature), so a new field is declared exactly once.

import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { createDockMemory } from './dockLayout'
import { createLocalUiStateRepository } from '@/services/storage/uiStateRepository'
import type { UiStateRepository } from '@/studio/ports/ui-state-repository'
import { useWorkspaceStore } from './workspace'

/** WHERE YOU ARE — the whole working surface the track is showing. */
export type AppPage = 'workbench' | 'agent'
export type NavigatorSection = 'runs' | 'wiki' | 'files'
export type PanelPosition = 'bottom' | 'right'
export type Density = 'comfortable' | 'compact'
export type ActivityTab = 'runs' | 'logs'

export const NAVIGATOR_WIDTH_RANGE = { min: 240, max: 420 }
export const AGENT_SESSIONS_WIDTH_RANGE = { min: 220, max: 380 }
// Panel: height when docked bottom, width when docked right.
export const PANEL_BOTTOM_RANGE = { min: 120, max: 480 }
export const PANEL_RIGHT_RANGE = { min: 280, max: 560 }
// The Workbench's right-docked Agent sidebar (a second view of the one
// conversation; see agentConversation.ts).
export const AGENT_SIDEBAR_WIDTH_RANGE = { min: 240, max: 440 }

const DEFAULTS = {
  navigatorWidth: 320,
  navigatorCollapsed: false,
  agentSessionsWidth: 260,
  panelVisible: false,
  panelSize: 260,
  panelPosition: 'bottom' as PanelPosition,
  panelMaximized: false,
  // The Agent page is the front door: every boot lands there. Deliberately
  // NOT persisted — where the track rests is a product decision, not layout
  // memory, so a stored page must never override the landing page.
  activePage: 'agent' as AppPage,
  // Runs (work product) is the default Navigator section, not Files: a user
  // lands focused on what runs PRODUCED, not on raw file noise. Files — the
  // full tree including skill/config/data for advanced control — is the last
  // tab, reached by an explicit click.
  activeNavigatorSection: 'runs' as NavigatorSection,
  density: 'comfortable' as Density,
  activityTab: 'runs' as ActivityTab,
  // The Agent sidebar starts closed: opt-in chrome.
  agentSidebarCollapsed: true,
  agentSidebarWidth: 320,
} as const

function storedNumber(repo: UiStateRepository, workspaceId: string, key: string, fallback: number): number {
  const value = repo.read<unknown>(workspaceId, key, fallback)
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function storedBoolean(repo: UiStateRepository, workspaceId: string, key: string, fallback: boolean): boolean {
  const value = repo.read<unknown>(workspaceId, key, fallback)
  return typeof value === 'boolean' ? value : fallback
}

function storedEnum<T extends string>(
  repo: UiStateRepository,
  workspaceId: string,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = repo.read<unknown>(workspaceId, key, fallback)
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback
}

const defaultRepository = createLocalUiStateRepository()

export const useUiLayoutStore = defineStore('uiLayout', () => {
  // --- Panel (Runs/Logs dock): movable and maximizable ----------------------
  const panelVisible = ref<boolean>(DEFAULTS.panelVisible)
  const panelPosition = ref<PanelPosition>(DEFAULTS.panelPosition)
  const panelMaximized = ref<boolean>(DEFAULTS.panelMaximized)

  // --- Docks: size memory delegated to the dockLayout module ----------------
  const docks = {
    navigator: createDockMemory({
      pxKey: 'navigatorWidth',
      ratioKey: 'navigatorWidthRatio',
      range: () => NAVIGATOR_WIDTH_RANGE,
      defaultPx: DEFAULTS.navigatorWidth,
    }),
    panel: createDockMemory({
      pxKey: 'panelSize',
      ratioKey: 'panelSizeRatio',
      // The axis — and so the bounds — follows the dock side.
      range: () => (panelPosition.value === 'right' ? PANEL_RIGHT_RANGE : PANEL_BOTTOM_RANGE),
      defaultPx: DEFAULTS.panelSize,
      legacyPxKeys: ['activityHeight'],
    }),
    agentSidebar: createDockMemory({
      pxKey: 'agentSidebarWidth',
      ratioKey: 'agentSidebarWidthRatio',
      range: () => AGENT_SIDEBAR_WIDTH_RANGE,
      defaultPx: DEFAULTS.agentSidebarWidth,
    }),
  }
  const navigatorWidth = docks.navigator.px
  const panelSize = docks.panel.px
  const agentSidebarWidth = docks.agentSidebar.px

  const navigatorCollapsed = ref<boolean>(DEFAULTS.navigatorCollapsed)
  const agentSessionsWidth = ref<number>(DEFAULTS.agentSessionsWidth)

  const activePage = ref<AppPage>(DEFAULTS.activePage)
  const activeNavigatorSection = ref<NavigatorSection>(DEFAULTS.activeNavigatorSection)
  const density = ref<Density>(DEFAULTS.density)
  const activityTab = ref<ActivityTab>(DEFAULTS.activityTab)
  // Which Run the panel's Logs tab shows. Session-scoped on purpose: it points
  // at run ids that stop existing across Workspace switches, so it is never
  // persisted and the panel falls back to its newest run when the id is stale.
  const activityRunId = ref('')
  const agentSidebarCollapsed = ref<boolean>(DEFAULTS.agentSidebarCollapsed)

  // Bound at hydrate() time; persist() writes back through the same pair.
  let repository: UiStateRepository = defaultRepository
  let boundWorkspaceId: string | null = null

  function setNavigatorWidth(px: number, containerSize = 0) {
    docks.navigator.setPx(px, containerSize)
  }

  function setAgentSessionsWidth(px: number) {
    agentSessionsWidth.value = Math.min(
      Math.max(px, AGENT_SESSIONS_WIDTH_RANGE.min),
      AGENT_SESSIONS_WIDTH_RANGE.max,
    )
  }

  function setPanelSize(px: number, containerSize = 0) {
    docks.panel.setPx(px, containerSize)
  }

  function setNavigatorCollapsed(value: boolean) {
    navigatorCollapsed.value = value
  }

  function setPanelVisible(value: boolean) {
    // Closing the panel also drops its maximized state — restore semantics
    // belong to the open panel, not the next open (same rule as toggle).
    panelMaximized.value = false
    panelVisible.value = value
  }

  function setAgentSidebarCollapsed(value: boolean) {
    agentSidebarCollapsed.value = value
  }

  function toggleNavigatorCollapsed() {
    navigatorCollapsed.value = !navigatorCollapsed.value
  }

  function togglePanelVisible() {
    // Closing the panel also drops its maximized state — restore semantics
    // belong to the open panel, not the next open.
    panelMaximized.value = false
    panelVisible.value = !panelVisible.value
  }

  function setPanelPosition(position: PanelPosition) {
    if (panelPosition.value === position) return
    panelPosition.value = position
    // Re-clamp into the new axis's range: the stored px meant height, now it
    // means width (or vice versa) and the ranges differ. No container is in
    // hand here, so no ratio capture happens — the next real drag recaptures.
    docks.panel.setPx(panelSize.value, 0)
  }

  function togglePanelMaximized() {
    if (!panelVisible.value) panelVisible.value = true
    panelMaximized.value = !panelMaximized.value
  }

  function setActivePage(page: AppPage) {
    activePage.value = page
  }

  function setActiveNavigatorSection(section: NavigatorSection) {
    activeNavigatorSection.value = section
  }

  function setActivityTab(tab: ActivityTab) {
    activityTab.value = tab
  }

  /** Jump the panel to a Run's log, expanding it if the user had it closed. */
  function showRunLog(runId: string) {
    activityRunId.value = runId
    activityTab.value = 'logs'
    panelVisible.value = true
  }

  function toggleAgentSidebar() {
    agentSidebarCollapsed.value = !agentSidebarCollapsed.value
  }

  function setAgentSidebarWidth(px: number, containerSize = 0) {
    docks.agentSidebar.setPx(px, containerSize)
  }

  function setDensity(next: Density) {
    density.value = next
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.density = next
    }
  }

  /**
   * Restores layout for a Workspace. Every value is read defensively by the
   * repository, so a first run / cleared cache / corrupt entry all fall back
   * to the defaults, never to a thrown error.
   *
   * Legacy keys (`activityCollapsed`/`activityHeight` for the panel) are read
   * as fallbacks so an existing workspace keeps its open regions and sizes —
   * the panel's legacy px key is declared on its DockMemory spec.
   * NOTE: assignments only — never route a stored value through an action
   * with side effects (the 2026-09-10 boot bug: a restore branch inside an
   * action forced the agent dock open on every fresh boot).
   *
   * `repo` defaults to the shared localStorage-backed repository; tests pass
   * a fake to avoid touching real storage.
   */
  function hydrate(workspaceId: string, repo: UiStateRepository = defaultRepository) {
    repository = repo
    boundWorkspaceId = workspaceId

    const legacyActivityCollapsed = storedBoolean(repo, workspaceId, 'activityCollapsed', true)

    // Proportional restore (VSCode's SplitView proportions): the dock ratio
    // maps onto the CURRENT window axis before the range clamp, so the layout
    // comes back proportional on any window size. Window-based estimates: the
    // workbench page spans the window minus the icon rail, and the panel's
    // axis depends on its dock side — close enough for a clamp either way.
    const windowWidth = typeof window === 'undefined' ? 0 : window.innerWidth
    const windowHeight = typeof window === 'undefined' ? 0 : window.innerHeight

    docks.navigator.restore(repo, workspaceId, windowWidth)
    navigatorCollapsed.value = storedBoolean(repo, workspaceId, 'navigatorCollapsed', DEFAULTS.navigatorCollapsed)
    setAgentSessionsWidth(storedNumber(repo, workspaceId, 'agentSessionsWidth', DEFAULTS.agentSessionsWidth))
    // The panel's ratio rides its own axis, so the dock side must be known first.
    setPanelPosition(storedEnum(repo, workspaceId, 'panelPosition', ['bottom', 'right'], DEFAULTS.panelPosition))
    docks.panel.restore(repo, workspaceId, panelPosition.value === 'right' ? windowWidth : windowHeight)
    panelVisible.value = storedBoolean(repo, workspaceId, 'panelVisible', !legacyActivityCollapsed)
    panelMaximized.value = storedBoolean(repo, workspaceId, 'panelMaximized', DEFAULTS.panelMaximized)
    // activePage is not restored: a fresh boot always lands on the Agent page
    // (see DEFAULTS). An in-session Workspace switch keeps the current page —
    // hydrate only runs again through the workspaceId watch, and leaving the
    // ref untouched preserves where the user is.
    setActiveNavigatorSection(storedEnum(
      repo, workspaceId, 'activeNavigatorSection', ['runs', 'wiki', 'files'], DEFAULTS.activeNavigatorSection,
    ))
    setDensity(storedEnum(repo, workspaceId, 'density', ['comfortable', 'compact'], DEFAULTS.density))
    activityTab.value = storedEnum(repo, workspaceId, 'activityTab', ['runs', 'logs'], DEFAULTS.activityTab)
    docks.agentSidebar.restore(repo, workspaceId, windowWidth)
    agentSidebarCollapsed.value = storedBoolean(
      repo, workspaceId, 'agentSidebarCollapsed', DEFAULTS.agentSidebarCollapsed,
    )
  }

  // ── The persisted-field inventory (write it, digest it) ────────────────────
  // persist() writes exactly these entries; `persistSignature` digests exactly
  // these entries. AppShell watches the signature — a field is added here
  // once, and both behaviors follow.

  function persistedEntries(): Array<[string, unknown]> {
    return [
      ...docks.navigator.entries(),
      ['navigatorCollapsed', navigatorCollapsed.value],
      ['agentSessionsWidth', agentSessionsWidth.value],
      ...docks.panel.entries(),
      ['panelVisible', panelVisible.value],
      ['panelPosition', panelPosition.value],
      ['panelMaximized', panelMaximized.value],
      ['activeNavigatorSection', activeNavigatorSection.value],
      ['density', density.value],
      ['activityTab', activityTab.value],
      ...docks.agentSidebar.entries(),
      ['agentSidebarCollapsed', agentSidebarCollapsed.value],
    ]
  }

  const persistSignature = computed(() => JSON.stringify(persistedEntries()))

  /** Persists current layout through the repository bound at hydrate() time. */
  function persist() {
    if (!boundWorkspaceId) return
    const workspaceId = boundWorkspaceId
    for (const [key, value] of persistedEntries()) {
      repository.write(workspaceId, key, value)
    }
  }

  /**
   * Follow the Workspace the app is on, the way `documents.ts` / `runs.ts` /
   * `agent.ts` already do: a later in-session switch (no remount) must re-bind
   * the storage key, or persists keep writing the new Workspace's layout under
   * the old Workspace's key. Passing the already-bound `repository` through
   * keeps this a no-op for the test seam.
   */
  const workspaceStore = useWorkspaceStore()
  watch(
    () => workspaceStore.workspaceId,
    (id, previous) => { if (id && id !== previous) hydrate(id, repository) },
  )

  return {
    navigatorWidth,
    navigatorCollapsed,
    agentSessionsWidth,
    panelVisible,
    panelSize,
    panelPosition,
    panelMaximized,
    activePage,
    activeNavigatorSection,
    density,
    activityTab,
    activityRunId,
    agentSidebarCollapsed,
    agentSidebarWidth,
    persistSignature,
    setNavigatorWidth,
    setAgentSessionsWidth,
    setPanelSize,
    setNavigatorCollapsed,
    setPanelVisible,
    setAgentSidebarCollapsed,
    toggleNavigatorCollapsed,
    togglePanelVisible,
    setPanelPosition,
    togglePanelMaximized,
    setActivePage,
    setActiveNavigatorSection,
    setActivityTab,
    showRunLog,
    toggleAgentSidebar,
    setAgentSidebarWidth,
    setDensity,
    hydrate,
    persist,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUiLayoutStore, import.meta.hot))
}
