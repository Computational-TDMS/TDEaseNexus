<!--
  Written rather than installed: every split library available fails the
  keyboard requirement in PRODUCT.md, and wrapping one to fix that would be
  larger than writing this. ~separator role, full keyboard map, coalesced
  pointer drag.

  This component renders a projection of `size` and dispatches `update:size`
  (plus `update:collapsed` for snap transitions). It holds no truth beyond its
  own drag/collapse bookkeeping; durable layout state belongs to the parents'
  stores. A drag is reactive-silent: geometry flows live through the
  --resizable-split-live-size variable on the root, and `update:size` fires
  exactly once on release.

  The sash mechanics follow VS Code's Sash/SplitView pair, not just its look:
    • SashState (disabled/min/max/enabled) drives BOTH the dim feedback and
      the cursor — at a bound the cursor names the only direction left
      (e-resize means "the sized pane can still grow rightward").
    • A drag holds a global lock: a document-level `* { cursor: … !important`
      stylesheet (rewritten live when the state changes) plus
      `pointer-events: none` on every iframe, both released on drop — so the
      cursor cannot flicker when the pointer slips off the handle.
    • A collapsible split SNAPS: dragging past `min − min/2` collapses (and
      past `min/2` from the collapsed edge re-expands), VS Code's snap rule.
    • Alt drags at half rate — a binary split has one degree of freedom, so
      VS Code's n-ary symmetric redistribution degenerates to a fine-adjust
      rate (recorded divergence).
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useElementSize, useEventListener } from '@vueuse/core'
import {
  ARROW_STEP,
  SHIFT_STEP,
  expandTarget as expandTargetFor,
  sashCursor,
  sashDragCursor,
  sashKeys,
  sashStateOf,
  snapDecision,
  type SashState,
} from './sash'

type SizeBound = number | ((containerSize: number) => number)

const props = withDefaults(defineProps<{
  direction: 'horizontal' | 'vertical'
  /** px of the first pane — v-model:size */
  size: number
  min: SizeBound
  max: SizeBound
  /** px the first pane collapses to. Default 0. */
  collapsedSize?: number
  collapsible?: boolean
  /** Parent-controlled collapse, independent of which pane is the sized one.
   * A trailing-pane collapse keeps the first pane at the full container (the
   * parent widens min/max to allow it) while the split renders — and skips
   * re-clamping — in its collapsed state. */
  collapsed?: boolean
  /** Which pane carries `size`. 'first' (default) sizes the leading pane;
   * 'second' sizes the trailing pane — the right-docked host / right panel
   * case, where the drag delta and the arrow keys invert. */
  sizedPane?: 'first' | 'second'
  ariaLabel?: string
}>(), {
  collapsedSize: 0,
  collapsible: false,
  collapsed: false,
  sizedPane: 'first',
  ariaLabel: 'Resize panel',
})

const emit = defineEmits<{
  'update:size': [value: number]
  /** Snap/toggle collapse transitions, for parents whose collapsed state is
   * a separate flag (the docks pass `collapsed` + `size` 0 together). */
  'update:collapsed': [value: boolean]
}>()

const rootEl = ref<HTMLElement | null>(null)
const handleEl = ref<HTMLElement | null>(null)
const isDragging = ref(false)

const { width: containerWidth, height: containerHeight } = useElementSize(rootEl)
const containerSize = computed(() => (props.direction === 'horizontal' ? containerWidth.value : containerHeight.value))

function resolveBound(bound: SizeBound): number {
  return typeof bound === 'function' ? bound(containerSize.value) : bound
}

const resolvedMin = computed(() => resolveBound(props.min))
const resolvedMax = computed(() => {
  const hi = resolveBound(props.max)
  const lo = resolvedMin.value
  return hi < lo ? lo : hi
})

