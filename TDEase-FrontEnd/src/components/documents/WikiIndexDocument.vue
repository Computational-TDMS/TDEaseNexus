<script setup lang="ts">
/**
 * WikiIndexDocument — the wiki index: both scopes listed and searched.
 *
 * Search is a straight scan over titles, tags and body text — the wiki is
 * plain markdown files at human scale, so there is no derived index to
 * rebuild or go stale (the Agent greps the same files). Rows open the page
 * document; a create control opens the not-yet-written page, which resolves
 * links pointing at it once saved.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import { parseWikiFrontMatter } from '@/services/wiki/front-matter'
import {
  hasSystemWiki, listWikiPages, readWikiPage, type WikiPageEntry, type WikiScope,
} from '@/services/wiki/wiki-library'

const { t } = useI18n()
const documentsStore = useDocumentsStore()
const workspaceStore = useWorkspaceStore()

interface IndexRow extends WikiPageEntry {
  haystack: string
}

const rows = ref<ReadonlyArray<IndexRow>>([])
const loading = ref(true)
const query = ref('')
const newScope = ref<WikiScope>('workspace')
const newName = ref('')

const workspaceRoot = computed(() => workspaceStore.workspacePath)

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return rows.value
  return rows.value.filter((row) => row.haystack.includes(needle))
})

const systemRows = computed(() => filtered.value.filter((row) => row.ref.scope === 'system'))
const workspaceRows = computed(() => filtered.value.filter((row) => row.ref.scope === 'workspace'))

async function load(): Promise<void> {
  loading.value = true
  const scopes: WikiScope[] = hasSystemWiki() ? ['system', 'workspace'] : ['workspace']
  const all: IndexRow[] = []
  for (const scope of scopes) {
    for (const entry of await listWikiPages(scope, workspaceRoot.value)) {
      let text: string
      try {
        text = await readWikiPage(entry.ref, workspaceRoot.value)
      } catch {
        continue
      }
      const { body } = parseWikiFrontMatter(text)
      all.push({
        ...entry,
        haystack: `${entry.title}\n${entry.name}\n${entry.tags.join(' ')}\n${body}`.toLowerCase(),
      })
    }
  }
  rows.value = all
  loading.value = false
}

function open(entry: WikiPageEntry): void {
  documentsStore.openWiki(entry.ref.scope, entry.ref.page, { preview: false })
}

function create(): void {
  const name = newName.value.trim()
  if (!name) return
  documentsStore.openWiki(newScope.value, /\.(?:md|txt)$/i.test(name) ? name : `${name}.md`, { preview: false })
  newName.value = ''
}

onMounted(load)
</script>

<template>
  <div class="wiki-index">
    <header class="wiki-index-header">
      <input
        v-model="query"
        class="wiki-search"
        type="search"
        :placeholder="t('workbench.wikiIndex.searchPlaceholder')"
      >
      <button class="wiki-button" type="button" @click="load">{{ t('workbench.wikiIndex.refresh') }}</button>
    </header>

    <div class="wiki-create">
      <select v-model="newScope" class="wiki-select">
        <option value="workspace">{{ t('workbench.wikiIndex.workspaceScope') }}</option>
        <option v-if="hasSystemWiki()" value="system">{{ t('workbench.wikiIndex.systemScope') }}</option>
      </select>
      <input
        v-model="newName"
        class="wiki-name-input"
        type="text"
        :placeholder="t('workbench.wikiIndex.namePlaceholder')"
        @keydown.enter="create"
      >
      <button class="wiki-button wiki-button--primary" type="button" @click="create">
        {{ t('workbench.wikiIndex.create') }}
      </button>
    </div>

    <p v-if="loading" class="wiki-index-empty">{{ t('workbench.wikiIndex.loading') }}</p>
    <p v-else-if="!filtered.length" class="wiki-index-empty">{{ t('workbench.wikiIndex.empty') }}</p>

    <template v-else>
      <section v-if="systemRows.length" class="wiki-group">
        <h2>{{ t('workbench.wikiIndex.systemGroup') }}</h2>
        <button v-for="row in systemRows" :key="`system:${row.ref.page}`" class="wiki-row" type="button" @click="open(row)">
          <span class="wiki-row-title">{{ row.title }}</span>
          <span class="wiki-row-path">{{ row.ref.page }}</span>
          <span v-for="tag in row.tags.slice(0, 3)" :key="tag" class="wiki-row-tag">#{{ tag }}</span>
        </button>
      </section>

      <section class="wiki-group">
        <h2>{{ t('workbench.wikiIndex.workspaceGroup') }}</h2>
        <p v-if="!workspaceRoot" class="wiki-index-empty">{{ t('workbench.wikiIndex.noWorkspace') }}</p>
        <template v-else-if="workspaceRows.length">
          <button v-for="row in workspaceRows" :key="`workspace:${row.ref.page}`" class="wiki-row" type="button" @click="open(row)">
            <span class="wiki-row-title">{{ row.title }}</span>
            <span class="wiki-row-path">{{ row.ref.page }}</span>
            <span v-for="tag in row.tags.slice(0, 3)" :key="tag" class="wiki-row-tag">#{{ tag }}</span>
          </button>
        </template>
        <p v-else class="wiki-index-empty">{{ t('workbench.wikiIndex.workspaceEmpty') }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.wiki-index {
  height: 100%;
  overflow: auto;
  padding: 16px 24px 32px;
}

.wiki-index-header {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.wiki-search {
  flex: 1;
  border: 1px solid var(--el-border-color, #dcdfe6);
  background: transparent;
  color: inherit;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: var(--text-base);
}

.wiki-create {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
}

.wiki-select,
.wiki-name-input {
  border: 1px solid var(--el-border-color, #dcdfe6);
  background: transparent;
  color: inherit;
  border-radius: 6px;
  padding: 5px 10px;
  font-size: var(--text-base);
}

.wiki-name-input {
  flex: 1;
}

.wiki-button {
  border: 1px solid var(--el-border-color, #dcdfe6);
  background: transparent;
  color: inherit;
  border-radius: 6px;
  padding: 5px 14px;
  font-size: var(--text-base);
  cursor: pointer;
}

.wiki-button--primary {
  background: var(--el-color-primary, #4a7dbe);
  border-color: var(--el-color-primary, #4a7dbe);
  color: #fff;
}

.wiki-group {
  margin-bottom: 24px;
}

.wiki-group h2 {
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.65;
  margin: 0 0 8px;
}

.wiki-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  padding: 7px 8px;
  cursor: pointer;
  border-radius: 6px;
  font-size: var(--text-base);
}

.wiki-row:hover {
  background: color-mix(in srgb, currentColor 6%, transparent);
}

.wiki-row-title {
  font-weight: 600;
  white-space: nowrap;
}

.wiki-row-path {
  opacity: 0.55;
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wiki-row-tag {
  margin-left: auto;
  color: var(--el-color-primary, #4a7dbe);
  font-size: var(--text-sm);
  white-space: nowrap;
}

.wiki-row-tag + .wiki-row-tag {
  margin-left: 0;
}

.wiki-index-empty {
  opacity: 0.6;
  font-size: var(--text-base);
  padding: 12px 0;
}
</style>
