<template>
  <div ref="treeRef" class="file-tree" @contextmenu.prevent="onBlankContextMenu">
    <!-- No workspace → empty overlay -->
    <template v-if="!store.workspacePath">
      <div class="empty-overlay">
        <p class="empty-text">{{ t('workbench.fileTree.noWorkspaceTitle') }}</p>
        <p class="empty-hint">{{ t('workbench.fileTree.noWorkspaceHint') }}</p>
      </div>
    </template>

    <!-- Loading -->
    <template v-else-if="store.loading">
      <div class="tree-loading">{{ t('workbench.fileTree.scanning') }}</div>
    </template>

    <!-- Tree -->
    <div
      v-else
      class="tree"
      role="tree"
      tabindex="0"
      :data-empty-text="visibleEntries.length === 0 ? t('workbench.fileTree.emptyFolder') : ''"
      @click="onTreeBlankClick"
      @keydown="onTreeKeyDown"
    >
      <!-- Pending create at root -->
      <PendingCreateNode
        v-if="rootPendingCreate"
        :kind="rootPendingCreate.kind"
        :draft-name="rootPendingCreate.draftName"
        :saving="rootPendingCreate.phase === 'saving'"
        :depth="0"
        @commit="(v) => commitCreate(rootPendingCreate!, v)"
        @cancel="cancelEdit"
      />

      <TreeNode
        v-for="node in rootNodes"
        :key="node.path"
        :node="node"
        :parent-path="''"
        :depth="0"
      />

      <div v-if="visibleEntries.length === 0 && !store.loading" class="tree-empty-hint">
        {{ t('workbench.fileTree.emptyRootHint') }}
      </div>
    </div>

    <!-- Context menu portal -->
    <ContextMenu :state="ctxMenu" @close="ctxMenu = null" />
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref, watch, nextTick, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FileTreeNode } from '@/types/workspace-data'
import { useWorkspaceStore } from '@/stores/workspace'
import { useSelectionStore } from '@/stores/selection'
import { useConfirmDialogStore } from '@/stores/confirmDialog'
import {
  collectVisibleTreeEntries,
  compactDragEntries,
  childPath,
  type VisibleTreeEntry,
} from '@/services/workspace/tree-selection'
import { isDesktopFileOpsAvailable, getDesktopFileOps } from '@/services/workspace/desktopWorkspace'
import { getViewsFS } from '@/services/workspace/views-fs'
import { createFileWatcher } from '@/services/workspace/fileWatcher'
import {
  writeFileDragPayload,
  readFileDragPayload,
  clearFileDragPayload,
  type DraggedFile,
} from '@/services/workspace/file-drag'
import { buildMoveItemsForDest } from '@/services/workspace/tree-move'
import ContextMenu, { type CtxMenuState, type MenuItem } from '@/components/common/ContextMenu.vue'
import PendingCreateNode from './PendingCreateNode.vue'
import TreeNode from './TreeNode.vue'
import {
  TREE_CTX_KEY,
  TREE_INLINE_EDIT_KEY,
  TREE_DROP_TARGET_KEY,
  type InlineEdit,
  type TreeCtx,
  type DropTargetMap,
} from './tree-context'

// This tree is mounted in the Navigator's Files section,
// so every string it shows is shell copy and goes through i18n — including the
// context-menu labels and the confirm/alert text, which a zh-CN user would
// otherwise meet in English.
const { t } = useI18n()

const store = useWorkspaceStore()
const selStore = useSelectionStore()
const treeRef = ref<HTMLDivElement>()

const emit = defineEmits<{ contextExplore: [filePath: string] }>()

// ── Visible entries (recursive, respecting expanded set) ─────────────────────

function childrenOf(dirPath: string): FileTreeNode[] | undefined {
  return store.directoryCache.get(dirPath) ?? undefined
}

const rootNodes = computed(() => sortNodes(store.fileTree))

const visibleEntries = computed<VisibleTreeEntry[]>(() =>
  collectVisibleTreeEntries(
    rootNodes.value,
    '',
    0,
    store.expandedPaths,
    childrenOf,
  ),
)

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  const dirs = nodes.filter(n => n.type === 'directory')
  const files = nodes.filter(n => n.type !== 'directory')
  const cmp = (a: FileTreeNode, b: FileTreeNode) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  dirs.sort(cmp)
  files.sort(cmp)
  return [...dirs, ...files]
}

