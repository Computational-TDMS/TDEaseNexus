<!--
  One group's tab strip over THAT group's own tab stack (`groupOf(groupId).tabs`
  — VSCode per-group ownership, not the shared list the old split model used).

  Tab states: pinned (icon only, leftmost section), preview (italic, replaced
  by the next preview rather than accumulating), open (normal). A dirty
  document shows a filled dot instead of its close affordance — it cannot be
  closed silently (`documentStore.close` itself refuses without `force`).
  There is no tab-count ceiling (VSCode): tabs shrink to their floor and the
  strip scrolls, with the active tab scrolled back into view.

  Keyboard: the tablist follows the WAI-ARIA tabs pattern — the active tab is
  the only one in the tab order (tabindex 0, the rest -1); Left/Right move
  focus along the strip and activate the focused tab; the dirty dot and the
  close button are real buttons, so they are reachable and operable too.

  Drag & drop (VSCode gestures): a tab is draggable. Dropping ON another tab
  inserts before/after it (left/right half hit test — the drop-border marker);
  the strip and DocumentGroup's directional overlays handle the rest. The
  payload rides the tabDrag singleton because DataTransfer.getData is unread-
  able during dragover.
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Close, Document, Flag, Grid } from '@element-plus/icons-vue'
import IconButton from '@/components/primitives/IconButton.vue'
import type { OpenDocument } from '@/studio/domain/document'
import {
  documentTabPanelId,
  documentTabDomId,
} from '@/components/documents/registry'
import { useDocumentsStore } from '@/stores/documents'
import { useConfirmDialogStore } from '@/stores/confirmDialog'
import { TAB_DRAG_TYPE, currentTabDrag, clearTabDrag, setTabDrag, isCopyDrop } from './tabDrag'

const props = defineProps<{ groupId: string }>()

const { t } = useI18n()
const documentsStore = useDocumentsStore()

const group = computed(() => documentsStore.groupOf(props.groupId))
const tabs = computed<OpenDocument[]>(() =>
  (group.value?.tabs ?? [])
    .map((id) => documentsStore.openDocuments.find((doc) => doc.id === id))
    .filter((doc): doc is OpenDocument => Boolean(doc)))

const selectedId = computed(() => group.value?.activeId ?? null)
const panelId = computed(() => documentTabPanelId(props.groupId))

/** Pinned lead the strip; unpinned keep the group's own (drag-ordered) order. */
const pinnedTabs = computed(() => tabs.value.filter((doc) => doc.pinned))
const unpinnedTabs = computed(() => tabs.value.filter((doc) => !doc.pinned))

// Ids in tab-strip order — used for roving focus. Pinned tabs lead, then the rest.
const tabOrder = computed<string[]>(() => [
  ...pinnedTabs.value.map((d) => d.id),
  ...unpinnedTabs.value.map((d) => d.id),
])

function kindIcon(doc: OpenDocument) {
  return doc.key.kind === 'run-index' ? Grid : Document
}

// tabindex: only the active (or first) tab is in the page tab order; the rest
// are reached via the arrow keys, per the ARIA tabs pattern.
function tabbableIndex(id: string): 0 | -1 {
  const active = selectedId.value
  if (active && tabOrder.value.includes(active)) return id === active ? 0 : -1
  return id === tabOrder.value[0] ? 0 : -1
}

// Overflow has no tab-count ceiling (VSCode): tabs shrink to their floor and
// the strip scrolls. The strip follows the selection so an activated tab is
// always in view.
const stripEl = ref<HTMLElement | null>(null)

async function revealActiveTab() {
  await nextTick()
  const el = stripEl.value?.querySelector<HTMLElement>('[data-tab].is-active')
  // jsdom/test environments ship no scrollIntoView.
  el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
}

watch(selectedId, revealActiveTab, { immediate: true })
watch(() => tabs.value.length, revealActiveTab)

function focusTab(id: string) {
  stripEl.value?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus()
}

function onTabKeydown(event: KeyboardEvent, doc: OpenDocument) {
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    const order = tabOrder.value
    const i = order.indexOf(doc.id)
    if (i === -1) return
    const dir = event.key === 'ArrowRight' ? 1 : -1
    const next = order[(i + dir + order.length) % order.length]
    if (next) {
      select(next)
      focusTab(next)
    }
  } else if (event.key === 'Home') {
    event.preventDefault()
    const first = tabOrder.value[0]
    if (first) { select(first); focusTab(first) }
  } else if (event.key === 'End') {
    event.preventDefault()
    const last = tabOrder.value[tabOrder.value.length - 1]
    if (last) { select(last); focusTab(last) }
  }
}

