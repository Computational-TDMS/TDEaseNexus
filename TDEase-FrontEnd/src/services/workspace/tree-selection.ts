/**
 * Tree-selection helpers — multi-select semantics for the workspace file tree.
 *
 * Mirrors openhanako DeskTree's selection model:
 *   - single click → replace selection
 *   - Cmd/Ctrl click → toggle one entry
 *   - Shift click → range from anchor to clicked entry
 *
 * Selection state is keyed by workspace-relative paths (subdir strings).
 * `compactDragEntries` drops descendants of selected directories so a drag
 * never carries a parent AND its child (which would double-move).
 */

import type { FileTreeNode } from '@/types/workspace-data'

/** "parent/child" join for workspace-relative paths. Empty parent → name only. */
export function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/** Get the parent path of a workspace-relative path ('' = root). */
export function parentPath(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(0, idx) : ''
}

/** Is `path` strictly inside `ancestor`? (ancestor !== path). */
export function isDescendant(path: string, ancestor: string): boolean {
  return ancestor !== '' && path.startsWith(`${ancestor}/`)
}

export interface VisibleTreeEntry {
  node: FileTreeNode
  parent: string
  path: string
  depth: number
}

/** Collect the flattened, visible entry list — only expanded directories recurse. */
export function collectVisibleTreeEntries(
  nodes: FileTreeNode[],
  parent: string,
  depth: number,
  expandedPaths: Set<string>,
  childrenOf: (dirPath: string) => FileTreeNode[] | undefined,
): VisibleTreeEntry[] {
  const out: VisibleTreeEntry[] = []
  for (const node of nodes) {
    const path = childPath(parent, node.name)
    out.push({ node, parent, path, depth })
    if (node.type === 'directory' && expandedPaths.has(path)) {
      const children = childrenOf(path) ?? node.children ?? []
      out.push(...collectVisibleTreeEntries(children, path, depth + 1, expandedPaths, childrenOf))
    }
  }
  return out
}

/** True if any ancestor of `path` is in `selectedDirs`. */
export function hasSelectedDirectoryAncestor(path: string, selectedDirs: Set<string>): boolean {
  let current = parentPath(path)
  while (current) {
    if (selectedDirs.has(current)) return true
    current = parentPath(current)
  }
  return false
}

/**
 * Drop entries whose ancestor directory is also in the selection — dragging
 * both would otherwise move a directory and then try to move its child into
 * the destination too, causing failures.
 */
export function compactDragEntries(entries: VisibleTreeEntry[]): VisibleTreeEntry[] {
  const selectedDirs = new Set(
    entries.filter(e => e.node.type === 'directory').map(e => e.path),
  )
  if (selectedDirs.size === 0) return entries
  return entries.filter(e => !hasSelectedDirectoryAncestor(e.path, selectedDirs))
}

export interface TreeSelectMeta {
  /** Cmd (mac) or Ctrl (win/linux). */
  multi: boolean
  /** Shift. */
  shift: boolean
}

/**
 * Compute the next selected-paths set given the current selection, the
 * clicked path, and the visible-entry list (for range selection).
 *
 * Returns:
 *   - `paths`: the new selected set
 *   - `anchor`: the new anchor (null = cleared)
 *   - `primary`: the "main" clicked path (for backward-compat single-selection)
 */
export function computeTreeSelection(
  current: Set<string>,
  currentAnchor: string | null,
  clickedPath: string,
  meta: TreeSelectMeta,
  visible: VisibleTreeEntry[],
): { paths: Set<string>; anchor: string | null; primary: string } {
  // ── Shift + range ──
  if (meta.shift && currentAnchor) {
    const anchorIdx = visible.findIndex(e => e.path === currentAnchor)
    const clickIdx = visible.findIndex(e => e.path === clickedPath)
    if (anchorIdx >= 0 && clickIdx >= 0) {
      const start = Math.min(anchorIdx, clickIdx)
      const end = Math.max(anchorIdx, clickIdx)
      const next = meta.multi ? new Set(current) : new Set<string>()
      for (let i = start; i <= end; i++) next.add(visible[i]!.path)
      return { paths: next, anchor: currentAnchor, primary: clickedPath }
    }
  }

  // ── Cmd/Ctrl toggle ──
  if (meta.multi) {
    const next = new Set(current)
    if (next.has(clickedPath)) next.delete(clickedPath)
    else next.add(clickedPath)
    return { paths: next, anchor: clickedPath, primary: clickedPath }
  }

  // ── Plain single-select ──
  return { paths: new Set([clickedPath]), anchor: clickedPath, primary: clickedPath }
}
