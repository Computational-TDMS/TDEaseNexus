/**
 * TreeCtx — the contract each virtualized TreeRow receives from the FileTree
 * wrapper via provide/inject. Keeps the rows free of prop drilling and
 * free of module-level mutable state (which would break multi-instance trees).
 */

import type { InjectionKey } from 'vue'
import type { Ref } from 'vue'
import type { FileTreeNode } from '@/types/workspace-data'

export type InlineEdit =
  | { mode: 'rename'; targetPath: string }
  | {
      mode: 'create'
      parentPath: string
      kind: 'file' | 'folder'
      draftName: string
      phase: 'editing' | 'saving'
    }
  | null

export interface TreeSelectMeta {
  multi: boolean
  shift: boolean
}

export interface TreeCtx {
  /** Selection + (for dirs) expand toggle. */
  onSelect(path: string, meta: TreeSelectMeta, isDir: boolean): void
  /** Single-click a file → preview/open in Studio. */
  onFileOpen(path: string): void
  /** Begin inline rename for a node. */
  onBeginRename(path: string): void
  /** Commit rename with the new name. */
  onCommitRename(path: string, newName: string): void
  /** Begin inline create. */
  startCreate(parentPath: string, kind: 'file' | 'folder'): void
  /** Commit create with the chosen name. */
  onCommitCreate(edit: Extract<InlineEdit, { mode: 'create' }>, newName: string): void
  /** Cancel any inline edit. */
  onCancelEdit(): void
  /** Right-click on a node → build node menu. */
  onNodeContextMenu(node: FileTreeNode, path: string, x: number, y: number): void
  // ── Drag & drop ──
  /** Begin a drag from this node (writes payload, may start native drag). */
  onDragStart(node: FileTreeNode, path: string, e: DragEvent): void
  /** Drag-over a directory → decide dropEffect + highlight. */
  onDragOver(path: string, e: DragEvent): boolean
  /** Drag leaves a directory → clear highlight. */
  onDragLeave(path: string, e: DragEvent): void
  /** Drop onto a directory → perform the move / upload. */
  onDrop(path: string, e: DragEvent): Promise<void>
}

/**
 * The single directory path currently highlighted as a drag-over drop target
 * (read by TreeRow). A scalar, not a per-path map: rebuilding a map object on
 * every dragover event re-rendered the whole tree.
 */
export type ActiveDropTarget = Ref<string | null>

export const TREE_CTX_KEY: InjectionKey<TreeCtx> = Symbol('treeCtx')
export const TREE_INLINE_EDIT_KEY: InjectionKey<Ref<InlineEdit>> = Symbol('treeInlineEdit')
export const TREE_DROP_TARGET_KEY: InjectionKey<ActiveDropTarget> = Symbol('treeDropTarget')