function select(id: string) {
  documentsStore.activateInGroupAndFocus(props.groupId, id)
}

function requestClose(doc: OpenDocument) {
  if (doc.dirty) return // no close affordance is rendered while dirty (see template)
  documentsStore.close(doc.id)
}

async function confirmDirtyClose(doc: OpenDocument) {
  const confirmDialog = useConfirmDialogStore()
  const ok = await confirmDialog.request({
    title: t('workbench.documentTabs.closeDirtyTitle'),
    message: t('workbench.documentTabs.closeDirtyConfirm'),
    confirmLabel: t('workbench.documentTabs.closeDirtyConfirmAction'),
    cancelLabel: t('workbench.documentTabs.closeDirtyCancelAction'),
    danger: true,
  })
  if (!ok) return // dismissed — Esc, backdrop and the cancel button all land here
  documentsStore.close(doc.id, { force: true })
}

function keepOpen(doc: OpenDocument) {
  documentsStore.keep(doc.id)
}

function pinTab(doc: OpenDocument) {
  documentsStore.pin(doc.id)
}

function unpinTab(doc: OpenDocument) {
  documentsStore.unpin(doc.id)
}

// ── Drag & drop: the strip's half of the gesture ────────────────────────────
// The strip owns the drop-ON-A-TAB zones (insert before/after). Dropping on
// the strip's empty area, the group body's center, or its edges is
// DocumentGroup's half (overlay + directional splits).

/** 'before' | 'after' insertion marker next to this tab id. */
const dropMarker = ref<{ tabId: string; side: 'before' | 'after' } | null>(null)

/**
 * Custom drag image (VSCode's applyDragImage): a plain labeled chip offset up
 * -left of the pointer so the drop-border markers stay visible under it.
 */
function applyTabDragImage(event: DragEvent, label: string) {
  if (!event.dataTransfer) return
  const ghost = document.createElement('div')
  ghost.textContent = label
  ghost.className = 'tab-drag-ghost'
  ghost.style.position = 'absolute'
  ghost.style.top = '-1000px'
  document.body.appendChild(ghost)
  try {
    event.dataTransfer.setDragImage(ghost, -10, -10)
  } catch {
    // setDragImage is unsupported in some environments — the default ghost
    // (the tab element itself) is the fallback, not an error.
  }
  window.setTimeout(() => ghost.remove(), 0)
}

function onDragStart(event: DragEvent, doc: OpenDocument) {
  setTabDrag({ tabId: doc.id, fromGroupId: props.groupId })
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(TAB_DRAG_TYPE, doc.id)
    event.dataTransfer.setData('text/plain', doc.title)
  }
  applyTabDragImage(event, doc.title)
}

function onDragEnd() {
  clearTabDrag()
  dropMarker.value = null
}

function tabInsertIndex(tabId: string, side: 'before' | 'after'): number {
  const list = group.value?.tabs ?? []
  const at = list.indexOf(tabId)
  return side === 'before' ? Math.max(0, at) : Math.min(list.length, at + 1)
}

function onTabDragOver(event: DragEvent, doc: OpenDocument) {
  const drag = currentTabDrag()
  if (!drag || !event.dataTransfer) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const side: 'before' | 'after' = event.clientX - rect.left <= rect.width / 2 ? 'before' : 'after'
  dropMarker.value = { tabId: doc.id, side }
}

function onTabDrop(event: DragEvent, doc: OpenDocument) {
  const drag = currentTabDrag()
  dropMarker.value = null
  if (!drag) return
  event.preventDefault()
  event.stopPropagation()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const side: 'before' | 'after' = event.clientX - rect.left <= rect.width / 2 ? 'before' : 'after'
  const index = tabInsertIndex(doc.id, side)
  if (drag.fromGroupId === props.groupId) {
    documentsStore.reorderTab(props.groupId, drag.tabId, index)
  } else {
    // The copy modifier must mean the same thing at EVERY landing zone of one
    // gesture — a strip insert copies just like a body drop does.
    documentsStore.moveTab(drag.tabId, props.groupId, index, drag.fromGroupId, { copy: isCopyDrop(event) })
  }
  clearTabDrag()
}

