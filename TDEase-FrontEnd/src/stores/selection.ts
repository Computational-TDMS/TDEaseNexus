/**
 * Selection Module — unified scope entry point.
 *
 * Five select methods + clearRunFocus. Each method:
 *   1. Updates SelectionContext (with validity checks)
 *   2. Determines main tab projection
 *   3. Triggers file tree ↔ runs panel bidirectional highlight
 *   4. Manages SSE subscriptions (only active + selected run)
 *   5. Updates Agent focus
 *
 * Scattered state this replaces:
 *   - TaskPanel local logRunId
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { SelectionContext, MainTab } from '@/types/selection'
import { resolveMainTab } from '@/types/selection'
import { useWorkspaceStore } from './workspace'
import { useRunsStore } from './runs'
import {
  computeTreeSelection,
  type TreeSelectMeta,
  type VisibleTreeEntry,
} from '@/services/workspace/tree-selection'
import {
  probeRunFileStatuses,
  runIdFromWorkspacePath,
  runResultsDir,
  type RunFileStatus,
} from '@/services/workspace/run-file-status'
import { getTDEaseClient } from '@/services/backend/backend'
import { isDesktopFileOpsAvailable, desktopWorkspaceBridgeOptionally } from '@/services/workspace/desktopWorkspace'

export const useSelectionStore = defineStore('selection', () => {
  // ── State ──────────────────────────────────────────────────────────────────

  const runId = ref<string | undefined>(undefined)

  // ── Tree multi-select state ────────────────────────────────────────────────
  // `filePath` is retained as the *primary* selection (the last clicked node)
  // for backward compat with Studio.vue. Multi-select lives alongside in
  // `selectedTreePaths`; single-click keeps them in sync.
  const filePath = ref<string | undefined>(undefined)
  const selectedTreePaths = ref<Set<string>>(new Set())
  const treeSelectionAnchor = ref<string | null>(null)

  // ── Main-tab projection (§3.2) ─────────────────────────────────────────────
  // `mainTab` is the pure projection of SelectionContext. The user may pin a
  // different tab while a Run is selected; that override lives HERE, not in
  // local component state —
  // so there is a single source of truth for "what tab is shown". Any
  // selection change clears the override and re-runs the projection.
  const mainTabOverride = ref<MainTab | null>(null)

  function setMainTabOverride(tab: MainTab) {
    mainTabOverride.value = tab
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const workspaceStore = useWorkspaceStore()
  const runsStore = useRunsStore()

  function mappedRunPath(id: string): string | undefined {
    const item = runsStore.active.get(id) ?? runsStore.history.find((run) => run.id === id)
    return item?.workspaceRunPath
      || (item?.labels.source_run ? `runs/${item.labels.source_run}` : undefined)
  }

  /** Full SelectionContext derived from individual refs + workspace store. */
  const context = computed<SelectionContext>(() => ({
    workspaceId: workspaceStore.workspaceId || '',
    runId: runId.value,
    filePath: filePath.value,
  }))

  const mainTab = computed<MainTab>(() => resolveMainTab(context.value))

  /** The tab the Studio should actually display — user override wins, else the
   *  §3.2 projection. Components MUST read this, not re-derive it. */
  const activeMainTab = computed<MainTab>(() => mainTabOverride.value ?? mainTab.value)

  /** Whether the current Run scope is active. */
  const hasRunFocus = computed(() => !!runId.value)

  /**
   * §3.1 forward highlight: the `runs/<runId>/` directory in the file tree
   * that corresponds to the currently selected Run. Undefined when no Run is
   * selected. Consumed by FileTree/TreeNode to render a soft highlight + auto
   * -expand (the file→run half of the bidirectional link lives in selectFile).
   */
  const runResultsPath = computed<string | undefined>(() =>
    runId.value && mappedRunPath(runId.value) ? runResultsDir(mappedRunPath(runId.value)!) : undefined,
  )

  /**
   * §3.3 sync-status map for files inside the selected Run's `runs/<runId>/`
   * directory. Keyed by workspace-relative path. Only populated for the
   * currently selected Run; cleared on every selectRun / clearRunFocus.
   *
   *   cached    — local digest == server manifest ✓
   *   conflict  — local digest != server manifest ⚠
   *   cloud     — server has it, local doesn't ⇩
   */
  const runFileStatuses = ref<Map<string, RunFileStatus>>(new Map())

  /** Whether more than one tree node is currently selected. */
  const hasMultiSelection = computed(() => selectedTreePaths.value.size > 1)

  // ── Select methods ─────────────────────────────────────────────────────────

  function selectWorkspace() {
    runId.value = undefined
    filePath.value = undefined
    selectedTreePaths.value = new Set()
    treeSelectionAnchor.value = null
    mainTabOverride.value = null
    // `runFileStatuses` is keyed by the *previous* Workspace's paths (§3.3);
    // leaving it populated across a switch shows stale ⇩/✓/⚠ badges the
    // moment a same-named runs/<runId>/ path exists in the new Workspace.
    runFileStatuses.value = new Map()
  }

  function selectFile(path: string) {
    filePath.value = path
    // Keep the multi-select set in sync: a plain programmatic selectFile
    // collapses to a single selection.
    selectedTreePaths.value = new Set([path])
    treeSelectionAnchor.value = path
    mainTabOverride.value = null

    // Bidirectional: if path is under runs/<runId>/, highlight that Run.
    const owner = runIdFromWorkspacePath(path)
    if (owner) runId.value = owner
  }

  /**
   * Multi-aware tree click. Updates `selectedTreePaths`, `treeSelectionAnchor`,
   * and `filePath` (the primary). The visible-entry list is supplied by the
   * caller (FileTree) — pass `[]` to disable range semantics.
   */
  function selectTreePath(path: string, meta: TreeSelectMeta, visible: VisibleTreeEntry[] = []) {
    const result = computeTreeSelection(
      selectedTreePaths.value,
      treeSelectionAnchor.value,
      path,
      meta,
      visible,
    )
    selectedTreePaths.value = result.paths
    treeSelectionAnchor.value = result.anchor
    filePath.value = result.primary || undefined
    mainTabOverride.value = null

    // Bidirectional runs/<runId>/ highlight (only for single-select)
    if (selectedTreePaths.value.size === 1) {
      const owner = runIdFromWorkspacePath(path)
      if (owner) runId.value = owner
    }
  }

  /** Clear the multi-select set (e.g. blank-space click). */
  function clearTreeSelection() {
    selectedTreePaths.value = new Set()
    treeSelectionAnchor.value = null
    filePath.value = undefined
  }

  function selectRun(id: string) {
    runId.value = id
    mainTabOverride.value = null
    runFileStatuses.value = new Map()

  }


  function clearRunFocus() {
    runId.value = undefined
    mainTabOverride.value = null
    runFileStatuses.value = new Map()
  }

  // ── §3.3 sync-status computation ──────────────────────────────────────────
  //
  // When a Run is selected, fetch its server-side file manifest and compare
  // each entry's digest against the local `runs/<runId>/` copy. The result
  // populates `runFileStatuses`, which TreeNode renders as ⇩ / ✓ / ⚠ badges.
  //
  // Best-effort by design: digest computation requires the desktop bridge
  // (Electron); in browser dev mode we degrade to "cloud if local missing,
  // otherwise unknown" — never blocking the selection.

  /**
   * Assemble what `probeRunFileStatuses` needs, then hand it the decision.
   * Everything platform-specific stops here: the Backend client, the optional
   * Electron digest bridge, and the already-loaded tree state. The store keeps
   * the reactive slot; it no longer owns the comparison.
   */
  async function refreshRunFileStatuses(id: string) {
    // Stale-response guard, mirroring backendConnection's targetEpoch: capture
    // the requested run at entry and bail before every state write unless the
    // store still has that run selected — a slow chain for a previous Run (or
    // a previous Workspace, which clears runId) must not overwrite the fresh
    // statuses of the current one.
    const stale = () => runId.value !== id
    const workspaceRoot = workspaceStore.workspacePath
    if (!workspaceRoot || !id) {
      if (!stale()) runFileStatuses.value = new Map()
      return
    }

    // The digest bridge is Electron-only; browser dev mode simply has none,
    // which the probe's fallback already accounts for.
    let bridge:
      | {
          exists(root: string, path: string): Promise<boolean>
          sha256(root: string, path: string): Promise<string>
        }
      | undefined
    try {
      if (isDesktopFileOpsAvailable()) {
        bridge = desktopWorkspaceBridgeOptionally() ?? undefined
      }
    } catch { /* bridge optional */ }

    let directory = mappedRunPath(id)
    if (!directory) {
      try {
        const remote = await getTDEaseClient().status(id)
        directory = remote.workspace_run_path
          || (remote.labels.source_run ? `runs/${remote.labels.source_run}` : undefined)
      } catch { /* status failure is handled as an empty projection below */ }
    }
    if (!directory) {
      if (!stale()) runFileStatuses.value = new Map()
      return
    }
    directory = runResultsDir(directory)
    // A directory under runs/ is also where a person authors a draft. Until
    // run.json exists it has no persisted Run identity to query on the Backend,
    // so treating its directory name as a remote id only generates a guaranteed
    // 404 whenever the file tree selects an input in that draft.
    if (bridge) {
      try {
        if (!(await bridge.exists(workspaceRoot, `${directory}/run.json`))) {
          if (!stale()) runFileStatuses.value = new Map()
          return
        }
      } catch {
        if (!stale()) runFileStatuses.value = new Map()
        return
      }
    }

    const statuses = await probeRunFileStatuses(id, directory, {
      listRunFiles: (runId) => getTDEaseClient().listRunFiles(runId),
      localDigest: async (path) => {
        if (!bridge) return undefined
        try {
          if (!(await bridge.exists(workspaceRoot, path))) return undefined
          return await bridge.sha256(workspaceRoot, path)
        } catch {
          return undefined
        }
      },
      isKnownLocally: (path) => {
        const siblings = workspaceStore.directoryCache.get(directory)
        return !!siblings?.some((node) => `${directory}/${node.name}` === path)
      },
    })
    if (!stale()) runFileStatuses.value = statuses
  }

  watch(runId, (next) => {
    if (next) {
      void refreshRunFileStatuses(next)
    }
  })

  /**
   * Follow the Workspace the app is on, the way `documents.ts` / `runs.ts` /
   * `agent.ts` already do. `selectWorkspace()` was defined and exported but
   * had no caller anywhere in the app, so switching Workspaces left every
   * field here — runId, filePath, the tree multi-select set, runFileStatuses
   * — pointing at the previous Workspace with nothing to clear it.
   */
  watch(
    () => workspaceStore.workspaceId,
    (id, previous) => { if (id !== previous) selectWorkspace() },
    { immediate: true },
  )

  return {
    // state
    runId,
    filePath,
    selectedTreePaths,
    treeSelectionAnchor,
    runFileStatuses,
    // derived
    context,
    mainTab,
    activeMainTab,
    hasRunFocus,
    hasMultiSelection,
    runResultsPath,
    // actions
    selectWorkspace,
    selectFile,
    selectTreePath,
    clearTreeSelection,
    selectRun,
    clearRunFocus,
    setMainTabOverride,
    refreshRunFileStatuses,
  }
})
