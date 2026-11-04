/** Thin Pinia projection over the Studio Run repository. */

import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { studioInfrastructure } from '@/services/backend/studioInfrastructure'
import { contextFor } from '@/services/agent/permissionMode'
import { resolvePermission } from '@/services/agent/permissionResolver'
import { asRunId, asWorkspaceId } from '@/studio/domain/identity'
import type { RunSummary, TrashedRunSummary } from '@/studio/domain/run'
import { RunRepository, type RunRepositorySnapshot } from '@/studio/runtime/run-repository'
import { createStudioRunSurface } from '@/studio/runtime/run-surface'
import { CommandRegistry, type CommandContext } from '@/studio/commands/registry'
import { createStudioCommandRegistry } from '@/studio/commands/definitions'
import type { BackendGateway } from '@/studio/ports/backend-gateway'
import type { PermissionGateway } from '@/studio/ports/permission-gateway'
import { useWorkspaceStore } from './workspace'
import { useSettingsStore } from './settings'
import { createSystemTemplateCatalog } from '@/services/catalog/systemTemplateCatalog'
import { subscribeDesktopRunsInvalidation } from '@/services/desktop/desktopBridge'

const PAGE_SIZE = 50

// Every Run mutation (cancel / resume / overwrite / trash / restore) is
// routed through this registry rather than calling the repository or the
// backend client directly (STUDIO-FRONTEND-BUSINESS-
// LOGIC.md §15): that is what makes the permission gate and the provenance
// ledger apply to a button click exactly the way they apply to an Agent
// tool call. The registry is stateless configuration, shared across every
// Workspace this store attaches to.
const commandRegistry: CommandRegistry = createStudioCommandRegistry()

