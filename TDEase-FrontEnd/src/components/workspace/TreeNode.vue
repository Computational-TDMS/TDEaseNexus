<template>
  <div class="tree-node-wrapper">
    <!-- Pending create row (rendered before children when this dir is the create target) -->
    <PendingCreateNode
      v-if="pendingCreateHere"
      :kind="pendingCreateHere.kind"
      :draft-name="pendingCreateHere.draftName"
      :saving="pendingCreateHere.phase === 'saving'"
      :depth="depth + 1"
      @commit="(v) => ctx.onCommitCreate(pendingCreateHere!, v)"
      @cancel="ctx.onCancelEdit"
    />

    <!-- The row itself -->
    <div
      :class="['tree-item', {
        selected: isSelected,
        'drop-target': isDropTarget,
        'in-run-focus': inRunFocus,
      }]"
      role="treeitem"
      :aria-label="node.name"
      :title="node.name"
      :aria-expanded="isDir ? isExpanded : undefined"
      data-tree-item=""
      :data-tree-path="selfPath"
      :style="{ '--tree-depth': String(depth) }"
      tabindex="-1"
      draggable="true"
      @click="onClick"
      @dblclick="onDblClick"
      @contextmenu="onContextMenu"
      @keydown="onKeyDown"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <span class="tree-indent" />
      <span class="tree-disclosure" v-html="disclosureSvg" />
      <span class="tree-icon" v-html="iconSvg" />
      <InlineRenameInput
        v-if="renaming"
        :initial-value="node.name"
        @commit="(v) => ctx.onCommitRename(selfPath, v)"
        @cancel="ctx.onCancelEdit"
      />
      <span v-else class="tree-name">{{ node.name }}</span>
      <!-- §3.3 sync badge — only for files inside the selected Run's
           results/<runId>/ directory. Icons only, no row tinting (restraint principle). -->
      <span
        v-if="syncBadge"
        class="tree-sync-badge"
        :class="`is-${syncBadge}`"
        :title="syncBadgeTitle"
      >
        <el-icon v-if="syncBadge === 'cached'" :size="11" aria-hidden="true"><Check /></el-icon>
        <el-icon v-else-if="syncBadge === 'conflict'" :size="11" aria-hidden="true"><Warning /></el-icon>
        <el-icon v-else-if="syncBadge === 'cloud'" :size="11" aria-hidden="true"><ArrowDown /></el-icon>
      </span>
    </div>

    <!-- Children -->
    <div v-if="isExpanded && visibleChildren.length > 0" role="group">
      <TreeNode
        v-for="child in visibleChildren"
        :key="child.path"
        :node="child"
        :parent-path="selfPath"
        :depth="depth + 1"
      />
    </div>

    <!-- Load failure — never a silent empty dir -->
    <div v-if="isExpanded && loadError" class="tree-load-error" role="alert">
      <span class="tree-load-error-text" :title="loadError">{{ t('workbench.fileTree.loadFailed') }}</span>
      <button class="tree-load-error-retry" type="button" @click.stop="retryLoad">
        {{ t('workbench.fileTree.retry') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Warning, ArrowDown } from '@element-plus/icons-vue'
import type { FileTreeNode } from '@/types/workspace-data'
import { useWorkspaceStore } from '@/stores/workspace'
import { useSelectionStore } from '@/stores/selection'
import InlineRenameInput from './InlineRenameInput.vue'
import PendingCreateNode from './PendingCreateNode.vue'
import { TREE_CTX_KEY, TREE_INLINE_EDIT_KEY, TREE_DROP_TARGET_KEY, type TreeCtx, type InlineEdit, type DropTargetMap } from './tree-context'
import { iconSvgFor, disclosureSvgFor } from './tree-icons'

const props = defineProps<{
  node: FileTreeNode
  parentPath: string
  depth: number
}>()

const store = useWorkspaceStore()
const { t } = useI18n()
const selStore = useSelectionStore()
const ctx = inject(TREE_CTX_KEY) as TreeCtx
const inlineEditRef = inject<Ref<InlineEdit>>(TREE_INLINE_EDIT_KEY)!
const dropTargets = inject<Ref<DropTargetMap>>(TREE_DROP_TARGET_KEY)!

const selfPath = computed(() =>
  props.parentPath ? `${props.parentPath}/${props.node.name}` : props.node.name,
)
const isDir = computed(() => props.node.type === 'directory')
const isExpanded = computed(() => store.expandedPaths.has(selfPath.value))
const isSelected = computed(() => selStore.selectedTreePaths.has(selfPath.value))

/**
 * §3.1 forward highlight: this node lives inside the selected Run's
 * `results/<runId>/` directory (or is that directory itself). Distinct from
 * `selected` — a Run focus is a soft contextual highlight, not a click.
 */
const inRunFocus = computed(() => {
  const runDir = selStore.runResultsPath
  if (!runDir) return false
  return selfPath.value === runDir || selfPath.value.startsWith(`${runDir}/`)
})

/**
 * §3.3 sync badge for this node — only meaningful for files inside the
 * selected Run's results directory. Returns undefined when no badge applies
 * (ordinary file, no Run selected, or status unknown).
 */
const syncBadge = computed<'cached' | 'conflict' | 'cloud' | undefined>(() => {
  if (isDir.value) return undefined
  return selStore.runFileStatuses.get(selfPath.value)
})

const syncBadgeTitle = computed(() => {
  switch (syncBadge.value) {
    case 'cached': return t('workbench.fileTree.sync.cached')
    case 'conflict': return t('workbench.fileTree.sync.conflict')
    case 'cloud': return t('workbench.fileTree.sync.cloud')
    default: return ''
  }
})

const renaming = computed(
  () => inlineEditRef.value?.mode === 'rename' && inlineEditRef.value.targetPath === selfPath.value,
)
const pendingCreateHere = computed(() =>
  inlineEditRef.value?.mode === 'create' && inlineEditRef.value.parentPath === selfPath.value
    ? inlineEditRef.value
    : null,
)

// Children: prefer the lazily-loaded cache; fall back to seed children.
const visibleChildren = computed<FileTreeNode[]>(() => {
  const cached = store.directoryCache.get(selfPath.value)
  if (cached && cached.length > 0) return sortNodes(cached)
  const nodeChildren = props.node.children ?? []
  return sortNodes(nodeChildren)
})

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  const dirs = nodes.filter(n => n.type === 'directory')
  const files = nodes.filter(n => n.type !== 'directory')
  const cmp = (a: FileTreeNode, b: FileTreeNode) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  dirs.sort(cmp)
  files.sort(cmp)
  return [...dirs, ...files]
}

