/**
 * ViewsFS — concrete filesystem implementations.
 *
 * FRONTEND-ZERO: workspace = local directory, managed by frontend.
 *
 * - Electron: reads workspace files from disk via tdeaseDesktop.workspace IPC
 * - Browser (dev): uses embedded demo data (no backend needed)
 * - Server mode: future — uses fetch to backend
 *
 * The backend files API (api/v2/files) is NOT used by the frontend.
 * It exists for the server/cloud deployment where workspace is remote.
 */

import { DEMO_FILES } from '../demo-data'
import { mediaMimeType } from '@/services/visualization/fileTypes'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

/**
 * The filesystem surface every Workspace reader goes through.
 *
 * It used to be declared in the Canvas `views` store while being implemented
 * here and consumed by `tree-hash.ts` — the store owned a type it neither
 * implemented nor used. It now lives next to its one adapter.
 */
export interface ViewsFS {
  /** Read file contents. */
  readFile(absPath: string): Promise<string>
  /** Read file bytes without decoding them as text. */
  readBlob(absPath: string): Promise<Blob>
  /**
   * Random-access byte range `[start, end)` without reading the whole file
   * into the renderer — the mzML preview streams and slices multi-GB files
   * through this. `null` where the adapter cannot range-read (browser demo).
   */
  readByteRange(absPath: string, start: number, end: number): Promise<Uint8Array | null>
  /** Write file contents (for state persistence). */
  writeFile(absPath: string, content: string): Promise<void>
  /** List files matching a glob pattern. */
  listFiles(glob: string, cwd: string): Promise<string[]>
  /** Check if a file exists. */
  fileExists(absPath: string): Promise<boolean>
  /** Get file modification time in ms. */
  fileMtime(absPath: string): Promise<number>
  /** Check if a path is a directory. */
  isDirectory(absPath: string): Promise<boolean>
  /** Create a new empty file (or overwrite with the given content). */
  createFile(absPath: string, content?: string): Promise<void>
  /** Create a directory (recursive). */
  mkdir(absPath: string): Promise<void>
  /** Rename/move within the same workspace. */
  rename(absOldPath: string, absNewPath: string): Promise<void>
  /** Trash a file or directory (recycle bin if available). */
  trash(absPath: string): Promise<void>
  /** Move multiple entries into a directory. */
  move(srcAbsPaths: string[], destDirAbsPath: string): Promise<void>
  /** Copy external absolute paths into a workspace directory. */
  copyInto(absSrcPaths: string[], destDirAbsPath: string): Promise<void>
  /** Recursive copy to an exact destination path inside the workspace. */
  copy(srcAbsPath: string, destAbsPath: string): Promise<void>
  /** Single-level directory listing with metadata. */
  listDir(absPath: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>
}


// ── Path helpers ──────────────────────────────────────────────────────────────

/** Strip a workspace root / "demo/" prefix / leading slash → workspace-relative key. */
function normalizeKey(path: string): string {
  let key = path.replace(/\\/g, '/')
  key = key.replace(/^demo\//, '')
  key = key.replace(/^\//, '')
  return key
}

// ── Path helpers (Electron IPC wants root + relative; ViewsFS exposes abs) ────

/**
 * Split an absolute workspace path into (root, relative).
 * The "root" is the workspace base — the longest prefix passed to the FS so
 * far. In practice we hand it through `setWorkspace` and the FS carries it.
 * For the Electron impl we keep an explicit root; for the Mock impl keys are
 * already relative.
 */
function splitWorkspacePath(absPath: string, root: string): string {
  const norm = absPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const bareRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  // The root itself is the empty relative path. Without this case the trailing
  // slash below makes `root` fail its own prefix test and fall through to the
  // "already relative" branch, which returns the whole absolute path — so a
  // listing scoped to the Workspace root was scoped to a directory named after
  // the root's own absolute path, and matched nothing.
  if (!bareRoot || norm === bareRoot) return ''
  if (norm.startsWith(`${bareRoot}/`)) return norm.slice(bareRoot.length + 1)
  // Already relative
  return norm.replace(/^\//, '')
}

// ── Electron implementation (IPC-based) ─────────────────────────────────────

interface WorkspaceBridge {
  exists(root: string, rel: string): Promise<boolean>
  mkdir(root: string, rel: string): Promise<void>
  listFiles(root: string): Promise<string[]>
  readText(root: string, rel: string): Promise<string>
  readBytes(root: string, rel: string): Promise<Uint8Array>
  readByteRange(root: string, rel: string, start: number, end: number): Promise<Uint8Array | null>
  writeTextAtomic(root: string, rel: string, content: string): Promise<void>
  rename(root: string, oldRel: string, newRel: string): Promise<void>
  trash(root: string, rel: string): Promise<void>
  move(root: string, srcRels: string[], destDirRel: string): Promise<void>
  copyInto(root: string, absSrcPaths: string[], destDirRel: string): Promise<void>
  copy(root: string, srcRel: string, destRel: string): Promise<void>
  listDir(root: string, rel: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>
}

function workspaceBridge(): WorkspaceBridge | undefined {
  return (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspace
}

let workspaceReadyGate: () => Promise<void> = async () => {}

/**
 * Install the active Workspace registration barrier. Electron filesystem IPC
 * must not race the main-process registry write performed while restoring or
 * switching Workspaces.
 */
export function setViewsFSWorkspaceReady(gate: () => Promise<void>) {
  workspaceReadyGate = gate
}

/**
 * `**` matches zero or more path segments; `*` stays inside one segment.
 *
 * "Zero or more" is the part that matters: `**` followed by a separator has to
 * be able to consume that separator too, or the pattern `loadFileTree` uses to
 * mean "everything" silently excludes every file sitting at the Workspace root
 * -- which is exactly where `Snakefile` lives.
 *
 * Written as a scan rather than a chain of `.replace()` calls so no sentinel
 * character is needed to keep the two star forms apart.
 */
function globToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      i += 1
      if (pattern[i + 1] === '/') {
        i += 1
        source += '(?:.*/)?'
      } else {
        source += '.*'
      }
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * Every read and write goes through `tdeaseDesktop.workspace`, whose IPC handlers
 * take `(root, relative)` and confine each call to the attached Workspace.
 *
 * This used to be written against `window.__tdease_fs`, a global the preload
 * declared a filesystem on in some earlier revision and had long since narrowed
 * to `{ pickDirectory }`. The mismatch never surfaced as an error message,
 * because `getViewsFS()` treated the global's absence as "not Electron" and
 * silently handed back the browser DEMO filesystem — so an attached Workspace
 * rendered an empty tree, `loadFileTree()` reported no files, and the Agent's
 * empty state said "0 raw files" about a directory with files in it. Binding to
 * the bridge that exists removes the second, invented contract.
 *
 * `isDirectory` and `fileMtime` have no direct IPC handler; both are derived
 * from the parent directory's `listDir`, which returns them per entry.
 */
function createElectronFS(root: string): ViewsFS {
  const desk = workspaceBridge()
  if (!desk) throw new Error('[views-fs] tdeaseDesktop.workspace is unavailable — the preload did not load')

  const rel = (absPath: string) => splitWorkspacePath(absPath, root)

  /** The parent directory's entry for `absPath`, or null when it has none. */
  async function entryOf(absPath: string) {
    await workspaceReadyGate()
    const relative = rel(absPath)
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
    const name = relative.split('/').pop() ?? relative
    const entries = await desk!.listDir(root, parent).catch(() => [])
    return entries.find((entry) => entry.name === name) ?? null
  }

  return {
    async readFile(absPath) { await workspaceReadyGate(); return desk.readText(root, rel(absPath)) },
    async readBlob(absPath) {
      await workspaceReadyGate()
      const relative = rel(absPath)
      // MIME from the extension: a type-aware consumer (<iframe src=blob-url>)
      // renders an untyped blob as plain text.
      return new Blob([new Uint8Array(await desk.readBytes(root, relative))], { type: mediaMimeType(relative) })
    },
    async readByteRange(absPath, start, end) {
      await workspaceReadyGate()
      const bytes = await desk.readByteRange(root, rel(absPath), start, end)
      return bytes ? new Uint8Array(bytes) : null
    },
    async writeFile(absPath, content) { await workspaceReadyGate(); return desk.writeTextAtomic(root, rel(absPath), content) },

    /**
     * `cwd` may be the Workspace root or any directory inside it. The bridge
     * lists the whole Workspace relative to the root, so the listing is
     * re-based onto `cwd` before the glob is applied — otherwise a pattern
     * anchored at a subdirectory would match nothing.
     */
    async listFiles(glob, cwd) {
      await workspaceReadyGate()
      const all = await desk.listFiles(root)
      const base = cwd ? rel(cwd) : ''
      const prefix = base && base !== '.' ? `${base.replace(/\/$/, '')}/` : ''
      const scoped = prefix
        ? all.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length))
        : all
      const pattern = prefix && glob.startsWith(prefix) ? glob.slice(prefix.length) : glob
      if (!pattern.includes('*') && !pattern.includes('?')) {
        return scoped.includes(pattern) ? [pattern] : []
      }
      const regex = globToRegExp(pattern)
      return scoped.filter((path) => regex.test(path)).sort()
    },

    async fileExists(absPath) { await workspaceReadyGate(); return desk.exists(root, rel(absPath)) },
    async fileMtime(absPath) { return (await entryOf(absPath))?.mtime ?? 0 },
    async isDirectory(absPath) { return (await entryOf(absPath))?.isDir ?? false },
    async createFile(absPath, content = '') { await workspaceReadyGate(); return desk.writeTextAtomic(root, rel(absPath), content) },
    async mkdir(absPath) { await workspaceReadyGate(); return desk.mkdir(root, rel(absPath)) },
    async rename(absOld, absNew) { await workspaceReadyGate(); return desk.rename(root, rel(absOld), rel(absNew)) },
    async trash(absPath) { await workspaceReadyGate(); return desk.trash(root, rel(absPath)) },
    async move(srcAbsPaths, destDirAbs) {
      await workspaceReadyGate()
      return desk.move(root, srcAbsPaths.map(rel), rel(destDirAbs))
    },
    async copyInto(absSrcPaths, destDirAbs) {
      await workspaceReadyGate()
      return desk.copyInto(root, absSrcPaths, rel(destDirAbs))
    },
    async copy(srcAbs, destAbs) {
      await workspaceReadyGate()
      return desk.copy(root, rel(srcAbs), rel(destAbs))
    },
    async listDir(absPath) { await workspaceReadyGate(); return desk.listDir(root, rel(absPath)) },
  }
}

// ── Mock FS (browser dev mode, no backend needed) ───────────────────────────

interface MockEntry {
  /** File content; undefined for directories. */
  content?: string
  isDir: boolean
  mtime: number
}

function createMockFS(initialFiles: Record<string, string>): ViewsFS {
  const store = new Map<string, MockEntry>()

  // Seed: each key becomes a file; create intermediate directory entries.
  for (const [key, content] of Object.entries(initialFiles)) {
    store.set(key, { content, isDir: false, mtime: Date.now() })
    // Auto-create parent directories
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) {
      const dirKey = parts.slice(0, i).join('/')
      if (!store.has(dirKey)) store.set(dirKey, { isDir: true, mtime: Date.now() })
    }
  }

  // Match glob pattern against stored keys.
  // Supports * (single path segment) and ** (any depth).
  function matchGlob(pattern: string): string[] {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return store.has(pattern) ? [pattern] : []
    }
    const regex = new RegExp(
      '^' + pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '<<<DSH>>>')
        .replace(/\*/g, '[^/]*')
        .replace(/<<<DSH>>>/g, '.*')
      + '$'
    )
    const results: string[] = []
    for (const key of store.keys()) {
      if (regex.test(key)) results.push(key)
    }
    return results.sort()
  }

  /** Resolve `key` to its normalized workspace-relative form. */
  function asKey(absPath: string): string {
    return normalizeKey(absPath)
  }

  /** Direct children of a directory key (one level deep). */
  function directChildren(dirKey: string): string[] {
    const prefix = dirKey ? `${dirKey}/` : ''
    const seen = new Set<string>()
    for (const key of store.keys()) {
      if (prefix && !key.startsWith(prefix)) continue
      const rest = prefix ? key.slice(prefix.length) : key
      if (!rest) continue
      const first = rest.split('/')[0]
      seen.add(prefix + first)
    }
    return Array.from(seen)
  }

  /** Recollect all keys under a directory (inclusive). */
  function keysUnder(dirKey: string): string[] {
    const prefix = dirKey ? `${dirKey}/` : ''
    if (!prefix) return Array.from(store.keys())
    return Array.from(store.keys()).filter(k => k === dirKey || k.startsWith(prefix))
  }

  /** Bulk rewrite a key prefix (used by move/rename of a directory). */
  function renamePrefix(oldKey: string, newKey: string) {
    const victims = keysUnder(oldKey)
    for (const k of victims) {
      const entry = store.get(k)!
      const suffix = k === oldKey ? '' : k.slice(oldKey.length + 1)
      const target = suffix ? `${newKey}/${suffix}` : newKey
      store.set(target, entry)
      store.delete(k)
    }
  }

  return {
    async readFile(absPath) {
      const key = asKey(absPath)
      const entry = store.get(key)
      if (!entry || entry.isDir) throw new Error(`File not found: ${absPath}`)
      return entry.content ?? ''
    },

    async readBlob(absPath) {
      const key = asKey(absPath)
      const entry = store.get(key)
      if (!entry || entry.isDir) throw new Error(`File not found: ${absPath}`)
      return new Blob([entry.content ?? ''])
    },

    async readByteRange() {
      return null
    },

    async writeFile(absPath, content) {
      const key = asKey(absPath)
      store.set(key, { content, isDir: false, mtime: Date.now() })
      // Ensure parents exist
      const parts = key.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dirKey = parts.slice(0, i).join('/')
        if (!store.has(dirKey)) store.set(dirKey, { isDir: true, mtime: Date.now() })
      }
    },

    async listFiles(glob, cwd) {
      const prefix = cwd ? cwd.replace(/\\/g, '/').replace(/\/?$/, '/') : ''
      const cleanGlob = prefix && glob.startsWith(prefix) ? glob.slice(prefix.length) : glob
      return matchGlob(cleanGlob)
    },

    async fileExists(absPath) {
      return store.has(asKey(absPath))
    },

    async fileMtime(absPath) {
      return store.get(asKey(absPath))?.mtime ?? 0
    },

    async isDirectory(absPath) {
      const entry = store.get(asKey(absPath))
      if (entry) return entry.isDir
      // Inferred: anything with children counts as a dir
      const prefix = asKey(absPath)
      for (const k of store.keys()) {
        if (k.startsWith(`${prefix}/`)) return true
      }
      return false
    },

    async createFile(absPath, content = '') {
      const key = asKey(absPath)
      store.set(key, { content, isDir: false, mtime: Date.now() })
      const parts = key.split('/')
      for (let i = 1; i < parts.length; i++) {
        const dirKey = parts.slice(0, i).join('/')
        if (!store.has(dirKey)) store.set(dirKey, { isDir: true, mtime: Date.now() })
      }
    },

    async mkdir(absPath) {
      const key = asKey(absPath)
      store.set(key, { isDir: true, mtime: Date.now() })
    },

    async rename(absOld, absNew) {
      const oldKey = asKey(absOld)
      const newKey = asKey(absNew)
      if (!store.has(oldKey)) throw new Error(`Not found: ${absOld}`)
      renamePrefix(oldKey, newKey)
    },

    async trash(absPath) {
      const key = asKey(absPath)
      for (const k of keysUnder(key)) store.delete(k)
    },

    async move(srcAbsPaths, destDirAbs) {
      const destDir = asKey(destDirAbs)
      if (!store.has(destDir)) store.set(destDir, { isDir: true, mtime: Date.now() })
      for (const src of srcAbsPaths) {
        const srcKey = asKey(src)
        if (!store.has(srcKey)) continue
        const baseName = srcKey.split('/').pop() || srcKey
        renamePrefix(srcKey, `${destDir}/${baseName}`)
      }
    },

    async copyInto(_absSrcPaths, _destDirAbs) {
      // Browser dev mode has no access to external absolute paths — the
      // upload path reads File objects via FileReader and calls createFile
      // instead. This stub is only reached when copyInto is invoked with
      // real absolute paths (Electron), so it is effectively unreachable
      // in mock mode. Implemented for interface completeness.
      throw new Error('[views-fs:mock] copyInto is unavailable in browser dev mode')
    },

    async copy(srcAbs, destAbs) {
      const srcKey = asKey(srcAbs)
      const destKey = asKey(destAbs)
      if (!store.has(srcKey)) throw new Error(`Not found: ${srcAbs}`)
      if (destKey === srcKey || destKey.startsWith(`${srcKey}/`)) {
        throw new Error('cannot copy a path into itself')
      }
      // Directory copy: clone every key under the source onto the destination.
      for (const k of keysUnder(srcKey)) {
        const entry = store.get(k)!
        const suffix = k === srcKey ? '' : k.slice(srcKey.length + 1)
        store.set(suffix ? `${destKey}/${suffix}` : destKey, { ...entry, mtime: Date.now() })
      }
    },

    async listDir(absPath) {
      const dirKey = asKey(absPath)
      const children = directChildren(dirKey)
      return children.map(name => {
        const entry = store.get(name)!
        return {
          name: name.split('/').pop() || name,
          isDir: entry.isDir,
          size: entry.isDir ? 0 : (entry.content?.length ?? 0),
          mtime: entry.mtime,
        }
      }).sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name))
    },
  }
}

