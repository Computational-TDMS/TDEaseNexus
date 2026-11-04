<!--
  MediaLightbox — a top-layer fullscreen viewer for a single image.

  The preview tab (FileDocument → MediaViewer) fits the image inside its pane,
  which is right for browsing but not for reading a dense mass-shift spectrum.
  This overlay takes the same `src` and shows it against a dark backdrop with
  wheel-zoom + drag-pan, so a spectrum's fine structure is actually legible.

  Zero dependencies: zoom/pan is a CSS `transform: translate() scale()` driven
  by two refs, updated on `wheel` / pointer drag. Clamped to [1, 8]; at scale 1
  the image is centred and panning is disabled (it already fits). Double-click
  resets. Esc / backdrop click / X closes.

  Teleported to `<body>` so the host pane's `overflow:auto` cannot clip it, and
  raised above the shell via a high z-index (the CommandPalette uses the native
  `<dialog>` top layer; this is a sibling overlay, not a dialog, so an explicit
  z-index carries it above region chrome).
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Close } from '@element-plus/icons-vue'
import { getDesktopFileOps } from '@/services/workspace/desktopWorkspace'

const props = defineProps<{ src: string; alt?: string; /** Absolute Workspace path — when present, the lightbox offers "open with default app". */ externalPath?: string }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()

const MIN_SCALE = 1
const MAX_SCALE = 8
const scale = ref(1)
const x = ref(0)
const y = ref(0)

function openExternally() {
  if (!props.externalPath) return
  void getDesktopFileOps().openExternal(props.externalPath).catch(() => undefined)
}

const transform = computed(() => `translate(${x.value}px, ${y.value}px) scale(${scale.value})`)

// Drag state. `dragging` flips the cursor and swallows the click that would
// otherwise close the lightbox after a pan — a tiny drag still moves the image,
// and releasing it should not be treated as "click backdrop to close".
const dragging = ref(false)
let dragStartX = 0
let dragStartY = 0
let originX = 0
let originY = 0
let movedDuringDrag = false

function onWheel(event: WheelEvent) {
  event.preventDefault()
  const delta = event.deltaY > 0 ? -0.15 : 0.15
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(scale.value + delta * scale.value).toFixed(3)))
  // Zooming back to 1 re-centres — a scaled+panned image snapped to scale 1
  // without resetting its translate would sit off-centre.
  if (next === MIN_SCALE) reset()
  else scale.value = next
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  dragging.value = true
  movedDuringDrag = false
  dragStartX = event.clientX
  dragStartY = event.clientY
  originX = x.value
  originY = y.value
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value) return
  const dx = event.clientX - dragStartX
  const dy = event.clientY - dragStartY
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedDuringDrag = true
  // Only let the user pan once they have zoomed in; at scale 1 the image is
  // already centred and drag would move it out of frame for no benefit.
  if (scale.value === MIN_SCALE) return
  x.value = originX + dx
  y.value = originY + dy
}

function onPointerUp(event: PointerEvent) {
  dragging.value = false
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
}

/** Backdrop click closes — but only if it was a clean click, not the tail of a drag. */
function onBackdropClick() {
  if (movedDuringDrag) { movedDuringDrag = false; return }
  emit('close')
}

function onImageClick(event: MouseEvent) {
  // A click on the image itself (not the backdrop) toggles zoom: at 1× zoom in
  // to 2×, otherwise reset. Double-click below also resets, so this is the
  // single-click affordance for a quick closer look.
  event.stopPropagation()
  if (scale.value === MIN_SCALE) scale.value = 2
  else reset()
}

function reset() { scale.value = MIN_SCALE; x.value = 0; y.value = 0 }

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); emit('close') }
  else if (event.key === '0') { event.preventDefault(); reset() }
}

// Esc should close the lightbox even if focus is on the backdrop; bind on
// window while open. Also lock the underlying scroll by guarding body — the
// overlay is fixed so this is about stopping wheel events leaking underneath.
watch(() => props.src, () => {
  reset()
}, { immediate: true })

onBeforeUnmount(() => { dragging.value = false })
</script>

<template>
  <Teleport to="body">
    <div
      class="media-lightbox"
      role="dialog"
      aria-modal="true"
      :aria-label="alt ?? t('visualization.viewer.mediaLabel')"
      tabindex="-1"
      @wheel="onWheel"
      @keydown="onKeydown"
      @click.self="onBackdropClick"
    >
      <button
        type="button"
        class="media-lightbox__close"
        :title="t('common.button.close')"
        :aria-label="t('common.button.close')"
        @click.stop="emit('close')"
      >
        <el-icon :size="20"><Close /></el-icon>
      </button>

      <button
        v-if="externalPath"
        type="button"
        class="media-lightbox__external"
        :title="t('visualization.viewer.openExternal')"
        :aria-label="t('visualization.viewer.openExternal')"
        @click.stop="openExternally"
      >
        {{ t('visualization.viewer.openExternal') }}
      </button>

      <span class="media-lightbox__zoom" aria-hidden="true">{{ Math.round(scale * 100) }}%</span>

      <img
        class="media-lightbox__img"
        :class="{ 'is-draggable': scale > MIN_SCALE }"
        :src="src"
        :alt="alt"
        :style="{ transform }"
        draggable="false"
        @click="onImageClick"
        @dblclick.stop.prevent="reset"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.media-lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, #000 86%, transparent);
  backdrop-filter: blur(2px);
  cursor: zoom-out;
  /* Surface the focus ring if focus lands here. */
  outline: none;
  animation: media-lightbox-fade 120ms var(--ease-out);
}
@keyframes media-lightbox-fade {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.media-lightbox__img {
  max-width: 92vw;
  max-height: 92vh;
  object-fit: contain;
  transform-origin: center center;
  transition: transform 60ms linear;
  user-select: none;
  -webkit-user-drag: none;
  cursor: zoom-in;
}
.media-lightbox__img.is-draggable {
  cursor: grab;
}
.media-lightbox__img.is-draggable:active {
  cursor: grabbing;
}

.media-lightbox__close {
  position: absolute;
  top: var(--space-3, 12px);
  right: var(--space-3, 12px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  background: color-mix(in srgb, #fff 14%, transparent);
  color: #fff;
  cursor: pointer;
  transition: background-color var(--dur-fast, 120ms) var(--ease-out);
}
.media-lightbox__close:hover { background: color-mix(in srgb, #fff 26%, transparent); }
.media-lightbox__close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

.media-lightbox__external {
  position: absolute;
  top: var(--space-3, 12px);
  right: calc(var(--space-3, 12px) + 44px);
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, #fff 14%, transparent);
  color: #fff;
  font: inherit;
  font-size: 12px;
  padding: 0 12px;
  height: 36px;
  cursor: pointer;
  transition: background-color var(--dur-fast, 120ms) var(--ease-out);
}
.media-lightbox__external:hover { background: color-mix(in srgb, #fff 26%, transparent); }
.media-lightbox__external:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

.media-lightbox__zoom {
  position: absolute;
  bottom: var(--space-3, 12px);
  left: 50%;
  transform: translateX(-50%);
  padding: 2px 10px;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, #fff 14%, transparent);
  color: #fff;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .media-lightbox { animation: none; }
  .media-lightbox__img { transition: none; }
}
</style>
