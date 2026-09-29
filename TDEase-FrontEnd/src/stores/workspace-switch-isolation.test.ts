/**
 * Pins Workspace-switch isolation across the stores that filter their
 * contents by the active Workspace id.
 *
 * Each store binds to `workspaceStore.workspaceId` differently — some
 * self-watch and reset (documents/runs/agent), some rely on a caller to
 * invoke a reset function (selection, before the fix below), some rely on a
 * component lifecycle hook to re-bind (uiLayout, before the fix below). That
 * divergence is exactly where a switch can leave workspace A's data visible
 * or reachable inside workspace B — this file switches the active Workspace
 * and asserts, store by store, that nothing does.
 *
 * Two real leaks were found and fixed while writing this file (see the WHY
 * comments in `src/stores/selection.ts` and `src/stores/uiLayout.ts`):
 *
 *  - `selection.ts`'s `selectWorkspace()` reset function existed and was
 *    exported, but nothing in the app ever called it — no self-watch on
 *    `workspaceStore.workspaceId` — so runId/filePath/tree selection/
 *    runFileStatuses all survived a Workspace switch untouched. It also
 *    never cleared `runFileStatuses` even when called.
 *  - `uiLayout.ts`'s `hydrate()` was only ever invoked once, from
 *    `AppShell.vue`'s `onMounted`. A later in-session switch (no remount)
 *    left `boundWorkspaceId` on the Workspace open at boot, so every
 *    `persist()` after a switch silently wrote the new Workspace's layout
 *    changes under the old Workspace's storage key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { TDEaseClient } from '@/services/backend/backend'
import type { RunInfo, RunListOptions } from '@/services/backend/backend'
import type { UiStateRepository } from '@/studio/ports/ui-state-repository'
import { useWorkspaceStore } from './workspace'
import { useDocumentsStore } from './documents'
import { useRunsStore } from './runs'
import { useAgentStore } from './agent'
import { useSelectionStore } from './selection'
import { useUiLayoutStore } from './uiLayout'
import { useSettingsStore } from './settings'

function makeRunInfo(overrides: Partial<RunInfo> & { run_id: string; workspace_id: string }): RunInfo {
  return {
    name: overrides.run_id,
    status: 'RUNNING',
    cores: 1,
    rerun_mode: 'resume',
    labels: {},
    result_file_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    event_seq_last: 0,
    ...overrides,
  }
}

/** Tracks which run ids currently have a live (unstopped) SSE subscription. */
let liveRunSubscriptions: Set<string>

function mockBackendRuns(byWorkspace: Record<string, RunInfo[]>) {
  liveRunSubscriptions = new Set()
  vi.spyOn(TDEaseClient.prototype, 'listPage').mockImplementation(async (opts: RunListOptions = {}) => {
    const items = byWorkspace[opts.workspaceId ?? ''] ?? []
    return { runs: items, total: items.length, offset: 0, limit: 50, has_more: false }
  })
  vi.spyOn(TDEaseClient.prototype, 'listTrash').mockResolvedValue([])
  vi.spyOn(TDEaseClient.prototype, 'subscribeEvents').mockImplementation((runId: string) => {
    liveRunSubscriptions.add(runId)
    return () => { liveRunSubscriptions.delete(runId) }
  })
}

function mockRunFiles(byRunId: Record<string, Array<{ path: string; sha256: string }>>) {
  vi.spyOn(TDEaseClient.prototype, 'listRunFiles').mockImplementation(async (runId: string) => byRunId[runId] ?? [])
}

