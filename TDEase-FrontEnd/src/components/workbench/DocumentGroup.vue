<!--
  DocumentGroup — one editor group: its OWN tab strip + split actions +
  document surface. The group's tabs are `documentsStore.groupOf(groupId).tabs`
  (VSCode's per-group tab stacks); two groups may show the same document, but
  each strip is that group's membership, never a shared list.

  Group actions are the VSCode affordances, scoped to THIS group:
    • agent sidebar — expand/collapse the Workbench's right dock (the
      directional-split buttons are gone: tab drag to an edge splits, and
      Ctrl+\ clones);
    • rotate — flip the orientation of the branch this group lives in;
    • close group — collapse this leaf (tabs that also live elsewhere keep
      living; unique tabs are closed, with the same dirty guard as a tab).

  Clicking anywhere in a group focuses it, so the next `open()` lands here —
  the same "opens into the focused editor group" rule VSCode uses.

  With no document to resolve, the surface is the Welcome guide: an empty
  group is never a blank pane.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Close } from '@element-plus/icons-vue'
import AppErrorBoundary from '@/components/common/AppErrorBoundary.vue'
import IconButton from '@/components/primitives/IconButton.vue'
import { documentRegistry } from '@/components/documents/definitions'
import WelcomeDocument from '@/components/documents/WelcomeDocument.vue'
import {
  documentTabPanelId,
  documentTabDomId,
} from '@/components/documents/registry'
import { useDocumentsStore } from '@/stores/documents'
import { useConfirmDialogStore } from '@/stores/confirmDialog'
import { useUiLayoutStore } from '@/stores/uiLayout'
import DocumentTabs from './DocumentTabs.vue'
import { currentTabDrag, clearTabDrag, dropZoneOf, indicatorStyleFor, isCopyDrop, isMergeDrop, type TabDropZone } from './tabDrag'

const props = defineProps<{ groupId: string }>()

const { t } = useI18n()
const documentsStore = useDocumentsStore()
const uiLayout = useUiLayoutStore()

const group = computed(() => documentsStore.groupOf(props.groupId))

const document = computed(() => {
  const activeId = group.value?.activeId
  return activeId
    ? documentsStore.openDocuments.find((doc) => doc.id === activeId) ?? null
    : null
})

const resolved = computed(() => (document.value ? documentRegistry.resolve(document.value.key) : null))

const panelId = computed(() => documentTabPanelId(props.groupId))
const labelledByTabId = computed(() => {
  const activeId = group.value?.activeId
  return activeId ? documentTabDomId(activeId, props.groupId) : undefined
})

const isFocused = computed(() => documentsStore.focusedGroupId === props.groupId)
const canRotate = computed(() => {
  const root = documentsStore.layoutRoot
  if (!root || root.kind === 'group') return false
  return documentsStore.groupIdsOf(root).includes(props.groupId) && groupIdsTotal() > 1
})
const canClose = computed(() => groupIdsTotal() > 1)
const isMaximized = computed(() => documentsStore.maximizedGroupId === props.groupId)

function groupIdsTotal(): number {
  const root = documentsStore.layoutRoot
  return root ? documentsStore.groupIdsOf(root).length : 0
}

function toggleMaximized() {
  if (groupIdsTotal() < 2) return
  documentsStore.toggleGroupMaximized(props.groupId)
}

async function requestCloseGroup() {
  if (!canClose.value) return
  const closed = documentsStore.closeGroup(props.groupId)
  if (!closed) {
    const confirmDialog = useConfirmDialogStore()
    const ok = await confirmDialog.request({
      title: t('workbench.documentTabs.closeDirtyTitle'),
      message: t('workbench.documentGroup.closeDirtyConfirm'),
      confirmLabel: t('workbench.documentTabs.closeDirtyConfirmAction'),
      cancelLabel: t('workbench.documentTabs.closeDirtyCancelAction'),
      danger: true,
    })
    if (!ok) return
    documentsStore.closeGroup(props.groupId, { force: true })
  }
}

