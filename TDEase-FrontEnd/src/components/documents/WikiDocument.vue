<script setup lang="ts">
/**
 * WikiDocument — one wiki page: rendered view, plain-markdown edit, backlinks.
 *
 * The wiki is plain markdown files the user and the Agent both write (the
 * Agent through read/grep/write and its `system-wiki/` prefix — no dedicated
 * tool surface), so this document adds nothing a file editor would need:
 * it renders the body, edits the raw text, and follows `[[wikilinks]]`
 * across the two scopes (System wiki, this workspace's `wiki/`).
 *
 * A missing page is a create flow, not an error: following a dead wikilink
 * opens this document in its "not written yet" state, and creating it
 * resolves every link that pointed here.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MarkdownContent from '@/components/agent/MarkdownContent.vue'
import MarkdownEditor from '@/components/wiki/MarkdownEditor.vue'
import { useDocumentsStore, documentId } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import { parseWikiFrontMatter, renderWikiPage, wikiPageTitle } from '@/services/wiki/front-matter'
import {
  findWikiBacklinks, isMarkdownPage, readWikiPage, resolveWikiTarget, wikiPageName, writeWikiPage,
  type WikiBacklink, type WikiScope,
} from '@/services/wiki/wiki-library'
import { extractWikiLinks } from '@/services/wiki/wikilinks'
import { renderMarkdown } from '@/utils/markdown'

const props = defineProps<{
  scope: WikiScope
  page: string
}>()

const { t } = useI18n()
const documentsStore = useDocumentsStore()
const workspaceStore = useWorkspaceStore()

const text = ref('')
const draft = ref('')
const mode = ref<'view' | 'edit'>('view')
const loading = ref(true)
const notFound = ref(false)
const loadError = ref('')
const backlinks = ref<ReadonlyArray<WikiBacklink>>([])
const rootEl = ref<HTMLDivElement | null>(null)

const docId = computed(() => documentId({ kind: 'wiki', scope: props.scope, page: props.page }))
const workspaceRoot = computed(() => workspaceStore.workspacePath)
const pageName = computed(() => wikiPageName(props.page))

/** A .txt page has no wiki format: shown verbatim, no front matter, no links. */
const isPlain = computed(() => !isMarkdownPage(props.page))
const stripPageExtension = (name: string): string => name.replace(/\.(?:md|txt)$/i, '')

const parsed = computed(() => parseWikiFrontMatter(text.value))
const title = computed(() => (isPlain.value ? stripPageExtension(pageName.value) : wikiPageTitle(text.value, pageName.value)))
const bodyHtml = computed(() => (mode.value === 'view' && !notFound.value && !isPlain.value ? renderMarkdown(parsed.value.body) : ''))