/** Dragging across the strip but not over a tab: no marker. */
function onStripDragOver(event: DragEvent) {
  if (!currentTabDrag()) return
  if (!(event.target as Element).closest('[data-tab]')) dropMarker.value = null
}

/**
 * Double-click on the strip's empty area toggles group maximize (VS Code's
 * double-click-on-empty-tab-bar affordance). A double-click on a tab keeps
 * its own meaning (preview → keep open).
 */
function onStripDblclick(event: MouseEvent) {
  if ((event.target as Element).closest('[data-tab]')) return
  documentsStore.toggleGroupMaximized(props.groupId)
}
</script>

<template>
  <div
    ref="stripEl"
    class="document-tabs"
    role="tablist"
    :aria-label="t('workbench.documentTabs.label')"
    @dragover="onStripDragOver"
    @drop="dropMarker = null"
    @dblclick="onStripDblclick"
  >
    <template v-if="tabs.length">
      <div
        v-for="doc in pinnedTabs"
        :id="documentTabDomId(doc.id, groupId)"
        :key="doc.id"
        role="tab"
        class="document-tabs__tab document-tabs__tab--pinned"
        :class="{ 'is-active': doc.id === selectedId }"
        :data-tab="doc.id"
        :aria-controls="panelId"
        :tabindex="tabbableIndex(doc.id)"
        :aria-selected="doc.id === selectedId"
        :title="doc.title"
        draggable="true"
        @dragstart="onDragStart($event, doc)"
        @dragend="onDragEnd"
        @click="select(doc.id)"
        @keydown="onTabKeydown($event, doc)"
      >
        <el-icon :size="16"><component :is="kindIcon(doc)" /></el-icon>
        <button
          type="button"
          class="document-tabs__pin document-tabs__pin--active"
          :aria-label="t('workbench.documentTabs.unpin')"
          :title="t('workbench.documentTabs.unpin')"
          @click.stop="unpinTab(doc)"
        >
          <el-icon :size="12"><Flag /></el-icon>
        </button>
      </div>

      <span v-if="pinnedTabs.length" class="document-tabs__divider" aria-hidden="true" />

      <div
        v-for="doc in unpinnedTabs"
        :id="documentTabDomId(doc.id, groupId)"
        :key="doc.id"
        role="tab"
        class="document-tabs__tab"
        :class="{
          'is-active': doc.id === selectedId,
          'is-preview': documentsStore.tierOf(doc) === 'preview',
          'is-drop-before': dropMarker?.tabId === doc.id && dropMarker.side === 'before',
          'is-drop-after': dropMarker?.tabId === doc.id && dropMarker.side === 'after',
        }"
        :data-tab="doc.id"
        :aria-controls="panelId"
        :tabindex="tabbableIndex(doc.id)"
        :aria-selected="doc.id === selectedId"
        :title="doc.title"
        draggable="true"
        @dragstart="onDragStart($event, doc)"
        @dragend="onDragEnd"
        @dragover="onTabDragOver($event, doc)"
        @drop="onTabDrop($event, doc)"
        @click="select(doc.id)"
        @dblclick="keepOpen(doc)"
        @keydown="onTabKeydown($event, doc)"
      >
        <span class="document-tabs__title">{{ doc.title }}</span>
        <button
          type="button"
          class="document-tabs__pin"
          :aria-label="t('workbench.documentTabs.pin')"
          :title="t('workbench.documentTabs.pin')"
          @click.stop="pinTab(doc)"
        >
          <el-icon :size="12"><Flag /></el-icon>
        </button>
        <button
          v-if="doc.dirty"
          type="button"
          class="document-tabs__dirty-dot"
          :aria-label="t('workbench.documentTabs.closeDirty')"
          :title="t('workbench.documentTabs.dirtyHint')"
          @click.stop="confirmDirtyClose(doc)"
        />
        <IconButton
          v-else
          size="sm"
          class="document-tabs__close"
          :aria-label="t('workbench.documentTabs.close')"
          @click.stop="requestClose(doc)"
        >
          <Close />
        </IconButton>
      </div>
    </template>

    <template v-else>
      <span class="document-tabs__placeholder">{{ t('workbench.documentTabs.empty') }}</span>
    </template>
  </div>
</template>