// ── Drop target (the group's half of the tab-drag gesture) ──────────────────
// Hit zones follow VS Code's editorDropTarget partition exactly — the INVERSE
// of the naive thirds grid this used: the inner 80% (outside the 10% edge
// ring) is one big MERGE target; only the outer ring offers a split, and the
// direction comes from the preferred-axis thirds (Ctrl+\ splits side-by-side,
// so horizontal thirds lead). Zones are measured on the BODY region — the tab
// strip does not take part (dropping on a tab is the strip's insert gesture).
// Modifiers: Alt (Shift on mac) toggles split OFF for the whole gesture →
// merge everywhere; Ctrl (Alt on mac) turns the drop into a COPY.
const dropZone = ref<TabDropZone | null>(null)
const dropOverlayTransition = ref(false)
let dropOverlayTimer: number | null = null
const bodyEl = ref<HTMLElement | null>(null)

const dropIndicatorStyle = computed(() => (dropZone.value ? indicatorStyleFor(dropZone.value) : undefined))

// dragover fires per pointer move; the group's geometry cannot change while
// the pointer is captured by the drag, so the rect is measured once per drag
// entry and dropped with the overlay.
let cachedBodyRect: DOMRect | null = null

function zoneFromEvent(event: DragEvent): TabDropZone {
  const rect = cachedBodyRect ?? bodyEl.value?.getBoundingClientRect() ?? null
  if (!rect) return 'center'
  return dropZoneOf(event.clientX, event.clientY, rect)
}

/** First show: indicator at opacity 0 → shown without the move transition;
 *  the transition class lands a tick later so the FIRST position never
 *  animates and subsequent zone changes glide (VS Code's setTimeout(0)). */
function showOverlay(zone: TabDropZone) {
  if (dropZone.value === null) {
    cachedBodyRect = bodyEl.value?.getBoundingClientRect() ?? null
    dropZone.value = zone
    dropOverlayTransition.value = false
    if (dropOverlayTimer != null) window.clearTimeout(dropOverlayTimer)
    dropOverlayTimer = window.setTimeout(() => {
      dropOverlayTransition.value = true
      dropOverlayTimer = null
    }, 0)
  } else {
    dropZone.value = zone
  }
}

function hideOverlay() {
  dropZone.value = null
  cachedBodyRect = null
  dropOverlayTransition.value = false
  if (dropOverlayTimer != null) {
    window.clearTimeout(dropOverlayTimer)
    dropOverlayTimer = null
  }
}

onBeforeUnmount(hideOverlay)