// ── Inline edit state machine ────────────────────────────────────────────────

const inlineEdit = ref<InlineEdit>(null)
provide(TREE_INLINE_EDIT_KEY, inlineEdit)

/** Per-directory drop-target highlight state (path → highlighted?). */
const dropTargets = ref<DropTargetMap>({})
provide(TREE_DROP_TARGET_KEY, dropTargets)

/** The pending-create edit, if and only if it targets the workspace root. */
const rootPendingCreate = computed(() =>
  inlineEdit.value?.mode === 'create' && inlineEdit.value.parentPath === ''
    ? inlineEdit.value
    : null,
)

function validateName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return null            // empty → cancel
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    void useConfirmDialogStore().notice({ message: t('workbench.fileTree.invalidName') })
    return null
  }
  return trimmed
}

function startCreate(parentPath: string, kind: 'file' | 'folder') {
  const draftName = kind === 'folder' ? t('workbench.fileTree.draftFolder') : t('workbench.fileTree.draftFile')
  // Ensure the parent dir is expanded so the pending row is visible.
  if (parentPath && !store.expandedPaths.has(parentPath)) {
    store.toggleExpand(parentPath)
    // Trigger lazy load so the new node can be inserted into a real listing.
    void store.loadDirLazy(parentPath)
  }
  inlineEdit.value = { mode: 'create', parentPath, kind, draftName, phase: 'editing' }
}

function beginRename(targetPath: string) {
  inlineEdit.value = { mode: 'rename', targetPath }
}

function cancelEdit() {
  inlineEdit.value = null
}

async function commitRename(targetPath: string, nextName: string) {
  const trimmed = validateName(nextName)
  inlineEdit.value = null
  if (!trimmed) return
  const oldName = targetPath.split('/').pop() || targetPath
  if (trimmed === oldName) return
  try {
    const newPath = await store.renamePath(targetPath, trimmed)
    selStore.selectFile(newPath)
  } catch (err) {
    console.error('[FileTree] rename failed', err)
    void useConfirmDialogStore().notice({
      message: t('workbench.fileTree.renameFailed', { error: err instanceof Error ? err.message : String(err) }),
    })
  }
}

async function commitCreate(edit: Extract<InlineEdit, { mode: 'create' }>, nextName: string) {
  const trimmed = validateName(nextName)
  if (!trimmed) { inlineEdit.value = null; return }
  inlineEdit.value = { ...edit, phase: 'saving' }
  try {
    if (edit.kind === 'folder') {
      await store.mkdir(edit.parentPath, trimmed)
    } else {
      await store.createFile(edit.parentPath, trimmed, '')
    }
    const newPath = childPath(edit.parentPath, trimmed)
    selStore.selectFile(newPath)
  } catch (err) {
    console.error('[FileTree] create failed', err)
    void useConfirmDialogStore().notice({
      message: t('workbench.fileTree.createFailed', { error: err instanceof Error ? err.message : String(err) }),
    })
  } finally {
    inlineEdit.value = null
  }
}

// ── Clipboard / duplicate / refresh ──────────────────────────────────────────

function selectedPaths(): string[] {
  return getSelectedEntries().map(e => e.path)
}

function doCopy() {
  store.copyPaths(selectedPaths())
}

function doCut() {
  store.cutPaths(selectedPaths())
}

/** Paste lands in `path` when it is a directory, else in its parent. */
function pasteTargetFor(path: string, isDir: boolean): string {
  return isDir ? path : path.split('/').slice(0, -1).join('/')
}

async function doPaste(targetDir: string) {
  try {
    await store.pastePaths(targetDir)
  } catch (err) {
    console.error('[FileTree] paste failed', err)
    void useConfirmDialogStore().notice({
      message: t('workbench.fileTree.pasteFailed', { error: err instanceof Error ? err.message : String(err) }),
    })
  }
}

async function doDuplicate() {
  try {
    await store.duplicatePaths(selectedPaths())
  } catch (err) {
    console.error('[FileTree] duplicate failed', err)
    void useConfirmDialogStore().notice({
      message: t('workbench.fileTree.duplicateFailed', { error: err instanceof Error ? err.message : String(err) }),
    })
  }
}

function doRefresh() {
  void store.refreshExpanded()
}

// ── Trash (used by context menu / keyboard) ──────────────────────────────────

