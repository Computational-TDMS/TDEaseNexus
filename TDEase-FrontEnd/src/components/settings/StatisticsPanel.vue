<template>
  <div class="settings-tab-content active" data-tab="statistics">
    <!-- Toolbar: range scope + data management. -->
    <div class="stats-toolbar">
      <div class="stats-ranges" role="tablist" :aria-label="t('workbench.settings.statistics.overview')">
        <button
          v-for="r in RANGES" :key="r"
          :class="['stats-range', { active: range === r }]"
          role="tab" :aria-selected="range === r"
          @click="range = r"
        >
          {{ t(`workbench.settings.statistics.range.${r}`) }}
        </button>
      </div>
      <div class="stats-toolbar-actions">
        <AppButton size="sm" variant="subtle" :disabled="!hasData" @click="exportJson">
          {{ t('workbench.settings.statistics.export') }}
        </AppButton>
        <AppButton size="sm" variant="subtle" :disabled="!hasData" @click="exportCsv">
          {{ t('workbench.settings.statistics.exportCsv') }}
        </AppButton>
        <AppButton
          v-if="hasData" size="sm" variant="subtle"
          :class="{ armed: clearArmed }"
          @click="onClear"
        >
          {{ clearArmed ? t('workbench.settings.statistics.clearConfirm') : t('workbench.settings.statistics.clear') }}
        </AppButton>
      </div>
    </div>

    <template v-if="stats && stats.totals.attempted > 0">
      <!-- Hero cards: consumption first (settled only), quality second. -->
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">{{ t('workbench.settings.statistics.overview') }}</h2>
          <!-- The coverage line keeps truncation honest: the ledger is a
               bounded window, so "30d" can mean "everything we have". -->
          <span class="stats-scope">
            {{ t('workbench.settings.statistics.scopeAttempts', { n: stats.totals.attempted }) }}
            <template v-if="stats.oldestAt">
              · {{ t('workbench.settings.statistics.coverageSince', { date: new Date(stats.oldestAt).toLocaleDateString() }) }}
            </template>
          </span>
        </div>
        <div class="stats-hero">
          <div class="stats-card">
            <span class="stats-value">{{ fmtNum(stats.totals.totalTokens) }}</span>
            <span class="stats-label">{{ t('workbench.settings.statistics.totalTokens') }}</span>
          </div>
          <div class="stats-card">
            <span class="stats-value">{{ fmtCost(stats.totals.costTotal) }}</span>
            <span class="stats-label">{{ t('workbench.settings.statistics.estCost') }}</span>
          </div>
          <div class="stats-card">
            <span class="stats-value">{{ stats.totals.requests }}</span>
            <span class="stats-label">{{ t('workbench.settings.statistics.requests') }}</span>
          </div>
          <div class="stats-card">
            <span class="stats-value">{{ fmtPct(stats.totals.cacheHitRatio) }}</span>
            <span class="stats-label">{{ t('workbench.settings.statistics.cacheHit') }}</span>
          </div>
          <div class="stats-card" :class="{ 'stats-card--warn': (stats.totals.errorRate ?? 0) > 0.05 }">
            <span class="stats-value">{{ fmtPct(stats.totals.errorRate) }}</span>
            <span class="stats-label">{{ t('workbench.settings.statistics.errorRate') }}</span>
          </div>
          <div class="stats-card">
            <span class="stats-value">{{ fmtSpeed(stats.totals.outputTokensPerSecond) }}</span>
            <span class="stats-label">{{ t('workbench.settings.statistics.avgSpeed') }}</span>
          </div>
        </div>
        <!-- Token composition: where the window budget actually went. Reasoning
             is a vendor-reported subset of output, so it annotates the legend
             instead of taking a segment — a fifth segment would double-count. -->
        <div v-if="composition.length > 0" class="stats-comp">
          <div class="stats-comp-bar">
            <span
              v-for="seg in composition" :key="seg.key"
              class="stats-comp-seg" :data-seg="seg.key"
              :style="{ width: `${seg.share}%` }"
            />
          </div>
          <div class="stats-comp-legend">
            <span v-for="seg in composition" :key="seg.key" class="stats-comp-item">
              <i class="stats-comp-dot" :data-seg="seg.key" aria-hidden="true" />
              {{ t(`workbench.settings.statistics.comp.${seg.key}`) }}
              <b>{{ fmtNum(seg.tokens) }}</b>
            </span>
            <span v-if="stats.totals.reasoningTokens > 0" class="stats-comp-note">
              {{ t('workbench.settings.statistics.comp.reasoningNote', { n: fmtNum(stats.totals.reasoningTokens) }) }}
            </span>
          </div>
        </div>
      </section>

      <!-- Trend: per-bucket bars, one metric at a time (hourly for today/5h,
           daily otherwise). -->
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">{{ t('workbench.settings.statistics.trend') }}</h2>
          <div class="stats-ranges" role="tablist" :aria-label="t('workbench.settings.statistics.trend')">
            <button
              v-for="m in TREND_METRICS" :key="m"
              :class="['stats-range', { active: trendMetric === m }]"
              role="tab" :aria-selected="trendMetric === m"
              @click="trendMetric = m"
            >
              {{ t(`workbench.settings.statistics.col.${m}`) }}
            </button>
          </div>
        </div>
        <div class="surface-card trend-card">
          <div class="trend-bars">
            <div v-for="b in stats.buckets" :key="b.startMs" class="trend-col">
              <div
                class="trend-bar"
                :style="{ height: trendPct(b) }"
                :title="trendTitle(b)"
              />
            </div>
          </div>
          <div class="trend-axis">
            <span>{{ stats.buckets[0]?.label }}</span>
            <span>{{ stats.buckets[stats.buckets.length - 1]?.label }}</span>
          </div>
        </div>
      </section>

      <!-- By provider / by model -->
      <section v-if="stats.byProvider.length > 0" class="section">
        <div class="section-header">
          <h2 class="section-title">{{ t('workbench.settings.statistics.byProvider') }}</h2>
        </div>
        <div class="surface-card" style="padding:var(--space-4)">
          <div class="stats-bars">
            <div class="stats-bar-row stats-bar-head" aria-hidden="true">
              <span class="stats-bar-name" />
              <span class="stats-bar-meter" />
              <span class="stats-bar-val">{{ t('workbench.settings.statistics.col.tokens') }}</span>
              <span class="stats-bar-val stats-bar-val--req">{{ t('workbench.settings.statistics.col.requests') }}</span>
              <span class="stats-bar-val stats-bar-val--cost">{{ t('workbench.settings.statistics.col.cost') }}</span>
            </div>
            <div v-for="g in stats.byProvider" :key="g.key" class="stats-bar-row">
              <span class="stats-bar-name">{{ providerLabel(g.key) }}</span>
              <div class="stats-bar-meter"><Meter :value="g.tokens" :max="maxGroupTokens(stats.byProvider)" density="comfortable" /></div>
              <span class="stats-bar-val">{{ fmtNum(g.tokens) }}</span>
              <span class="stats-bar-val stats-bar-val--req">{{ g.requests }}</span>
              <span class="stats-bar-val stats-bar-val--cost">{{ g.costTotal != null ? fmtCost(g.costTotal) : '—' }}</span>
            </div>
          </div>
        </div>
      </section>

      <section v-if="stats.byModel.length > 0" class="section">
        <div class="section-header">
          <h2 class="section-title">{{ t('workbench.settings.statistics.byModel') }}</h2>
        </div>
        <div class="surface-card" style="padding:var(--space-4)">
          <div class="stats-bars">
            <div class="stats-bar-row stats-bar-head" aria-hidden="true">
              <span class="stats-bar-name" />
              <span class="stats-bar-meter" />
              <span class="stats-bar-val">{{ t('workbench.settings.statistics.col.tokens') }}</span>
              <span class="stats-bar-val stats-bar-val--req">{{ t('workbench.settings.statistics.col.requests') }}</span>
              <span class="stats-bar-val stats-bar-val--cost">{{ t('workbench.settings.statistics.col.cost') }}</span>
            </div>
            <div v-for="g in stats.byModel" :key="g.key" class="stats-bar-row">
              <span class="stats-bar-name" :title="g.key">{{ g.key }}<span v-if="g.provider" class="stats-bar-sub">{{ providerLabel(g.provider) }}</span></span>
              <div class="stats-bar-meter"><Meter :value="g.tokens" :max="maxGroupTokens(stats.byModel)" density="comfortable" /></div>
              <span class="stats-bar-val">{{ fmtNum(g.tokens) }}</span>
              <span class="stats-bar-val stats-bar-val--req">{{ g.requests }}</span>
              <span class="stats-bar-val stats-bar-val--cost">{{ g.costTotal != null ? fmtCost(g.costTotal) : '—' }}</span>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- Recent requests (newest first; a "recent" table, so capped is correct). -->
    <section v-if="recent.length > 0" class="section">
      <div class="section-header">
        <h2 class="section-title">{{ t('workbench.settings.statistics.recentRequests') }}</h2>
      </div>
      <div class="surface-card">
        <div class="req-list">
          <div class="req-row req-head">
            <span>{{ t('workbench.settings.statistics.col.time') }}</span><span>{{ t('workbench.settings.statistics.col.provider') }}</span><span>{{ t('workbench.settings.statistics.col.model') }}</span><span>{{ t('workbench.settings.statistics.col.tokens') }}</span><span>{{ t('workbench.settings.statistics.col.cost') }}</span><span>{{ t('workbench.settings.statistics.col.duration') }}</span><span>{{ t('workbench.settings.statistics.col.status') }}</span>
          </div>
          <div v-for="e in recent" :key="e.requestId" class="req-row">
            <span class="mono dim">{{ fmtTime(e.startedAt) }}</span>
            <span>{{ providerLabel(e.model.provider) }}</span>
            <span class="mono" :title="e.model.modelId ?? ''">{{ e.model.modelId }}</span>
            <span class="mono">{{ fmtNum(e.usage?.totalTokens ?? 0) }}</span>
            <span class="mono">{{ e.usage?.costTotal != null ? fmtCost(e.usage.costTotal) : '—' }}</span>
            <span class="mono dim">{{ fmtDuration(e.durationMs) }}</span>
            <span :class="['st', e.status]">{{ t(`workbench.settings.statistics.status.${e.status}`) }}</span>
          </div>
        </div>
      </div>
    </section>

    <div v-if="!hasData" style="padding:var(--space-6) 0;text-align:center;color:var(--color-text-muted);font-size:var(--text-sm)">
      {{ loaded ? t('workbench.settings.statistics.empty') : t('workbench.settings.statistics.loading') }}
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * StatisticsPanel — the settings-level usage overview. All aggregates come
 * from the main process (`usage-ledger:stats`, full ledger — never a capped
 * page); this component only formats and filters by range. Consumption
 * numbers count settled requests only; the scope line shows total attempts
 * so failed/aborted calls stay visible without polluting spend.
 */
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { UsageEntry } from '@/services/agent/usageLedger'
import { clearUsage, getUsageStats, listUsage, subscribeUsage, type UsageStats, type UsageStatsRange } from '@/services/agent/usageLedger'
import type { UsageStatsGroup, UsageStatsBucket } from '@/ai/core/usage-stats'
import { formatDuration } from '@/utils/format'
import { useSettingsStore } from '@/stores/settings'
import Meter from '@/components/primitives/Meter.vue'
import AppButton from '@/components/primitives/AppButton.vue'

