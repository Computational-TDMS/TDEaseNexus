<!--
  EditorLayoutNode — one node of the group layout tree, rendered recursively.

  A leaf mounts its `DocumentGroup`; a branch mounts the two-pane
  `ResizableSplit` (orientation + the first child's ratio from the store) and
  recurses into both children. Every branch measures its own container, so a
  sash drag anywhere in the tree converts px back to that branch's ratio via
  `documentsStore.setBranchRatio` — VSCode's rule that a resize only touches
  the two views its sash separates, with all proportions elsewhere preserved.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElementSize } from '@vueuse/core'
import { useDocumentsStore } from '@/stores/documents'
import type { LayoutNode } from '@/stores/editorLayout'
import DocumentGroup from './DocumentGroup.vue'
import ResizableSplit from './ResizableSplit.vue'

/** Minimum pane width/height in px — a pane never shrinks below it and a
 *  sash drag clamps against the sibling's same floor (splitview delta rule). */
const MIN_PANE = 170

const props = defineProps<{ node: LayoutNode }>()

const { t } = useI18n()
const documentsStore = useDocumentsStore()

const isBranch = computed(() => props.node.kind === 'branch')
const branch = computed(() => (props.node.kind === 'branch' ? props.node : null))

const el = ref<HTMLElement | null>(null)
const { width, height } = useElementSize(el)
const containerSize = computed(() =>
  branch.value?.orientation === 'vertical' ? height.value : width.value)

const firstPaneSize = computed(() => {
  if (!branch.value || containerSize.value <= 0) return 0
  return Math.round(branch.value.ratio * containerSize.value)
})

function firstMin(container: number): number {
  if (container <= 0) return 0
  return Math.min(MIN_PANE, container)
}
function firstMax(container: number): number {
  if (container <= 0) return 0
  return Math.max(MIN_PANE, container - MIN_PANE)
}

function onFirstPaneResize(px: number): void {
  if (!branch.value || containerSize.value <= 0) return
  documentsStore.setBranchRatio(branch.value, px / containerSize.value)
}
</script>

<template>
  <DocumentGroup
    v-if="!isBranch"
    :group-id="(node as Extract<LayoutNode, { kind: 'group' }>).id"
    class="editor-layout-node__group"
  />
  <div v-else ref="el" class="editor-layout-node__branch">
    <ResizableSplit
      :direction="branch!.orientation"
      :size="firstPaneSize"
      :min="firstMin"
      :max="firstMax"
      :aria-label="t('workbench.documentGroup.resizeSplit')"
      @update:size="onFirstPaneResize"
    >
      <template #first>
        <EditorLayoutNode :node="branch!.left" />
      </template>
      <template #second>
        <EditorLayoutNode :node="branch!.right" />
      </template>
    </ResizableSplit>
  </div>
</template>

<style scoped>
.editor-layout-node__branch,
.editor-layout-node__group {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
</style>
