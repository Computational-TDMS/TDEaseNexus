/**
 * Page-track state machine — view logic only; `uiLayout.activePage` is the
 * truth and changes only on COMMIT.
 *
 * The two-page track is a sliding door and the page handle is its pull:
 *   • a tap animates the slide (CSS `transform` transition; the state machine
 *     only flips `activePage` — the DOM transition does the animation);
 *   • grabbing the handle drags the whole track 1:1 (transition disabled),
 *     and release past the midpoint — or with a flick — commits to the other
 *     page; anything less springs back;
 *   • while the door is in motion BOTH slots stay painted, so a pulled-away
 *     page never blanks; once settled, the off-screen slot drops to
 *     `visibility: hidden` and costs no paint.
 *
 * `prefers-reduced-motion` removes the CSS transition entirely (AppShell's
 * stylesheet) — a toggle then lands instantly, and the settle fallback timer
 * below is what re-hides the vacated slot.
 */

import { computed, onScopeDispose, ref, watch } from 'vue'
import { useUiLayoutStore, type AppPage } from '@/stores/uiLayout'
import {
  handleNudgeFor,
  initialVelocityState,
  pullProgress,
  settlePull,
  trackVelocity,
  type VelocityState,
} from './pageTrackCore'

/** Settle fallback for reduced-motion / missed transitionend. */
const SETTLE_FALLBACK_MS = 500

export function usePageTrack() {
  const uiLayout = useUiLayoutStore()

  const pageEl = ref<HTMLElement | null>(null)
  const trackEl = ref<HTMLElement | null>(null)

  function setPageEl(el: unknown) {
    pageEl.value = el as HTMLElement | null
  }

  function setTrackEl(el: unknown) {
    trackEl.value = el as HTMLElement | null
  }

  const isAgent = computed(() => uiLayout.activePage === 'agent')
  const activeIndex = computed(() => (isAgent.value ? 1 : 0))

  const dragging = ref(false)
  /** Pull progress toward the other page, px; positive = toward the other page. */
  const dragProgress = ref(0)
  /** True while the slide CSS transition may still be running. */
  const inMotion = ref(false)

  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let startAxis = 0
  let velocityState: VelocityState = initialVelocityState(0, 0)

  function pageWidth(): number {
    const fallback = typeof window === 'undefined' ? 0 : window.innerWidth
    const width = pageEl.value?.offsetWidth || fallback
    return width > 0 ? width : 1
  }

  function clearSettleTimer() {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
  }

  function markMoving() {
    inMotion.value = true
    clearSettleTimer()
    settleTimer = setTimeout(() => { inMotion.value = false }, SETTLE_FALLBACK_MS)
  }

  function commitTo(page: AppPage) {
    dragProgress.value = 0
    uiLayout.setActivePage(page)
  }

  // ANY committed page change animates the slide — the handle's tap, the
  // settings door, the Welcome card — and keeps both slots painted until the
  // transition (or the fallback timer) settles.
  watch(activeIndex, () => markMoving())

  function onHandleClick() {
    if (dragging.value) return
    commitTo(isAgent.value ? 'workbench' : 'agent')
  }

  function onHandlePointerDown(event: PointerEvent) {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    dragging.value = true
    inMotion.value = false
    clearSettleTimer()
    startAxis = event.clientX
    velocityState = initialVelocityState(event.clientX, event.timeStamp)
    dragProgress.value = 0
    const target = event.currentTarget as HTMLElement | null
    target?.setPointerCapture?.(event.pointerId)
  }

  function onHandlePointerMove(event: PointerEvent) {
    if (!dragging.value) return
    const dx = event.clientX - startAxis
    // Workbench pulls the track left (the agent enters from the right edge);
    // agent pulls it right (workbench enters from the left edge).
    dragProgress.value = pullProgress(dx, isAgent.value, pageWidth())
    velocityState = trackVelocity(velocityState, event.clientX, event.timeStamp)
  }

  function onHandlePointerUp(event: PointerEvent) {
    if (!dragging.value) return
    dragging.value = false
    const target = event.currentTarget as HTMLElement | null
    if (target?.hasPointerCapture?.(event.pointerId)) {
      target.releasePointerCapture(event.pointerId)
    }
    const settlement = settlePull({
      progress: dragProgress.value,
      velocity: velocityState.velocity,
      isAgent: isAgent.value,
      pageWidth: pageWidth(),
      activePage: uiLayout.activePage,
    })
    if (settlement.kind === 'commit') {
      commitTo(settlement.page)
    } else {
      // Spring back: zero the progress and let the transition carry it.
      dragProgress.value = 0
      if (settlement.moved) markMoving()
    }
    velocityState = initialVelocityState(velocityState.axis, velocityState.at)
  }

  function onHandlePointerCancel(event: PointerEvent) {
    if (!dragging.value) return
    dragging.value = false
    const target = event.currentTarget as HTMLElement | null
    if (target?.hasPointerCapture?.(event.pointerId)) {
      target.releasePointerCapture(event.pointerId)
    }
    dragProgress.value = 0
    velocityState = initialVelocityState(velocityState.axis, velocityState.at)
  }

  function onTrackTransitionEnd(event: TransitionEvent) {
    if (event.propertyName !== 'transform') return
    inMotion.value = false
    clearSettleTimer()
  }

  /**
   * The track's transform: the settled page offset plus the live pull, in
   * percent of one page slot (each slot is exactly 50% of the 200% track).
   */
  const trackStyle = computed(() => {
    const progressPct = (dragProgress.value / pageWidth()) * 100
    const translate = -(activeIndex.value * 50) + progressPct
    return {
      transform: `translateX(${translate}%)`,
    }
  })

  const trackClass = computed(() => ({
    'is-dragging': dragging.value,
  }))

  /** While the door moves both slots paint; settled, only the active one. */
  const settled = computed(() => !dragging.value && !inMotion.value)
  const workbenchVisible = computed(() => !settled.value || activeIndex.value === 0)
  const agentVisible = computed(() => !settled.value || activeIndex.value === 1)

  /** The handle leans into the pull — a bead of resistance, not a joystick. */
  const handleNudge = computed(() => handleNudgeFor(dragProgress.value, isAgent.value))

  onScopeDispose(clearSettleTimer)

  return {
    isAgent,
    handleNudge,
    dragging,
    trackStyle,
    trackClass,
    workbenchVisible,
    agentVisible,
    onTrackTransitionEnd,
    onHandleClick,
    onHandlePointerDown,
    onHandlePointerMove,
    onHandlePointerUp,
    onHandlePointerCancel,
    setPageEl,
    setTrackEl,
  }
}
