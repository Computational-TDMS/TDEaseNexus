<!--
  §4.2 is explicit that this section is "the real Workspace tree" and that
  `FileTree.vue`, `TreeNode.vue`, `InlineRenameInput.vue` and `tree-icons.ts`
  "already exist and are reused". They did exist — with context menu, inline
  rename, drag/drop and multi-select — and nothing mounted them: the whole
  subsystem was unreachable from the shell, which is `PRODUCT.md`
  anti-reference #5 ("interfaces that make advanced users abandon the product
  to regain access to ordinary source files and scripts") written as a fact.
  This component mounts the existing tree and gives its file-open event a
  destination. It adds no second tree and no second selection model.

  Selecting a file routes through `documentsStore.openWorkspaceFile`, which
  performs §3.1.1's role-first dispatch (a `wiki/*.md` page opens the wiki
  document, everything else opens a `file` document).

  A plain Workspace file now opens into a document that actually renders it:
  `components/documents/FileDocument.vue` reads Workspace bytes through
  `documentsStore.readWorkspaceFile` and dispatches on type (§5.6). What
  remains here is only the picker-cancelled acknowledgement. Anything a file
  document cannot render, it says so itself, in the tab, with the actions that
  work — not from here.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Empty from '@/components/primitives/Empty.vue'
import FileTree from '@/components/workspace/FileTree.vue'
import { useWorkspaceOpener } from '@/composables/useWorkspaceOpener'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'

const { t } = useI18n()
const workspaceStore = useWorkspaceStore()
const documentsStore = useDocumentsStore()
const { pickAndOpen } = useWorkspaceOpener()

const hasWorkspace = computed(() => workspaceStore.hasWorkspace)

type SectionNote =
  | { kind: 'picker-cancelled' }
  | null

/**
 * A single note slot, replaced rather than accumulated: the Navigator is a
 * narrow column and a stack of advisories would push the tree off screen.
 */
const note = ref<SectionNote>(null)
const opening = ref(false)

async function openFolder() {
  if (opening.value) return
  opening.value = true
  try {
    const opened = await pickAndOpen()
    note.value = opened ? null : { kind: 'picker-cancelled' }
  } finally {
    opening.value = false
  }
}

/**
 * `FileTree` emits `contextExplore` on a single click / Enter on a file row.
 * The document store decides what the path *is* (§3.1.1). Opening needs no
 * commentary — the tab shows the document.
 */
function openFile(path: string) {
  documentsStore.openWorkspaceFile(path)
  note.value = null
}

function dismissNote() {
  note.value = null
}
</script>

<template>
  <div class="files-section">
    <Empty
      v-if="!hasWorkspace"
      data-state="no-workspace"
      :title="t('workbench.filesSection.noWorkspaceTitle')"
      :description="t('workbench.filesSection.noWorkspaceDescription')"
      :action-label="t('workbench.filesSection.openFolder')"
      @action="openFolder"
    />

    <FileTree v-else class="files-section__tree" @context-explore="openFile" />

    <p
      v-if="note"
      class="files-section__note"
      :data-note-kind="note.kind"
      role="status"
      aria-live="polite"
    >
      <span class="files-section__note-text">
        {{ t('workbench.filesSection.openFolderCancelled') }}
      </span>
      <button
        type="button"
        class="files-section__note-dismiss"
        @click="dismissNote"
      >
        {{ t('workbench.filesSection.dismissNote') }}
      </button>
    </p>
  </div>
</template>

<style scoped>
.files-section {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

/* FileTree is `flex: 1 1 0; height: 0`, so it needs a flex column parent with
   a resolved height — the Navigator body supplies one. */
.files-section__tree {
  min-height: 0;
}

.files-section__note {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-top: var(--line-w) solid var(--line-seam);
  background: var(--color-bg-muted);
  color: var(--color-text-muted);
  font-size: var(--text-label);
  line-height: var(--text-sm-lh);
}

.files-section__note-text {
  overflow-wrap: anywhere;
}

.files-section__note-dismiss {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.files-section__note-dismiss:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}
</style>