async function load(): Promise<void> {
  loading.value = true
  notFound.value = false
  loadError.value = ''
  documentsStore.setDirty(docId.value, false)
  try {
    text.value = await readWikiPage({ scope: props.scope, page: props.page }, workspaceRoot.value)
    mode.value = 'view'
    await loadBacklinks()
    if (!isPlain.value) await annotateLinks()
  } catch (error) {
    text.value = ''
    notFound.value = true
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

async function loadBacklinks(): Promise<void> {
  backlinks.value = await findWikiBacklinks({ scope: props.scope, page: props.page }, workspaceRoot.value)
}

/** Resolve every link target once per render; unresolvable ones get the dashed create style. */
async function annotateLinks(): Promise<void> {
  if (isPlain.value) return
  await nextTick()
  const container = rootEl.value
  if (!container) return
  const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.wikilink'))
  const resolved = new Set<string>()
  for (const target of new Set(extractWikiLinks(parsed.value.body).map((link) => link.target))) {
    const ref = await resolveWikiTarget(target, props.scope, workspaceRoot.value)
    if (ref) resolved.add(target.toLowerCase())
  }
  for (const anchor of anchors) {
    const target = anchor.dataset.wikilinkTarget ?? ''
    anchor.classList.toggle('wikilink-unresolved', !resolved.has(target.toLowerCase()))
  }
}

function openTarget(event: Event): void {
  const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a.wikilink')
  if (!anchor) return
  event.preventDefault()
  void followLink(anchor.dataset.wikilinkTarget ?? '', anchor.dataset.wikilinkHeading ?? null)
}

async function followLink(target: string, heading: string | null): Promise<void> {
  if (!target) return
  const resolved = await resolveWikiTarget(target, props.scope, workspaceRoot.value)
  if (resolved) {
    documentsStore.openWiki(resolved.scope, resolved.page)
    if (heading) scrollToHeading(heading)
    return
  }
  // Dead link: open the create flow in the linking page's scope. The page
  // name is the target's file-name part; the create resolves the link.
  const name = target.split('/').pop() ?? target
  documentsStore.openWiki(props.scope, /\.(?:md|txt)$/i.test(name) ? name : `${name}.md`)
}

function scrollToHeading(heading: string): void {
  void nextTick(() => {
    const container = rootEl.value
    if (!container) return
    const wanted = heading.trim().toLowerCase()
    for (const element of container.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (element.textContent?.trim().toLowerCase() === wanted) {
        element.scrollIntoView({ block: 'start' })
        return
      }
    }
  })
}

function startEdit(): void {
  draft.value = text.value
  mode.value = 'edit'
}

function onDraftUpdate(value: string): void {
  draft.value = value
  documentsStore.setDirty(docId.value, value !== text.value)
}

async function save(): Promise<void> {
  try {
    await writeWikiPage({ scope: props.scope, page: props.page }, draft.value, workspaceRoot.value)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
    return
  }
  text.value = draft.value
  documentsStore.setDirty(docId.value, false)
  mode.value = 'view'
  await loadBacklinks()
  if (!isPlain.value) await annotateLinks()
}

function cancelEdit(): void {
  mode.value = 'view'
  documentsStore.setDirty(docId.value, false)
}

/** Create the missing page with a minimal front-matter stub, then edit it. */
async function createPage(): Promise<void> {
  const stub = isPlain.value
    ? ''
    : renderWikiPage({ title: stripPageExtension(pageName.value), body: '' })
  try {
    await writeWikiPage({ scope: props.scope, page: props.page }, stub, workspaceRoot.value)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
    return
  }
  await load()
  startEdit()
}

function openBacklink(ref: WikiBacklink): void {
  documentsStore.openWiki(ref.ref.scope, ref.ref.page)
}

onMounted(load)
watch(() => [props.scope, props.page], load)
</script>

<template>
  <div class="wiki-document">
    <header class="wiki-header">
      <div class="wiki-header-main">
        <span
          class="wiki-scope"
          :class="scope === 'system' ? 'wiki-scope--system' : 'wiki-scope--workspace'"
        >{{ t(scope === 'system' ? 'workbench.wikiDocument.systemScope' : 'workbench.wikiDocument.workspaceScope') }}</span>
        <h1 class="wiki-title">{{ title }}</h1>
      </div>
      <div class="wiki-header-actions">
        <template v-if="!notFound">
          <button
            v-if="mode === 'view'"
            class="wiki-button"
            type="button"
            @click="startEdit"
          >
            {{ t('workbench.wikiDocument.edit') }}
          </button>
          <template v-else>
            <button class="wiki-button wiki-button--primary" type="button" @click="save">
              {{ t('workbench.wikiDocument.save') }}
            </button>
            <button class="wiki-button" type="button" @click="cancelEdit">
              {{ t('workbench.wikiDocument.cancel') }}
            </button>
          </template>
        </template>
        <button v-else class="wiki-button wiki-button--primary" type="button" @click="createPage">
          {{ t('workbench.wikiDocument.create') }}
        </button>
      </div>
    </header>

    <div v-if="!isPlain && (parsed.front.tags.length || parsed.front.status || parsed.front.updated)" class="wiki-meta">
      <span v-if="parsed.front.status" class="wiki-chip">{{ parsed.front.status }}</span>
      <span v-if="parsed.front.kind" class="wiki-chip">{{ parsed.front.kind }}</span>
      <span v-if="parsed.front.updated" class="wiki-chip wiki-chip--dim">{{ parsed.front.updated }}</span>
      <span v-for="tag in parsed.front.tags" :key="tag" class="wiki-chip wiki-chip--tag">#{{ tag }}</span>
    </div>

    <p v-if="loadError" class="wiki-error">{{ loadError }}</p>

    <div v-if="loading" class="wiki-empty">{{ t('workbench.wikiDocument.loading') }}</div>

    <template v-else-if="notFound">
      <div class="wiki-empty">
        <p>{{ t('workbench.wikiDocument.notWritten', { page: pageName }) }}</p>
        <p class="wiki-empty-hint">{{ t(scope === 'system' ? 'workbench.wikiDocument.systemUnavailableHint' : 'workbench.wikiDocument.workspaceUnavailableHint') }}</p>
      </div>
    </template>

    <MarkdownEditor
      v-else-if="mode === 'edit'"
      :model-value="draft"
      :plain="isPlain"
      @update:model-value="onDraftUpdate"
      @save="save"
    />

    <template v-else>
      <pre v-if="isPlain" ref="rootEl" class="wiki-plain">{{ text }}</pre>
      <div v-else ref="rootEl" class="wiki-body" @click="openTarget">
        <MarkdownContent :html="bodyHtml" content-class="wiki-content" />
      </div>

      <section v-if="backlinks.length" class="wiki-backlinks">
        <h2>{{ t('workbench.wikiDocument.backlinks') }}</h2>
        <button
          v-for="link in backlinks"
          :key="`${link.ref.scope}:${link.ref.page}`"
          class="wiki-backlink"
          type="button"
          @click="openBacklink(link)"
        >
          <span
            class="wiki-scope"
            :class="link.ref.scope === 'system' ? 'wiki-scope--system' : 'wiki-scope--workspace'"
          >{{ link.ref.scope }}</span>
          <span class="wiki-backlink-title">{{ link.title }}</span>
          <span class="wiki-backlink-excerpt">{{ link.excerpt }}</span>
        </button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.wiki-document {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: auto;
  padding: 0 24px 32px;
}

.wiki-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0 8px;
}

.wiki-header-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.wiki-title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  line-height: 1.3;
}