export const useRunsStore = defineStore('runs', () => {
  // One Run representation past the gateway seam: the store projects the
  // domain RunSummary the repository already holds — the old wire-shaped
  // RunInfo copy (and its inverse toRunInfoProjection) is gone, so a Run
  // field changes in exactly one place (the gateway mapping).
  const active = ref<Map<string, RunSummary>>(new Map())
  const history = ref<RunSummary[]>([])
  const connected = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const historyTotal = ref(0)
  const historyHasMore = ref(false)
  const trashed = ref<TrashedRunSummary[]>([])

  let repository: RunRepository | null = null
  let gateway: BackendGateway | null = null
  let stopProjection: (() => void) | null = null
  let currentWorkspaceId = ''
  // Monotonic epoch, bumped on every attach/detach. A slow `loadRuns` /
  // `loadMoreHistory` from a previous Workspace (or a previous attach of the
  // same one) must not clobber the fresh attach's `loading` / `error` /
  // `connected` flags when it resolves last — the same stale-response guard
  // selection.ts and backendConnection's targetEpoch use. The repository
  // dedupes identical in-flight queries but does not order distinct ones.
  let loadEpoch = 0

  const runningCount = computed(() =>
    Array.from(active.value.values()).filter((run) => run.status === 'RUNNING').length,
  )
  const queuedCount = computed(() =>
    Array.from(active.value.values()).filter((run) => run.status === 'QUEUED').length,
  )

  function init(workspaceId: string) {
    teardown()
    loadEpoch++
    // One assembly point owns which client, which actor, and the shared
    // subscription multiplexer -- this store just takes what it is given.
    const infrastructure = studioInfrastructure()
    gateway = infrastructure.gateway
    repository = infrastructure.runRepository
    currentWorkspaceId = workspaceId
    stopProjection = repository.onChange(applySnapshot)
    connected.value = false
  }

  function teardown() {
    loadEpoch++
    stopProjection?.()
    stopProjection = null
    repository = null
    gateway = null
    connected.value = false
    currentWorkspaceId = ''
    applySnapshot({ runs: new Map(), ranges: new Map(), trash: [], total: 0, offset: 0, limit: PAGE_SIZE, hasMore: false })
  }

  async function loadRuns(workspaceId = currentWorkspaceId) {
    if (!useSettingsStore().backendConnected) return
    if (!repository) return
    const epoch = loadEpoch
    await withLoading(() => repository!.load({ workspaceId: workspaceId || undefined, offset: 0, limit: PAGE_SIZE }))
    // A load for a Workspace this store has since detached from must not
    // flip `connected` for the current attach.
    if (epoch !== loadEpoch || workspaceId !== currentWorkspaceId) return
    connected.value = !error.value
  }

  async function ensureLoaded() {
    const workspaceId = useWorkspaceStore().workspaceId
    if (!useSettingsStore().backendConnected) return
    if (!repository && workspaceId) init(workspaceId)
    await loadRuns(workspaceId)
  }

  async function loadMoreHistory() {
    if (!useSettingsStore().backendConnected) return
    if (!repository || loading.value || !historyHasMore.value) return
    await withLoading(() => repository!.loadMore({ workspaceId: currentWorkspaceId || undefined, limit: PAGE_SIZE }))
  }

  async function cancel(runId: string) {
    await invoke('runs.cancel', { runId })
  }

  async function rerun(runId: string, mode: 'resume' | 'overwrite') {
    await invoke(mode === 'resume' ? 'runs.resume' : 'runs.overwrite', { runId })
  }

  async function trash(runId: string) {
    await invoke('runs.trash', { runId })
  }

  async function restore(runId: string) {
    await invoke('runs.restore', { runId })
  }

  async function refreshRun(runId: string) { await repository?.refresh(asRunId(runId)) }

  /** Tail a Run log through this store's own gateway. The one read path the
   * Activity dock needs — keeping it here means a component never assembles
   * `studioInfrastructure()` itself (the components layer owns no composition
   * root; src/architecture.test.ts bans the import). */
  async function readRunLog(runId: string, lines = 200): Promise<string> {
    if (!gateway) throw new Error('The Run repository is not attached')
    return (await gateway.readLog(asRunId(runId), lines)).text
  }

  /** Every mutating Run action funnels through here — never the repository
   * directly. Kept as a single seam so nothing regains a bypass later. */
  async function invoke(commandId: string, args: Record<string, unknown>): Promise<unknown> {
    if (!currentWorkspaceId) throw new Error('No Workspace is attached to the Run surface')
    error.value = null
    try {
      return await commandRegistry.invoke(commandId, args, buildCommandContext())
    } catch (cause) {
      error.value = message(cause)
      throw cause
    }
  }

  function buildCommandContext(): CommandContext {
    const repo = repository
    const gw = gateway
    if (!repo || !gw) throw new Error('The Run repository is not attached')
    const templates = createSystemTemplateCatalog()
    const unsupported = (what: string) => async () => {
      throw new Error(`${what} is not available from the Run surface`)
    }
    return {
      studio: {
        // The shared surface factory over this store's own repository — the
        // same assembly the Agent's StudioRuntime uses, minus the Workspace
        // writer (pullFile refuses here) and the second file watcher it would
        // open. Mutations (cancel / rerun / trash / restore) fire onRunsChanged,
        // i.e. reload this store's projection; run ids resolve through
        // RunRepository.resolveRunId, so a Workspace run folder name works.
        runs: createStudioRunSurface({
          repository: repo,
          backend: gw,
          onRunsChanged: () => void loadRuns(currentWorkspaceId),
        }),
        // S5 Analysis Review is out of scope for the Run surface — throw
        // rather than silently no-op; nothing prepared here to discard.
        analysis: {
          inspect: unsupported('Inspecting a workflow'),
          validate: unsupported('Validating a workflow'),
          run: unsupported('Running a workflow'),
          prepare: unsupported('Preparing an analysis'),
          dryRun: unsupported('Dry-running an analysis'),
          submit: unsupported('Submitting an analysis'),
          discard: () => { /* nothing prepared here to discard */ },
        },
        discovery: {
          listNodes: () => gw.listNodes(),
          getNode: (id: string) => gw.getNode(id),
          listTemplates: () => templates.list(),
          getTemplate: (id: string) => templates.get(id),
        },
      },
      workspaceId: asWorkspaceId(currentWorkspaceId),
      permission: runSurfacePermission,
    }
  }

  const workspaceStore = useWorkspaceStore()
  const settingsStore = useSettingsStore()
  watch(
    [() => workspaceStore.workspaceId, () => settingsStore.backendConnected],
    ([workspaceId, backendConnected], [previousWorkspaceId, previousBackendConnected]) => {
      if (!workspaceId) {
        if (previousWorkspaceId) teardown()
        return
      }
      if (workspaceId !== previousWorkspaceId || (backendConnected && !previousBackendConnected)) init(workspaceId)
      if (backendConnected) void loadRuns(workspaceId)
    },
    { immediate: true },
  )

  const stopDesktopInvalidation = typeof window === 'undefined'
    ? undefined
    : subscribeDesktopRunsInvalidation((workspaceId) => {
        if (workspaceId !== currentWorkspaceId || !settingsStore.backendConnected) return
        void loadRuns(workspaceId)
      })
  if (stopDesktopInvalidation) onScopeDispose(stopDesktopInvalidation)

  return {
    active, history, trashed, connected, loading, error, historyTotal, historyHasMore,
    runningCount, queuedCount, init, teardown, ensureLoaded, loadRuns, loadMoreHistory,
    cancel, rerun, trash, restore, refreshRun, readRunLog,
  }

  async function withLoading(operation: () => Promise<unknown>) {
    const epoch = loadEpoch
    loading.value = true
    error.value = null
    try { await operation() }
    catch (cause) { if (epoch === loadEpoch) error.value = message(cause) }
    finally { if (epoch === loadEpoch) loading.value = false }
  }

  function applySnapshot(snapshot: RunRepositorySnapshot) {
    const projected = projectRunCollections(snapshot, currentWorkspaceId)
    active.value = projected.active
    history.value = projected.history
    trashed.value = snapshot.trash.filter((run) => !currentWorkspaceId || run.workspaceId === currentWorkspaceId)
    historyTotal.value = snapshot.total
    historyHasMore.value = snapshot.hasMore
  }
})

