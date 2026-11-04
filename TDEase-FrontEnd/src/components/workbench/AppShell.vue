<!--
  AppShell — the window frame, and the one place a page is chosen.

  Everything here is shared by every page:

    SideBar (fixed-width icon rail) | <the page track> | StatusBar
    CommandPalette + PageHandle (top layer, not regions)

  The page area is a two-slot track: WorkbenchPage and AgentPage stay mounted
  side by side, and switching slides the track. The PageHandle is the ONE
  control: it hangs on the window edge that faces the Agent — the RIGHT edge
  while the Agent is the Workbench's right-docked sidebar, the LEFT edge on
  the full Agent page. A click animates the slide; dragging it pulls the track
  by hand (release past the midpoint or with a flick commits; otherwise it
  springs back). `activePage` still changes only on commit, so every
  `setActivePage` caller is untouched; it is boot-time state — every launch
  lands on the Agent page — and is deliberately not persisted. The slide
  animates `transform` only (VISUAL-ROLLOUT-PLAN §1.3), and the settled
  off-screen slot drops to `visibility: hidden` so it costs no paint.

  Layout keys (VS Code grammar): Ctrl+B toggles the Navigator, Ctrl+J the
  panel, Ctrl+Alt+B the Agent sidebar, Ctrl+Shift+J maximizes the panel,
  Ctrl+\ splits the focused editor group, Ctrl+=/-/0 font zoom.
-->
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useAgentViewStore } from '@/stores/agentView'
import { useI18n } from 'vue-i18n'
import { useUiLayoutStore } from '@/stores/uiLayout'
import { useSettingsStore } from '@/stores/settings'
import { useDocumentsStore } from '@/stores/documents'
import { useConfirmDialogStore } from '@/stores/confirmDialog'
import { setRunSurfacePrompt } from '@/stores/runs'
import SideBar from './SideBar.vue'
import PageHandle from './PageHandle.vue'
import StatusBar from './StatusBar.vue'
import CommandPalette from './CommandPalette.vue'
import ConfirmDialogHost from '@/components/primitives/ConfirmDialogHost.vue'
import WorkbenchPage from './WorkbenchPage.vue'
import AgentPage from '@/components/agent/AgentPage.vue'
import { usePageTrack } from './usePageTrack'

const uiLayout = useUiLayoutStore()
const settingsStore = useSettingsStore()
const documentsStore = useDocumentsStore()
const confirmDialog = useConfirmDialogStore()
const { t } = useI18n()
const agentHost = '#agent-page-host'

/**
 * Wire the Run surface's permission-ask callback to a real confirm dialog.
 * The runs store holds truth but renders no UI; when a destructive Run
 * command (cancel / trash / overwrite) needs user consent, it calls back
 * through `setRunSurfacePrompt`. AppShell is the shell root — the right
 * place to bind the shell's confirm surface once, for every page.
 */
setRunSurfacePrompt((_action, reason) => confirmDialog.request({
  title: t('workbench.runDocument.confirmTitle'),
  message: reason,
  danger: true,
}))

/**
 * Global shortcuts. Font zoom (Ctrl+=/-/0) deliberately NOT guarded against
 * typing targets: browser convention is that zoom always works. The layout
 * keys are VS Code grammar; they fire even from a field, matching
 * `workbench.action.toggleSidebarVisibility` etc. The panel keys only act on
 * the Workbench page — that is where the panel and the editor live.
 */
function onGlobalKeydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey)) return
  const key = event.key
  if (key === '=' || key === '+') {
    event.preventDefault()
    settingsStore.stepFontScale(1)
    showZoomReadout()
  } else if (key === '-') {
    event.preventDefault()
    settingsStore.stepFontScale(-1)
    showZoomReadout()
  } else if (key === '0') {
    event.preventDefault()
    settingsStore.resetFontScale()
    showZoomReadout()
  } else if (key === '\\') {
    // Ctrl+\ — split the focused editor group right (VS Code's split editor).
    if (uiLayout.activePage !== 'workbench') return
    event.preventDefault()
    documentsStore.splitFocusedGroup('horizontal')
  } else if (event.altKey && (key === 'b' || key === 'B')) {
    if (uiLayout.activePage !== 'workbench') return
    event.preventDefault()
    uiLayout.toggleAgentSidebar()
  } else if (event.shiftKey && (key === 'J' || key === 'j')) {
    if (uiLayout.activePage !== 'workbench') return
    event.preventDefault()
    uiLayout.togglePanelMaximized()
  } else if (key === 'b' || key === 'B') {
    if (uiLayout.activePage !== 'workbench') return
    event.preventDefault()
    uiLayout.toggleNavigatorCollapsed()
  } else if (key === 'j' || key === 'J') {
    if (uiLayout.activePage !== 'workbench') return
    event.preventDefault()
    uiLayout.togglePanelVisible()
  }
}

/**
 * Transient zoom readout: a centered-bottom pill with the new percentage,
 * shown for ~1s after a shortcut zoom — the same feedback a browser gives
 * for Ctrl+=. Slider/stepper changes already have the Appearance panel's
 * live percentage, so only the shortcut path raises it.
 */
const zoomReadoutPct = ref<number | null>(null)
let zoomReadoutTimer: ReturnType<typeof setTimeout> | undefined
function showZoomReadout() {
  zoomReadoutPct.value = Math.round(settingsStore.fontScale * 100)
  if (zoomReadoutTimer) clearTimeout(zoomReadoutTimer)
  zoomReadoutTimer = setTimeout(() => { zoomReadoutPct.value = null }, 1000)
}

