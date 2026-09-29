// Renderer-side accessor for the AI usage ledger.
//
// The ledger itself lives in the Electron main process (persisted under
// <userData>/system/usage-ledger.json) and is populated by the Node AgentRuntime
// on every Pi prompt. This module is the renderer's only seam: it queries via
// the usage-ledger:list IPC and subscribes to the usage-ledger:event live stream.
//
// No localStorage fallback: there is no Pi engine in browser-dev mode, so there
// is nothing to record. Callers get an empty list and a no-op subscribe, which
// is the correct state for "no usage yet".

import type { UsageEntry } from '@/ai/core/usage-ledger'
import type { UsageStats, UsageStatsRange } from '@/ai/core/usage-stats'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

export type { UsageEntry } from '@/ai/core/usage-ledger'
export type { UsageStats, UsageStatsRange } from '@/ai/core/usage-stats'

export type UsageEntryListener = (entry: UsageEntry) => void

export interface UsageListFilter {
  limit?: number
  since?: string
  until?: string
  status?: UsageEntry['status']
  provider?: string
  modelId?: string
}

interface UsageLedgerBridge {
  list(filter?: UsageListFilter): Promise<UsageEntry[]>
  stats(range: UsageStatsRange): Promise<UsageStats | null>
  clear(): Promise<void>
  subscribe(onEntry: UsageEntryListener): () => void
}

function bridge(): UsageLedgerBridge | undefined {
  return (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.usageLedger
}

/** Query recorded usage entries. Empty list when the Electron bridge is absent. */
export async function listUsage(filter: UsageListFilter = {}): Promise<UsageEntry[]> {
  const b = bridge()
  if (!b) return []
  try {
    return await b.list(filter)
  } catch {
    return []
  }
}

/**
 * Full-ledger aggregates computed in the main process (usage-stats.ts).
 * Null when the Electron bridge is absent (browser dev) or the query fails —
 * callers render their empty state, never a fabricated zero.
 */
export async function getUsageStats(range: UsageStatsRange): Promise<UsageStats | null> {
  const b = bridge()
  if (!b?.stats) return null
  try {
    return await b.stats(range)
  } catch {
    return null
  }
}

/** Wipe the whole usage ledger in the main process. */
export async function clearUsage(): Promise<void> {
  const b = bridge()
  if (!b?.clear) return
  await b.clear().catch(() => {})
}

/**
 * Subscribe to live usage appends. Returns an unsubscribe. No-op (returns a
 * tear-down that does nothing) when the Electron bridge is absent, so callers
 * can wire onMounted/onScopeDispose uniformly.
 */
export function subscribeUsage(onEntry: UsageEntryListener): () => void {
  const b = bridge()
  if (!b) return () => {}
  return b.subscribe(onEntry)
}
