<!--
  PageHandle — the sliding door's pull, pinned to the window edge.

  The handle FOLLOWS the Agent window: while the Agent lives as the
  Workbench's right-docked sidebar, the handle hangs on the RIGHT edge (pull
  left to bring the Agent page over); on the full Agent page it hangs on the
  LEFT edge (pull right to bring the Workbench back). One tall slim bar with
  the destination glyph set into it — a tap slides the track, grabbing it
  drags 1:1 (release past midpoint or with a flick commits; otherwise it
  springs back). The gesture state machine is `usePageTrack`.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Grid, ChatDotRound } from '@element-plus/icons-vue'
import { usePageTrack } from './usePageTrack'

const { t } = useI18n()

const {
  isAgent, handleNudge, dragging,
  onHandleClick, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp, onHandlePointerCancel,
} = usePageTrack()
</script>

<template>
  <button
    type="button"
    class="page-handle"
    :class="[isAgent ? 'page-handle--left' : 'page-handle--right', { 'is-pulling': dragging }]"
    :style="{ transform: `translateX(${handleNudge}px)` }"
    :title="isAgent ? t('workbench.rail.workbench') : t('workbench.rail.agent')"
    :aria-label="isAgent ? t('workbench.rail.workbench') : t('workbench.rail.agent')"
    @click="onHandleClick"
    @pointerdown="onHandlePointerDown"
    @pointermove="onHandlePointerMove"
    @pointerup="onHandlePointerUp"
    @pointercancel="onHandlePointerCancel"
  >
    <span class="page-handle__bar" aria-hidden="true" />
    <span class="page-handle__glyph" aria-hidden="true">
      <el-icon :size="15">
        <Grid v-if="isAgent" />
        <ChatDotRound v-else />
      </el-icon>
    </span>
  </button>
</template>

<style scoped>
/*
  The pull: one tall slim bar at the window's edge, vertically centered — the
  same "draggable structural seam" register as the split handles, stretched to
  door-handle height. It leans into the pull (the inline transform from
  usePageTrack) and springs back through its transform transition. Frameless
  Electron: it must be a no-drag region or the rail drag region behind it eats
  the pointer.
*/
.page-handle {
  position: fixed;
  top: 50%;
  margin-top: -66px;
  z-index: var(--z-handle);
  width: 28px;
  height: 132px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  cursor: col-resize;
  border-radius: 999px;
  touch-action: none;
  user-select: none;
  -webkit-app-region: no-drag;
  transition:
    transform var(--dur-fast) var(--ease-out),
    background-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.page-handle--right { right: 0; }
.page-handle--left { left: 0; }

.page-handle.is-pulling {
  transition: none; /* the nudge must track the pointer, not lag behind it */
}

/* Hover announces the grab: a surface pill lifts the whole handle off the
   window edge, the bar thickens under the cursor, the bead grows — three
   cues, one message: this pulls the pages apart. */
.page-handle:hover {
  background: var(--color-bg-tertiary);
  box-shadow: var(--shadow-sm);
}

.page-handle__bar {
  position: absolute;
  width: 4px;
  height: 100%;
  border-radius: 2px;
  background: var(--color-border);
  transition:
    background-color var(--dur-fast) var(--ease-out),
    width var(--dur-fast) var(--ease-out);
}

.page-handle:hover .page-handle__bar {
  width: 6px;
  background: var(--line-seam);
}

.page-handle.is-pulling .page-handle__bar {
  background: var(--color-primary);
}

.page-handle:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

/* The glyph sits on the bar like a bead: the chip masks the bar behind it in
   the surface color. */
.page-handle__glyph {
  position: relative;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  transition:
    color var(--dur-instant) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.page-handle:hover .page-handle__glyph {
  color: var(--color-text);
  transform: scale(1.08);
}

@media (prefers-reduced-motion: reduce) {
  .page-handle,
  .page-handle__bar,
  .page-handle__glyph { transition: none; }
}
</style>
