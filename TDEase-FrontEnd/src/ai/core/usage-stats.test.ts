// Pins the accounting vocabulary of computeUsageStats (task_plan.md D11):
// consumption follows usage presence (a failed turn's completed calls were
// billed), attempts count every status, cache hit is weighted over the
// cache-reporting population only, and bucketing is local-time. These are the
// numbers users compare against vendor dashboards — a silent accounting-caliber
// drift here is a billing dispute.

import { describe, expect, it } from 'vitest'
import { computeUsageStats, type UsageStatsRange } from './usage-stats'
import type { UsageEntry } from './usage-ledger'

// Fixed afternoon anchor: 2026-09-14 15:00 local. Buckets assert local-time
// semantics, never UTC.
const NOW = new Date(2026, 8, 14, 15, 0, 0).getTime()

function entry(partial: Partial<UsageEntry> & { startedAt: string }): UsageEntry {
  return {
    requestId: partial.requestId ?? `r${Math.random()}`,
    startedAt: partial.startedAt,
    endedAt: partial.endedAt ?? partial.startedAt,
    durationMs: partial.durationMs !== undefined ? partial.durationMs : 1000,
    status: partial.status ?? 'ok',
    model: partial.model ?? { provider: 'deepseek', modelId: 'v4-flash', api: 'openai-completions' },
    usage: partial.usage !== undefined ? partial.usage : {
      input: { totalTokens: 100, uncachedTokens: null },
      output: { totalTokens: 50, reasoningTokens: null },
      cache: { readTokens: null, writeTokens: null, hitRatio: null },
      totalTokens: 150,
      costTotal: 0.001,
    },
    error: partial.error ?? null,
  }
}

const iso = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m, d, h, min).toISOString()