// Remembers the last non-collapsed size so collapse/expand round-trips.
// Derived from the incoming size prop, never owned independently of it —
// this component has exactly one source of truth: `props.size`.
const initialSize = props.size
let lastExpandedSize = props.size > props.collapsedSize ? props.size : Math.max(resolvedMin.value, initialSize)

const isCollapsed = computed(() => props.collapsed || Math.round(props.size) <= Math.round(props.collapsedSize))

watch(() => props.size, (next) => {
  if (Math.round(next) > Math.round(props.collapsedSize)) {
    lastExpandedSize = next
  }
})

// Re-clamp on every path, not just this component's own keyboard/drag/collapse
// handlers: the `size` prop can also be driven directly by a parent, and
// `min`/`max` are frequently container-size functions (see AppShell.vue)
// that can shrink out from under the current size on a container resize
// with no interaction at all. Whenever the clamped value differs from the
// incoming prop, emit the corrected value so the parent's source of truth
// is never left out of bounds — mirrors commit()'s round-comparison guard
// to avoid an emit loop.
//
// `useElementSize` starts both dimensions at 0 until the first real
// measurement (a ResizeObserver callback that lands during this
// component's own onMounted, strictly after this immediate watch's first,
// synchronous run during setup). Before that first measurement, a
// function-derived bound resolves against a bogus 0px container — clamping
// against that would emit a spurious corrective size (e.g. 0) into the
// parent on every single mount. Literal numeric bounds carry no such
// ambiguity and are corrected immediately regardless of container size.
const boundsNeedContainer = computed(() => typeof props.min === 'function' || typeof props.max === 'function')

watch([() => props.size, resolvedMin, resolvedMax], () => {
  // A collapsed split is deliberately outside [resolvedMin, resolvedMax] —
  // `collapsedSize` (default 0) is not meant to satisfy the normal bounds,
  // so skip the correction in that state or every collapse would be
  // immediately re-clamped back open.
  if (isCollapsed.value) return
  if (boundsNeedContainer.value && containerSize.value === 0) return
  const clamped = clamp(props.size)
  if (Math.round(clamped) !== Math.round(props.size)) {
    emit('update:size', clamped)
  }
}, { immediate: true })

function clamp(value: number): number {
  return Math.min(Math.max(value, resolvedMin.value), resolvedMax.value)
}

function commit(value: number) {
  const clamped = clamp(value)
  if (Math.round(clamped) !== Math.round(props.size)) {
    emit('update:size', clamped)
  }
}

function toggleCollapse() {
  if (isCollapsed.value) {
    emit('update:size', expandTargetFor(lastExpandedSize, initialSize, resolvedMin.value, resolvedMax.value))
    emit('update:collapsed', false)
  } else {
    lastExpandedSize = props.size
    emit('update:size', props.collapsedSize)
    emit('update:collapsed', true)
  }
}

function resetToInitial() {
  commit(initialSize)
}

function onKeydown(event: KeyboardEvent) {
  const step = event.shiftKey ? SHIFT_STEP : ARROW_STEP
  const { decrease: decreaseKey, increase: increaseKey } = sashKeys(props.direction, props.sizedPane)

  switch (event.key) {
    case decreaseKey:
      event.preventDefault()
      commit(props.size - step)
      break
    case increaseKey:
      event.preventDefault()
      commit(props.size + step)
      break
    case 'Home':
      event.preventDefault()
      commit(resolvedMin.value)
      break
    case 'End':
      event.preventDefault()
      commit(resolvedMax.value)
      break
    case 'Enter':
      if (props.collapsible) {
        event.preventDefault()
        toggleCollapse()
      }
      break
    default:
      break
  }
}

function onDoubleClick() {
  resetToInitial()
}

// ── Sash state (VS Code's SashState, computed for a two-pane split) ─────────
// 'min'/'max' = the sized pane sits at that bound and can only move the other
// way, which is what the cursor then says; 'disabled' = degenerate bounds
// (nothing can move). Collapsed renders no state — the bar is invisible.

