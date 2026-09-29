import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalUiStateRepository } from './uiStateRepository'

const { warningLog } = vi.hoisted(() => ({ warningLog: vi.fn() }))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: warningLog }),
}))

// A minimal in-memory Storage implementation so tests don't depend on
// jsdom's localStorage quirks, and so we can force a throwing setItem to
// simulate a quota / serialisation failure.
class FakeStorage implements Storage {
  private store = new Map<string, string>()
  public failNextSetItem = false

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    if (this.failNextSetItem) {
      this.failNextSetItem = false
      throw new DOMException('QuotaExceededError')
    }
    this.store.set(key, value)
  }
}

describe('createLocalUiStateRepository', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    warningLog.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the fallback for an unknown key', () => {
    const storage = new FakeStorage()
    const repo = createLocalUiStateRepository(storage)

    expect(repo.read('ws1', 'navigatorWidth', 320)).toBe(320)
  })

  it('returns the fallback for corrupt JSON and never throws', () => {
    const storage = new FakeStorage()
    storage.setItem('tdease.ui.ws1.navigatorWidth', '{not valid json')
    const repo = createLocalUiStateRepository(storage)

    expect(() => repo.read('ws1', 'navigatorWidth', 320)).not.toThrow()
    expect(repo.read('ws1', 'navigatorWidth', 320)).toBe(320)
    expect(warningLog).toHaveBeenCalledTimes(2)
  })

  it('debounces writes to the same key, coalescing to the last value', () => {
    const storage = new FakeStorage()
    const repo = createLocalUiStateRepository(storage)

    repo.write('ws1', 'navigatorWidth', 300)
    repo.write('ws1', 'navigatorWidth', 340)
    repo.write('ws1', 'navigatorWidth', 360)

    // Not yet flushed.
    expect(storage.getItem('tdease.ui.ws1.navigatorWidth')).toBeNull()

    vi.advanceTimersByTime(199)
    expect(storage.getItem('tdease.ui.ws1.navigatorWidth')).toBeNull()

    vi.advanceTimersByTime(1)
    expect(JSON.parse(storage.getItem('tdease.ui.ws1.navigatorWidth')!)).toBe(360)
  })

  it('swallows and logs a quota/serialisation throw on write, never propagating it', () => {
    const storage = new FakeStorage()
    storage.failNextSetItem = true
    const repo = createLocalUiStateRepository(storage)

    expect(() => repo.write('ws1', 'navigatorWidth', 400)).not.toThrow()
    expect(() => vi.advanceTimersByTime(300)).not.toThrow()

    // The failed write never landed; a subsequent read still falls back.
    expect(repo.read('ws1', 'navigatorWidth', 320)).toBe(320)
    expect(warningLog).toHaveBeenCalledOnce()
  })

  it('clear removes only that workspace\'s keys', () => {
    const storage = new FakeStorage()
    const repo = createLocalUiStateRepository(storage)

    repo.write('ws1', 'navigatorWidth', 300)
    repo.write('ws1', 'inspectorHeight', 200)
    repo.write('ws2', 'navigatorWidth', 500)
    vi.advanceTimersByTime(300)

    expect(storage.getItem('tdease.ui.ws1.navigatorWidth')).not.toBeNull()
    expect(storage.getItem('tdease.ui.ws2.navigatorWidth')).not.toBeNull()

    repo.clear('ws1')

    expect(storage.getItem('tdease.ui.ws1.navigatorWidth')).toBeNull()
    expect(storage.getItem('tdease.ui.ws1.inspectorHeight')).toBeNull()
    expect(storage.getItem('tdease.ui.ws2.navigatorWidth')).not.toBeNull()
  })
})
