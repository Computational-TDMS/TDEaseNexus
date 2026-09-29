<!--
  The `main` region: the group layout tree. It holds no dispatch knowledge of
  its own. §5.1 -- "one component per `DocumentKey` variant; there is no
  fallback branch; an unmapped key is a startup assertion failure, exactly
  like an unregistered command" -- is enforced by
  `components/documents/definitions.ts`, a registration table validated at
  construction; each group resolves through it.

  The whole arrangement is `documentsStore.layoutRoot` — a recursive binary
  tree whose leaves are editor groups (see the store header). Splitting,
  closing, sash drags and tab drags all mutate that one tree; this component
  just renders it from the root. Document surface, not a panel: background is
  `--color-bg`, not the shell mantle (VISUAL-SYSTEM.md §4.1's surface ladder).
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocumentsStore } from '@/stores/documents'
import EditorLayoutNode from './EditorLayoutNode.vue'
import DocumentGroup from './DocumentGroup.vue'

const { t } = useI18n()
const documentsStore = useDocumentsStore()

/**
 * The maximized group renders alone at full size (grid.maximizeView): the
 * layout tree is untouched underneath, so restore is a pure render flip. A
 * stale id (the group closed while maximized) falls back to the tree.
 */
const maximizedId = computed(() => {
  const id = documentsStore.maximizedGroupId
  if (!id || !documentsStore.layoutRoot) return null
  return documentsStore.isGroupInTree(documentsStore.layoutRoot, id) ? id : null
})

// Ctrl+Tab walks the global MRU. The listener lives HERE — one per document
// area — because each group mounts its own tab strip, and a per-strip
// listener would hop MRU twice per keypress.
function handleKeydown(event: KeyboardEvent) {
  if (!event.ctrlKey || event.key !== 'Tab') return
  event.preventDefault()
  documentsStore.selectByMruOffset(event.shiftKey ? -1 : 1)
}

onMounted(() => document.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <main
    class="document-host"
    role="main"
    :aria-label="t('workbench.documentHost.label')"
    tabindex="-1"
  >
    <DocumentGroup v-if="maximizedId" :group-id="maximizedId" class="document-host__maximized" />
    <EditorLayoutNode v-else-if="documentsStore.layoutRoot" :node="documentsStore.layoutRoot" />
  </main>
</template>

<style scoped>
.document-host {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--color-bg);
}
</style>