// ── Demo data FS (browser dev) ──────────────────────────────────────────────

/** Create a ViewsFS pre-loaded with demo workspace data. */
export function createDemoFS(): ViewsFS {
  return createMockFS(DEMO_FILES)
}

// ── Factory ─────────────────────────────────────────────────────────────────

let _fs: ViewsFS | null = null

export function getViewsFS(): ViewsFS {
  if (_fs) return _fs

  // Detect Electron by the bridge this adapter actually calls. Detecting on a
  // different global than the implementation uses is how the demo filesystem
  // came to be served to a real, attached Workspace.
  if (workspaceBridge()) {
    _fs = createElectronFS(getWorkspaceRootHint())
  } else {
    // Browser dev mode: use embedded demo data
    _fs = createDemoFS()
  }
  return _fs
}

export function setViewsFS(fs: ViewsFS) {
  _fs = fs
}

/**
 * Hint used to split absolute paths into (root, relative) for the Electron
 * IPC bridge. Read from the workspace store's persisted path.
 */
let _workspaceRootHint = ''
export function setViewsFSWorkspaceRoot(root: string) {
  _workspaceRootHint = root
  // Reset FS so the next getViewsFS() call re-creates with the new root.
  _fs = null
}
function getWorkspaceRootHint(): string {
  return _workspaceRootHint
}