describe('computeUsageStats', () => {
  it('consumption follows usage presence: attempts count every status, tokens only what carries usage', () => {
    const stats = computeUsageStats([
      entry({ startedAt: iso(2026, 8, 14, 10) }),
      entry({ startedAt: iso(2026, 8, 14, 11), status: 'error', usage: null }),
      entry({ startedAt: iso(2026, 8, 14, 12), status: 'aborted', usage: null }),
      entry({ startedAt: iso(2026, 8, 14, 13), status: 'usage_missing', usage: null }),
      // An aborted turn whose earlier LLM calls completed: real consumption.
      entry({ startedAt: iso(2026, 8, 14, 14), status: 'aborted', usage: {
        input: { totalTokens: 300, uncachedTokens: 300 },
        output: { totalTokens: 20, reasoningTokens: null },
        cache: { readTokens: null, writeTokens: null, hitRatio: null },
        totalTokens: 320, costTotal: null,
      } }),
    ], { range: 'today', now: NOW })

    expect(stats.totals.attempted).toBe(5)
    expect(stats.totals.requests).toBe(2)
    // errors counts every error/aborted entry — the aborted turn appears in
    // both populations: once as an error, once as consumption.
    expect(stats.totals.errors).toBe(3)
    expect(stats.totals.usageMissing).toBe(1)
    expect(stats.totals.totalTokens).toBe(470)
    expect(stats.totals.errorRate).toBeCloseTo(0.6)
  })

  it('weights cache hit across requests instead of averaging ratios', () => {
    const big = entry({ startedAt: iso(2026, 8, 14, 10), usage: {
      input: { totalTokens: 1000, uncachedTokens: null },
      output: { totalTokens: 10, reasoningTokens: null },
      cache: { readTokens: 500, writeTokens: null, hitRatio: 0.5 },
      totalTokens: 1510, costTotal: null,
    } })
    const tiny = entry({ requestId: 'tiny', startedAt: iso(2026, 8, 14, 11), usage: {
      input: { totalTokens: 10, uncachedTokens: null },
      output: { totalTokens: 10, reasoningTokens: null },
      cache: { readTokens: 10, writeTokens: null, hitRatio: 1 },
      totalTokens: 30, costTotal: null,
    } })
    const stats = computeUsageStats([big, tiny], { range: 'today', now: NOW })
    // Weighted share of ALL prompt tokens: ΣcacheRead / Σ(input + cacheRead +
    // cacheWrite) = 510 / 1520. The input totals are uncached-only under the
    // ledger's canonical contract, so they must not form the denominator
    // alone — cacheRead/Σinput could exceed 1 on a cache-heavy window.
    expect(stats.totals.cacheHitRatio).toBeCloseTo(510 / 1520, 5)
  })

  it('excludes cache-less traffic from the hit ratio population', () => {
    const cached = entry({ startedAt: iso(2026, 8, 14, 10), usage: {
      input: { totalTokens: 100, uncachedTokens: 100 },
      output: { totalTokens: 50, reasoningTokens: null },
      cache: { readTokens: 90, writeTokens: null, hitRatio: 0.47 },
      totalTokens: 240, costTotal: null,
    } })
    // Legacy-pipeline row / provider without prompt caching: no counters, so
    // it must not touch the ratio's denominator — the defect that showed real
    // 50-60% windows as 0.1%.
    const legacy = entry({ requestId: 'legacy', startedAt: iso(2026, 8, 14, 11), usage: {
      input: { totalTokens: 1_000_000, uncachedTokens: null },
      output: { totalTokens: 1, reasoningTokens: null },
      cache: { readTokens: null, writeTokens: null, hitRatio: null },
      totalTokens: 1_000_001, costTotal: null,
    } })
    const stats = computeUsageStats([cached, legacy], { range: 'today', now: NOW })
    expect(stats.totals.cacheHitRatio).toBeCloseTo(90 / 190, 5)
    // ...and a window where nothing reported cache counters reads as no data,
    // never as a fabricated 0%.
    expect(computeUsageStats([legacy], { range: 'today', now: NOW }).totals.cacheHitRatio).toBeNull()
  })

  it('buckets "today" hourly in local time; empty hours stay zero bars', () => {
    const stats = computeUsageStats([entry({ startedAt: iso(2026, 8, 14, 10, 30) })], { range: 'today', now: NOW })
    expect(stats.buckets[0].label).toBe('00:00')
    expect(stats.buckets[stats.buckets.length - 1].label).toBe('15:00')
    const ten = stats.buckets.find((b) => b.label === '10:00')
    expect(ten?.tokens).toBe(150)
    expect(stats.buckets.every((b) => b.startMs < b.endMs)).toBe(true)
  })

  it('scopes 7d/30d by cutoff and sums costs only from reported values', () => {
    const stats = computeUsageStats([
      entry({ startedAt: iso(2026, 8, 14, 14), usage: {
        input: { totalTokens: 1, uncachedTokens: null },
        output: { totalTokens: 1, reasoningTokens: null },
        cache: { readTokens: null, writeTokens: null, hitRatio: null },
        totalTokens: 2, costTotal: 0.25,
      } }),
      entry({ requestId: 'old', startedAt: iso(2026, 7, 1, 10) }),
      entry({ requestId: 'free', startedAt: iso(2026, 8, 14, 14, 30), usage: {
        input: { totalTokens: 1, uncachedTokens: null },
        output: { totalTokens: 1, reasoningTokens: null },
        cache: { readTokens: null, writeTokens: null, hitRatio: null },
        totalTokens: 2, costTotal: null,
      } }),
    ], { range: '7d', now: NOW })
    expect(stats.fromMs).not.toBeNull()
    expect(stats.totals.requests).toBe(2)
    expect(stats.totals.costTotal).toBeCloseTo(0.25)
    expect(stats.buckets).toHaveLength(7)
  })

  it('groups by provider and by model with provider attribution', () => {
    const stats = computeUsageStats([
      entry({ startedAt: iso(2026, 8, 14, 10) }),
      entry({ requestId: 'b', startedAt: iso(2026, 8, 14, 11), model: { provider: 'openai', modelId: 'gpt-5', api: 'openai-responses' } }),
      entry({ requestId: 'c', startedAt: iso(2026, 8, 14, 12) }),
    ], { range: 'today', now: NOW })

    expect(stats.byProvider.map((g) => [g.key, g.requests])).toEqual([['deepseek', 2], ['openai', 1]])
    expect(stats.byModel[0]).toMatchObject({ key: 'v4-flash', provider: 'deepseek', requests: 2 })
  })

  it('computes settled output throughput over durations', () => {
    const stats = computeUsageStats([
      entry({ startedAt: iso(2026, 8, 14, 10), durationMs: 2000 }),
      entry({ requestId: 'no-duration', startedAt: iso(2026, 8, 14, 11), durationMs: null }),
    ], { range: 'today', now: NOW })
    // 50 output tokens over 2s — the duration-less entry must not poison it.
    expect(stats.totals.outputTokensPerSecond).toBeCloseTo(25)
  })

  it('caps "all" trend buckets at 90 daily columns', () => {
    const stats = computeUsageStats([entry({ startedAt: iso(2026, 8, 14, 10) })], { range: 'all', now: NOW })
    expect(stats.fromMs).toBeNull()
    expect(stats.buckets.length).toBeLessThanOrEqual(90)
    expect(stats.buckets[stats.buckets.length - 1].tokens).toBe(150)
  })

  it('rejects future entries and unparseable timestamps silently', () => {
    const stats = computeUsageStats([
      entry({ startedAt: 'not-a-date' }),
      entry({ requestId: 'future', startedAt: iso(2026, 8, 14, 23) }),
    ], { range: 'today', now: NOW })
    expect(stats.totals.attempted).toBe(0)
  })

  it('reports ledger coverage (oldestAt) across the whole ledger, not the range', () => {
    const stats = computeUsageStats([
      // Outside the "today" range on purpose — coverage is about the ledger,
      // not the selected window.
      entry({ startedAt: iso(2026, 7, 1, 9) }),
      entry({ startedAt: iso(2026, 8, 14, 10) }),
    ], { range: 'today', now: NOW })
    expect(stats.oldestAt).toBe(iso(2026, 7, 1, 9))
  })

  it('oldestAt is null for an empty ledger', () => {
    expect(computeUsageStats([], { range: 'all', now: NOW }).oldestAt).toBeNull()
  })

  it('every declared range is accepted', () => {
    const ranges: UsageStatsRange[] = ['5h', 'today', '7d', '30d', 'all']
    for (const range of ranges) {
      expect(computeUsageStats([], { range, now: NOW }).range).toBe(range)
    }
  })
})
