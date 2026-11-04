import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setViewsFS, type ViewsFS } from '@/services/workspace/views-fs'
import { useWorkspaceStore } from './workspace'

function workspaceFs(listDir = vi.fn()): ViewsFS {
  return {
    async readFile() { return '' },
    async writeFile() {},
    async listFiles() { return ['Snakefile', 'raw/sample.mzML'] },
    async fileExists() { return true },
    async fileMtime() { return 0 },
    async isDirectory() { return false },
    async createFile() {},
    async mkdir() {},
    async rename() {},
    async trash() {},
    async move() {},
    async copyInto() {},
    listDir,
  }
}

describe('workspace file tree', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })

  it('keeps an extensionless root file from being expanded as a directory', async () => {
    const listDir = vi.fn(async () => [
      { name: 'Snakefile', isDir: false, size: 0, mtime: 0 },
      { name: 'raw', isDir: true, size: 0, mtime: 0 },
    ])
    const store = useWorkspaceStore()
    await store.setWorkspace('C:/workspace', { id: 'workspace-1' })
    setViewsFS(workspaceFs(listDir))

    await store.loadFileTree()
    listDir.mockClear()

    expect(store.fileTree.find((node) => node.path === 'Snakefile')?.type).toBe('file')
    store.expandedPaths.add('Snakefile') // Stale persisted state from an older build.
    await store.loadDirLazy('Snakefile')

    expect(listDir).not.toHaveBeenCalled()
    expect(store.expandedPaths.has('Snakefile')).toBe(false)
  })

  it('restores an absolute Desktop workspace path together with its id', () => {
    window.localStorage.setItem('tdease.workspace.path', 'C:\\studies\\demo')
    window.localStorage.setItem('tdease.workspace.id', 'ws-dev-001')

    const store = useWorkspaceStore()

    expect(store.workspacePath).toBe('C:\\studies\\demo')
    expect(store.workspaceId).toBe('ws-dev-001')
    expect(store.hasWorkspace).toBe(true)
  })

  /**
   * `refreshExpanded` is the single semantic action behind the manual refresh
   * button AND the chokidar dirty-directory queue: it reloads the root listing
   * plus every currently-expanded directory, so a deleted/renamed/created entry
   * anywhere visible re-syncs from disk. Splitting that knowledge across each
   * caller would recreate the bug — that the tree stops reflecting the disk for
   * some event class.
   */
  it('refreshExpanded reloads the root and every expanded directory', async () => {
    const listDir = vi.fn(async () => [{ name: 'raw', isDir: true, size: 0, mtime: 0 }])
    const store = useWorkspaceStore()
    await store.setWorkspace('C:/workspace', { id: 'workspace-1' })
    setViewsFS(workspaceFs(listDir))

    await store.loadFileTree()
    // Two expanded dirs + the empty-string root behave differently for the call.
    store.expandedPaths.add('raw')
    store.expandedPaths.add('results')
    listDir.mockClear()

    await store.refreshExpanded()

    // Root reload + each expanded dir reload. Root goes through listDir with
    // the absolute workspace path; expanded dirs go through loadDirLazy.
    expect(listDir).toHaveBeenCalled()
    // 1 (root) + 2 (expanded dirs) = 3 filesystem reads.
    expect(listDir).toHaveBeenCalledTimes(3)
  })

  it('does not restore a workspace id without its path', () => {
    window.localStorage.setItem('tdease.workspace.id', 'ws-dev-001')

    const store = useWorkspaceStore()

    expect(store.workspacePath).toBe('')
    expect(store.workspaceId).toBe('')
    expect(store.hasWorkspace).toBe(false)
  })

  /**
   * The restore path builds `workspacePath`/`workspaceId` from localStorage the
   * instant the store is constructed, so `hasWorkspace` is already true before
   * `loadFileTree` resolves. If the load fails (here: the filesystem throws)
   * the store must fall back to the honest "open a folder" empty state instead
   * of leaving `FileTree` mounted over an empty `fileTree` — the ghost
   * "selected but blank" startup state. localStorage is intentionally kept so
   * the next launch retries the restore.
   */
  it('falls back to the empty state when loadFileTree fails on restore', async () => {
    window.localStorage.setItem('tdease.workspace.path', 'C:\\gone\\dir')
    window.localStorage.setItem('tdease.workspace.id', 'ws-gone')

    // Stub the Electron bridge so `isDesktopFileOpsAvailable()` is true and the
    // constructor's restore branch runs. The `workspace.listDir` stub is what
    // `createElectronFS` invokes from `loadFileTree`; make it reject to stand
    // in for a moved/locked directory. `setViewsFSWorkspaceRoot(storedPath)`
    // in the constructor wipes any pre-injected ViewsFS, so driving the bridge
    // directly is the faithful seam here.
    vi.stubGlobal('tdeaseDesktop', {
      workspace: {
        listDir: async () => { throw new Error('ENOENT') },
      },
      workspaceRegistry: {
        list: async () => ({ schema_version: 1, workspaces: [] }),
        upsert: async () => ({ schema_version: 1, workspaces: [] }),
        remove: async () => ({ schema_version: 1, workspaces: [] }),
      },
    })

    const store = useWorkspaceStore()
    await store.ready() // let the restore chain settle

    expect(store.hasWorkspace).toBe(false)
    expect(store.workspacePath).toBe('')
    expect(store.workspaceId).toBe('')
    // localStorage is preserved so the next launch retries the restore.
    expect(window.localStorage.getItem('tdease.workspace.path')).toBe('C:\\gone\\dir')
    expect(window.localStorage.getItem('tdease.workspace.id')).toBe('ws-gone')

    // The "preserve localStorage" promise is what makes a transient failure
    // self-heal on the next launch: a fresh store (simulating a relaunch) must
    // re-attempt the restore. Flip the filesystem stub to succeed and rebuild
    // the store under a new Pinia instance — `hasWorkspace` must come back true
    // and the tree must load.
    ;(globalThis as any).tdeaseDesktop.workspace.listDir = async () => [
      { name: 'recovered.txt', isDir: false, size: 0, mtime: 0 },
    ]
    setActivePinia(createPinia())
    const { useWorkspaceStore: freshUse } = await import('./workspace')
    const relaunched = freshUse()
    await relaunched.ready()

    expect(relaunched.hasWorkspace).toBe(true)
    expect(relaunched.workspacePath).toBe('C:\\gone\\dir')
    expect(relaunched.fileTree.length).toBeGreaterThan(0)

    vi.unstubAllGlobals()
  })

  it('restores the file tree when the restore chain succeeds', async () => {
    window.localStorage.setItem('tdease.workspace.path', 'C:\\studies\\demo')
    window.localStorage.setItem('tdease.workspace.id', 'ws-demo')

    vi.stubGlobal('tdeaseDesktop', {
      workspace: {
        listDir: async () => [
          { name: 'Snakefile', isDir: false, size: 0, mtime: 0 },
        ],
      },
      workspaceRegistry: {
        list: async () => ({ schema_version: 1, workspaces: [] }),
        upsert: async () => ({ schema_version: 1, workspaces: [] }),
        remove: async () => ({ schema_version: 1, workspaces: [] }),
      },
    })

    const store = useWorkspaceStore()
    await store.ready()

    expect(store.hasWorkspace).toBe(true)
    expect(store.workspacePath).toBe('C:\\studies\\demo')
    expect(store.fileTree.length).toBeGreaterThan(0)

    vi.unstubAllGlobals()
  })
})

