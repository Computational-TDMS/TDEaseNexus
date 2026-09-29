/** Thin Pinia projection over the Studio Run repository. */

import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { studioInfrastructure } from '@/services/backend/studioInfrastructure'
import { contextFor } from '@/services/agent/permissionMode'
import { resolvePermission } from '@/services/agent/permissionResolver'
import { asRunId, asWorkspaceId } from '@/studio/domain/identity'
import type { RunSummary, TrashedRunSummary } from '@/studio/domain/run'
import { RunRepository, type RunRepositorySnapshot } from '@/studio/runtime/run-repository'
import { CommandRegistry, type CommandContext } from '@/studio/commands/registry'
import { createStudioCommandRegistry } from '@/studio/commands/definitions'
import type { StudioRuntime } from '@/studio/runtime/studio-runtime'
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

  const runningCount = computed(() =>
    Array.from(active.value.values()).filter((run) => run.status === 'RUNNING').length,
  )
  const queuedCount = computed(() =>
    Array.from(active.value.values()).filter((run) => run.status === 'QUEUED').length,
  )

  function init(workspaceId: string) {
    teardown()
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
    await withLoading(() => repository!.load({ workspaceId: workspaceId || undefined, offset: 0, limit: PAGE_SIZE }))
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
    return {
      studio: runSurfaceStudio(),
      workspaceId: asWorkspaceId(currentWorkspaceId),
      permission: runSurfacePermission,
      evidence: unavailableEvidencePort,
    }
  }

  /**
   * Adapts this store's own `RunRepository` + `TDEaseBackendGateway` to the
   * `StudioRuntime` surface the command registry expects, without building a
   * second full `StudioRuntime` (which would open a second Workspace file
   * watcher next to the Agent's own). Only `.runs` is ever exercised from
   * this store; `.analysis` (S5 Analysis Review) and the parts of
   * `.discovery` nothing here calls are out of scope and throw rather than
   * silently no-op.
   */
  function runSurfaceStudio(): StudioRuntime {
    const repo = repository
    const gw = gateway
    if (!repo || !gw) throw new Error('The Run repository is not attached')
    const runs = {
      snapshot: () => repo.snapshot(),
      onChange: (listener: (snapshot: RunRepositorySnapshot) => void) => repo.onChange(listener),
      load: (query?: Parameters<RunRepository['load']>[0]) => repo.load(query),
      loadMore: (query?: Parameters<RunRepository['loadMore']>[0]) => repo.loadMore(query),
      refresh: (runId: ReturnType<typeof asRunId>) => repo.refresh(runId),
      wait: (runId: ReturnType<typeof asRunId>, deadlineMs?: number) => repo.wait(runId, deadlineMs),
      tailLog: (runId: ReturnType<typeof asRunId>, lines?: number) => gw.readLog(runId, lines),
      listFiles: (runId: ReturnType<typeof asRunId>, pattern?: string) => gw.listRunFiles(runId, pattern),
      fetchFile: (runId: ReturnType<typeof asRunId>, path: Parameters<BackendGateway['fetchRunFile']>[1]) =>
        gw.fetchRunFile(runId, path),
      cancel: (runId: ReturnType<typeof asRunId>) => repo.cancel(runId),
      rerun: (runId: ReturnType<typeof asRunId>, mode: 'resume' | 'overwrite') => repo.rerun(runId, mode),
      trash: (runId: ReturnType<typeof asRunId>) => repo.trash(runId),
      restore: (runId: ReturnType<typeof asRunId>) => repo.restore(runId),
    }
    const unsupported = (what: string) => async () => {
      throw new Error(`${what} is not available from the Run surface`)
    }
    const templates = createSystemTemplateCatalog()
    return {
      runs,
      analysis: {
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
    } as unknown as StudioRuntime
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
    loading.value = true
    error.value = null
    try { await operation() }
    catch (cause) { error.value = message(cause) }
    finally { loading.value = false }
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

const unavailableEvidencePort = {
  list: unavailable('Evidence'),
  read: unavailable('Evidence'),
  graph: unavailable('Evidence'),
  write: unavailable('Evidence'),
  verify: unavailable('Evidence'),
}

function unavailable(what: string) {
  return async () => {
    throw new Error(`${what} is not available from the Run surface`)
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
