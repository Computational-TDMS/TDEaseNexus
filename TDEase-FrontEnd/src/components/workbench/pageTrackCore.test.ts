import { describe, expect, it } from 'vitest'
import {
  FLICK_MIN_TRAVEL,
  HANDLE_NUDGE_MAX,
  handleNudgeFor,
  initialVelocityState,
  pullProgress,
  settlePull,
  trackVelocity,
} from './pageTrackCore'

// These cases PIN the extracted decisions byte-for-byte. Where an expectation
// looks surprising, that is the point: the pinned behavior is what ships
// today — a deliberate change needs its own decision (see findings.md).
describe('pageTrackCore', () => {
  it('pullProgress signs toward the other page and clamps to ± page width', () => {
    // Workbench: pulling left (negative dx) is toward the agent.
    expect(pullProgress(-100, false, 1000)).toBe(100)
    // Agent: pulling right (positive dx) is toward the workbench.
    expect(pullProgress(100, true, 1000)).toBe(100)
    // Overshoot clamps to the page width.
    expect(pullProgress(-5000, false, 1000)).toBe(1000)
  })

  it('velocity tracking ignores duplicate timestamps', () => {
    const start = initialVelocityState(0, 100)
    expect(trackVelocity(start, 50, 100)).toBe(start) // dt 0 → keep previous
    const next = trackVelocity(start, 50, 150)
    expect(next.velocity).toBeCloseTo(1) // 50px / 50ms
    expect(trackVelocity(next, 60, 160).velocity).toBeCloseTo(1)
  })

  it('settlePull commits past the midpoint toward the pulled page (workbench side)', () => {
    // From workbench, pulled 600px of a 1000px page toward the agent.
    expect(settlePull({ progress: 600, velocity: 0, isAgent: false, pageWidth: 1000, activePage: 'workbench' }))
      .toEqual({ kind: 'commit', page: 'agent' })
    // Short of the midpoint springs back (and animates: real travel).
    expect(settlePull({ progress: 400, velocity: 0, isAgent: false, pageWidth: 1000, activePage: 'workbench' }))
      .toEqual({ kind: 'spring', moved: true })
  })

  it('PINNED (suspicious): from agent, a midpoint pull toward workbench re-commits agent', () => {
    // pullSign flips to −1 on the agent page, so `pullSign * progress > 0`
    // selects the ACTIVE page here. The workbench side commits the OTHER
    // page; this side re-commits the current one. Flagged in findings.md —
    // pinned as-is until someone verifies the drag-close gesture by hand.
    expect(settlePull({ progress: 600, velocity: 0, isAgent: true, pageWidth: 1000, activePage: 'agent' }))
      .toEqual({ kind: 'commit', page: 'agent' })
  })

  it('flick: commits when the RAW velocity sign matches the pull sign', () => {
    // Workbench pull sign is +1: a rightward-ending flick commits.
    expect(settlePull({ progress: 200, velocity: 1, isAgent: false, pageWidth: 1000, activePage: 'workbench' }))
      .toEqual({ kind: 'commit', page: 'agent' })
    // Leftward-ending (sign −1) is not a flick from workbench.
    expect(settlePull({ progress: 200, velocity: -1, isAgent: false, pageWidth: 1000, activePage: 'workbench' }))
      .toEqual({ kind: 'spring', moved: true })
    // Under the travel dead zone, speed alone is not a flick.
    expect(settlePull({ progress: FLICK_MIN_TRAVEL - 1, velocity: 9, isAgent: false, pageWidth: 1000, activePage: 'workbench' }))
      .toEqual({ kind: 'spring', moved: true })
  })

  it('a tap-like release (≤1px) springs back without animating', () => {
    expect(settlePull({ progress: 0.5, velocity: 0, isAgent: false, pageWidth: 1000, activePage: 'workbench' }))
      .toEqual({ kind: 'spring', moved: false })
  })

  it('handleNudge leans into the raw pull direction, clamped and rounded', () => {
    // Workbench progress>0 = the pointer moved LEFT, so the nudge is negative.
    expect(handleNudgeFor(40, false)).toBe(-HANDLE_NUDGE_MAX)
    expect(handleNudgeFor(-40, false)).toBe(HANDLE_NUDGE_MAX)
    expect(handleNudgeFor(10, false)).toBe(-1.5)
    expect(handleNudgeFor(10, true)).toBeCloseTo(1.5)
    expect(handleNudgeFor(3, false)).toBe(-0.4) // 0.4499… rounds to 0.1px
  })
})
