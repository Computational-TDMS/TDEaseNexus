import { describe, expect, it } from 'vitest'
import { createDockMemory } from './dockLayout'

function fakeRepo(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  return {
    read: <T>(_ws: string, key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
  }
}

const SPEC = {
  pxKey: 'dockWidth',
  ratioKey: 'dockWidthRatio',
  range: () => ({ min: 240, max: 420 }),
  defaultPx: 320,
}

describe('dockLayout', () => {
  it('setPx clamps into the range and captures the ratio of a real size', () => {
    const dock = createDockMemory(SPEC)
    dock.setPx(9999, 1000)
    expect(dock.px.value).toBe(420)
    expect(dock.ratio.value).toBeCloseTo(0.42)

    dock.setPx(10, 1000)
    expect(dock.px.value).toBe(240)
  })

  it('never captures a ratio from a collapse artifact (px below the minimum)', () => {
    const dock = createDockMemory(SPEC)
    dock.setPx(380, 1000)
    dock.setPx(0, 1000)
    expect(dock.px.value).toBe(240)
    // The expanded proportion survives the collapse — that is the memory's job.
    expect(dock.ratio.value).toBeCloseTo(0.38)
  })

  it('restore maps a stored ratio onto the current axis, then clamps', () => {
    const dock = createDockMemory(SPEC)
    dock.restore(fakeRepo({ dockWidthRatio: 0.5 }), 'ws', 1024)
    expect(dock.px.value).toBe(420) // 512 clamped to max
    expect(dock.ratio.value).toBeCloseTo(0.5)
  })

  it('restore ignores an invalid ratio, restores the ref as 0, and falls back to legacy px', () => {
    const dock = createDockMemory(SPEC)
    dock.restore(fakeRepo({ dockWidthRatio: 4.2, dockWidth: 380 }), 'ws', 1024)
    expect(dock.px.value).toBe(380)
    expect(dock.ratio.value).toBe(0)
  })

  it('restore without any stored size falls back to the default', () => {
    const dock = createDockMemory(SPEC)
    dock.restore(fakeRepo({}), 'ws', 0)
    expect(dock.px.value).toBe(320)
    expect(dock.ratio.value).toBe(0)
  })

  it('entries() carries exactly the px and ratio keys for a persist pass', () => {
    const dock = createDockMemory(SPEC)
    dock.setPx(300, 1000)
    expect(dock.entries()).toEqual([['dockWidth', 300], ['dockWidthRatio', 0.3]])
  })

  it('reproject re-derives the px from the proportion when the axis changes', () => {
    const dock = createDockMemory(SPEC)
    dock.setPx(400, 1000)
    dock.reproject(750)
    expect(dock.px.value).toBe(300)
    // A resize moves the projection; it never re-learns the layout.
    expect(dock.ratio.value).toBeCloseTo(0.4)

    // A widened axis grows the dock back up to its range ceiling.
    dock.reproject(4000)
    expect(dock.px.value).toBe(420)
    expect(dock.ratio.value).toBeCloseTo(0.4)
  })

  it('reproject gives way to a range the container tightened', () => {
    let max = 420
    const dock = createDockMemory({ ...SPEC, range: () => ({ min: 240, max }) })
    dock.setPx(420, 0)
    expect(dock.px.value).toBe(420)

    max = 240
    dock.reproject(0)
    expect(dock.px.value).toBe(240)
  })
})