/**
 * Pins the ordering invariant the runtime bug taught us: the Electron main
 * process gates every `workspace:*` IPC on the root being registered
 * (`workspacePath()` in `electron/main.ts`), so `setWorkspace` MUST register
 * before the initializer's filesystem calls arrive. A previous version ran the
 * initializer first and the registry upsert silently failed on every fresh
 * Workspace because the initializer threw "workspace root is not registered".
 *
 * This test stands in for the real Electron bridge with a recording fake and
 * asserts the call order by sequence number.
 */
describe('setWorkspace desktop ordering', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('registers the workspace before the initializer touches the filesystem', async () => {
    let seq = 0
    const order: string[] = []
    // A registry bridge that records when upsert lands.
    const registryCalls: Array<{ workspaceId: string; localPath: string }> = []
    vi.stubGlobal('tdeaseDesktop', {
      workspace: {
        // The initializer probes identity existence first; record that probe so
        // we can prove it happens AFTER the registry upsert.
        exists: async () => { order.push(`fs:exists#${++seq}`); return false },
        mkdir: async () => { order.push(`fs:mkdir#${++seq}`) },
        readText: async () => '',
        writeTextAtomic: async () => { order.push(`fs:write#${++seq}`) },
      },
      workspaceRegistry: {
        list: async () => ({ schema_version: 1, workspaces: [] }),
        upsert: async (entry: { workspace_id: string; local_path: string }) => {
          order.push(`registry:upsert#${++seq}`)
          registryCalls.push({ workspaceId: entry.workspace_id, localPath: entry.local_path })
          return { schema_version: 1, workspaces: [] }
        },
        remove: async () => ({ schema_version: 1, workspaces: [] }),
      },
    })

    const store = useWorkspaceStore()
    await store.setWorkspace('C:/studies/demo', { name: 'demo' })

    // The registry upsert is the FIRST operation; the filesystem probes that
    // the initializer triggers come only after. If this ordering ever flips,
    // the main-process `workspacePath()` check rejects every `workspace:*`
    // call with "workspace root is not registered".
    const firstRegistryIdx = order.findIndex((op) => op.startsWith('registry:upsert'))
    const firstFsIdx = order.findIndex((op) => op.startsWith('fs:'))
    expect(firstRegistryIdx).toBeGreaterThanOrEqual(0)
    expect(firstFsIdx).toBeGreaterThan(firstRegistryIdx)

    // The registered id is the minted `ws_<hex12>`, not the folder basename.
    expect(registryCalls[0].workspaceId).toMatch(/^ws_[0-9a-f]{12}$/)
    expect(registryCalls[0].localPath).toBe('C:/studies/demo')
    expect(store.workspaceId).toMatch(/^ws_[0-9a-f]{12}$/)

    vi.unstubAllGlobals()
  })
})