const { t } = useI18n()
const settingsStore = useSettingsStore()

// 5h rides the same hourly bucketing as "today" and matches the composer
// panel's 5h window — one vocabulary, not two.
const RANGES: UsageStatsRange[] = ['5h', 'today', '7d', '30d', 'all']
const range = ref<UsageStatsRange>('7d')
const stats = ref<UsageStats | null>(null)
const loaded = ref(false)
const recent = ref<UsageEntry[]>([])

async function refresh() {
  const [nextStats, nextRecent] = await Promise.all([
    getUsageStats(range.value),
    listUsage({ limit: 20 }),
  ])
  stats.value = nextStats
  // The ledger lists oldest→newest; a "recent" table reads newest first.
  recent.value = [...nextRecent].reverse()
  loaded.value = true
}

onMounted(refresh)
watch(range, refresh)

// Live refresh, debounced — a streaming turn appends several entries and the
// full recompute is cheap in main, but one refresh per landing entry is waste.
let refreshTimer: ReturnType<typeof setTimeout> | null = null
const stopUsage = subscribeUsage(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { void refresh() }, 300)
})
onScopeDispose(() => {
  stopUsage()
  if (refreshTimer) clearTimeout(refreshTimer)
})

const hasData = computed(() => (stats.value?.totals.attempted ?? 0) > 0)