<style scoped>
.document-tabs {
  flex: none;
  display: flex;
  align-items: center;
  height: var(--header-h);
  min-height: var(--header-h);
  padding: 0 var(--space-3);
  gap: 2px;
  background: var(--color-bg-secondary);
  /* Tonal layering: no border-bottom. The document surface below steps UP to
     --ctp-base, so the mantle→base luminance step separates chrome from
     content (VISUAL-SYSTEM.md §1.1, §4.1). */
  /* VSCode's shrink strip: no tab-count ceiling — tabs shrink to their floor
     and the strip scrolls; the active tab is scrolled back into view. */
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.document-tabs__placeholder {
  font-size: var(--text-sm);
  color: var(--color-text-disabled);
}

.document-tabs__divider {
  width: var(--line-w);
  align-self: stretch;
  margin: var(--space-1) var(--space-1);
  background: var(--line-seam);
}

.document-tabs__tab {
  position: relative;
  /* VSCode sizing-shrink: flexbox IS the shrink algorithm — every tab shares
     the free space equally (basis 0, grow 1), floored at 84px and capped at
     its OWN content width (fit-content), so a lone tab hugs its label instead
     of stretching; past the floors the strip scrolls. */
  flex: 1 1 0;
  min-width: 84px;
  max-width: fit-content;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: calc(var(--header-h) - 10px);
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: background-color var(--dur-instant) var(--ease-out), color var(--dur-instant) var(--ease-out);
}

.document-tabs__tab--pinned {
  flex: 0 0 auto;
  min-width: 0;
  max-width: none;
  padding: 0 var(--space-1);
}

.document-tabs__tab:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.document-tabs__tab.is-active {
  /* Lead voice for chrome selection — same unification as NavigatorPanel's
     tabs: blue stays the interact/data voice, not the accent of chrome. */
  background: var(--color-primary-soft);
  color: var(--color-text);
}

/* VSCode-style active marker: a 2px lead-voice accent at the tab's bottom
   edge, carrying the "which document is live" signal without a heavy color
   block. */
.document-tabs__tab.is-active::after {
  content: '';
  position: absolute;
  left: var(--space-2);
  right: var(--space-2);
  bottom: -1px;
  height: 2px;
  border-radius: 50%;
  background: var(--color-primary);
}

.document-tabs__tab--pinned.is-active::after {
  left: var(--space-1);
  right: var(--space-1);
}

.document-tabs__tab.is-preview .document-tabs__title {
  font-style: italic;
}

/* Drop-position markers (VSCode's tab drop-border): a lead-voice bar at the
   edge the drop will insert at. Instant, not animated — layout is never
   animated, and the marker tracks the pointer every frame. */
.document-tabs__tab.is-drop-before::before,
.document-tabs__tab.is-drop-after::after {
  content: '';
  position: absolute;
  top: 2px;
  bottom: 2px;
  width: 2px;
  border-radius: 1px;
  background: var(--color-primary);
  z-index: var(--z-seam);
}
.document-tabs__tab.is-drop-before::before { left: -2px; }
.document-tabs__tab.is-drop-after::after { right: -2px; }

/* Roving focus must be VISIBLE. Every other focusable here (close, pin,
   overflow) carries the 2px ring; the tab itself went without one, so arrow
   navigation was a silent trip. Offset is negative because tabs sit 2px
   apart — an outer ring would bleed onto the neighbor; this draws inside the
   tab's own rounded box. */
.document-tabs__tab:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -2px;
}

.document-tabs__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.document-tabs__dirty-dot {
  flex: none;
  width: 10px;
  height: 10px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--color-warning, var(--color-primary));
  cursor: pointer;
}

.document-tabs__dirty-dot:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.document-tabs__pin {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-disabled);
  cursor: pointer;
  opacity: 0;
}

.document-tabs__tab:hover .document-tabs__pin,
.document-tabs__tab:focus-within .document-tabs__pin {
  opacity: 1;
}

.document-tabs__pin:hover {
  background: var(--color-border-panel);
  color: var(--color-text);
}

.document-tabs__pin--active {
  opacity: 1;
  color: var(--color-primary, var(--color-primary));
}

.document-tabs__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.document-tabs__close:hover {
  background: var(--color-border-panel);
}
</style>

<style>
/* The drag ghost mounts on document.body — outside any scoped style's
   reach, so this block is deliberately unscoped. */
.tab-drag-ghost {
  position: absolute;
  top: -1000px;
  left: 0;
  max-width: 240px;
  padding: 3px 10px;
  border: 1px solid var(--line-seam);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--text-sm);
  font-family: var(--font-body);
  box-shadow: var(--shadow-md);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
</style>
