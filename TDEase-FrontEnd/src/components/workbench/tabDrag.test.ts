import { describe, expect, it } from 'vitest'
import {
  clearTabDrag,
  currentTabDrag,
  dropZoneOf,
  indicatorStyleFor,
  isCopyDrop,
  isMergeDrop,
  setTabDrag,
  TAB_DRAG_TYPE,
} from './tabDrag'

// A 300×200 body region at page origin: the 10% ring is 30px wide / 20px tall,
// the horizontal thirds sit at 100 / 200.
const RECT = { left: 0, top: 0, width: 300, height: 200 }

function zoneAt(x: number, y: number) {
  return dropZoneOf(x, y, RECT)
}

describe('tab drag gesture controller', () => {
  it('the inner 80% is one MERGE target', () => {
    expect(zoneAt(150, 100)).toBe('center')
    expect(zoneAt(40, 25)).toBe('center') // just outside the ring
    expect(zoneAt(260, 175)).toBe('center')
  })

  it('the outer ring offers splits, direction by the preferred-axis thirds', () => {
    // Left/right thirds cover the full height of the ring columns.
    expect(zoneAt(20, 100)).toBe('left')
    expect(zoneAt(20, 5)).toBe('left') // ring corner still resolves left first
    expect(zoneAt(280, 100)).toBe('right')
    // Middle column: the vertical edge bands split up/down.
    expect(zoneAt(150, 10)).toBe('up')
    expect(zoneAt(150, 190)).toBe('down')
  })

  it('degenerate rects merge everywhere', () => {
    expect(dropZoneOf(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toBe('center')
  })

  it('indicator geometry: directional drops show a half cell, merge shows full', () => {
    expect(indicatorStyleFor('left')).toEqual({ top: '0', left: '0', width: '50%', height: '100%' })
    expect(indicatorStyleFor('down')).toEqual({ top: '50%', left: '0', width: '100%', height: '50%' })
    expect(indicatorStyleFor('center')).toEqual({ top: '0', left: '0', width: '100%', height: '100%' })
  })

  it('modifier semantics: Ctrl copies, Alt merges (Shift on mac)', () => {
    const win = { ctrlKey: false, altKey: false, shiftKey: false } as DragEvent
    expect(isCopyDrop(win)).toBe(false)
    expect(isCopyDrop({ ...win, ctrlKey: true } as DragEvent)).toBe(true)
    expect(isMergeDrop(win)).toBe(false)
    expect(isMergeDrop({ ...win, altKey: true } as DragEvent)).toBe(true)
  })

  it('the payload singleton carries the drag from start to drop', () => {
    expect(currentTabDrag()).toBeNull()
    setTabDrag({ tabId: 'doc-1', fromGroupId: 'group-1' })
    expect(currentTabDrag()).toEqual({ tabId: 'doc-1', fromGroupId: 'group-1' })
    expect(TAB_DRAG_TYPE).toBe('application/x-tdease-tab')
    clearTabDrag()
    expect(currentTabDrag()).toBeNull()
  })
})
