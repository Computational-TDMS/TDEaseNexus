import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUsageLedger, type UsageEntry } from './usage-ledger.ts'

const roots: string[] = []
function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdease-usage-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const model = { provider: 'anthropic', modelId: 'claude-fable-5', api: 'anthropic' }

describe('createUsageLedger — start/finish/recordError', () => {
  it('records an ok entry on finish with normalized Pi usage', () => {
    const ledger = createUsageLedger()
    const started = ledger.start({ model, costRates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } })
    const entry = ledger.finish(started.requestId, {
      usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, totalTokens: 1800 },
      model,
    })
    expect(entry?.status).toBe('ok')
    expect(entry?.usage?.input.totalTokens).toBe(1000)
    expect(entry?.usage?.output.totalTokens).toBe(500)
    expect(entry?.usage?.cache.readTokens).toBe(200)
    expect(entry?.usage?.totalTokens).toBe(1800)
    // cost = (1000*3 + 500*15 + 200*0.3 + 100*3.75) / 1e6
    expect(entry?.usage?.costTotal).toBeCloseTo((3000 + 7500 + 60 + 375) / 1_000_000, 10)
    // Canonical contract: `input` counts UNCACHED prompt tokens, so the
    // uncached figure IS the input figure — never input minus cacheRead.
    expect(entry?.usage?.input.uncachedTokens).toBe(1000)
    // Hit ratio = share of ALL prompt tokens served from cache
    // (200 / (1000 + 200 + 100)) — bounded by 1 even on cache-heavy turns.
    expect(entry?.usage?.cache.hitRatio).toBeCloseTo(200 / 1300, 10)
  })

  it('normalizes Anthropic-style usage payloads', () => {
    const ledger = createUsageLedger()
    const started = ledger.start({ model })
    const entry = ledger.finish(started.requestId, {
      usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
      model,
    })
    expect(entry?.usage?.input.totalTokens).toBe(120)
    expect(entry?.usage?.output.totalTokens).toBe(80)
    expect(entry?.usage?.cache.readTokens).toBe(20)
    expect(entry?.usage?.cache.writeTokens).toBe(10)
  })

  it('normalizes OpenAI-compatible usage payloads (prompt_tokens is cache-inclusive)', () => {
    const ledger = createUsageLedger()
    const started = ledger.start({ model })
    const entry = ledger.finish(started.requestId, {
      usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80, prompt_tokens_details: { cached_tokens: 5 } },
      model,
    })
    // prompt_tokens is inclusive by OpenAI spec: uncached input = 50 − 5.
    expect(entry?.usage?.input.totalTokens).toBe(45)
    expect(entry?.usage?.output.totalTokens).toBe(30)
    expect(entry?.usage?.cache.readTokens).toBe(5)
    expect(entry?.usage?.totalTokens).toBe(80)
  })

  it('derives totalTokens without double-counting uncached input when the payload carries no total', () => {
    const ledger = createUsageLedger()
    const started = ledger.start({ model })
    // The live feeder's exact shape (observers.finishUsage): no totalTokens
    // field, cache counters included. total must be prompt + output — the
    // former fallback re-added inputTokens and inflated every entry by its
    // full uncached input.
    const entry = ledger.finish(started.requestId, {
      usage: { input_tokens: 1000, output_tokens: 500, cacheRead: 200, cacheWrite: 100 },
      model,
    })
    expect(entry?.usage?.totalTokens).toBe(1800)
  })

  it('marks usage_missing when no usage payload is provided', () => {
    const ledger = createUsageLedger()
    const started = ledger.start({ model })
    const entry = ledger.finish(started.requestId, { model })
    expect(entry?.status).toBe('usage_missing')
    expect(entry?.usage).toBeNull()
  })

  it('records an error entry with normalized error shape', () => {
    const ledger = createUsageLedger()
    const started = ledger.start({ model })
    const entry = ledger.recordError(started.requestId, new Error('boom'), 'error', { model })
    expect(entry?.status).toBe('error')
    expect(entry?.error?.message).toBe('boom')
  })

  it('records an aborted entry', () => {
    const ledger = createUsageLedger()
    const started = ledger.start({ model })
    const entry = ledger.recordError(started.requestId, new Error('aborted'), 'aborted', { model })
    expect(entry?.status).toBe('aborted')
  })

  it('returns null when finishing an unknown requestId', () => {
    const ledger = createUsageLedger()
    expect(ledger.finish('nope')).toBeNull()
    expect(ledger.recordError('nope', new Error('x'), 'error')).toBeNull()
  })
})