async function trashSelection() {
  const entries = getSelectedEntries()
  if (entries.length === 0) return
  const names = entries.map(e => e.node.name).join(', ')
  const ok = await useConfirmDialogStore().request({
    title: t('workbench.fileTree.deleteTitle'),
    message: entries.length > 1
      ? t('workbench.fileTree.confirmDeleteMany', { count: entries.length })
      : t('workbench.fileTree.confirmDeleteOne', { name: names }),
    confirmLabel: t('workbench.fileTree.deleteConfirm'),
    cancelLabel: t('workbench.fileTree.deleteCancel'),
    danger: true,
  })
  if (!ok) return // dismissed — Esc, backdrop and the cancel button all land here
  try {
    await store.trashPaths(entries.map(e => e.path))
    selStore.clearTreeSelection()
  } catch (err) {
    console.error('[FileTree] trash failed', err)
    void useConfirmDialogStore().notice({
      message: t('workbench.fileTree.deleteFailed', { error: err instanceof Error ? err.message : String(err) }),
    })
  }
}

/** All currently-selected visible entries, with descendants-of-selected-dirs removed. */
function getSelectedEntries(): VisibleTreeEntry[] {
  const selected = visibleEntries.value.filter(e => selStore.selectedTreePaths.has(e.path))
  return compactDragEntries(selected)
}

// ── Selection handlers ───────────────────────────────────────────────────────

function onSelect(path: string, meta: { multi: boolean; shift: boolean }, isDir: boolean) {
  selStore.selectTreePath(path, meta, visibleEntries.value)
  // Single-click a directory (no modifier) → toggle expand + lazy-load
  if (isDir && !meta.multi && !meta.shift) {
    store.toggleExpand(path)
    if (store.expandedPaths.has(path)) void store.loadDirLazy(path)
  }
}

function onFileOpen(path: string) {
  emit('contextExplore', path)
}

function onTreeBlankClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (target?.closest('[data-tree-item]')) return
  // Click on blank area → clear selection + cancel any inline edit
  selStore.clearTreeSelection()
  inlineEdit.value = null
}

// ── Container-level keyboard navigation ──────────────────────────────────────
// ↑/↓ move the primary selection through visibleEntries; ← collapses a dir
// (or jumps to parent when already collapsed); → expands a dir (or descends);
// Enter opens a file / toggles a dir; F2 / Shift+Enter begins rename; Delete
// trashes the selection; Esc clears multi-select / cancels inline edit.
//
// Inline-edit keystrokes (Enter/Esc inside the rename input) are handled by
// InlineRenameInput itself and never reach this handler.

function currentEntryIndex(): number {
  const p = selStore.filePath
  if (!p) return -1
  return visibleEntries.value.findIndex(e => e.path === p)
}

function focusEntry(path: string) {
  selStore.selectFile(path)
  // scrollIntoView is handled by the watch on selStore.filePath.
}

