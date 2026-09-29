// Usage statistics aggregation — THE single aggregation core for every usage
// surface (settings StatisticsPanel, composer ContextUsagePanel).
//
// Lives beside usage-ledger.ts so the Electron main process can aggregate the
// FULL ledger over IPC (`usage-ledger:stats`). Renderer-side aggregation over
// a `limit`-capped page was the defect class this module retires: totals drawn
// from the latest 500 entries systematically under-counted a 5000-entry ledger.
//
// Accounting vocabulary (task_plan.md D11):
//   - Consumption (tokens, cost) counts every entry that CARRIES usage. An
//     aborted or failed turn still ran — and was billed for — every LLM call
//     that completed before it stopped; dropping that usage would fabricate
//     savings. Entries without usage (usage_missing, failures with no settled
//     call) never contribute tokens.
//   - Attempts (request counts, error rate) count EVERY entry: error, aborted
//     and usage_missing land in the denominator, never in consumption.
//   - Cache hit ratio is weighted (ΣcacheRead / ΣpromptTokens over the
//     cache-reporting population only, where promptTokens = uncached input +
//     cacheRead + cacheWrite), not a mean of ratios — a tiny request must not
//     outweigh a large one. The population gate is the calibration: entries
//     whose provider reported no cache counters (providers without prompt
//     caching, legacy pipeline rows) carry no hit-rate semantics — counting
//     their input in the denominator dragged real 50-60% windows down to
//     fractions of a percent.

import type { UsageEntry } from "./usage-ledger";

export type UsageStatsRange = "5h" | "today" | "7d" | "30d" | "all";

export interface UsageStatsTotals {
  /** Entries that carry usage — the consumption population. */
  requests: number;
  /** Every entry in range regardless of status. */
  attempted: number;
  /** status "error" | "aborted". */
  errors: number;
  usageMissing: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costTotal: number | null;
  cacheHitRatio: number | null;
  errorRate: number | null;
  avgDurationMs: number | null;
  /** Settled output throughput: Σoutput / Σduration over ok entries with a duration. */
  outputTokensPerSecond: number | null;
}

export interface UsageStatsBucket {
  /** Local-time label: "HH:00" for hourly buckets, "M/D" for daily ones. */
  label: string;
  startMs: number;
  endMs: number;
  tokens: number;
  requests: number;
  costTotal: number | null;
}

export interface UsageStatsGroup {
  key: string;
  /** byModel groups carry the owning provider for display. */
  provider: string | null;
  tokens: number;
  requests: number;
  costTotal: number | null;
}