// Render the clamped value, not the raw prop: on a container resize (or
// any direct programmatic write) `props.size` can be transiently out of
// [resolvedMin, resolvedMax] for a frame before the watcher above emits a
// correction. The rendered pane and the reported aria-valuenow must never
// show an out-of-bounds number even for that one frame.
const clampedSize = computed(() => {
  if (isCollapsed.value) return props.size
  // Same pre-measurement guard as the watch above: don't render a collapse
  // to a bogus 0px for a container-derived bound before the first real
  // measurement lands.
  if (boundsNeedContainer.value && containerSize.value === 0) return props.size
  return clamp(props.size)
})

/**
 * Sash state, VS Code's SashState reduced to the two bounds that matter: at
 * the minimum or maximum the adjacent pane can no longer grow in the dragged
 * direction, so the bar dims (the drag still clamps — the state is feedback,
 * not a lock).
 */
const sashState = computed<SashState | null>(() => {
  if (isCollapsed.value) return null
  if (boundsNeedContainer.value && containerSize.value === 0) return null
  return sashStateOf(clampedSize.value, resolvedMin.value, resolvedMax.value)
})

// Cursor semantics live in ./sash (one mapping table, tested there).
const stateCursor = computed(() =>
  sashCursor(sashState.value ?? 'enabled', props.sizedPane, props.direction))

const dragCursor = computed(() => {
  if (isCollapsed.value) return sashDragCursor('min', props.sizedPane, props.direction, true)
  return sashCursor(sashState.value ?? 'enabled', props.sizedPane, props.direction)
})

// ── Global drag lock (VS Code's onPointerStart) ─────────────────────────────
// A document-wide `* { cursor }` stylesheet + pointer-events disabled on
// iframes, both while a drag is live. The stylesheet is rewritten when the
// cursor changes mid-drag (the sash can cross a bound), removed on release.
let dragStyleEl: HTMLStyleElement | null = null
let lockedFrames: HTMLElement[] = []

function writeDragStyle() {
  if (!dragStyleEl) return
  dragStyleEl.textContent
    = `* { cursor: ${dragCursor.value} !important; }\n.sash-pointer-lock { pointer-events: none !important; }`
}

function lockPointerInput() {
  dragStyleEl = document.createElement('style')
  writeDragStyle()
  document.head.appendChild(dragStyleEl)
  lockedFrames = [...document.querySelectorAll<HTMLElement>('iframe')]
  for (const frame of lockedFrames) {
    frame.classList.add('sash-pointer-lock')
  }
}

function unlockPointerInput() {
  dragStyleEl?.remove()
  dragStyleEl = null
  for (const frame of lockedFrames) {
    frame.classList.remove('sash-pointer-lock')
  }
  lockedFrames = []
}

watch(dragCursor, () => writeDragStyle())

// --- Pointer drag: live geometry via a CSS variable, one commit on release. ---
// VS Code's WorkspaceShellLayout sash rule: a drag must not push reactive
// updates through the tree per frame (with a virtualized transcript mounted
// that is thousands of nodes). pointermove only clamps the next size and
// writes --resizable-split-live-size on the root; the sized pane's inline
// style consumes that variable with the committed size as fallback, so the
// dragged pane tracks the pointer while every other store consumer stays
// frozen. pointerup commits the final value exactly once — which also closes
// the old RAF window where a same-frame release silently dropped the last
// pending delta.
let dragStartPos = 0
let dragStartSize = 0
let pendingSize: number | null = null

const LIVE_SIZE_VAR = '--resizable-split-live-size'

function writeLiveSize(value: number) {
  rootEl.value?.style.setProperty(LIVE_SIZE_VAR, `${Math.round(clamp(value))}px`)
}

function clearLiveSize() {
  rootEl.value?.style.removeProperty(LIVE_SIZE_VAR)
}