// --- Page track: the state machine is `usePageTrack` (the PageHandle drives
//     the same singleton); this component owns only the DOM. ---
const track = usePageTrack()
const {
  trackStyle, trackClass, workbenchVisible, agentVisible, onTrackTransitionEnd,
} = track
const pageEl = ref<HTMLElement | null>(null)
const trackEl = ref<HTMLElement | null>(null)
watch(pageEl, (el) => track.setPageEl(el))
watch(trackEl, (el) => track.setTrackEl(el))

// Layout persistence is trailing-debounced: a sash drag streams size updates
// every frame, and each one would otherwise fan out into ~18 repository
// timer resets. 200ms after the last change, one persist — flushed on
// unmount so a layout change racing window close is not lost.
let persistTimer: ReturnType<typeof setTimeout> | undefined
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    uiLayout.persist()
  }, 200)
}

onMounted(() => {
  // Agent → Workbench viewer commands (view.*): one subscription per window.
  useAgentViewStore().start()
  // Boot-time restoration no longer happens here: uiLayout.hydrate, the
  // documents restore and the no-tabs landing-page decision all run in
  // `src/main.ts` BEFORE `app.mount()`, so the first painted frame is already
  // the real layout (doing it post-mount was the largest measured CLS event,
  // 2026-09-04 perf audit). Per-Workspace layout switches remain covered by
  // the uiLayout store's own workspace follower.

  // Persist layout after hydrate settles, so the initial hydrate-driven writes
  // do not immediately re-write the values they just read. The store digests
  // its own persisted-field inventory into one signature — this side names no
  // individual fields, so a new persisted value cannot be forgotten here.
  watch(() => uiLayout.persistSignature, schedulePersist)

  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  if (zoomReadoutTimer) clearTimeout(zoomReadoutTimer)
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
    uiLayout.persist()
  }
})
</script>

<template>
  <div class="app-shell">
    <div class="app-shell__body">
      <SideBar />

      <div ref="pageEl" class="app-shell__page">
        <div
          ref="trackEl"
          class="app-shell__track"
          :class="trackClass"
          :style="trackStyle"
          @transitionend="onTrackTransitionEnd"
        >
          <div
            class="app-shell__page-slot app-shell__slot--workbench"
            :style="{ visibility: workbenchVisible ? 'visible' : 'hidden' }"
          >
            <WorkbenchPage />
          </div>
          <div
            class="app-shell__page-slot app-shell__slot--agent"
            :style="{ visibility: agentVisible ? 'visible' : 'hidden' }"
          >
            <div id="agent-page-host" class="app-shell__agent-host" />
          </div>
        </div>

        <Teleport :to="agentHost" defer>
          <AgentPage />
        </Teleport>
      </div>
    </div>

    <!-- The door handle: the ONE page control, pinned to the edge that faces
         the Agent (right while it is the Workbench's sidebar, left on its own
         full page). -->
    <PageHandle />

    <StatusBar />

    <!--
      One overlay, not an eighth region. It renders into
      the top layer through the native `<dialog>`, so it is a sibling of the
      regions rather than a child of any of them -- a palette nested in a
      ResizableSplit pane would be clipped by that pane's overflow. Esc dismisses it.
    -->
    <CommandPalette />

    <!-- The one renderer for the imperative confirm store (confirm/prompt/
         notice). Teleports to <body> itself; mounted here so every page and
         the stores' injected callbacks share a single queue. -->
    <ConfirmDialogHost />

    <!-- Transient zoom readout: the browser-style "110%" HUD for the
         Ctrl+= / Ctrl+- / Ctrl+0 font-zoom shortcuts. -->
    <Transition name="zoom-readout">
      <div
        v-if="zoomReadoutPct !== null"
        class="zoom-readout"
        role="status"
      >
        {{ t('workbench.settings.appearance.zoomIndicator', { pct: zoomReadoutPct }) }}
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--color-bg-shell);
}

.app-shell__body {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.app-shell__page {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/*
  The two-page track. Both slots stay mounted at exactly the visible area's
  width; sliding moves `transform` only (VISUAL-ROLLOUT-PLAN §1.3 bans
  layout-property transitions). Dragging disables the transition so the track
  follows the pointer 1:1; `prefers-reduced-motion` drops it entirely and the
  SideBar toggle then lands instantly.
*/
.app-shell__track {
  display: flex;
  /* `shrink` must stay 0: a single flex item wider than its container gets
     squeezed back to the container width otherwise, and translateX(-50%)
     would resolve against one page instead of two (measured: exactly half
     the pull distance). */
  flex: 0 0 auto;
  width: 200%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  transition: transform var(--dur-slow) var(--ease-inout);
}

.app-shell__track.is-dragging {
  transition: none;
  will-change: transform;
}

.app-shell__page-slot {
  flex: 0 0 50%;
  width: 50%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
}

.app-shell__agent-host {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

/* Zoom readout pill: centered-bottom, elevated surface, never intercepts
   pointer input — it is feedback, not a control. */
.zoom-readout {
  position: fixed;
  left: 50%;
  bottom: var(--space-6);
  transform: translateX(-50%);
  padding: var(--space-1) var(--space-3);
  border: var(--line-w) solid var(--elev-2-border, var(--line-seam));
  border-radius: var(--radius-lg);
  background: var(--elev-2-bg);
  box-shadow: var(--elev-2);
  color: var(--color-text);
  font-size: var(--text-sm);
  pointer-events: none;
  z-index: var(--z-floating);
}
.zoom-readout-enter-active,
.zoom-readout-leave-active { transition: opacity var(--dur-normal) var(--ease-out); }
.zoom-readout-enter-from,
.zoom-readout-leave-to { opacity: 0; }

@media (prefers-reduced-motion: reduce) {
  .zoom-readout-enter-active,
  .zoom-readout-leave-active { transition: none; }

  /* Toggle clicks land instantly; pulling still works — it is user-driven. */
  .app-shell__track { transition: none; }
}
</style>