.wiki-header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
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

.wiki-scope {
  align-self: flex-start;
  font-size: var(--text-label);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 4px;
  padding: 1px 7px;
}

.wiki-scope--system {
  background: color-mix(in srgb, var(--el-color-primary, #4a7dbe) 14%, transparent);
  color: var(--el-color-primary, #4a7dbe);
}

.wiki-scope--workspace {
  background: color-mix(in srgb, var(--el-color-success, #67c23a) 14%, transparent);
  color: var(--el-color-success, #529b2e);
}

.wiki-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0 12px;
}

.wiki-chip {
  font-size: var(--text-sm);
  border-radius: 10px;
  padding: 1px 9px;
  background: color-mix(in srgb, currentColor 8%, transparent);
}

.wiki-chip--dim {
  opacity: 0.65;
}

.wiki-chip--tag {
  color: var(--el-color-primary, #4a7dbe);
}

.wiki-error {
  color: var(--el-color-danger, #c45656);
  font-size: var(--text-base);
}

.wiki-empty {
  padding: 48px 0;
  text-align: center;
  opacity: 0.75;
  font-size: var(--text-md);
}

.wiki-empty-hint {
  font-size: var(--text-sm);
  opacity: 0.7;
}

.wiki-plain {
  margin: 0;
  padding: 8px 0 16px;
  font-family: var(--font-mono);
  font-size: var(--text-base);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.wiki-backlinks {
  margin-top: 40px;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  padding-top: 16px;
}

.wiki-backlinks h2 {
  font-size: var(--text-md);
  margin: 0 0 8px;
  opacity: 0.8;
}

.wiki-backlink {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  padding: 6px 4px;
  cursor: pointer;
  border-radius: 6px;
  font-size: var(--text-base);
}

.wiki-backlink:hover {
  background: color-mix(in srgb, currentColor 6%, transparent);
}

.wiki-backlink-title {
  font-weight: 600;
  white-space: nowrap;
}

.wiki-backlink-excerpt {
  opacity: 0.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wiki-document :deep(.wikilink) {
  color: var(--el-color-primary, #4a7dbe);
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--el-color-primary, #4a7dbe) 45%, transparent);
  cursor: pointer;
}

.wiki-document :deep(.wikilink-unresolved) {
  color: var(--el-color-danger, #c45656);
  border-bottom-style: dashed;
}
</style>