/** The four-way token split the ledger's own fallback algebra sums to
 *  (input + output + cacheRead + cacheWrite). reasoningTokens is a
 *  vendor-reported subset of output, so it never takes a segment. */
const composition = computed(() => {
  const totals = stats.value?.totals
  if (!totals) return []
  const segments = [
    { key: 'input', tokens: totals.inputTokens },
    { key: 'output', tokens: totals.outputTokens },
    { key: 'cacheRead', tokens: totals.cacheReadTokens },
    { key: 'cacheWrite', tokens: totals.cacheWriteTokens },
  ] as const
  const sum = segments.reduce((acc, seg) => acc + seg.tokens, 0)
  if (sum <= 0) return []
  return segments
    .filter((seg) => seg.tokens > 0)
    .map((seg) => ({ ...seg, share: (seg.tokens / sum) * 100 }))
})

function maxGroupTokens(groups: UsageStatsGroup[]): number {
  return groups[0]?.tokens ?? 1
}

// ── Trend metric ─────────────────────────────────────────────────────────────
// Labels reuse the table column vocabulary (col.tokens/cost/requests) — one
// set of words for the same concept across the whole panel.
const TREND_METRICS = ['tokens', 'cost', 'requests'] as const
type TrendMetric = (typeof TREND_METRICS)[number]
const trendMetric = ref<TrendMetric>('tokens')

