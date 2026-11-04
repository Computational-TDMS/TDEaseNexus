import { describe, expect, it } from 'vitest'
import type { ContextUsage, SessionEntry } from '@earendil-works/pi-coding-agent'
import { toContextSnapshot } from './context-usage'

/** A usage-bearing assistant message entry, as Pi's branch would hold it. */
function usageEntry(usage: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>>, stopReason = 'end_turn'): SessionEntry {
  return {
    type: 'message',
    message: {
      role: 'assistant',
      stopReason,
      content: [],
      usage: {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        totalTokens: (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  } as SessionEntry
}

function context(tokens: number | null): ContextUsage {
  return { tokens, contextWindow: 200_000, percent: tokens === null ? null : (tokens / 200_000) * 100 }
}

describe('toContextSnapshot', () => {
  it('returns null when Pi reports no context answer', () => {
    expect(toContextSnapshot(undefined, [])).toBeNull()
  })

  it('reports tokens:null AND cache:null when occupancy is unknown (post-compaction)', () => {
    expect(toContextSnapshot(context(null), [usageEntry({ input: 50_000 })])).toEqual({ tokens: null, cache: null })
  })

  it('carries the estimated tokens + the last valid request cache figures', () => {
    const branch = [
      usageEntry({ input: 9_000, output: 500, cacheRead: 7_000, cacheWrite: 1_500 }),
      usageEntry({ input: 10_000, output: 400, cacheRead: 8_500, cacheWrite: 1_200 }),
    ]
    expect(toContextSnapshot(context(10_400), branch)).toEqual({
      tokens: 10_400,
      cache: { read: 8_500, write: 1_200, uncached: 10_000 },
    })
  })

  it('nulls cache when no branch entry carries valid usage', () => {
    expect(toContextSnapshot(context(3_000), [])).toEqual({ tokens: 3_000, cache: null })
  })

  it('skips aborted/error assistant messages when scanning for usage', () => {
    const branch = [
      usageEntry({ input: 1_000 }, 'aborted'),
      usageEntry({ input: 2_000 }, 'error'),
      usageEntry({ input: 3_000 }, 'end_turn'),
    ]
    const snap = toContextSnapshot(context(3_000), branch)
    expect(snap?.cache).toEqual({ read: 0, write: 0, uncached: 3_000 })
  })

  it('nulls cache when the only usage-bearing messages were aborted/error', () => {
    const branch = [usageEntry({ input: 1_000 }, 'aborted'), usageEntry({ input: 2_000 }, 'error')]
    expect(toContextSnapshot(context(2_000), branch)).toEqual({ tokens: 2_000, cache: null })
  })
})
