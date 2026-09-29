<template>
  <div
    class="tree-item selected pending-create"
    role="treeitem"
    :style="{ '--tree-depth': String(depth) }"
    tabindex="0"
    @click.stop
    @contextmenu.prevent.stop
  >
    <span class="tree-indent" />
    <span class="tree-disclosure" />
    <span class="tree-icon" v-html="iconSvg" />
    <InlineRenameInput
      :initial-value="draftName"
      :disabled="saving"
      @commit="(v) => emit('commit', v)"
      @cancel="emit('cancel')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import InlineRenameInput from './InlineRenameInput.vue'

const props = defineProps<{
  kind: 'file' | 'folder'
  draftName: string
  depth: number
  saving?: boolean
}>()
const emit = defineEmits<{ commit: [value: string]; cancel: [] }>()

const FOLDER_ICON = '<path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
const FILE_ICON = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'

const iconSvg = computed(() => {
  const inner = props.kind === 'folder' ? FOLDER_ICON : FILE_ICON
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
})
</script>

<style scoped>
/* Mirrors TreeNode.vue's grid + density so the pending-create row reads as a
   sibling of the rows around it, not a foreign element. Keep the two files'
   metrics in lockstep — the indent step and icon box are tree-local. */
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
    minmax(0, 1fr);
  align-items: center;
  min-width: 0;
  height: var(--row-h-sm);
  padding: 0 var(--space-2) 0 var(--space-1-5);
  margin: 0 var(--space-1-5);
  border-radius: var(--radius-sm);
}
.tree-indent { display: block; width: calc((var(--tree-depth, 0) * var(--tree-indent-step))); }
.tree-disclosure { width: var(--tree-icon-box); display: inline-flex; align-items: center; justify-content: center; }
.tree-icon {
  width: var(--tree-icon-box);
  height: var(--tree-icon-box);
  display: flex;
  align-items: center;
  justify-content: flex-start;
  color: var(--color-text-muted);
}
.tree-icon :deep(svg) { display: block; }
.pending-create { background: var(--color-primary-soft); }
</style>