function onTreeKeyDown(e: KeyboardEvent) {
  // Don't hijack typing inside an inline-edit input.
  const target = e.target as HTMLElement | null
  if (target?.tagName === 'INPUT') return

  const entries = visibleEntries.value
  if (entries.length === 0) return

  switch (e.key) {
    case 'ArrowDown': {
      e.preventDefault()
      const idx = currentEntryIndex()
      const next = idx < entries.length - 1 ? entries[idx + 1] : entries[idx]
      if (next) focusEntry(next.path)
      break
    }
    case 'ArrowUp': {
      e.preventDefault()
      const idx = currentEntryIndex()
      const prev = idx > 0 ? entries[idx - 1] : entries[0]
      if (prev) focusEntry(prev.path)
      break
    }
    case 'ArrowLeft': {
      const cur = entries[currentEntryIndex()]
      if (!cur) return
      e.preventDefault()
      if (cur.node.type === 'directory' && store.expandedPaths.has(cur.path)) {
        store.toggleExpand(cur.path)
      } else if (cur.parent) {
        focusEntry(cur.parent)
      }
      break
    }
    case 'ArrowRight': {
      const cur = entries[currentEntryIndex()]
      if (!cur) return
      if (cur.node.type !== 'directory') return
      e.preventDefault()
      if (!store.expandedPaths.has(cur.path)) {
        store.toggleExpand(cur.path)
        void store.loadDirLazy(cur.path)
      } else {
        // Descend to first child.
        const firstChild = entries.find(e => e.parent === cur.path)
        if (firstChild) focusEntry(firstChild.path)
      }
      break
    }
    case 'Enter': {
      const cur = entries[currentEntryIndex()]
      if (!cur) return
      e.preventDefault()
      if (e.shiftKey) {
        beginRename(cur.path)
      } else if (cur.node.type === 'directory') {
        store.toggleExpand(cur.path)
        if (store.expandedPaths.has(cur.path)) void store.loadDirLazy(cur.path)
      } else {
        emit('contextExplore', cur.path)
      }
      break
    }
    case 'F2': {
      const cur = entries[currentEntryIndex()]
      if (!cur) return
      e.preventDefault()
      beginRename(cur.path)
      break
    }
    case 'Delete': {
      if (selStore.selectedTreePaths.size === 0) return
      e.preventDefault()
      void trashSelection()
      break
    }
    case 'c':
    case 'C': {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      doCopy()
      break
    }
    case 'x':
    case 'X': {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      doCut()
      break
    }
    case 'v':
    case 'V': {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      if (!store.clipboard) break
      const cur = entries[currentEntryIndex()]
      doPaste(cur ? pasteTargetFor(cur.path, cur.node.type === 'directory') : '')
      break
    }
    case 'F5': {
      e.preventDefault()
      doRefresh()
      break
    }
    case 'Escape': {
      if (inlineEdit.value) { inlineEdit.value = null; e.preventDefault(); break }
      if (selStore.selectedTreePaths.size > 0) {
        selStore.clearTreeSelection()
        e.preventDefault()
      }
      break
    }
  }
}

// ── Auto-scroll the primary selection into view ──────────────────────────────

