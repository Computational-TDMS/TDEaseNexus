import { describe, expect, it } from 'vitest'
import {
  ARROW_STEP,
  SHIFT_STEP,
  expandTarget,
  sashCursor,
  sashDragCursor,
  sashKeys,
  sashStateOf,
  snapDecision,
  snapDistance,
} from './sash'

describe('sash core', () => {
  it('classifies the size: at a bound, degenerate, or free', () => {
    expect(sashStateOf(240, 240, 420)).toBe('min')
    expect(sashStateOf(420, 240, 420)).toBe('max')
    expect(sashStateOf(320, 240, 420)).toBe('enabled')
    expect(sashStateOf(300, 300, 300)).toBe('disabled')
    expect(sashStateOf(300, 400, 300)).toBe('disabled') // inverted bounds
  })

  it('cursor table: at a bound the cursor names the only live direction', () => {
    // 'min' on a leading pane = grow rightward / downward.
    expect(sashCursor('min', 'first', 'horizontal')).toBe('e-resize')
    expect(sashCursor('min', 'first', 'vertical')).toBe('s-resize')
    // Mirrored for a trailing sized pane.
    expect(sashCursor('min', 'second', 'horizontal')).toBe('w-resize')
    expect(sashCursor('min', 'second', 'vertical')).toBe('n-resize')
    // 'max' is the inverse of 'min'.
    expect(sashCursor('max', 'first', 'horizontal')).toBe('w-resize')
    expect(sashCursor('max', 'first', 'vertical')).toBe('n-resize')
    expect(sashCursor('max', 'second', 'horizontal')).toBe('e-resize')
    expect(sashCursor('max', 'second', 'vertical')).toBe('s-resize')
    // Free: the plain resize cursors; disabled: nothing to grab.
    expect(sashCursor('enabled', 'first', 'horizontal')).toBe('col-resize')
    expect(sashCursor('enabled', 'first', 'vertical')).toBe('row-resize')
    expect(sashCursor('disabled', 'first', 'horizontal')).toBe('default')
  })

  it('drag cursor shows the grow direction from a collapsed edge', () => {
    expect(sashDragCursor('enabled', 'second', 'horizontal', true)).toBe('w-resize')
    expect(sashDragCursor('enabled', 'first', 'vertical', true)).toBe('s-resize')
    // Not collapsed → identical to the resting cursor.
    expect(sashDragCursor('max', 'first', 'horizontal', false)).toBe('w-resize')
  })

  it('snap distance is min/2 with a floor', () => {
    expect(snapDistance(240)).toBe(120)
    expect(snapDistance(20)).toBe(24)
  })

  it('snap decision: past min − min/2 collapses, from collapsed past min/2 expands', () => {
    const base = { collapsible: true, dragStartSize: 320, collapsedSize: 0, min: 240 }
    // Open split: 320 + delta < 240 − 120 → delta < −200.
    expect(snapDecision({ ...base, next: 110 })).toBe('collapse')
    expect(snapDecision({ ...base, next: 130 })).toBeNull()
    // Collapsed at start: 0 + delta > 120 expands.
    const collapsedStart = { ...base, dragStartSize: 0 }
    expect(snapDecision({ ...collapsedStart, next: 130 })).toBe('expand')
    expect(snapDecision({ ...collapsedStart, next: 110 })).toBeNull()
    // Non-collapsible never snaps.
    expect(snapDecision({ ...base, collapsible: false, next: -100 })).toBeNull()
  })

  it('expandTarget prefers the remembered size, then the initial, then a sane floor', () => {
    expect(expandTarget(380, 320, 240, 420)).toBe(380)
    expect(expandTarget(0, 320, 240, 420)).toBe(320)
    // Never-been-open: the clamped minimum, never 0.
    expect(expandTarget(0, 0, 240, 420)).toBe(240)
    // Result always clamps into the bounds.
    expect(expandTarget(9999, 0, 240, 420)).toBe(420)
  })

  it('arrow keys invert with the sized pane, steps double with Shift', () => {
    expect(sashKeys('horizontal', 'first').decrease).toBe('ArrowLeft')
    expect(sashKeys('horizontal', 'second').decrease).toBe('ArrowRight')
    expect(sashKeys('vertical', 'first').decrease).toBe('ArrowUp')
    expect(sashKeys('vertical', 'second').decrease).toBe('ArrowDown')
    expect(sashKeys('vertical', 'second').increase).toBe('ArrowUp')
    expect(ARROW_STEP).toBe(16)
    expect(SHIFT_STEP).toBe(64)
  })
})
