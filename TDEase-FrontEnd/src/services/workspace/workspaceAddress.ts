/**
 * workspaceAddress — the renderer's ONE module for turning a
 * workspace-relative path into an absolute one and back.
 *
 * Three hand-rolled joins used to coexist here (the store's byte readers,
 * the composer's attachment flow, FileDocument's desktop actions), each with
 * its own separator and case rules and none with traversal protection. This
 * module replaces all of them and aligns the comparison semantics with the
 * main process's authority, `electron/path_containment.cjs`:
 *
 *   - resolve both sides, then compare segment-wise (never raw string
 *     prefixes, so `C:/wsfoo` does not slip past root `C:/ws`);
 *   - Windows paths (drive-letter or UNC shape, or a Windows host) compare
 *     case-insensitively, exactly `comparisonPath`'s `toLowerCase()` on
 *     win32;
 *   - containment is fail-closed: an absolute `relative`, an empty part, or
 *     any `..` that would climb above the root is refused.
 *
 * The renderer cannot run `realpathSync.native`, so symlink pivots stay the
 * main process's job — every byte that actually moves still crosses a
 * `workspace:*` IPC handler, which re-checks containment against the
 * registry. What this module adds is the same refusal one layer earlier,
 * before a bogus path is ever placed on the wire.
 */

/** The host the renderer runs on — the same machine the main process's
 *  `process.platform === 'win32'` branch sees. Electron's contextIsolation
 *  hides `process` from this world, so `navigator.platform` is the reliable
 *  tell (absent in jsdom, where shape detection alone decides). */
function hostIsWindows(): boolean {
  return typeof navigator !== 'undefined' && /win/i.test(navigator.platform)
}

interface ParsedPath {
  /** Windows comparison semantics apply (case-insensitive segments). */
  windows: boolean
  /** Absolute base: drive (`C:`), UNC share (`//srv/sh`), posix root (`/`), or '' (relative). */
  prefix: string
  /** Resolved segments: separators unified, `.` dropped, `..` applied (clamped at the base). */
  segments: string[]
}

function parsePath(input: string): ParsedPath {
  const unified = input.replace(/[\\/]+/g, '/')
  const unc = /^\/\/[^/]+\/[^/]+/.exec(unified)
  const drive = /^[a-zA-Z]:/.exec(unified)
  const windows = Boolean(unc || drive) || hostIsWindows()
  let prefix = ''
  let rest = unified
  if (unc) {
    prefix = unc[0]
    rest = unified.slice(unc[0].length)
  } else if (drive) {
    prefix = drive[0]
    rest = unified.slice(drive[0].length)
  } else if (unified.startsWith('//')) {
    prefix = '//'
    rest = unified.slice(2)
  } else if (unified.startsWith('/')) {
    prefix = '/'
    rest = unified.slice(1)
  }
  const segments: string[] = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue
    // `..` above the base clamps (posix `path.resolve` semantics); whether
    // that means "escaped" is each caller's question, not the parser's.
    if (segment === '..') {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return { windows, prefix, segments }
}

function segmentKey(path: ParsedPath, segment: string): string {
  return path.windows ? segment.toLowerCase() : segment
}

/** The prefix re-spelled in the output separator convention: posix `/` IS the
 *  separator (never doubled); a UNC share gets its leading slashes back. */
function nativePrefix(path: ParsedPath, sep: '\\' | '/'): string {
  if (!path.prefix) return ''
  const prefix = sep === '\\' ? path.prefix.replace(/\//g, '\\') : path.prefix
  return prefix === '/' ? sep : `${prefix}${sep}`
}

/**
 * Whether `candidate` resolves to the root itself or to something under it —
 * the renderer twin of `isContained` in `electron/path_containment.cjs`
 * (segment-wise, case-insensitive on Windows, the root itself counts as
 * contained). A relative root (browser demo mode's `demo`) contains only
 * paths that resolve under it.
 */
export function isInsideWorkspace(root: string, candidate: string): boolean {
  if (!root.trim()) return false
  const rootPath = parsePath(root)
  const candidatePath = parsePath(candidate)
  if (rootPath.windows !== candidatePath.windows) return false
  if (rootPath.prefix.toLowerCase() !== candidatePath.prefix.toLowerCase()) return false
  if (candidatePath.segments.length < rootPath.segments.length) return false
  for (let i = 0; i < rootPath.segments.length; i += 1) {
    if (segmentKey(rootPath, rootPath.segments[i]!) !== segmentKey(candidatePath, candidatePath.segments[i]!)) {
      return false
    }
  }
  return true
}

/**
 * Resolves `relative` under `root` and returns the contained absolute path,
 * in the root's own separator convention. Fails closed — throws on an
 * absolute `relative`, an empty part, or a `..` that would climb above the
 * root — mirroring `containedPath`'s denial, one layer earlier.
 */
export function workspaceFilePath(root: string, relative: string): string {
  if (!root.trim()) throw new Error('workspace path resolved without a Workspace root')
  if (!relative.trim()) throw new Error('workspace path resolved without a relative part')
  const rel = relative.replace(/[\\/]+/g, '/')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('//')) {
    throw new Error(`workspace path must be Workspace-relative: ${relative}`)
  }
  const rootPath = parsePath(root)
  const segments = [...rootPath.segments]
  for (const segment of rel.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length <= rootPath.segments.length) {
        throw new Error('workspace path traversal denied')
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  const sep: '\\' | '/' = root.includes('\\') ? '\\' : '/'
  return `${nativePrefix(rootPath, sep)}${segments.join(sep)}`
}

/**
 * The workspace-relative spelling of an absolute path — posix-separated, the
 * convention every document key, attachment marker and tree path uses. A
 * path outside the root is not an error for a *display* helper: it comes
 * back unchanged rather than throwing.
 */
export function displayRelativePath(root: string, absolute: string): string {
  if (!isInsideWorkspace(root, absolute)) return absolute
  const rootPath = parsePath(root)
  const absolutePath = parsePath(absolute)
  return absolutePath.segments.slice(rootPath.segments.length).join('/')
}