export interface UsageStats {
  range: UsageStatsRange;
  generatedAt: string;
  /** Inclusive range start (ms epoch); null = unbounded ("all"). */
  fromMs: number | null;
  /** Oldest entry timestamp in the whole ledger (not range-filtered), so a
   *  UI can show what window the data actually covers. Null = empty ledger. */
  oldestAt: string | null;
  totals: UsageStatsTotals;
  buckets: UsageStatsBucket[];
  byProvider: UsageStatsGroup[];
  byModel: UsageStatsGroup[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** "all" trends are capped — a bounded chart beats a 5000-bucket one. */
const ALL_TREND_DAYS = 90;

export function computeUsageStats(
  entries: UsageEntry[],
  options: { range: UsageStatsRange; now?: number },
): UsageStats {
  const now = options.now ?? Date.now();
  const range = options.range;

  let fromMs: number | null = null;
  let bucketMs = DAY_MS;
  // Assigned by every branch of the exhaustive range chain below.
  let bucketCount: number;
  if (range === "5h") {
    fromMs = now - 5 * HOUR_MS;
    bucketMs = HOUR_MS;
    bucketCount = 5;
  } else if (range === "today") {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    fromMs = day.getTime();
    bucketMs = HOUR_MS;
    // Hours elapsed since local midnight, inclusive of the running hour.
    bucketCount = Math.max(1, Math.floor((now - fromMs) / HOUR_MS) + 1);
  } else if (range === "7d") {
    fromMs = now - 7 * DAY_MS;
    bucketCount = 7;
  } else if (range === "30d") {
    fromMs = now - 30 * DAY_MS;
    bucketCount = 30;
  } else {
    bucketCount = ALL_TREND_DAYS;
  }

  const totals = emptyTotals();
  // Ledger coverage: the oldest entry across ALL entries, taken before the
  // range filter — the answer to "how far back does this data go".
  let oldestMs: number | null = null;
  const durations = { total: 0, count: 0 };
  const throughput = { outputTokens: 0, durationMs: 0 };
  // Hit-ratio population: only entries whose provider actually reported cache
  // counters. Σ over everything would let cache-less traffic define the
  // denominator of a metric it cannot participate in.
  const cachePopulation = { promptTokens: 0, cacheRead: 0 };
  const groups = new Map<string, UsageStatsGroup>();
  // Buckets are pre-built so days with no traffic still draw as zero bars.
  const lastBucketStart = bucketFloor(now, bucketMs);
  const firstBucketStart = range === "all" ? bucketFloor(now - (ALL_TREND_DAYS - 1) * bucketMs, DAY_MS) : lastBucketStart - (bucketCount - 1) * bucketMs;
  const buckets: UsageStatsBucket[] = [];
  for (let start = firstBucketStart; start <= lastBucketStart; start += bucketMs) {
    buckets.push({ label: bucketLabel(start, bucketMs), startMs: start, endMs: start + bucketMs, tokens: 0, requests: 0, costTotal: null });
  }

  for (const entry of entries) {
    const startedMs = Date.parse(entry.startedAt);
    if (!Number.isFinite(startedMs)) continue;
    if (oldestMs === null || startedMs < oldestMs) oldestMs = startedMs;
    if (fromMs != null && startedMs < fromMs) continue;
    if (startedMs > now) continue;

    totals.attempted += 1;
    if (entry.status === "error" || entry.status === "aborted") totals.errors += 1;
    else if (entry.status === "usage_missing") totals.usageMissing += 1;

    if (entry.durationMs != null && entry.durationMs > 0) {
      durations.total += entry.durationMs;
      durations.count += 1;
    }

    // Usage presence — not status — decides consumption: a failed turn that
    // completed three LLM calls before dying still burned those tokens.
    const usage = entry.usage;
    if (!usage) continue;

    totals.requests += 1;
    totals.inputTokens += usage.input.totalTokens;
    totals.outputTokens += usage.output.totalTokens;
    totals.reasoningTokens += usage.output.reasoningTokens ?? 0;
    totals.cacheReadTokens += usage.cache.readTokens ?? 0;
    totals.cacheWriteTokens += usage.cache.writeTokens ?? 0;
    totals.totalTokens += usage.totalTokens;
    if (usage.cache.readTokens != null || usage.cache.writeTokens != null) {
      cachePopulation.promptTokens += usage.input.totalTokens + (usage.cache.readTokens ?? 0) + (usage.cache.writeTokens ?? 0);
      cachePopulation.cacheRead += usage.cache.readTokens ?? 0;
    }
    if (usage.costTotal != null) totals.costTotal = (totals.costTotal ?? 0) + usage.costTotal;
    if (usage.output.totalTokens > 0 && entry.durationMs != null && entry.durationMs > 0) {
      throughput.outputTokens += usage.output.totalTokens;
      throughput.durationMs += entry.durationMs;
    }

    const providerKey = entry.model.provider ?? "unknown";
    addConsumption(groups, providerKey, providerKey, null, usage.totalTokens, usage.costTotal);
    const modelKey = `${providerKey}/${entry.model.modelId ?? "unknown"}`;
    addConsumption(groups, modelKey, entry.model.modelId ?? "unknown", entry.model.provider, usage.totalTokens, usage.costTotal);

    const bucket = buckets.find((b) => startedMs >= b.startMs && startedMs < b.endMs);
    if (bucket) {
      bucket.tokens += usage.totalTokens;
      bucket.requests += 1;
      if (usage.costTotal != null) bucket.costTotal = (bucket.costTotal ?? 0) + usage.costTotal;
    }
  }

  const consumption = Array.from(groups.values());
  return {
    range,
    generatedAt: new Date(now).toISOString(),
    fromMs,
    oldestAt: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
    totals: {
      ...totals,
      // Weighted share of prompt tokens served from cache, computed over the
      // cache-reporting population only (see cachePopulation above). Null —
      // rendered as "—" — when nothing in range reported cache counters: no
      // data, not a zero.
      cacheHitRatio: cachePopulation.promptTokens > 0
        ? cachePopulation.cacheRead / cachePopulation.promptTokens
        : null,
      errorRate: totals.attempted > 0 ? totals.errors / totals.attempted : null,
      avgDurationMs: durations.count > 0 ? durations.total / durations.count : null,
      outputTokensPerSecond: throughput.durationMs > 0 ? throughput.outputTokens / (throughput.durationMs / 1000) : null,
    },
    buckets,
    byProvider: consumption.filter((g) => g.provider === null).sort((a, b) => b.tokens - a.tokens),
    byModel: consumption.filter((g) => g.provider !== null).sort((a, b) => b.tokens - a.tokens),
  };
}

// ── internals ────────────────────────────────────────────────────────────────

function emptyTotals(): UsageStatsTotals {
  return {
    requests: 0, attempted: 0, errors: 0, usageMissing: 0,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, costTotal: null, cacheHitRatio: null, errorRate: null, avgDurationMs: null,
    outputTokensPerSecond: null,
  };
}

function addConsumption(
  groups: Map<string, UsageStatsGroup>,
  key: string,
  displayKey: string,
  provider: string | null,
  tokens: number,
  cost: number | null,
): void {
  let group = groups.get(key);
  if (!group) {
    group = { key: displayKey, provider, tokens: 0, requests: 0, costTotal: null };
    groups.set(key, group);
  }
  group.tokens += tokens;
  group.requests += 1;
  if (cost != null) group.costTotal = (group.costTotal ?? 0) + cost;
}

function bucketFloor(ms: number, bucketMs: number): number {
  if (bucketMs >= DAY_MS) {
    const day = new Date(ms);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  }
  return Math.floor(ms / bucketMs) * bucketMs;
}

function bucketLabel(startMs: number, bucketMs: number): string {
  const date = new Date(startMs);
  if (bucketMs < DAY_MS) {
    return `${String(date.getHours()).padStart(2, "0")}:00`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
