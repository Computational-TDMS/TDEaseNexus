<!--
  The Workbench's own regions. `AppShell` owns the SideBar and the page track;
  this owns the arrangement that is specific to working on documents:

    Navigator | [DocumentHost over Panel | AgentSidebar]

  The AgentSidebar is the Workbench's right-docked view of the ONE Agent
  conversation (see agentConversation.ts) — toggled from the StatusBar's Agent
  control (or Ctrl+Alt+B); collapsed it leaves NO slab and unmounts entirely
  (`v-if`).

  The panel (Runs/Logs dock) is movable: docked bottom (default) or right, and
  maximizable over the center — its header carries position/maximize/close.
  Collapse leaves NO slab: the split renders in its `is-collapsed` state and
  the dock's subtree unmounts.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElementSize } from '@vueuse/core'
import { useUiLayoutStore, PANEL_BOTTOM_RANGE, PANEL_RIGHT_RANGE, AGENT_SIDEBAR_WIDTH_RANGE, NAVIGATOR_WIDTH_RANGE } from '@/stores/uiLayout'
import ResizableSplit from './ResizableSplit.vue'
import NavigatorPanel from './NavigatorPanel.vue'
import DocumentHost from './DocumentHost.vue'
import ActivityDock from './ActivityDock.vue'
import AgentSidebar from '@/components/agent/AgentSidebar.vue'

const { t } = useI18n()
const uiLayout = useUiLayoutStore()

// --- Container sizes: the dock sizes are stored as RATIOS of these axes
// (uiLayout's proportional memory), so every drag reports the container the
// px came from. ---
const pageRootRef = ref<HTMLElement | null>(null)
const rightZoneRef = ref<HTMLElement | null>(null)
const { width: pageWidth } = useElementSize(pageRootRef)
const { width: rightZoneWidth } = useElementSize(rightZoneRef)

// --- Panel vs. editor surface: the split sizes its SECOND pane (the panel);
// drag deltas and arrow keys invert accordingly. The panel's declared range
// is expressed as bounds on that trailing pane; the editor keeps ≥170px. ---
const centerRef = ref<HTMLElement | null>(null)
const { width: centerWidth, height: centerHeight } = useElementSize(centerRef)
const isRight = computed(() => uiLayout.panelPosition === 'right')
const containerSize = computed(() => (isRight.value ? centerWidth.value : centerHeight.value))

const panelSizePx = computed(() => {
  if (!uiLayout.panelVisible) return 0
  // Pre-measurement guard: useElementSize reports 0 before the first
  // ResizeObserver callback — estimate from the window instead of collapsing
  // the panel to 0px for a frame (the 2026-09-05 CLS lesson).
  if (containerSize.value === 0) {
    return typeof window === 'undefined' ? 0 : (isRight.value ? window.innerWidth : window.innerHeight) * 0.35
  }
  return uiLayout.panelSize
})

function panelBounds(): { min: number; max: number } {
  if (!uiLayout.panelVisible) return { min: 0, max: 0 }
  const range = isRight.value ? PANEL_RIGHT_RANGE : PANEL_BOTTOM_RANGE
  if (containerSize.value === 0) return range
  const ceiling = Math.max(0, containerSize.value - 170)
  return { min: range.min, max: Math.max(range.min, Math.min(range.max, ceiling)) }
}

const panelMin = computed(() => panelBounds().min)
const panelMax = computed(() => panelBounds().max)

function onPanelResize(px: number) {
  if (!uiLayout.panelVisible) return
  uiLayout.setPanelSize(px, containerSize.value)
}
</script>

<template>
  <!--
    Three columns: Navigator | [DocumentHost over Panel] | AgentSidebar. The
    Navigator is this page's own left column; the Agent sidebar is its right
    dock. Each dock's split stays mounted in both visibility states so nothing
    behind it ever remounts; collapsed, the bounds open to zero and the
    trailing content unmounts. All three are `collapsible`: dragging the sash
    past the snap threshold docks them away (and drags back out) — the snap
    reports through `update:collapsed`, which aims the same store flags the
    keyboard/StatusBar toggles use.
  -->
  <div ref="pageRootRef" class="workbench-page">
    <ResizableSplit
      direction="horizontal"
      :size="uiLayout.navigatorCollapsed ? 0 : uiLayout.navigatorWidth"
      :min="uiLayout.navigatorCollapsed ? 0 : NAVIGATOR_WIDTH_RANGE.min"
      :max="uiLayout.navigatorCollapsed ? 0 : NAVIGATOR_WIDTH_RANGE.max"
      :collapsed="uiLayout.navigatorCollapsed"
      collapsible
      :aria-label="t('workbench.layout.resizeNavigator')"
      @update:size="uiLayout.setNavigatorWidth($event, pageWidth)"
      @update:collapsed="uiLayout.setNavigatorCollapsed"
    >
      <template #first>
        <NavigatorPanel v-if="!uiLayout.navigatorCollapsed" />
      </template>
      <template #second>
        <div ref="rightZoneRef" class="workbench-page__right-zone">
          <ResizableSplit
            direction="horizontal"
            :size="uiLayout.agentSidebarCollapsed ? 0 : uiLayout.agentSidebarWidth"
            :min="uiLayout.agentSidebarCollapsed ? 0 : AGENT_SIDEBAR_WIDTH_RANGE.min"
            :max="uiLayout.agentSidebarCollapsed ? 0 : AGENT_SIDEBAR_WIDTH_RANGE.max"
            sized-pane="second"
            :collapsed="uiLayout.agentSidebarCollapsed"
            collapsible
            :aria-label="t('workbench.layout.resizeAgentSidebar')"
            @update:size="uiLayout.setAgentSidebarWidth($event, rightZoneWidth)"
            @update:collapsed="uiLayout.setAgentSidebarCollapsed"
          >
            <template #first>
              <div ref="centerRef" class="workbench-page__center">
                <!-- Panel-maximized: the dock owns the center; the editor DOM
                     is released (the documents store re-renders it on restore). -->
                <ActivityDock
                  v-if="uiLayout.panelVisible && uiLayout.panelMaximized"
                  class="workbench-page__panel-max"
                />
                <ResizableSplit
                  v-else
                  :direction="isRight ? 'horizontal' : 'vertical'"
                  :size="panelSizePx"
                  :min="panelMin"
                  :max="panelMax"
                  sized-pane="second"
                  :collapsed="!uiLayout.panelVisible"
                  collapsible
                  :aria-label="isRight ? t('workbench.layout.resizePanelRight') : t('workbench.layout.resizePanelBottom')"
                  @update:size="onPanelResize"
                  @update:collapsed="uiLayout.setPanelVisible"
                >
                  <template #first>
                    <DocumentHost />
                  </template>
                  <template #second>
                    <ActivityDock v-if="uiLayout.panelVisible" />
                  </template>
                </ResizableSplit>
              </div>
            </template>
            <template #second>
              <AgentSidebar v-if="!uiLayout.agentSidebarCollapsed" />
            </template>
          </ResizableSplit>
        </div>
      </template>
    </ResizableSplit>
  </div>
</template>

<style scoped>
.workbench-page {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workbench-page__right-zone {
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workbench-page__center {
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workbench-page__panel-max {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
</style>