watch(() => selStore.filePath, async (path) => {
  if (!path) return
  await nextTick()
  const root = treeRef.value
  if (!root) return
  const escaped = path.replace(/["\\]/g, '\\$&')
  const el = root.querySelector<HTMLElement>(`[data-tree-path="${escaped}"]`)
  // Optional *call*, not just optional access: `scrollIntoView` is absent in
  // jsdom, and an unguarded call rejects this watcher — a scroll convenience
  // must never be able to break selection.
  el?.scrollIntoView?.({ block: 'nearest' })
})

// ── §3.1 forward highlight: selecting a Run expands + softly highlights its
// `results/<runId>/` directory in the tree (the file→run half lives in
// selectFile). Silent no-op when the directory isn't present locally — the
// Run is still selectable, the tree just has nothing to show for it yet.

watch(() => selStore.runResultsPath, async (runDir) => {
  if (!runDir) return
  // Only act if the directory actually exists in the workspace. Probe both the
  // root listing and the directory cache; lazy-load either way so children
  // render once expanded.
  const existsLocally =
    store.fileTree.some(n => n.name === 'results') ||
    store.directoryCache.has('results') ||
    store.directoryCache.has(runDir)
  if (!existsLocally) return
  if (!store.expandedPaths.has(runDir)) {
    // Expand ancestors + the run dir itself.
    if (!store.expandedPaths.has('results')) store.toggleExpand('results')
    void store.loadDirLazy('results').then(() => void store.loadDirLazy(runDir))
    store.toggleExpand(runDir)
  }
})

// ── Context menu ─────────────────────────────────────────────────────────────

const ctxMenu = ref<CtxMenuState | null>(null)
const lastContextMenuPos = ref({ x: 0, y: 0 })

function resolveAbsPath(relPath: string): string | null {
  if (!store.workspacePath) return null
  const root = store.workspacePath.replace(/\\/g, '/').replace(/\/?$/, '/')
  return root + relPath
}

function buildNodeMenu(node: FileTreeNode, selfPath: string) {
  // If the right-clicked node isn't in the selection, collapse to just it
  // first so "Delete N" count and rename-target are accurate.
  if (!selStore.selectedTreePaths.has(selfPath)) {
    selStore.selectTreePath(selfPath, { multi: false, shift: false }, visibleEntries.value)
  }
  const entries = getSelectedEntries()
  const isDir = node.type === 'directory'
  const items: MenuItem[] = []

  items.push({
    label: isDir
      ? (store.expandedPaths.has(selfPath)
        ? t('workbench.fileTree.menuCollapse')
        : t('workbench.fileTree.menuExpand'))
      : t('workbench.fileTree.menuOpen'),
    action: () => {
      if (isDir) {
        store.toggleExpand(selfPath)
        if (store.expandedPaths.has(selfPath)) void store.loadDirLazy(selfPath)
      } else {
        emit('contextExplore', selfPath)
      }
    },
  })

  if (isDir) {
    items.push({ label: t('workbench.fileTree.menuNewFile'), action: () => startCreate(selfPath, 'file') })
    items.push({ label: t('workbench.fileTree.menuNewFolder'), action: () => startCreate(selfPath, 'folder') })
  }

  items.push({ divider: true })

  items.push({ label: t('workbench.fileTree.menuCopy'), disabled: entries.length === 0, action: () => doCopy() })
  items.push({ label: t('workbench.fileTree.menuCut'), disabled: entries.length === 0, action: () => doCut() })
  if (isDir && store.clipboard) {
    items.push({ label: t('workbench.fileTree.menuPaste'), action: () => { void doPaste(selfPath) } })
  }
  items.push({ label: t('workbench.fileTree.menuDuplicate'), disabled: entries.length !== 1, action: () => { void doDuplicate() } })
  items.push({ label: t('workbench.fileTree.menuRefresh'), action: () => doRefresh() })

  // Electron-only native ops. These are also the two actions the Navigator's
  // Files section points at when a Workspace file opens into a document that
  // cannot render it yet (see `FilesSection.vue`'s header) — they are the
  // working path to the bytes, so they must stay in this menu.
  if (isDesktopFileOpsAvailable()) {
    const abs = resolveAbsPath(selfPath)
    if (abs) {
      items.push({
        label: t('workbench.fileTree.menuReveal'),
        action: async () => {
          try { await getDesktopFileOps().showInFolder(abs) }
          catch (err) { console.error(err) }
        },
      })
      items.push({
        label: t('workbench.fileTree.menuCopyPath'),
        action: () => { navigator.clipboard?.writeText(abs).catch(() => {}) },
      })
      if (!isDir) {
        items.push({
          label: t('workbench.fileTree.menuOpenExternal'),
          action: async () => {
            try { await getDesktopFileOps().openExternal(abs) }
            catch (err) { console.error(err) }
          },
        })
      }
    }
  }

  items.push({ divider: true })

  items.push({
    label: t('workbench.fileTree.menuRename'),
    disabled: entries.length !== 1,
    action: () => beginRename(selfPath),
  })

  items.push({
    label: entries.length > 1
      ? t('workbench.fileTree.menuDeleteMany', { count: entries.length })
      : t('workbench.fileTree.menuDelete'),
    danger: true,
    action: () => { void trashSelection() },
  })

  ctxMenu.value = { position: lastContextMenuPos.value, items }
}

function buildBlankMenu() {
  const items: MenuItem[] = [
    { label: t('workbench.fileTree.menuNewFile'), action: () => startCreate('', 'file') },
    { label: t('workbench.fileTree.menuNewFolder'), action: () => startCreate('', 'folder') },
  ]
  if (store.clipboard) {
    items.push({ label: t('workbench.fileTree.menuPaste'), action: () => { void doPaste('') } })
  }
  items.push({ label: t('workbench.fileTree.menuRefresh'), action: () => doRefresh() })
  if (isDesktopFileOpsAvailable() && store.workspacePath) {
    items.push({ divider: true })
    items.push({
      label: t('workbench.fileTree.menuRevealWorkspace'),
      action: async () => {
        try { await getDesktopFileOps().showInFolder(store.workspacePath) }
        catch (err) { console.error(err) }
      },
    })
  }
  ctxMenu.value = { position: lastContextMenuPos.value, items }
}

function onNodeContextMenu(node: FileTreeNode, path: string, x: number, y: number) {
  lastContextMenuPos.value = { x, y }
  buildNodeMenu(node, path)
}

function onBlankContextMenu(e: MouseEvent) {
  // If the right-click landed on a tree item, let the node's own handler build
  // the node menu instead (node handler calls stopPropagation).
  const target = e.target as HTMLElement | null
  if (target?.closest('[data-tree-item]')) return
  lastContextMenuPos.value = { x: e.clientX, y: e.clientY }
  buildBlankMenu()
}

// ── Drag & drop ──────────────────────────────────────────────────────────────
// HTML5 DnD + a module-level payload registry (services/workspace/file-drag.ts)
// so we can carry structured {source, files} data across the drag. On Electron
// we additionally fire a native OS drag-out so the file can be dropped into
// other apps.

function resolveAbsPathStr(relPath: string): string | null {
  if (!store.workspacePath) return null
  const root = store.workspacePath.replace(/\\/g, '/').replace(/\/?$/, '/')
  return root + relPath
}

/** Collect the dragged entries: all selected if `path` is in selection, else just it. */
function getDragEntries(selfPath: string): VisibleTreeEntry[] {
  const visible = visibleEntries.value
  if (selStore.selectedTreePaths.has(selfPath)) {
    return compactDragEntries(visible.filter(e => selStore.selectedTreePaths.has(e.path)))
  }
  const single = visible.find(e => e.path === selfPath)
  return single ? [single] : []
}

function onDragStart(_node: FileTreeNode, path: string, e: DragEvent) {
  if (!e.dataTransfer) return
  const entries = getDragEntries(path)
  const files: DraggedFile[] = entries.map(en => ({
    path: en.path,
    name: en.node.name,
    absPath: resolveAbsPathStr(en.path) ?? undefined,
    isDirectory: en.node.type === 'directory',
  }))
  if (files.length === 0) return
  writeFileDragPayload(e.dataTransfer, { source: 'workspace', files })
  // Native OS drag-out (Electron only): lets the user drop the file into other
  // apps. Best-effort — failures fall back to the in-app HTML5 payload.
  if (isDesktopFileOpsAvailable()) {
    const absPaths = files.map(f => f.absPath).filter((p): p is string => !!p)
    if (absPaths.length > 0) {
      try { getDesktopFileOps().startNativeDrag(absPaths) } catch (err) { console.warn('[FileTree] native drag failed', err) }
    }
  }
}

function onDragOver(path: string, e: DragEvent): boolean {
  if (!e.dataTransfer) return false
  const payload = readFileDragPayload(e.dataTransfer)
  // Only directories accept drops.
  const canMove = payload?.source === 'workspace'
    ? buildMoveItemsForDest(payload.files, path).length > 0
    : true   // OS-file drop: always allow copy
  if (canMove) {
    e.dataTransfer.dropEffect = payload?.source === 'workspace' ? 'move' : 'copy'
    dropTargets.value = { ...dropTargets.value, [path]: true }
    return true
  }
  return false
}

function onDragLeave(path: string, e: DragEvent) {
  // Only clear if the pointer truly left this element (not just moved to a child).
  const rt = e.relatedTarget as Node | null
  const currentTarget = e.currentTarget as HTMLElement | null
  if (currentTarget && rt && currentTarget.contains(rt)) return
  if (dropTargets.value[path]) {
    const next = { ...dropTargets.value }
    delete next[path]
    dropTargets.value = next
  }
}

async function onDrop(path: string, e: DragEvent) {
  if (!e.dataTransfer) return
  // Clear highlight
  if (dropTargets.value[path]) {
    const next = { ...dropTargets.value }
    delete next[path]
    dropTargets.value = next
  }

  const payload = readFileDragPayload(e.dataTransfer)
  if (payload?.source === 'workspace') {
    clearFileDragPayload()
    const items = buildMoveItemsForDest(payload.files, path)
    if (items.length === 0) return
    try {
      // store.movePaths takes workspace-relative {path, isDirectory} items.
      await store.movePaths(
        items.map(it => ({ path: it.sourcePath, isDirectory: it.isDirectory })),
        path,
      )
    } catch (err) {
      console.error('[FileTree] move failed', err)
      void useConfirmDialogStore().notice({
        message: t('workbench.fileTree.moveFailed', { error: err instanceof Error ? err.message : String(err) }),
      })
    }
    return
  }

  // OS-file drop → upload into the directory
  const files = Array.from(e.dataTransfer.files ?? [])
  if (files.length === 0) return
  await uploadDroppedFiles(files, path)
}

/** Upload OS-dropped files into a workspace directory. */
async function uploadDroppedFiles(files: File[], destDirPath: string) {
  const fs = getViewsFS()
  const destAbs = resolveAbsPathStr(destDirPath)
  if (!destAbs) return

  // Electron: use the native absolute path → copyInto (preserves binary fidelity).
  if (isDesktopFileOpsAvailable()) {
    const absPaths: string[] = []
    for (const f of files) {
      const p = getDesktopFileOps().getPathForFile(f)
      if (p) absPaths.push(p)
    }
    if (absPaths.length > 0) {
      try {
        await fs.copyInto(absPaths, destAbs)
        await store.loadDirLazy(destDirPath)
        return
      } catch (err) {
        console.error('[FileTree] copyInto failed', err)
      }
    }
  }

  // Browser dev fallback: read text via FileReader → createFile. Binary files
  // (images etc.) won't survive this; that's acceptable for the mock mode.
  for (const f of files) {
    try {
      const text = await f.text()
      await fs.createFile(`${destAbs}/${f.name}`, text)
    } catch (err) {
      console.warn('[FileTree] dropped file upload failed', f.name, err)
    }
  }
  await store.loadDirLazy(destDirPath)
}

// Global dragend → clear any lingering payload + highlight.
if (typeof window !== 'undefined') {
  window.addEventListener('dragend', () => {
    clearFileDragPayload()
    if (Object.keys(dropTargets.value).length > 0) dropTargets.value = {}
  })
}

// ── Provide the TreeCtx to all descendant TreeNodes ──────────────────────────

const treeCtx: TreeCtx = {
  onSelect,
  onFileOpen,
  onBeginRename: beginRename,
  startCreate,
  onCommitRename: commitRename,
  onCommitCreate: commitCreate,
  onCancelEdit: cancelEdit,
  onNodeContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}
provide(TREE_CTX_KEY, treeCtx)

// ── Persist tree UI state (expanded paths + primary selection) per workspace ─
// Mirrors openhanako's workspace-ui-state-actions: debounced localStorage
// write keyed by workspaceId, restored on mount.

const TREE_STATE_DEBOUNCE_MS = 300
let persistTimer: ReturnType<typeof setTimeout> | null = null

function treeStateKey(): string | null {
  const id = store.workspaceId
  if (!id) return null
  return `tdease.tree-state.${id}`
}

function persistTreeState() {
  const key = treeStateKey()
  if (!key || typeof window === 'undefined') return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      const payload = JSON.stringify({
        expanded: Array.from(store.expandedPaths),
        selected: selStore.filePath ?? null,
      })
      window.localStorage.setItem(key, payload)
    } catch { /* quota / serialization — best effort */ }
  }, TREE_STATE_DEBOUNCE_MS)
}