/** Collapse/expand mid-drag, then REBASE the drag onto the new state so the
 *  gesture continues seamlessly (VS Code re-runs resize without snap).
 *  Emits directly, not through commit(): the collapse target sits outside
 *  [resolvedMin, resolvedMax] by design — commit's clamp would refuse it
 *  (the same reason toggleCollapse bypasses commit). The live variable is
 *  dropped so the pane follows the emitted state until the next move. */
function snapTo(size: number, collapsed: boolean, pos: number) {
  clearLiveSize()
  emit('update:size', size)
  emit('update:collapsed', collapsed)
  dragStartSize = size
  dragStartPos = pos
  pendingSize = null
}

function onPointerDown(event: PointerEvent) {
  isDragging.value = true
  dragStartPos = props.direction === 'horizontal' ? event.clientX : event.clientY
  dragStartSize = props.size
  const target = event.currentTarget as HTMLElement | null
  target?.setPointerCapture?.(event.pointerId)
  lockPointerInput()
}

function endDrag(event: PointerEvent) {
  if (!isDragging.value) return
  isDragging.value = false
  if (pendingSize != null) {
    const final = pendingSize
    pendingSize = null
    commit(final)
  }
  clearLiveSize()
  const target = event.currentTarget as HTMLElement | null
  if (target?.hasPointerCapture?.(event.pointerId)) {
    target.releasePointerCapture(event.pointerId)
  }
  unlockPointerInput()
}

useEventListener(handleEl, 'pointermove', (event: PointerEvent) => {
  if (!isDragging.value) return
  const pos = props.direction === 'horizontal' ? event.clientX : event.clientY
  // Alt = half-rate fine adjust; a trailing ('second') sized pane inverts.
  const rate = event.altKey ? 0.5 : 1
  const dir = props.sizedPane === 'second' ? -1 : 1
  const next = dragStartSize + (pos - dragStartPos) * rate * dir

  const snap = snapDecision({
    collapsible: props.collapsible,
    dragStartSize,
    collapsedSize: props.collapsedSize,
    next,
    min: resolvedMin.value,
  })
  if (snap === 'collapse') {
    snapTo(props.collapsedSize, true, pos)
    return
  }
  if (snap === 'expand') {
    snapTo(expandTargetFor(lastExpandedSize, initialSize, resolvedMin.value, resolvedMax.value), false, pos)
    return
  }

  pendingSize = next
  writeLiveSize(next)
})

useEventListener(handleEl, 'pointerup', endDrag)
useEventListener(handleEl, 'pointercancel', endDrag)
// A window blur (alt-tab, OS overlay) can swallow the pointerup: release the
// drag anyway — committing the pending value so the size lands where the
// pointer left it — rather than leave a stuck `* { cursor }` stylesheet.
useEventListener(window, 'blur', () => {
  if (isDragging.value) {
    isDragging.value = false
    if (pendingSize != null) {
      const final = pendingSize
      pendingSize = null
      commit(final)
    }
    clearLiveSize()
    unlockPointerInput()
  }
})

const sizedPaneStyle = computed(() => {
  const sizePx = `${Math.round(clampedSize.value)}px`
  const size = `var(${LIVE_SIZE_VAR}, ${sizePx})`
  return props.direction === 'horizontal'
    ? { width: size, height: '100%' }
    : { width: '100%', height: size }
})

onBeforeUnmount(() => {
  unlockPointerInput()
})

defineExpose({ toggleCollapse, resetToInitial })
</script>

