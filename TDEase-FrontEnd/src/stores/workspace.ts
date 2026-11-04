/**
 * Workspace store — file-system-first.
 *
 * FRONTEND-ZERO: workspace = local directory. No more API client.
 * File tree is loaded from the local filesystem (Electron fs / fetch).
 * Sharing = sharing the workspace directory.
 */

import { defineStore } from 'pinia'
import { ref, computed, shallowRef, triggerRef } from 'vue'
import type { FileTreeNode } from '@/types/workspace-data'
import { getViewsFS, setViewsFSWorkspaceReady, setViewsFSWorkspaceRoot } from '@/services/workspace/views-fs'
import { rememberWorkspace } from '@/services/workspace/workspaceRegistry'
import { createWorkspaceInitializer, mintWorkspaceId } from '@/services/workspace/workspaceInitializer'
import { desktopWorkspaceFileSystem, isDesktopFileOpsAvailable } from '@/services/workspace/desktopWorkspace'

const log = {
  debug: (...args: unknown[]) => console.log('[workspace-store]', ...args),
  error: (...args: unknown[]) => console.error('[workspace-store]', ...args),
}

const STORAGE_KEYS = {
  workspacePath: 'tdease.workspace.path',
  workspaceId: 'tdease.workspace.id',
} as const

function loadStored(key: string, fallback: string): string {
  try {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem(key)
      if (v?.trim()) return v.trim()
    }
  } catch { /* localStorage unavailable */ }
  return fallback
}

function persist(key: string, value: string) {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value)
  } catch { /* noop */ }
}

function isAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