/**
 * First-visit default expansion. When a Workspace has no persisted tree state
 * (first open, or cleared storage), the tree opens with only work-product
 * directories expanded — evidence, results, runs — so landing is
 * focused on what the user produced, not on raw file noise (data, config, src,
 * logs …). Anything outside this set stays collapsed until the user opens it,
 * at which point their choice is persisted and this default never runs again
 * for that Workspace.
 */
const DEFAULT_EXPANDED_WORK_PRODUCT_DIRS = ['evidence', 'results', 'runs']

function applyDefaultExpansion() {
  // Only expand dirs that actually exist at the Workspace root, so a Workspace
  // without (say) a `runs/` folder does not seed a phantom entry.
  const rootNames = new Set(store.fileTree.map((n) => n.name))
  for (const dir of DEFAULT_EXPANDED_WORK_PRODUCT_DIRS) {
    if (rootNames.has(dir) && !store.expandedPaths.has(dir)) {
      store.expandedPaths.add(dir)
      void store.loadDirLazy(dir)
    }
  }
}

function restoreTreeState() {
  const key = treeStateKey()
  if (!key || typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      // No persisted state for this Workspace → first visit. Open to the
      // work-product default rather than a fully-collapsed (or fully-noisy)
      // tree. The user's subsequent expand/collapse choices are persisted and
      // take over from here on.
      applyDefaultExpansion()
      return
    }
    const parsed = JSON.parse(raw) as { expanded?: string[]; selected?: string | null }
    if (Array.isArray(parsed.expanded) && parsed.expanded.length > 0) {
      // Replace the store's set directly so the tree opens to the saved state.
      store.expandedPaths = new Set(parsed.expanded)
      // Lazy-load each restored dir so its children render.
      for (const p of parsed.expanded) void store.loadDirLazy(p)
    }
    if (typeof parsed.selected === 'string' && parsed.selected) {
      selStore.selectFile(parsed.selected)
    }
  } catch { /* corrupt entry — ignore */ }
}