<template>
  <div
    ref="rootEl"
    class="resizable-split"
    :class="[`resizable-split--${direction}`, { 'is-dragging': isDragging, 'is-collapsed': isCollapsed }]"
    :data-sized-pane="sizedPane"
  >
    <div
      class="resizable-split__pane resizable-split__pane--first"
      :class="sizedPane === 'second' ? 'is-unsized' : 'is-sized'"
      :style="sizedPane === 'first' ? sizedPaneStyle : undefined"
    >
      <slot name="first" />
    </div>
    <div
      ref="handleEl"
      class="resizable-split__handle"
      role="separator"
      :aria-orientation="direction"
      :aria-valuenow="Math.round(clampedSize)"
      :aria-valuemin="Math.round(resolvedMin)"
      :aria-valuemax="Math.round(resolvedMax)"
      :data-sash-state="!sashState || sashState === 'enabled' ? undefined : sashState"
      :style="{ cursor: stateCursor }"
      :aria-label="ariaLabel"
      tabindex="0"
      @keydown="onKeydown"
      @dblclick="onDoubleClick"
      @pointerdown="onPointerDown"
    >
      <span class="resizable-split__handle-bar" aria-hidden="true" />
    </div>
    <div
      class="resizable-split__pane resizable-split__pane--second"
      :class="sizedPane === 'first' ? 'is-unsized' : 'is-sized'"
      :style="sizedPane === 'second' ? sizedPaneStyle : undefined"
    >
      <slot name="second" />
    </div>
  </div>
</template>

<style scoped>
.resizable-split {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.resizable-split--horizontal {
  flex-direction: row;
}

.resizable-split--vertical {
  flex-direction: column;
}

.resizable-split__pane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  transition: none;
}

/*
  Collapse/expand and keyboard steps switch size instantly. The previous
  width/height transition here was a layout-property animation (banned by
  VISUAL-ROLLOUT-PLAN §1.3); `transform` can't express a pane resize without
  distorting contents, so the compliant choice is no animation. Dragging was
  never affected — it writes size directly with no transition.
*/

/*
   Two complete sizing strategies — a flex item with an inline width/height
   still GROWS unless flex-grow is 0, so "sized" must opt out of flex entirely.
   Without this, a collapsed pane (size = 0px) with the base `flex: 1 1 auto`
   absorbed the free space back and blanked the app (observed 2026-09-10).
   The pane that does NOT carry `size` fills the rest of the container. */
.resizable-split__pane.is-sized {
  flex: 0 0 auto;
}

.resizable-split__pane.is-unsized {
  flex: 1 1 auto;
}

.resizable-split__handle {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  z-index: var(--z-elevated);
}

/* The cursor is style-bound from stateCursor (one mapping table, in the
   script); CSS carries only geometry and the interaction gate below. */

.resizable-split--horizontal .resizable-split__handle {
  width: 10px;
  margin-left: -5px;
  margin-right: -5px;
}

.resizable-split--vertical .resizable-split__handle {
  height: 10px;
  margin-top: -5px;
  margin-bottom: -5px;
}

/* Degenerate bounds: nothing can move (VS Code's Disabled sash). */
.resizable-split__handle[data-sash-state='disabled'] {
  pointer-events: none;
}

.resizable-split__handle-bar {
  background: var(--color-border);
  border-radius: 2px;
  transition: background-color var(--dur-fast) var(--ease-out);
}

.resizable-split--horizontal .resizable-split__handle-bar {
  width: 4px;
  height: 100%;
}

.resizable-split--vertical .resizable-split__handle-bar {
  width: 100%;
  height: 4px;
}

.resizable-split__handle:hover .resizable-split__handle-bar {
  background: var(--line-seam);
}

.resizable-split.is-dragging .resizable-split__handle-bar {
  background: var(--color-primary);
}

/* A collapsed split owns zero layout space and shows zero residue — but a
   snapped dock must stay findable: hover reveals a hairline grab edge. */
.resizable-split.is-collapsed .resizable-split__handle-bar {
  background: transparent;
}

.resizable-split.is-collapsed .resizable-split__handle:hover .resizable-split__handle-bar {
  background: var(--line-seam);
}

/* Sash state feedback: at a bound the bar dims — that direction is spent. */
.resizable-split__handle[data-sash-state] .resizable-split__handle-bar {
  opacity: 0.35;
}

.resizable-split__handle:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.resizable-split__handle:focus-visible .resizable-split__handle-bar {
  background: var(--color-primary);
}
</style>