function trendValue(b: UsageStatsBucket): number {
  if (trendMetric.value === 'requests') return b.requests
  if (trendMetric.value === 'cost') return b.costTotal ?? 0
  return b.tokens
}

function trendPct(b: UsageStatsBucket): string {
  const max = stats.value ? Math.max(...stats.value.buckets.map(trendValue), 1e-9) : 1
  const value = trendValue(b)
  return value > 0 ? `${Math.max(4, Math.round((value / max) * 100))}%` : '0%'
}

function trendTitle(b: UsageStatsBucket): string {
  const parts = [b.label]
  if (b.requests) parts.push(`${fmtNum(b.tokens)} · ${b.requests}`)
  else parts.push(fmtNum(b.tokens))
  if (b.costTotal != null && b.costTotal > 0) parts.push(fmtCost(b.costTotal))
  return parts.join(' · ')
}

/** The provider column speaks the user's language: a configured display
 *  name wins over the raw ledger id. */
function providerLabel(providerId: string | null | undefined): string {
  const id = providerId ?? 'unknown'
  return settingsStore.availableProviders().find((p) => p.id === id)?.displayName ?? id
}

function fmtNum(n: number): string { if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`; if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`; return String(n) }
function fmtCost(c: number | null): string { return c == null ? '—' : `$${c.toFixed(c > 0 && c < 1 ? 4 : 2)}` }
function fmtPct(rate: number | null): string { return rate == null ? '—' : `${Math.round(rate * 1000) / 10}%` }
function fmtSpeed(rate: number | null): string { return rate == null ? '—' : `${Math.round(rate)} ${t('workbench.settings.statistics.tokensPerSec')}` }
function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  return formatDuration(ms)
}
/** Same-day requests show a bare clock time; older ones need the date or
 *  "14:32:05" from three days ago reads as if it happened today. */
function fmtTime(ts: string | number): string {
  try {
    const date = new Date(ts)
    const now = new Date()
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
    return sameDay ? date.toLocaleTimeString() : date.toLocaleString()
  } catch { return '' }
}