// The Files section stays mounted across Workspace switches. Restore once per
// Workspace id, after that Workspace's tree has loaded.
let restoredWorkspaceId: string | null = null
watch(
  () => [store.workspaceId, store.fileTree.length] as const,
  ([id, treeLen]) => {
    if (id && treeLen > 0 && id !== restoredWorkspaceId) {
      restoredWorkspaceId = id
      restoreTreeState()
    }
  },
  { immediate: true },
)

watch(() => store.workspaceId, () => {
  // Do not let a debounce scheduled in Workspace A resolve after setWorkspace
  // has changed the key to Workspace B.
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
})

// Persist on changes.
watch(() => store.expandedPaths, persistTreeState, { deep: true })
watch(() => selStore.filePath, persistTreeState)

// ── FileWatcher integration: refresh dirty dirs when external changes land ──
// Active in Electron (native chokidar via main-process IPC). Browser dev
// mode has no watcher; the tree stays static until manual refresh.

const dirtyRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DIRTY_REFRESH_DELAY_MS = 120

function scheduleDirtyRefresh(dirPath: string) {
  const existing = dirtyRefreshTimers.get(dirPath)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    dirtyRefreshTimers.delete(dirPath)
    // Only refresh if the dir is currently expanded (don't waste IO).
    if (store.expandedPaths.has(dirPath)) {
      void store.loadDirLazy(dirPath)
    }
    // Also refresh root listing when files appear/disappear at top level.
    if (dirPath === '') void store.loadFileTree()
  }, DIRTY_REFRESH_DELAY_MS)
  dirtyRefreshTimers.set(dirPath, timer)
}