const iconSvg = computed(() => iconSvgFor(props.node.name, isDir.value, isExpanded.value))
const disclosureSvg = computed(() => disclosureSvgFor(isDir.value, isExpanded.value))

const isDropTarget = computed(() => !!dropTargets.value[selfPath.value])

const loadError = computed(() =>
  isDir.value && isExpanded.value ? store.dirErrors.get(selfPath.value) : undefined,
)

function retryLoad() {
  void store.loadDirLazy(selfPath.value)
}

function onClick(e: MouseEvent) {
  e.stopPropagation()
  const multi = e.metaKey || e.ctrlKey
  ctx.onSelect(selfPath.value, { multi, shift: e.shiftKey }, isDir.value)
  // Single-click a file (no modifier) → preview/open in Studio
  if (!isDir.value && !multi && !e.shiftKey) {
    ctx.onFileOpen(selfPath.value)
  }
}

function onDblClick(e: MouseEvent) {
  e.stopPropagation()
  // openhanako: double-click a dir toggles; double-click a file opens native.
  // We don't have native open wired here uniformly, so for files fall back to
  // the same file-open path the single click uses.
  if (isDir.value) {
    ctx.onSelect(selfPath.value, { multi: false, shift: false }, true)
  }
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  ctx.onNodeContextMenu(props.node, selfPath.value, e.clientX, e.clientY)
}

function onKeyDown(e: KeyboardEvent) {
  // Enter begins rename (openhanako parity). Arrow navigation is handled at
  // the container level.
  if (e.key === 'Enter' && !renaming.value) {
    e.preventDefault()
    e.stopPropagation()
    ctx.onBeginRename(selfPath.value)
  }
}

// ── Drag & drop ──
// The node forwards every DnD event to the FileTree-level handler, which
// owns the payload registry and the drop-target highlight map.