describe('createUsageLedger — list + filter', () => {
  it('applies limit (returns most recent N, in chronological order) and provider filter', () => {
    const ledger = createUsageLedger()
    const providers = ['anthropic', 'openai', 'anthropic', 'openai', 'anthropic']
    for (let i = 0; i < 5; i++) {
      const s = ledger.start({ model: { ...model, provider: providers[i] } })
      ledger.finish(s.requestId, { usage: { input: i, output: 0 }, model: { ...model, provider: providers[i] } })
    }
    const limited = ledger.list({ limit: 2 })
    expect(limited.length).toBe(2)
    // Most-recent-2 are indices 3 (openai) and 4 (anthropic), in append order.
    expect(limited.map((e) => e.model.provider)).toEqual(['openai', 'anthropic'])
    expect(limited.map((e) => e.usage?.input.totalTokens)).toEqual([3, 4])
    expect(ledger.list({ provider: 'openai' }).length).toBe(2)
  })
})

describe('createUsageLedger — subscribe', () => {
  it('emits appended entries to subscribers', () => {
    const ledger = createUsageLedger()
    const seen: UsageEntry[] = []
    const stop = ledger.subscribe((e) => seen.push(e))
    const s = ledger.start({ model })
    ledger.finish(s.requestId, { usage: { input: 1, output: 1 }, model })
    expect(seen.length).toBe(1)
    expect(seen[0].status).toBe('ok')
    stop()
    const s2 = ledger.start({ model })
    ledger.finish(s2.requestId, { usage: { input: 1, output: 1 }, model })
    expect(seen.length).toBe(1) // unsubscribed, no new emit
  })
})

describe('createUsageLedger — persistence', () => {
  it('round-trips entries through a storage file', () => {
    const storagePath = path.join(createRoot(), 'usage-ledger.json')
    const ledger1 = createUsageLedger({ storagePath })
    const s = ledger1.start({ model })
    ledger1.finish(s.requestId, { usage: { input: 10, output: 5 }, model })
    ledger1.flush()

    // A fresh ledger loading the same file sees the persisted entry.
    const ledger2 = createUsageLedger({ storagePath })
    const list = ledger2.list()
    expect(list.length).toBe(1)
    expect(list[0].usage?.input.totalTokens).toBe(10)
    expect(list[0].model.provider).toBe('anthropic')
  })

  it('coalesces a burst into one debounced write; flush() lands it early', () => {
    vi.useFakeTimers()
    try {
      const storagePath = path.join(createRoot(), 'usage-ledger.json')
      const ledger = createUsageLedger({ storagePath })
      for (let i = 0; i < 5; i++) {
        const s = ledger.start({ model })
        ledger.finish(s.requestId, { usage: { input: i, output: 0 }, model })
      }
      // In-memory reads are already exact while the write is still pending.
      expect(ledger.list().length).toBe(5)
      // The burst is inside the debounce window — nothing hit disk yet.
      expect(createUsageLedger({ storagePath }).list().length).toBe(0)
      ledger.flush()
      expect(createUsageLedger({ storagePath }).list().length).toBe(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps entries at maxEntries (FIFO)', () => {
    const storagePath = path.join(createRoot(), 'usage-ledger.json')
    const ledger = createUsageLedger({ storagePath, maxEntries: 3 })
    for (let i = 0; i < 5; i++) {
      const s = ledger.start({ model })
      ledger.finish(s.requestId, { usage: { input: i, output: 0 }, model })
    }
    const list = ledger.list()
    expect(list.length).toBe(3)
    // Oldest two evicted; remaining are inputs 2,3,4
    expect(list.map((e) => e.usage?.input.totalTokens)).toEqual([2, 3, 4])
  })

  it('clear() empties entries and rewrites the file', () => {
    const storagePath = path.join(createRoot(), 'usage-ledger.json')
    const ledger = createUsageLedger({ storagePath })
    const s = ledger.start({ model })
    ledger.finish(s.requestId, { usage: { input: 1, output: 1 }, model })
    ledger.clear()
    expect(ledger.list().length).toBe(0)
    expect(createUsageLedger({ storagePath }).list().length).toBe(0)
  })

  it('tolerates a missing storage file (first run)', () => {
    const storagePath = path.join(createRoot(), 'usage-ledger.json')
    expect(() => createUsageLedger({ storagePath })).not.toThrow()
    expect(createUsageLedger({ storagePath }).list().length).toBe(0)
  })
})
