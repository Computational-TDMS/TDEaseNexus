/**
 * pageTrackCore — the pure decisions of the sliding-door page track,
 * separated from the DOM/pointer machinery in `usePageTrack`.
 *
 * Sign conventions (do not "fix" them, they ARE the interface — extracted
 * verbatim from the composable):
 *   • `progress` is signed toward the OTHER page (positive = pulled toward
 *     the page that is not `activePage`);
 *   • `velocity` is the RAW pointer-axis velocity (clientX ms deltas), and a
 *     flick counts only when its sign matches the pull direction of the
 *     track under the current page.
 *
 * Tests here are the only place these decisions are exercised without a
 * mounted shell.
 */

import type { AppPage } from '@/stores/uiLayout'

/** px/ms along the pull axis that counts as a flick. */
export const FLICK_VELOCITY = 0.5
/** Small dead zone so a resting finger's jitter never reads as a flick. */
export const FLICK_MIN_TRAVEL = 24
/** The handle leans into the pull, clamped to this many px. */
export const HANDLE_NUDGE_MAX = 6

/** The live pull toward the other page, clamped to ± one page width. */
export function pullProgress(rawDx: number, isAgent: boolean, pageWidth: number): number {
  const signed = isAgent ? rawDx : -rawDx
  return Math.max(-pageWidth, Math.min(pageWidth, signed))
}

export interface VelocityState {
  axis: number
  at: number
  velocity: number
}

export function initialVelocityState(x: number, at: number): VelocityState {
  return { axis: x, at, velocity: 0 }
}

/** Raw-axis velocity, ignoring duplicate timestamps (dt ≤ 0 keeps the last). */
export function trackVelocity(prev: VelocityState, x: number, at: number): VelocityState {
  const dt = at - prev.at
  if (dt > 0) return { axis: x, at, velocity: (x - prev.axis) / dt }
  return prev
}

export type PullSettlement =
  | { kind: 'commit'; page: AppPage }
  | { kind: 'spring'; moved: boolean }

/**
 * What a released pull means: commit to a page (past the midpoint, or a
 * genuine flick), or spring back. `moved` distinguishes a real pull-back
 * (worth animating) from a tap-like release (not).
 */
export function settlePull(args: {
  progress: number
  velocity: number
  isAgent: boolean
  pageWidth: number
  activePage: AppPage
}): PullSettlement {
  const pullSign = args.isAgent ? -1 : 1
  // A flick commits when it is quick, directed at the other page, and past
  // the jitter dead zone.
  const flick = Math.abs(args.velocity) > FLICK_VELOCITY
    && Math.abs(args.progress) > FLICK_MIN_TRAVEL
    && Math.sign(args.velocity) === pullSign
  if (Math.abs(args.progress) > args.pageWidth / 2 || flick) {
    const page = pullSign * args.progress > 0
      ? (args.isAgent ? 'workbench' : 'agent')
      : args.activePage
    return { kind: 'commit', page }
  }
  return { kind: 'spring', moved: Math.abs(args.progress) > 1 }
}

/** The handle leans into the pull — a bead of resistance, not a joystick. */
export function handleNudgeFor(progress: number, isAgent: boolean): number {
  // progress is signed toward the destination page, which flips with the
  // active page; the on-screen nudge follows the raw pointer direction.
  const screenSigned = isAgent ? progress : -progress
  const clamped = Math.max(-HANDLE_NUDGE_MAX, Math.min(HANDLE_NUDGE_MAX, screenSigned * 0.15))
  return Math.round(clamped * 10) / 10
}