describe('Workspace-switch isolation', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    // `loadRuns` short-circuits when the backend is not connected, which would
    // make every run-loading assertion pass for the wrong reason. These tests
    // mock the backend's run listing, so mark the store connected.
    useSettingsStore().backendConnected = true
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('documents: switching workspace drops the previous workspace\'s open documents, active document and preview slot', async () => {
    const workspaceStore = useWorkspaceStore()
    const documents = useDocumentsStore()

    await workspaceStore.setWorkspace('demo-a', { id: 'ws-doc-a' })
    documents.openRun('run-a1', { preview: false })
    documents.openRun('run-a2', { preview: true })
    expect(documents.openDocuments.map((d) => d.id)).toEqual(
      expect.arrayContaining(['run-index:ws-doc-a', 'run:run-a1', 'run:run-a2']),
    )
    const activeInA = documents.activeDocumentId
    const previewInA = documents.previewDocumentId
    expect(activeInA).toBe('run:run-a2')
    expect(previewInA).toBe('run:run-a2')

    await workspaceStore.setWorkspace('demo-b', { id: 'ws-doc-b' })

    const idsAfterSwitch = documents.openDocuments.map((d) => d.id)
    expect(idsAfterSwitch).not.toContain('run-index:ws-doc-a')
    expect(idsAfterSwitch).not.toContain('run:run-a1')
    expect(idsAfterSwitch).not.toContain('run:run-a2')
    expect(documents.activeDocumentId).not.toBe(activeInA)
    expect(documents.previewDocumentId).not.toBe(previewInA)
    expect(documents.mru).not.toContain(activeInA)
    // Lands on ws-doc-b's own Run Index, not ws-doc-a's.
    expect(documents.activeKey).toEqual({ kind: 'run-index', workspaceId: 'ws-doc-b' })
  })

  it('runs: switching workspace tears down the previous workspace\'s runs AND their event subscriptions', async () => {
    mockBackendRuns({
      'ws-run-a': [makeRunInfo({ run_id: 'run-a1', workspace_id: 'ws-run-a', status: 'RUNNING' })],
      'ws-run-b': [makeRunInfo({ run_id: 'run-b1', workspace_id: 'ws-run-b', status: 'RUNNING' })],
    })

    const workspaceStore = useWorkspaceStore()
    const runs = useRunsStore()

    await workspaceStore.setWorkspace('demo-a', { id: 'ws-run-a' })
    await runs.loadRuns('ws-run-a') // await the watcher-triggered load to settle deterministically
    expect(Array.from(runs.active.keys())).toEqual(['run-a1'])
    expect(liveRunSubscriptions.has('run-a1')).toBe(true)

    await workspaceStore.setWorkspace('demo-b', { id: 'ws-run-b' })
    await runs.loadRuns('ws-run-b')

    expect(Array.from(runs.active.keys())).toEqual(['run-b1'])
    expect(Array.from(runs.active.values()).every((r) => r.workspaceId === 'ws-run-b')).toBe(true)
    // The old run's subscription must be stopped, not merely hidden.
    expect(liveRunSubscriptions.has('run-a1')).toBe(false)
    expect(liveRunSubscriptions.has('run-b1')).toBe(true)
  })

  it('agent: switching workspace hides the previous workspace\'s sessions, active session and its messages', async () => {
    const workspaceStore = useWorkspaceStore()
    const agent = useAgentStore()

    await workspaceStore.setWorkspace('demo-a', { id: 'ws-agent-a' })
    const sessionA = agent.createSession()
    agent.addMessage(sessionA.id, 'user', 'secret from workspace A')
    expect(agent.sessions.map((s) => s.id)).toContain(sessionA.id)
    expect(agent.active?.id).toBe(sessionA.id)
    expect(agent.active?.messages).toHaveLength(1)

    await workspaceStore.setWorkspace('demo-b', { id: 'ws-agent-b' })

    expect(agent.sessions.map((s) => s.id)).not.toContain(sessionA.id)
    expect(agent.archivedSessions.map((s) => s.id)).not.toContain(sessionA.id)
    expect(agent.active).toBeNull()

    // Even creating a brand-new session in ws-agent-b must not resurrect A's.
    const sessionB = agent.createSession()
    expect(agent.sessions.map((s) => s.id)).toEqual([sessionB.id])
    expect(agent.active?.messages).toHaveLength(0)
  })

  it('selection: switching workspace clears run focus, tree selection/multi-select, and run file statuses', async () => {
    mockRunFiles({ 'run-sel-a': [{ path: 'results/out.csv', sha256: 'aaa' }] })
    // runFileStatuses only populate for a Run the Backend knows — mappedRunPath
    // reads runsStore.active — so load run-sel-a. A path-only selection of an
    // unloaded/draft run intentionally yields no statuses (selection.ts §3.3:
    // a draft dir with no run.json must not 404 against the Backend).
    mockBackendRuns({ 'ws-sel-a': [makeRunInfo({ run_id: 'run-sel-a', workspace_id: 'ws-sel-a', workspace_run_path: 'runs/run-sel-a' })] })

    const workspaceStore = useWorkspaceStore()
    const runs = useRunsStore()
    const selection = useSelectionStore()

    await workspaceStore.setWorkspace('demo-a', { id: 'ws-sel-a' })
    await runs.loadRuns('ws-sel-a')
    selection.selectFile('runs/run-sel-a/out.csv') // derives runId via runIdFromWorkspacePath
    selection.selectTreePath('other/file.txt', { multi: true, shift: false }, [])
    await new Promise((resolve) => setTimeout(resolve, 0)) // let refreshRunFileStatuses settle

    expect(selection.runId).toBe('run-sel-a')
    expect(selection.filePath).toBeTruthy()
    expect(selection.selectedTreePaths.size).toBe(2) // selectFile's path + the ctrl-click toggle
    expect(selection.hasMultiSelection).toBe(true)
    expect(selection.runFileStatuses.size).toBeGreaterThan(0)

    await workspaceStore.setWorkspace('demo-b', { id: 'ws-sel-b' })

    expect(selection.runId).toBeUndefined()
    expect(selection.filePath).toBeUndefined()
    expect(selection.selectedTreePaths.size).toBe(0)
    expect(selection.hasMultiSelection).toBe(false)
    expect(selection.runFileStatuses.size).toBe(0)
  })

  it('uiLayout: switching workspace re-hydrates layout per workspace, and persist() writes to the new workspace\'s key', async () => {
    const workspaceStore = useWorkspaceStore()
    const uiLayout = useUiLayoutStore()

    const backing = new Map<string, unknown>()
    const fakeRepo: UiStateRepository = {
      read: <T>(workspaceId: string, key: string, fallback: T): T => {
        const k = `${workspaceId}.${key}`
        return backing.has(k) ? (backing.get(k) as T) : fallback
      },
      write: <T>(workspaceId: string, key: string, value: T): void => { backing.set(`${workspaceId}.${key}`, value) },
      clear: (workspaceId: string): void => {
        for (const k of Array.from(backing.keys())) if (k.startsWith(`${workspaceId}.`)) backing.delete(k)
      },
    }
    // Pre-seed distinct persisted layouts for both workspaces.
    backing.set('ws-ui-a.activeNavigatorSection', 'files')
    backing.set('ws-ui-b.activeNavigatorSection', 'wiki')

    await workspaceStore.setWorkspace('demo-a', { id: 'ws-ui-a' })
    // Mirrors src/main.ts's pre-mount boot call: the first hydrate is always
    // explicit (AppShell no longer performs it).
    uiLayout.hydrate('ws-ui-a', fakeRepo)
    expect(uiLayout.activeNavigatorSection).toBe('files')

    uiLayout.setActiveNavigatorSection('runs') // a user layout change mid-session
    uiLayout.persist()
    expect(fakeRepo.read('ws-ui-a', 'activeNavigatorSection', '')).toBe('runs')

    await workspaceStore.setWorkspace('demo-b', { id: 'ws-ui-b' })

    // Must have re-hydrated for ws-ui-b's own saved layout, not kept showing ws-ui-a's.
    expect(uiLayout.activeNavigatorSection).toBe('wiki')

    uiLayout.setActiveNavigatorSection('files')
    uiLayout.persist()
    // The write must land under ws-ui-b's key...
    expect(fakeRepo.read('ws-ui-b', 'activeNavigatorSection', '')).toBe('files')
    // ...and never silently overwrite ws-ui-a's already-persisted value.
    expect(fakeRepo.read('ws-ui-a', 'activeNavigatorSection', '')).toBe('runs')
  })
})
