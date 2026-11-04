<script setup lang="ts">
/**
 * Navigator Wiki section — both knowledge scopes as flat lists.
 *
 * The wiki is plain markdown the user and the Agent co-write, so this section
 * is a list, not a form: a row opens the page document through
 * `documentsStore.openWiki` (the same entrance a wikilink click and the Files
 * tree use), and the footer row opens the index tab for search and creation.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Empty from '@/components/primitives/Empty.vue'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import {
  hasSystemWiki, listWikiPages, type WikiPageEntry, type WikiScope,
} from '@/services/wiki/wiki-library'

const { t } = useI18n()
const documentsStore = useDocumentsStore()
const workspaceStore = useWorkspaceStore()

const systemPages = ref<ReadonlyArray<WikiPageEntry>>([])
const workspacePages = ref<ReadonlyArray<WikiPageEntry>>([])

const workspaceRoot = computed(() => workspaceStore.workspacePath)
const showSystem = computed(() => hasSystemWiki())

async function load(): Promise<void> {
  const scopes: WikiScope[] = showSystem.value ? ['system', 'workspace'] : ['workspace']
  const results = await Promise.all(scopes.map((scope) => listWikiPages(scope, workspaceRoot.value)))
  systemPages.value = results[0] ?? []
  workspacePages.value = showSystem.value ? (results[1] ?? []) : (results[0] ?? [])
}

function open(entry: WikiPageEntry): void {
  documentsStore.openWiki(entry.ref.scope, entry.ref.page, { preview: false })
}

function openIndex(): void {
  documentsStore.openWikiIndex()
}

onMounted(load)
</script>

<template>
  <div class="wiki-section">
    <div class="wiki-section__scroll">
      <template v-if="showSystem">
        <p class="wiki-section__group">{{ t('workbench.wikiIndex.systemGroup') }}</p>
        <button
          v-for="entry in systemPages"
          :key="`system:${entry.ref.page}`"
          class="wiki-section__row"
          type="button"
          :title="entry.ref.page"
          @click="open(entry)"
        >
          {{ entry.title }}
        </button>
        <p v-if="!systemPages.length" class="wiki-section__empty">{{ t('workbench.wikiIndex.empty') }}</p>
      </template>

      <p class="wiki-section__group">{{ t('workbench.wikiIndex.workspaceGroup') }}</p>
      <button
        v-for="entry in workspacePages"
        :key="`workspace:${entry.ref.page}`"
        class="wiki-section__row"
        type="button"
        :title="entry.ref.page"
        @click="open(entry)"
      >
        {{ entry.title }}
      </button>
      <Empty
        v-if="!workspacePages.length"
        data-state="no-wiki"
        :title="t('workbench.wikiIndex.workspaceEmpty')"
        :description="t('workbench.wikiIndex.workspaceEmptyHint')"
        :action-label="t('workbench.wikiIndex.openIndex')"
        @action="openIndex"
      />
    </div>

    <button class="wiki-section__index" type="button" @click="openIndex">
      {{ t('workbench.wikiIndex.openIndex') }}
    </button>
  </div>
</template>

<style scoped>
.wiki-section {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.wiki-section__scroll {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: 8px;
}

.wiki-section__group {
  margin: 10px 4px 4px;
  font-size: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
}

.wiki-section__row {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  font-size: var(--text-sm);
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wiki-section__row:hover {
  background: color-mix(in srgb, currentColor 6%, transparent);
}

.wiki-section__empty {
  margin: 4px 8px;
  font-size: var(--text-sm);
  opacity: 0.55;
}

.wiki-section__index {
  flex: none;
  border: none;
  border-top: 1px solid var(--line-seam, rgba(128, 128, 128, 0.25));
  background: transparent;
  color: inherit;
  font-size: var(--text-sm);
  padding: 9px;
  cursor: pointer;
  text-align: center;
}

.wiki-section__index:hover {
  background: color-mix(in srgb, currentColor 6%, transparent);
}
</style>