async function exportJson() {
  if (!stats.value) return
  const since = stats.value.fromMs != null ? new Date(stats.value.fromMs).toISOString() : undefined
  const entries = await listUsage(since ? { since } : {})
  const payload = { exportedAt: new Date().toISOString(), range: range.value, stats: stats.value, entries }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  downloadBlob(blob, `tdease-usage-${range.value}-${new Date().toISOString().slice(0, 10)}.json`)
}

// CSV twin of the JSON export: spreadsheet-friendly (BOM for Excel, quoted
// cells), same range scope. One row per ledger entry.
const CSV_HEADERS = ['startedAt', 'provider', 'model', 'status', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'costUsd', 'durationMs'] as const

function csvCell(value: string | number | null): string {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

async function exportCsv() {
  if (!stats.value) return
  const since = stats.value.fromMs != null ? new Date(stats.value.fromMs).toISOString() : undefined
  const entries = await listUsage(since ? { since } : {})
  const rows = entries.map((entry) => [
    entry.startedAt,
    entry.model.provider ?? '',
    entry.model.modelId ?? '',
    entry.status,
    entry.usage?.input.totalTokens ?? 0,
    entry.usage?.output.totalTokens ?? 0,
    entry.usage?.output.reasoningTokens ?? 0,
    entry.usage?.cache.readTokens ?? 0,
    entry.usage?.cache.writeTokens ?? 0,
    entry.usage?.totalTokens ?? 0,
    entry.usage?.costTotal ?? '',
    entry.durationMs ?? '',
  ])
  const csv = `\uFEFF${[CSV_HEADERS, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `tdease-usage-${range.value}-${new Date().toISOString().slice(0, 10)}.csv`)
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

// Two-step clear: first click arms, second click within the window wipes the
// whole ledger — a destructive action behind an accidental single click.
const clearArmed = ref(false)
let clearTimer: ReturnType<typeof setTimeout> | null = null
function onClear() {
  if (!clearArmed.value) {
    clearArmed.value = true
    if (clearTimer) clearTimeout(clearTimer)
    clearTimer = setTimeout(() => { clearArmed.value = false }, 3000)
    return
  }
  clearArmed.value = false
  void clearUsage().then(refresh)
}
</script>

<style scoped>
.settings-tab-content { width: 100%; max-width: 100%; min-width: 0; }

.section { margin-bottom: var(--space-6); }
.section:last-child { margin-bottom: 0; }

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.section-title {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--color-text);
  letter-spacing: 0.05em;
  margin: 0;
}

.surface-card {
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: 8px;
}

/* ─── Toolbar ─── */
.stats-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-5); }
.stats-toolbar-actions { display: flex; align-items: center; gap: var(--space-2); }
.stats-ranges { display: inline-flex; padding: 2px; background: var(--color-bg-secondary); border: var(--line-w) solid var(--line-hairline); border-radius: var(--radius-sm); }
.stats-range {
  padding: var(--space-1) var(--space-3);
  font-size: var(--text-label);
  color: var(--color-text-secondary);
  background: none;
  border: none;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.stats-range:hover { color: var(--color-text); }
.stats-range.active { background: var(--color-primary-soft); color: var(--color-interact-text); font-weight: 600; }

/* ─── Hero cards ─── */
.stats-hero { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }

.stats-card {
  padding: var(--space-4) var(--space-5);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
/* A failing streak speaks in the status channel — quiet elsewhere. */
.stats-card--warn .stats-value { color: var(--color-warning-text, var(--color-warning)); }

.stats-value { font-size: var(--text-xl); font-weight: 700; color: var(--color-text); font-family: var(--font-mono); }
.stats-label { font-size: var(--domain-text-meta); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.06em; }

/* ─── Token composition strip ─── */
.stats-comp { margin-top: var(--space-3); }
.stats-comp-bar {
  display: flex;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
}
.stats-comp-seg { height: 100%; min-width: 2px; }
.stats-comp-seg[data-seg='input'] { background: var(--color-primary); }
.stats-comp-seg[data-seg='output'] { background: var(--color-success, var(--color-primary-soft)); }
.stats-comp-seg[data-seg='cacheRead'] { background: var(--color-warning, var(--color-text-muted)); }
.stats-comp-seg[data-seg='cacheWrite'] { background: var(--color-text-muted); opacity: 0.55; }
.stats-comp-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-2) var(--space-4);
  margin-top: var(--space-2);
  font-size: var(--text-label);
  color: var(--color-text-secondary);
}
.stats-comp-item { display: inline-flex; align-items: center; gap: var(--space-1-5); }
.stats-comp-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
.stats-comp-dot[data-seg='input'] { background: var(--color-primary); }
.stats-comp-dot[data-seg='output'] { background: var(--color-success, var(--color-primary-soft)); }
.stats-comp-dot[data-seg='cacheRead'] { background: var(--color-warning, var(--color-text-muted)); }
.stats-comp-dot[data-seg='cacheWrite'] { background: var(--color-text-muted); opacity: 0.55; }
.stats-comp-item b { font-family: var(--font-mono); font-weight: 600; color: var(--color-text); }
.stats-comp-note { color: var(--color-text-muted); }

/* ─── Trend ─── */
.trend-card { padding: var(--space-4); }
.trend-bars { display: flex; align-items: flex-end; gap: 2px; height: 120px; }
.trend-col { flex: 1; height: 100%; display: flex; align-items: flex-end; min-width: 0; }
.trend-bar {
  width: 100%;
  min-height: 0;
  border-radius: 2px 2px 0 0;
  background: var(--color-primary);
  opacity: 0.85;
  transition: height var(--dur-normal, 0.2s) var(--ease-out);
}
.trend-bar:hover { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .trend-bar { transition: none; }
}
.trend-axis {
  display: flex;
  justify-content: space-between;
  margin-top: var(--space-2);
  font-size: var(--text-label);
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

/* ─── Bars ─── */
.stats-bars { display: flex; flex-direction: column; gap: var(--space-2); }
.stats-bar-row { display: flex; align-items: center; gap: var(--space-3); }
.stats-bar-head {
  font-size: var(--domain-text-meta); color: var(--color-text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.stats-bar-name {
  width: 170px; font-size: var(--text-sm); color: var(--color-text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0;
  display: flex; flex-direction: column; line-height: 1.3;
}
.stats-bar-head .stats-bar-name { font-size: inherit; }
.stats-bar-sub { font-size: var(--text-label); color: var(--color-text-muted); }
/* The bar itself is primitives/Meter.vue — composited scaleX fill and the
   reduced-motion fallback come from there. This only owns the row geometry. */
.stats-bar-meter { flex: 1; min-width: 0; }
.stats-bar-val { width: 56px; font-size: var(--text-label); font-family: var(--font-mono); color: var(--color-text-muted); text-align: right; flex-shrink: 0; }
.stats-bar-val--req { width: 44px; }
.stats-bar-val--cost { width: 72px; }
.stats-bar-head .stats-bar-val { font-family: var(--font-body); font-size: var(--domain-text-meta); }

/* ─── Request table ─── */
.req-list { font-size: var(--text-sm); }
.req-row { display: grid; grid-template-columns: 100px 110px 1fr 72px 72px 64px 80px; gap: var(--space-2); padding: var(--space-1) var(--space-2); align-items: center; }
.req-head { font-weight: 600; color: var(--color-text-muted); text-transform: uppercase; font-size: var(--domain-text-meta); letter-spacing: 0.04em; border-bottom: var(--line-w) solid var(--line-hairline); padding-bottom: var(--space-1-5); margin-bottom: var(--space-1); }
.mono { font-family: var(--font-mono); font-size: var(--text-label); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim { color: var(--color-text-muted); }
.st.ok { color: var(--color-success-text); }
.st.error { color: var(--color-error-text); }
.st.aborted { color: var(--color-warning-text); }
/* usage_missing and any future status render neutral instead of unstyled. */
.st { color: var(--color-text-muted); }
.stats-scope { font-size: var(--text-label); color: var(--color-text-muted); }
</style>