export function projectRunCollections(
  snapshot: RunRepositorySnapshot,
  workspaceId = '',
): { active: Map<string, RunSummary>; history: RunSummary[] } {
  const active = new Map<string, RunSummary>()
  const history: RunSummary[] = []
  for (const run of snapshot.runs.values()) {
    if (workspaceId && run.workspaceId !== workspaceId) continue
    if (run.status === 'QUEUED' || run.status === 'RUNNING') active.set(run.id, run)
    else history.push(run)
  }
  history.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return { active, history }
}

/**
 * A direct UI action IS a human decision, so it runs through the same
 * permission vocabulary the Agent uses (`resolvePermission` + `contextFor`,
 * CORE-ARCHITECTURE.md §9.2's agent-parity guarantee) rather than an
 * unguarded bypass. `'auto'` matches the previous TaskPanel UX for the
 * non-destructive actions (resume/restore ran without a prompt) while
 * keeping cancel / overwrite / trash always-ask, exactly as the Agent's own
 * gate does for the same actions.
 *
 * The `request` callback (called only when `decide` returns `'ask'`) is NOT
 * hard-wired to a native dialog — a store holds truth, it does not render
 * UI. `setRunSurfacePrompt` lets the shell inject its own confirm surface
 * (AppShell wires the confirmDialog store, whose host renders chrome); before
 * that injection the
 * default declines, so a destructive action fired before the shell is up
 * fails closed rather than silently proceeding.
 */
let runSurfacePrompt: (action: string, reason: string) => Promise<boolean> = async () => false

export function setRunSurfacePrompt(prompt: (action: string, reason: string) => Promise<boolean>): void {
  runSurfacePrompt = prompt
}

const runSurfacePermission: PermissionGateway = {
  decide: (action) => resolvePermission(contextFor('auto'), action),
  request: async (action, reason) => runSurfacePrompt(action, reason),
}


function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