function onDragOver(event: DragEvent) {
  const drag = currentTabDrag()
  if (!drag || !event.dataTransfer) return
  // The strip's own zones (insert next to a tab) own that feedback.
  if ((event.target as Element).closest('[data-tab]')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  showOverlay(isMergeDrop(event) ? 'center' : zoneFromEvent(event))
}

function onDragLeave(event: DragEvent) {
  const next = event.relatedTarget as Element | null
  if (!next || !(event.currentTarget as HTMLElement).contains(next)) hideOverlay()
}

function onDrop(event: DragEvent) {
  const drag = currentTabDrag()
  const zone = dropZone.value
  hideOverlay()
  if (!drag || !zone) return
  event.preventDefault()
  // Modifiers read off the DROP event: the user may have pressed them after
  // the last dragover (VS Code re-reads them at drop time too).
  const copy = isCopyDrop(event)
  const mergeInstead = isMergeDrop(event)
  if (zone === 'center' || mergeInstead) {
    documentsStore.moveTab(drag.tabId, props.groupId, undefined, drag.fromGroupId, { copy })
  } else {
    const orientation = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
    const side = zone === 'left' || zone === 'up' ? 'before' : 'after'
    documentsStore.moveTabToSplit(drag.tabId, props.groupId, orientation, side, drag.fromGroupId, { copy })
  }
  clearTabDrag()
}

function onDragEnd() {
  hideOverlay()
  clearTabDrag()
}
</script>

<template>
  <section
    class="document-group"
    :class="{ 'is-focused': isFocused }"
    @pointerdown="documentsStore.focusGroup(props.groupId)"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @dragend="onDragEnd"
  >
    <header class="document-group__head">
      <DocumentTabs :group-id="props.groupId" class="document-group__tabs" />
      <div class="document-group__actions" role="group" :aria-label="t('workbench.documentGroup.label')">
        <!-- The directional-split buttons are gone: tab drag to an edge splits
           (and Ctrl+\ clones), so this slot carries the shell's dock toggles
           instead — Navigator (left dock) and Agent sidebar (right dock),
           ordered by which edge each dock lives on. -->
        <IconButton
          size="xs"
          class="document-group__action document-group__navigator-toggle"
          :title="t(uiLayout.navigatorCollapsed
            ? 'workbench.documentGroup.showNavigator'
            : 'workbench.documentGroup.hideNavigator')"
          :aria-label="t(uiLayout.navigatorCollapsed
            ? 'workbench.documentGroup.showNavigator'
            : 'workbench.documentGroup.hideNavigator')"
          :aria-pressed="!uiLayout.navigatorCollapsed"
          @click="uiLayout.toggleNavigatorCollapsed()"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1" y="1.5" width="10" height="9" rx="1.2" />
            <line x1="4.5" y1="1.5" x2="4.5" y2="10.5" />
            <rect v-if="!uiLayout.navigatorCollapsed" x="1.8" y="2.4" width="1.8" height="7.2" rx="0.6" fill="currentColor" stroke="none" />
          </svg>
        </IconButton>
        <IconButton
          size="xs"
          class="document-group__action document-group__agent-toggle"
          :title="t(uiLayout.agentSidebarCollapsed
            ? 'workbench.documentGroup.showAgentSidebar'
            : 'workbench.documentGroup.hideAgentSidebar')"
          :aria-label="t(uiLayout.agentSidebarCollapsed
            ? 'workbench.documentGroup.showAgentSidebar'
            : 'workbench.documentGroup.hideAgentSidebar')"
          :aria-pressed="!uiLayout.agentSidebarCollapsed"
          @click="uiLayout.toggleAgentSidebar()"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1" y="1.5" width="10" height="9" rx="1.2" />
            <line x1="7.5" y1="1.5" x2="7.5" y2="10.5" />
            <rect v-if="!uiLayout.agentSidebarCollapsed" x="8.4" y="2.4" width="1.8" height="7.2" rx="0.6" fill="currentColor" stroke="none" />
          </svg>
        </IconButton>
        <IconButton
          v-if="canRotate"
          size="xs"
          class="document-group__action"
          :title="t('workbench.documentGroup.splitToggle')"
          :aria-label="t('workbench.documentGroup.splitToggle')"
          @click="documentsStore.rotateFocusedBranch()"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1" y="1.5" width="10" height="9" rx="1.2" />
            <line x1="7.5" y1="1.5" x2="7.5" y2="10.5" />
          </svg>
        </IconButton>
        <IconButton
          v-if="groupIdsTotal() > 1"
          size="xs"
          class="document-group__action"
          :title="t(isMaximized ? 'workbench.documentGroup.restoreGroup' : 'workbench.documentGroup.maximizeGroup')"
          :aria-label="t(isMaximized ? 'workbench.documentGroup.restoreGroup' : 'workbench.documentGroup.maximizeGroup')"
          @click="toggleMaximized"
        >
          <svg v-if="!isMaximized" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1" y="1.5" width="10" height="9" rx="1.2" />
          </svg>
          <svg v-else viewBox="0 0 12 12" aria-hidden="true">
            <rect x="1" y="3" width="10" height="7.5" rx="1.2" />
            <line x1="3" y1="1.5" x2="10" y2="1.5" />
          </svg>
        </IconButton>
        <IconButton
          v-if="canClose"
          size="xs"
          class="document-group__action"
          :title="t('workbench.documentGroup.closeGroup')"
          :aria-label="t('workbench.documentGroup.closeGroup')"
          @click="requestCloseGroup"
        >
          <Close />
        </IconButton>
      </div>
    </header>

    <AppErrorBoundary>
      <!-- The tabpanel half of the ARIA tabs pattern for this group; the
           surface is focusable so Tab from the strip lands in the document. -->
      <div
        :id="panelId"
        ref="bodyEl"
        class="document-group__body"
        role="tabpanel"
        :aria-labelledby="labelledByTabId"
        tabindex="0"
      >
        <KeepAlive :max="8">
          <component
            :is="resolved.component"
            v-if="resolved"
            :key="`${props.groupId}:${document?.id ?? ''}`"
            v-bind="resolved.props"
          />
        </KeepAlive>
        <!-- No open document → the guide surface. It is deliberately NOT a
             tab: "no tabs" is exactly the state it answers, and a Welcome tab
             could not be closed into anything but itself again. -->
        <WelcomeDocument v-if="!resolved" />
      </div>
    </AppErrorBoundary>

    <!-- Drop overlay (VSCode's editorDropTarget): a translucent block over
         the zone the tab will land in — full body for "move/copy into", a
         half cell for a directional split. Positioned via inline
         top/left/width/height so the indicator can glide between zones once
         the first-frame transition class lands; pointer-events stay with the
         group (the drag owns them). -->
    <div v-if="dropZone" class="document-group__drop" aria-hidden="true">
      <div
        class="document-group__drop-indicator"
        :class="{ 'is-transition': dropOverlayTransition }"
        :style="dropIndicatorStyle"
      />
    </div>
  </section>
</template>

<style scoped>
.document-group {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.document-group__head {
  flex: none;
  display: flex;
  align-items: center;
  min-width: 0;
  background: var(--color-bg-secondary);
}

.document-group__tabs {
  flex: 1 1 auto;
  min-width: 0;
}

.document-group__actions {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 var(--space-2);
}

.document-group__action {
  width: 22px;
  height: 22px;
}

.document-group__action svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: round;
}

.document-group__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  /* Windows classic-scrollbar shift guard (see Transcript.vue). */
  scrollbar-gutter: stable;
  display: flex;
}