export const useWorkspaceStore = defineStore('workspace', () => {
  // Restore identity atomically. Keeping an id after discarding its absolute
  // Desktop path creates a false "current Workspace" that cannot read files
  // and makes same-id selection return before the root is attached.
  const storedPath = loadStored(STORAGE_KEYS.workspacePath, '')
  const storedId = loadStored(STORAGE_KEYS.workspaceId, '')
  const validStoredWorkspace = storedPath && storedId
    && (!isDesktopFileOpsAvailable() || isAbsolutePath(storedPath))
  const workspacePath = ref<string>(validStoredWorkspace ? storedPath : '')
  const workspaceId = ref<string>(validStoredWorkspace ? storedId : '')
  // Prime the FS hint at construction so the first `getViewsFS()` call — which
  // fires from always-mounted components (e.g. useMentionCandidates' immediate
  // watcher) before the user picks a folder — bakes the restored root into the
  // cached Electron adapter. Without this the adapter is built with `root=''`
  // and every subsequent `workspace:read-text` / `workspace:list-dir` IPC fails
  // with "workspace root must be absolute" in `electron/main.ts`.
  if (validStoredWorkspace) setViewsFSWorkspaceRoot(storedPath)
  // A restored workspace must be authorized before any consumer can use the
  // Electron filesystem bridge. Keep this promise in the store so readiness
  // is shared by Agent, Workbench, and future workspace consumers.
  let registrationPromise: Promise<void> = Promise.resolve()
  let readyPromise: Promise<void> = Promise.resolve()
  setViewsFSWorkspaceReady(() => registrationPromise)
  const fileTree = shallowRef<FileTreeNode[]>([])
  const expandedPaths = ref<Set<string>>(new Set())
  // Monotonic mutation counter for the expanded set. Watching the Set deeply
  // (FileTree's old persist watch) traverses a potentially huge structure on
  // every trigger; consumers watch this number instead.
  const expandedVersion = ref(0)
  function bumpExpandedVersion() {
    expandedVersion.value++
  }
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Lazy-loading cache: dir path → children
  const directoryCache = shallowRef<Map<string, FileTreeNode[]>>(new Map())
  const dirLoadingSet = ref<Set<string>>(new Set())
  // Per-directory load failures (path → message). A silent `[]` here once made
  // any deep directory whose IPC failed render as an empty dir with no hint —
  // the tree UI shows these as an inline error row with a retry action.
  const dirErrors = ref<Map<string, string>>(new Map())
  // In-app file clipboard: the pending copy/cut source paths.
  const clipboard = ref<{ mode: 'copy' | 'cut'; paths: string[] } | null>(null)
  // Dirty dirs awaiting refresh (set by FileWatcher → consumed by FileTree)

  const isPathExpanded = computed(() => (path: string) => expandedPaths.value.has(path))
  const hasWorkspace = computed(() => !!workspacePath.value && !!workspaceId.value)

  /**
   * Drop the in-memory attach state so the UI shows the honest "open a folder"
   * empty state instead of the ghost "selected but blank" tree. Used by the
   * restore path when registration or `loadFileTree` fails: the refs built from
   * localStorage make `hasWorkspace` true on construction, so a failed load
   * would otherwise leave `FileTree` mounted over an empty `fileTree`.
   *
   * localStorage (`tdease.workspace.path/id`) is intentionally NOT cleared —
   * the failed state is usually transient (registry write blocked by a file
   * lock, a moved directory), so the next launch still attempts the restore.
   */
  function resetAttachedWorkspace() {
    workspacePath.value = ''
    workspaceId.value = ''
    setViewsFSWorkspaceRoot('')
    registrationPromise = Promise.resolve()
    readyPromise = Promise.resolve()
  }

  if (workspacePath.value && workspaceId.value && isDesktopFileOpsAvailable()) {
    // Restore the full attach path, not just identity: register the root with
    // the Electron main process, then load the file tree. Without the load,
    // `hasWorkspace` flips true on construction but the tree stays empty -- the
    // "selected but blank" startup state -- and `WorkspaceRailButton`'s own
    // reopen path is short-circuited by that truthy `hasWorkspace`. Doing the
    // load here inside `readyPromise` keeps the registration-vs-IPC ordering
    // (`workspacePath()` in `electron/main.ts` gates every `workspace:*` call
    // on the root being registered first).
    registrationPromise = rememberWorkspace({
      workspaceId: workspaceId.value,
      name: workspacePath.value.split(/[\\/]/).filter(Boolean).pop() ?? workspaceId.value,
      localPath: workspacePath.value,
    })
    readyPromise = registrationPromise
      .then(() => loadFileTree())
      .then(() => {
        // `loadFileTree` swallows filesystem errors into `error.value` instead
        // of throwing (so a transient failure doesn't crash the restore chain).
        // Treat a non-empty `error` as a failed load and fall back to the
        // honest empty state; the truthy `hasWorkspace` would otherwise keep a
        // blank tree mounted.
        if (error.value) resetAttachedWorkspace()
      })
      .catch((cause) => {
        log.error('failed to restore workspace registration', cause)
        resetAttachedWorkspace()
      })
  }

  /**
   * Attach a Workspace directory as the active Workspace.
   *
   * Desktop (Electron bridge available) runs the full initialize path:
   *
   *   1. mint a provisional `ws_<hex12>` id (pure crypto, no fs);
   *   2. `rememberWorkspace` — registers the root and approves it with the
   *      Backend. This MUST precede step 3, because the Electron main process
   *      gates every `workspace:*` IPC on the root being registered
   *      (`workspacePath()` in `electron/main.ts`);
   *   3. the initializer creates the 14 directories, the immutable
   *      `.tdease/workspace.json`, and the Scaffold files — idempotently per
   *      FILE-LAYOUT §4.1;
   *   4. if the initializer read back an existing identity whose id differs
   *      from the provisional one (a previously-initialized Workspace being
   *      re-opened), re-register under the stable persisted id so the registry
   *      and the on-disk identity never disagree.
   *
   * The on-disk identity is the single source of truth; `localStorage` and the
   * registry both flow from it. `opts.id` overrides the mint and is honoured
   * verbatim, so callers that already hold an identity (tests, a re-open path)
   * stay deterministic.
   *
   * Browser dev mode has no bridge, so the initializer — which writes through
   * main-process IPC — cannot run. That path keeps the legacy behaviour of
   * deriving id/name from the folder basename, since the path is DATA_ROOT-
   * relative there, not filesystem-absolute.
   */
  async function setWorkspace(path: string, opts: { id?: string; name?: string } = {}) {
    const fallbackName = opts.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
    const desktop = isDesktopFileOpsAvailable()
    const provisionalId = opts.id ?? (desktop ? mintWorkspaceId() : fallbackName)

    // Step 1+2: register before any workspace:* IPC, so the main process
    // accepts the root when the initializer's mkdir/exists calls arrive.
    workspacePath.value = path
    workspaceId.value = provisionalId
    setViewsFSWorkspaceRoot(path)
    persist(STORAGE_KEYS.workspacePath, path)
    persist(STORAGE_KEYS.workspaceId, provisionalId)
    fileTree.value = []
    expandedPaths.value.clear()
    bumpExpandedVersion()
    directoryCache.value = new Map()
    dirErrors.value = new Map()
    dirLoadingSet.value = new Set()
    clipboard.value = null
    registrationPromise = rememberWorkspace({ workspaceId: provisionalId, name: fallbackName, localPath: path })
    readyPromise = registrationPromise
    try {
      await readyPromise
    } catch (cause) {
      log.error('failed to remember workspace', cause)
    }

    // Step 3+4: initialize (desktop only). On a fresh Workspace this creates
    // everything; on re-open it is a no-op read that returns the persisted
    // identity, which we then reconcile against the registry if its id differs.
    if (desktop) {
      try {
        const initializer = createWorkspaceInitializer(desktopWorkspaceFileSystem(path))
        const identity = await initializer.initialize(path, { id: provisionalId, name: opts.name })
        workspaceId.value = identity.id
        persist(STORAGE_KEYS.workspaceId, identity.id)
        if (identity.id !== provisionalId) {
          try {
            await rememberWorkspace({ workspaceId: identity.id, name: identity.name, localPath: path })
          } catch (cause) {
            log.error('failed to reconcile workspace identity in registry', cause)
          }
        }
      } catch (cause) {
        // A failed init must not block the Workspace that was just registered.
        // The user can still open files; the directories just won't exist until
        // the next open (the initializer is idempotent and will retry).
        log.error('failed to initialize workspace; the registered id stands', cause)
      }
    }
  }

  /** Wait until the active workspace is authorized for filesystem access. */
  async function ready(): Promise<void> {
    await readyPromise
  }

  // FRONTEND-ZERO: file tree is loaded from local filesystem.
  // Monotonic epoch for `loadFileTree`: two rapid directory switches can let
  // the slower `listDir` resolve last and overwrite the newer tree (and drop
  // the newer load's error state). Only the latest invocation may write
  // `fileTree` / `loading` / `error` — same guard shape as selection.ts's
  // stale-response checks.
  let fileTreeEpoch = 0
  async function loadFileTree() {
    if (!workspacePath.value) return
    const epoch = ++fileTreeEpoch
    loading.value = true
    error.value = null
    try {
      // Always refresh the adapter binding before the first filesystem call.
      // Mounted consumers can create the cached adapter before a workspace is
      // restored or selected, leaving its Electron root empty.
      if (isDesktopFileOpsAvailable()) setViewsFSWorkspaceRoot(workspacePath.value)
      const fs = getViewsFS()
      log.debug('listing root directory in', workspacePath.value)
      // Switching Workspaces must not recursively scan every raw/result file.
      // The tree loads descendants on demand when a directory is expanded.
      const entries = await fs.listDir(workspacePath.value)
      const nodes: FileTreeNode[] = entries.map(entry => ({
        name: entry.name,
        path: entry.name,
        type: entry.isDir ? 'directory' : 'file',
        size: entry.size,
        mtime: entry.mtime,
        status: 'local',
        children: entry.isDir ? [] : undefined,
        loaded: !entry.isDir,
      }))
      log.debug('built tree with', nodes.length, 'root nodes')
      if (epoch !== fileTreeEpoch) return
      fileTree.value = nodes
    } catch (err) {
      if (epoch !== fileTreeEpoch) return
      error.value = err instanceof Error ? err.message : 'Failed to load file tree'
      log.error('loadFileTree failed', err)
    } finally {
      if (epoch === fileTreeEpoch) loading.value = false
    }
  }

  function isDirLoaded(path: string): boolean {
    return directoryCache.value.has(path)
  }

  function isDirLoading(path: string): boolean {
    return dirLoadingSet.value.has(path)
  }

  function getCachedDir(path: string): FileTreeNode[] | undefined {
    return directoryCache.value.get(path)
  }

  function toggleExpand(path: string) {
    if (expandedPaths.value.has(path)) {
      expandedPaths.value.delete(path)
    } else {
      expandedPaths.value.add(path)
    }
    triggerRef(expandedPaths)
    bumpExpandedVersion()
  }

  /** Replace the whole expanded set (persisted-state restore, defaults). */
  function setExpandedPaths(paths: Iterable<string>) {
    expandedPaths.value = new Set(paths)
    triggerRef(expandedPaths)
    bumpExpandedVersion()
  }

  function collapseAll() {
    expandedPaths.value.clear()
    triggerRef(expandedPaths)
    bumpExpandedVersion()
  }

  // ── DeskTree mutations ────────────────────────────────────────────────────
  // Each action calls the FS then updates `fileTree` / `directoryCache` /
  // `expandedPaths` locally so the tree reflects the change without a full
  // reload (mirrors openhanako's applyRenamedDirectoryCache /
  // pruneRemovedDirectoryCache).

  function absOf(relPath: string): string {
    const root = workspacePath.value.replace(/\\/g, '/').replace(/\/?$/, '/')
    return root + relPath
  }

  /** Insert a freshly created child into its parent's cached listing. */
  function injectChildEntry(parentPath: string, node: FileTreeNode) {
    if (parentPath === '') {
      fileTree.value = [...fileTree.value, node]
      return
    }
    const cached = directoryCache.value.get(parentPath)
    if (cached) {
      directoryCache.value.set(parentPath, [...cached, node])
      triggerRef(directoryCache)
    } else {
      // Parent dir not in the lazy cache yet — also patch the seed node's
      // children so a freshly expanded dir shows the new entry immediately.
      patchSeedChildren(parentPath, (kids) => [...kids, node])
    }
  }

  /** Mutate the .children array of a seed node (non-lazy tree) at `path`. */
  function patchSeedChildren(dirPath: string, fn: (kids: FileTreeNode[]) => FileTreeNode[]) {
    const update = (nodes: FileTreeNode[]): FileTreeNode[] =>
      nodes.map(n => {
        if (n.path === dirPath && n.children) return { ...n, children: fn(n.children) }
        if (n.children && n.path && dirPath.startsWith(n.path + '/')) {
          return { ...n, children: update(n.children) }
        }
        return n
      })
    fileTree.value = update(fileTree.value)
  }

  function findTreeNode(path: string, nodes: FileTreeNode[] = fileTree.value): FileTreeNode | undefined {
    for (const node of nodes) {
      if (node.path === path) return node
      const found = node.children ? findTreeNode(path, node.children) : undefined
      if (found) return found
    }
    return undefined
  }

  /**
   * The type the tree already knows for `path`, from either the seed tree or
   * a lazily-loaded parent listing. `findTreeNode` alone only walks the seed
   * tree, which never contains depth≥2 nodes under the lazy-loading model, so
   * the old guard misfired on deep paths.
   */
  function knownTypeOf(path: string): FileTreeNode['type'] | undefined {
    const seeded = findTreeNode(path)
    if (seeded) return seeded.type
    const name = path.split('/').pop() || path
    const parent = parentOf(path)
    const siblings = directoryCache.value.get(parent)
      ?? (parent === '' ? fileTree.value : undefined)
    return siblings?.find(n => n.name === name)?.type
  }

  /** Lazy-load a single directory's children via listDir (one level). */
  async function loadDirLazy(dirPath: string): Promise<FileTreeNode[]> {
    // Persisted expansion state can outlive a correction to a file's type.
    // Never send `list-dir` for a node the local tree already knows is a file.
    if (knownTypeOf(dirPath) === 'file') {
      expandedPaths.value.delete(dirPath)
      triggerRef(expandedPaths)
      bumpExpandedVersion()
      return []
    }
    if (dirLoadingSet.value.has(dirPath)) return getCachedDir(dirPath) || []
    await loadDirsLazy([dirPath])
    return getCachedDir(dirPath) || []
  }

  /**
   * Batched lazy-load: one IPC per directory, but a SINGLE cache write +
   * trigger at the end. Restoring a persisted tree with N expanded dirs used
   * to fire N `loadDirLazy`s whose completions each did
   * `directoryCache.set + triggerRef` — N full re-render invalidations on
   * workspace open. In-flight and known-file dirs are skipped (the caller's
   * own load covers the former; the latter is dropped from the expanded set,
   * mirroring loadDirLazy's stale-state guard).
   */
  async function loadDirsLazy(paths: string[]): Promise<void> {
    const unique = Array.from(new Set(paths))
    const pending: string[] = []
    for (const dirPath of unique) {
      if (knownTypeOf(dirPath) === 'file') {
        expandedPaths.value.delete(dirPath)
        triggerRef(expandedPaths)
        bumpExpandedVersion()
        continue
      }
      if (!dirLoadingSet.value.has(dirPath)) pending.push(dirPath)
    }
    if (pending.length === 0) return
    for (const p of pending) dirLoadingSet.value.add(p)
    try {
      const fs = getViewsFS()
      type DirResult =
        | { ok: true; dirPath: string; entries: Awaited<ReturnType<typeof fs.listDir>> }
        | { ok: false; dirPath: string; err: unknown }
      const results = await Promise.allSettled(pending.map(async (dirPath): Promise<DirResult> => {
        try {
          const entries = await fs.listDir(absOf(dirPath))
          return { ok: true, dirPath, entries }
        } catch (err) {
          return { ok: false, dirPath, err }
        }
      }))
      let cacheChanged = false
      let nextErrors: Map<string, string> | null = null
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        const res = result.value
        if (res.ok) {
          const nodes: FileTreeNode[] = res.entries.map(e => ({
            name: e.name,
            path: res.dirPath ? `${res.dirPath}/${e.name}` : e.name,
            type: e.isDir ? 'directory' : 'file',
            size: e.size,
            mtime: e.mtime,
            status: 'local',
            children: e.isDir ? [] : undefined,
            loaded: false,
          }))
          directoryCache.value.set(res.dirPath, nodes)
          if (dirErrors.value.has(res.dirPath)) {
            nextErrors ??= new Map(dirErrors.value)
            nextErrors.delete(res.dirPath)
          }
          cacheChanged = true
        } else {
          const message = res.err instanceof Error ? res.err.message : String(res.err)
          log.error('Failed to lazy-load directory', res.dirPath, res.err)
          nextErrors ??= new Map(dirErrors.value)
          nextErrors.set(res.dirPath, message)
        }
      }
      if (nextErrors) dirErrors.value = nextErrors
      if (cacheChanged) triggerRef(directoryCache)
    } finally {
      for (const p of pending) dirLoadingSet.value.delete(p)
    }
  }

  /**
   * Reload the root listing and every currently-expanded directory from disk.
   *
   * This is the single action behind a manual refresh AND the chokidar
   * dirty-queue fan-out: a deleted/created/renamed entry anywhere the user can
   * currently see re-syncs in one call. Folding that into one place — instead
   * of each caller re-stating "root plus expanded dirs" — is what keeps the
   * tree from silently dropping a class of changes.
   */
  async function refreshExpanded(): Promise<void> {
    if (!workspacePath.value) return
    const dirs = Array.from(expandedPaths.value)
    await Promise.all([
      loadFileTree(),
      ...dirs.map((dir) => loadDirLazy(dir).catch((err) => {
        log.error('refreshExpanded: loadDirLazy failed', dir, err)
      })),
    ])
  }

  /** Create a new empty file. */
  async function createFile(parentPath: string, name: string, content = '') {
    const fs = getViewsFS()
    const relPath = parentPath ? `${parentPath}/${name}` : name
    await fs.createFile(absOf(relPath), content)
    injectChildEntry(parentPath, {
      name, path: relPath, type: 'file', size: content.length, mtime: Date.now(),
      status: 'local', loaded: true,
    })
  }

  /** Create a new directory. */
  async function mkdir(parentPath: string, name: string) {
    const fs = getViewsFS()
    const relPath = parentPath ? `${parentPath}/${name}` : name
    await fs.mkdir(absOf(relPath))
    injectChildEntry(parentPath, {
      name, path: relPath, type: 'directory', status: 'local',
      children: [], loaded: false, mtime: Date.now(),
    })
  }

  /**
   * Rename a node. If it's a directory, all cached descendant paths are
   * rewritten so expanded state and selection stay valid.
   * Returns the new path on success.
   */
  async function renamePath(oldPath: string, newName: string): Promise<string> {
    const fs = getViewsFS()
    const parentPath = parentOf(oldPath)
    const newPath = parentPath ? `${parentPath}/${newName}` : newName
    await fs.rename(absOf(oldPath), absOf(newPath))
    rewritePathInTree(oldPath, newPath)
    return newPath
  }

  /** Trash one or more paths. Returns ONLY the paths actually removed — a
   *  failed fs.trash() must not prune the tree for a path that still exists. */
  async function trashPaths(paths: string[]): Promise<string[]> {
    if (paths.length === 0) return []
    const fs = getViewsFS()
    const removed: string[] = []
    for (const p of paths) {
      try {
        await fs.trash(absOf(p))
        removed.push(p)
      } catch (err) { log.error('trash failed', p, err) }
    }
    for (const p of removed) prunePathFromTree(p)
    return removed
  }

  /** Move multiple source entries into a destination directory. */
  async function movePaths(
    items: Array<{ path: string; isDirectory: boolean }>,
    destDirPath: string,
  ): Promise<void> {
    if (items.length === 0) return
    const fs = getViewsFS()
    await fs.move(items.map(it => absOf(it.path)), absOf(destDirPath))
    for (const it of items) {
      const name = it.path.split('/').pop() || it.path
      prunePathFromTree(it.path)
      injectChildEntry(destDirPath, {
        name,
        path: `${destDirPath}/${name}`,
        type: it.isDirectory ? 'directory' : 'file',
        status: 'local',
        children: it.isDirectory ? [] : undefined,
        loaded: !it.isDirectory,
        mtime: Date.now(),
      })
    }
    // Refresh destination to sync sizes/mtimes from disk.
    await loadDirLazy(destDirPath)
  }

  // ── Clipboard: in-app copy / cut / paste ─────────────────────────────────

  function copyPaths(paths: string[]) {
    clipboard.value = paths.length > 0 ? { mode: 'copy', paths: [...paths] } : null
  }

  function cutPaths(paths: string[]) {
    clipboard.value = paths.length > 0 ? { mode: 'cut', paths: [...paths] } : null
  }

  /** Names already taken inside a directory (root falls back to the seed tree). */
  function existingNamesOf(dirPath: string): Set<string> {
    const entries = directoryCache.value.get(dirPath)
      ?? (dirPath === '' ? fileTree.value : [])
    return new Set(entries.map(n => n.name))
  }

  /**
   * First collision-free name derived from `name`: itself, then
   * "stem (copy)ext", "stem (copy 2)ext", …
   */
  function uniqueName(existing: Set<string>, name: string): string {
    if (!existing.has(name)) return name
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 1; ; i++) {
      const candidate = i === 1 ? `${stem} (copy)${ext}` : `${stem} (copy ${i})${ext}`
      if (!existing.has(candidate)) return candidate
    }
  }

  /**
   * Paste the clipboard into `destDirPath`. Copy sources keep their names
   * unless taken (then "(copy)" suffixed); cut sources move via `movePaths`
   * and the clipboard clears. Returns the new paths (copy mode).
   */
  async function pastePaths(destDirPath: string): Promise<string[]> {
    const clip = clipboard.value
    if (!clip) return []
    const fs = getViewsFS()
    const joins = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
    // Never paste a directory into itself or its own subtree.
    const pasteable = clip.paths.filter(p => p !== destDirPath && !destDirPath.startsWith(`${p}/`))

    if (clip.mode === 'cut') {
      await movePaths(
        pasteable.map(p => ({ path: p, isDirectory: knownTypeOf(p) === 'directory' })),
        destDirPath,
      )
      clipboard.value = null
      return []
    }

    const existing = existingNamesOf(destDirPath)
    const created: string[] = []
    for (const p of pasteable) {
      const name = uniqueName(existing, p.split('/').pop() || p)
      await fs.copy(absOf(p), absOf(joins(destDirPath, name)))
      existing.add(name)
      created.push(joins(destDirPath, name))
    }
    // Re-sync the destination listing from disk (root has no cache entry).
    if (destDirPath === '') await loadFileTree()
    else await loadDirLazy(destDirPath)
    return created
  }

  /** Copy-and-paste each path back into its own parent with "(copy)" names. */
  async function duplicatePaths(paths: string[]): Promise<string[]> {
    if (paths.length === 0) return []
    copyPaths(paths)
    const parents = Array.from(new Set(paths.map(parentOf)))
    const created: string[] = []
    for (const parent of parents) {
      created.push(...await pastePaths(parent))
    }
    return created
  }

  // ── Local tree-mutation helpers ───────────────────────────────────────────

  function parentOf(path: string): string {
    const idx = path.lastIndexOf('/')
    return idx >= 0 ? path.slice(0, idx) : ''
  }

  /** Rewrite a path everywhere it appears (fileTree, cache, expandedPaths). */
  function rewritePathInTree(oldPath: string, newPath: string) {
    const newName = newPath.split('/').pop() || newPath
    const renameNode = (nodes: FileTreeNode[]): FileTreeNode[] =>
      nodes.map(n => {
        if (n.path === oldPath) {
          return { ...n, path: newPath, name: newName }
        }
        if (n.path.startsWith(`${oldPath}/`)) {
          const suffix = n.path.slice(oldPath.length)
          return { ...n, path: `${newPath}${suffix}` }
        }
        return n
      })

    fileTree.value = renameNode(fileTree.value)
    for (const [dir, nodes] of directoryCache.value) {
      directoryCache.value.set(dir, renameNode(nodes))
    }
    triggerRef(directoryCache)

    // Rewrite expanded paths under the renamed dir
    const oldExpanded = Array.from(expandedPaths.value)
    let changed = false
    const next = new Set<string>()
    for (const p of oldExpanded) {
      if (p === oldPath) { next.add(newPath); changed = true }
      else if (p.startsWith(`${oldPath}/`)) {
        next.add(`${newPath}${p.slice(oldPath.length)}`); changed = true
      } else next.add(p)
    }
    if (changed) { expandedPaths.value = next; triggerRef(expandedPaths); bumpExpandedVersion() }
  }

  /** Remove a path (and its descendants) from the tree, cache, expanded set. */
  function prunePathFromTree(path: string) {
    const isVictim = (p: string) => p === path || p.startsWith(`${path}/`)
    // Drop at root level
    fileTree.value = fileTree.value.filter(n => !isVictim(n.path))
    // Recursively drop from seed node .children (for non-lazy expanded dirs)
    patchSeedChildren(path.split('/').slice(0, -1).join('/'), (kids) =>
      kids.filter(n => !isVictim(n.path)),
    )
    for (const [dir, nodes] of directoryCache.value) {
      // Drop cached entries that are the victim or its descendants
      if (isVictim(dir)) {
        directoryCache.value.delete(dir)
        continue
      }
      const filtered = nodes.filter(n => !isVictim(n.path))
      if (filtered.length !== nodes.length) directoryCache.value.set(dir, filtered)
    }
    triggerRef(directoryCache)

    let changed = false
    const next = new Set<string>()
    for (const p of expandedPaths.value) {
      if (isVictim(p)) changed = true
      else next.add(p)
    }
    if (changed) { expandedPaths.value = next; triggerRef(expandedPaths); bumpExpandedVersion() }
  }

  return {
    workspacePath,
    workspaceId,
    fileTree,
    expandedPaths,
    expandedVersion,
    loading,
    error,
    directoryCache,
    dirLoadingSet,
    dirErrors,
    clipboard,
    hasWorkspace,
    ready,
    isPathExpanded,
    setWorkspace,
    loadFileTree,
    loadDirLazy,
    loadDirsLazy,
    refreshExpanded,
    isDirLoaded,
    isDirLoading,
    getCachedDir,
    toggleExpand,
    setExpandedPaths,
    collapseAll,
    // DeskTree mutations
    createFile,
    mkdir,
    renamePath,
    trashPaths,
    movePaths,
    copyPaths,
    cutPaths,
    pastePaths,
    duplicatePaths,
  }
})