function onDragStart(e: DragEvent) {
  if (!e.dataTransfer) return
  // Select this node first if it isn't (so dragEntry collection is correct).
  if (!selStore.selectedTreePaths.has(selfPath.value)) {
    ctx.onSelect(selfPath.value, { multi: false, shift: false }, isDir.value)
  }
  ctx.onDragStart(props.node, selfPath.value, e)
}

function onDragOver(e: DragEvent) {
  if (!isDir.value) return
  const canDrop = ctx.onDragOver(selfPath.value, e)
  if (canDrop) {
    e.preventDefault()
    e.stopPropagation()
  }
}

function onDragLeave(e: DragEvent) {
  if (!isDir.value) return
  ctx.onDragLeave(selfPath.value, e)
}

async function onDrop(e: DragEvent) {
  if (!isDir.value) return
  e.preventDefault()
  e.stopPropagation()
  await ctx.onDrop(selfPath.value, e)
}
</script>

<style scoped>
/* Density + icon metrics are tokens, not magic px. The indent step is a
   tree-local custom property (depth × step), every other length comes from
   the design-token scale. */
.tree-item {
  --tree-indent-step: 16px;
  --tree-icon-box: 14px;
  box-sizing: border-box;
  width: calc(100% - var(--space-1));
  display: grid;
  grid-template-columns:
    calc((var(--tree-depth, 0) * var(--tree-indent-step)))
    var(--tree-icon-box)
    calc(var(--tree-icon-box) + var(--space-1-5))
    minmax(0, 1fr)
    auto;
  align-items: center;
  column-gap: 0;
  min-width: 0;
  height: var(--row-h-sm);
  padding: 0 var(--space-2) 0 var(--space-1-5);
  margin: 0 var(--space-1-5);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: 1.4;
  cursor: default;
  user-select: none;
  transition: background-color var(--dur-instant) var(--ease-out);
}
.tree-item:hover { background: var(--color-hover); }
.tree-item.selected { background: var(--color-interact-soft); }
.tree-item.in-run-focus { background: color-mix(in srgb, var(--color-interact) 5%, transparent); }
.tree-item.in-run-focus.selected { background: color-mix(in srgb, var(--color-interact) 16%, transparent); }
.tree-item.drop-target {
  background: color-mix(in srgb, var(--color-interact) 16%, transparent);
  outline: 1.5px dashed color-mix(in srgb, var(--color-ring) 50%, transparent);
  outline-offset: -1.5px;
}
.tree-indent {
  display: block;
  width: calc((var(--tree-depth, 0) * var(--tree-indent-step)));
  min-width: 0;
  height: 100%;
  pointer-events: none;
}
.tree-disclosure {
  width: var(--tree-icon-box);
  min-width: var(--tree-icon-box);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  line-height: 1;
}
.tree-disclosure :deep(svg) { display: block; width: 12px; height: 12px; }
.tree-icon {
  flex-shrink: 0;
  width: var(--tree-icon-box);
  height: var(--tree-icon-box);
  display: flex;
  align-items: center;
  justify-content: flex-start;
  color: var(--color-text-muted);
}
.tree-icon :deep(svg) { display: block; }
.tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* §3.3 sync badge — icon-only, sits at the row's trailing edge. Color
   carries meaning (green/amber/blue); the row itself is never tinted. */
.tree-sync-badge {
  flex-shrink: 0;
  line-height: 1;
  margin-left: var(--space-1);
}
.tree-sync-badge.is-cached { color: var(--color-success-text); }
.tree-sync-badge.is-conflict { color: var(--color-warning-text); }
.tree-sync-badge.is-cloud { color: var(--color-primary); }

/* Directory load failure: an inline row, not a swallowed empty listing. */
.tree-load-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-left: calc(var(--space-2) + ((var(--tree-depth, 0) + 1) * 16px));
  padding-right: var(--space-2);
  height: var(--row-h-sm);
  font-size: var(--text-sm);
  color: var(--color-danger-text, var(--color-warning-text));
}
.tree-load-error-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-load-error-retry {
  flex-shrink: 0;
  border: 1px solid currentColor;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font-size: var(--text-label);
  padding: 0 var(--space-2);
  cursor: pointer;
}
.tree-load-error-retry:hover { background: var(--color-hover); }
</style>