/* Which group receives the next open(): the focused one carries the same
   2px interact accent the active tab uses — quiet, but findable. */
.document-group.is-focused > .document-group__head {
  box-shadow: inset 0 -2px 0 var(--color-interact);
}

/* Drop overlay: sits above everything inside the group, never intercepts
   pointer events (the drag does that). The region excludes the tab strip —
   the strip's insert gesture owns that band. */
.document-group__drop {
  position: absolute;
  top: var(--header-h);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-overlay);
  pointer-events: none;
}

.document-group__drop-indicator {
  position: absolute;
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  border: 2px solid color-mix(in srgb, var(--color-primary) 55%, transparent);
  border-radius: var(--radius-md);
  opacity: 0;
  transition: opacity 150ms ease-out;
}

.document-group__drop-indicator.is-transition {
  /* VSCode's overlay-move-transition: the FIRST position must not animate;
     zone changes afterwards glide. Banned as a layout animation everywhere
     else, but this is transient drag feedback measured in tens of ms — and
     prefers-reduced-motion kills it outright. */
  transition:
    top 70ms ease-out,
    left 70ms ease-out,
    width 70ms ease-out,
    height 70ms ease-out,
    opacity 150ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .document-group__drop-indicator,
  .document-group__drop-indicator.is-transition {
    transition: none;
  }
}
</style>