watch(() => store.workspacePath, async (path, _previous, onCleanup) => {
  for (const timer of dirtyRefreshTimers.values()) clearTimeout(timer)
  dirtyRefreshTimers.clear()
  if (!path) return

  const fileWatcher = createFileWatcher(path)
  const unsubscribe = fileWatcher.on((event) => {
    // Compute the affected directory: parent of the changed path.
    const slash = event.path.lastIndexOf('/')
    const dir = slash >= 0 ? event.path.slice(0, slash) : ''
    scheduleDirtyRefresh(dir)
  })
  let disposed = false
  onCleanup(() => {
    disposed = true
    unsubscribe()
    void fileWatcher.stop()
  })
  await fileWatcher.start()
  if (disposed) await fileWatcher.stop()
}, { immediate: true })

onUnmounted(() => {
  if (persistTimer) clearTimeout(persistTimer)
  for (const t of dirtyRefreshTimers.values()) clearTimeout(t)
  dirtyRefreshTimers.clear()
})
</script>

<style scoped>
/* ── Container: flex column, tree fills remaining space ── */
.file-tree {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  height: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

/* ── Empty overlay (no workspace) ── */
.empty-overlay {
  position: absolute;
  inset: 0;
  z-index: var(--z-float);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 40px var(--space-4) var(--space-4);
  background: var(--color-bg);
}
.empty-text {
  font-size: var(--text-base);
  color: var(--color-text);
  margin: 0 0 4px;
}
.empty-hint {
  font-size: var(--text-label);
  line-height: 1.7;
  color: var(--color-text-muted);
  text-align: center;
  margin: 0 0 var(--space-4);
  max-width: 200px;
}

.tree-loading {
  padding: 20px var(--space-3);
  font-size: var(--text-label);
  color: var(--color-text-muted);
  text-align: center;
}

/* ── Tree scroll area ── */
.tree {
  flex: 1 1 0;
  height: 0;
  min-height: 0;
  overflow-y: auto;
  display: block;
  padding: var(--space-1) 2px 0;
  outline: none;
}
/* The tree is `tabindex="0"` and carries its own ↑/↓/←/→/Enter map, so it is a
   real keyboard stop and must show one. `outline: none` above kills the UA
   ring for the mouse path only; `:focus-visible` puts a visible one back. */
.tree:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}
.tree:empty {
  display: flex;
  align-items: center;
  justify-content: center;
}
.tree:empty::after {
  content: attr(data-empty-text);
  color: var(--color-text-muted);
  font-size: var(--text-label);
}

.tree-empty-hint {
  padding: 20px var(--space-3);
  font-size: var(--domain-text-meta);
  color: var(--color-text-muted);
  text-align: center;
}
</style>
