/**
 * Tree-move helpers — filter drag items so a drop never moves a directory
 * into itself or its own descendant (which would fail or corrupt the tree).
 *
 * Mirrors openhanako's buildMoveItemsForDest / isDescendant.
 */

import { isDescendant } from './tree-selection'
import type { DraggedFile } from './file-drag'

export interface MoveItem {
  /** Workspace-relative source path. */
  sourcePath: string
  name: string
  isDirectory: boolean
}

/**
 * Given the dragged files and a destination directory, return only the items
 * that should actually move:
 *   - skip items already in the destination
 *   - skip the destination directory itself
 *   - skip moves where the destination is inside the dragged directory
 *     (would create a cycle)
 */
export function buildMoveItemsForDest(
  files: DraggedFile[],
  destPath: string,
): MoveItem[] {
  const normalizedDest = destPath.replace(/^\/+|\/+$/g, '')
  return files
    .map(f => ({
      sourcePath: f.path,
      name: f.name,
      isDirectory: f.isDirectory,
    }))
    .filter(item => {
      const src = item.sourcePath.replace(/^\/+|\/+$/g, '')
      if (src === normalizedDest) return false
      if (!item.isDirectory) return true
      // Moving a directory: reject if dest is the dir itself or under it.
      if (normalizedDest === src) return false
      if (isDescendant(normalizedDest, src)) return false
      return true
    })
}
