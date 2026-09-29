<template>
  <div class="ctx-panel" role="dialog" :aria-label="t('agent.contextPanel.title')" @click.stop>
    <!-- Heading: the PI-Desktop framing — what the number MEANS is how much
         of the model's window is still free, so the remaining tokens and
         percentage lead. -->
    <div class="ctx-panel__section">
      <div class="ctx-panel__heading">
        <span class="ctx-panel__heading-value">{{ remainingLabel }}</span>
        <span class="ctx-panel__heading-unit">{{ t('agent.contextPanel.tokensLeft') }}</span>
        <span v-if="remainingPct != null" class="ctx-panel__heading-pct" :data-level="level">{{ remainingPct }}%</span>
      </div>
      <div class="ctx-panel__row">
        <span class="ctx-panel__title">{{ t('agent.contextPanel.capacity') }}</span>
        <span class="ctx-panel__value">
          {{ usedLabel }} / {{ totalLabel }}
          <span v-if="pct != null" class="ctx-panel__muted">({{ pct }}%)</span>
        </span>
      </div>
      <div class="ctx-panel__bar">
        <div class="ctx-panel__bar-fill" :data-level="level" :style="{ width: `${pct ?? 0}%` }" />
      </div>
    </div>

    <!-- This turn: the latest settled request's total and its generation
         speed — the two numbers that answer "is it slow or just big?". -->
    <div v-if="lastEntry" class="ctx-panel__section">
      <div class="ctx-panel__kpi">
        <span class="ctx-panel__kpi-label">{{ t('agent.contextPanel.lastRequest') }}</span>
        <span class="ctx-panel__kpi-value">{{ formatTokens(lastEntry.usage?.totalTokens ?? 0) }} {{ t('agent.contextPanel.tokens') }}</span>
      </div>
      <div class="ctx-panel__kpi">
        <span class="ctx-panel__kpi-label">{{ t('agent.contextPanel.speed') }}</span>
        <span class="ctx-panel__kpi-value">{{ speedLabel }}</span>
      </div>
    </div>

    <!-- Provider usage: the latest request's normalized breakdown. Each row
         appears only when the provider actually reported that counter. -->
    <div v-if="providerRows.length" class="ctx-panel__section">
      <div class="ctx-panel__row">
        <span class="ctx-panel__title">{{ t('agent.contextPanel.providerUsage') }}</span>
        <span v-if="lastEntry?.model.modelId" class="ctx-panel__muted">{{ lastEntry.model.modelId }}</span>
      </div>
      <div v-for="row in providerRows" :key="row.label" class="ctx-panel__row ctx-panel__row--sub">
        <span class="ctx-panel__muted">{{ row.label }}</span>
        <span class="ctx-panel__value">{{ row.value }}</span>
      </div>
    </div>

    <!-- Cache -->
    <div class="ctx-panel__section">
      <div class="ctx-panel__row">
        <span class="ctx-panel__title">{{ t('agent.contextPanel.cacheHit') }}</span>
        <span class="ctx-panel__value">{{ lastHitLabel }}</span>
      </div>
      <div class="ctx-panel__row ctx-panel__row--sub">
        <span class="ctx-panel__muted">{{ t('agent.contextPanel.cacheRecent') }}</span>
        <span class="ctx-panel__value">{{ recentHitLabel }}</span>
      </div>
    </div>

    <!-- Usage windows (local ledger; includes real cost) -->
    <div class="ctx-panel__section">
      <div class="ctx-panel__row">
        <span class="ctx-panel__title">{{ t('agent.contextPanel.recentUsage') }}</span>
        <span v-if="loading" class="ctx-panel__muted">{{ t('agent.contextPanel.loading') }}</span>
      </div>
      <div class="ctx-panel__row ctx-panel__row--sub">
        <span class="ctx-panel__muted">{{ t('agent.contextPanel.window5h') }}</span>
        <span class="ctx-panel__value">{{ windowSummary(fiveHours) }}</span>
      </div>
      <div class="ctx-panel__row ctx-panel__row--sub">
        <span class="ctx-panel__muted">{{ t('agent.contextPanel.window7d') }}</span>
        <span class="ctx-panel__value">{{ windowSummary(sevenDays) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * ContextUsagePanel — the rich readout behind the composer's context ring.
 * The ring stays a quiet always-on gauge; this panel is what a hover or
 * click opens: remaining context (PI-Desktop's framing), the latest
 * request's total and generation speed, its provider-side token breakdown,
 * cache hit rates (latest + recent average), and local usage windows with
 * real cost. All numbers come from recorded data — vendor-side subscription
 * quotas are not queried, so nothing here fabricates a "remaining quota".
 */
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getUsageStats, listUsage, subscribeUsage } from '@/services/agent/usageLedger'

const { t } = useI18n()

const props = defineProps<{
  tokens: number | null
  windowSize: number | undefined
  lastHitRate: number | null
}>()

// ── Capacity / remaining ─────────────────────────────────────────────────────

const pct = computed<number | null>(() =>
  props.windowSize && props.tokens != null
    ? Math.min(100, Math.round((props.tokens / props.windowSize) * 100))
    : null)

const remainingPct = computed<number | null>(() => (pct.value == null ? null : 100 - pct.value))

/** PI-Desktop's levels, on remaining: comfortable / warning ≤25% / critical ≤10%. */
const level = computed<'comfortable' | 'warning' | 'critical'>(() => {
  const remaining = remainingPct.value
  if (remaining == null) return 'comfortable'
  if (remaining <= 10) return 'critical'
  if (remaining <= 25) return 'warning'
  return 'comfortable'
})

function formatTokens(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}
const usedLabel = computed(() => formatTokens(props.tokens))
const totalLabel = computed(() => formatTokens(props.windowSize))
const remainingLabel = computed(() => {
  if (props.windowSize && props.tokens != null) {
    return formatTokens(Math.max(0, props.windowSize - props.tokens))
  }
  return props.windowSize ? props.windowSize.toLocaleString() : '—'
})

// ── Cache hit rates ──────────────────────────────────────────────────────────

function formatRate(rate: number | null | undefined): string {
  return rate == null ? '—' : `${Math.round(rate * 1000) / 10}%`
}
const lastHitLabel = computed(() => formatRate(props.lastHitRate))

// ── Ledger: latest settled request + windows ─────────────────────────────────

interface UsageWindow {
  requests: number
  tokens: number
  cost: number | null
}

const lastEntry = ref<import('@/ai/core/usage-ledger').UsageEntry | null>(null)
const fiveHours = ref<UsageWindow | null>(null)
const sevenDays = ref<UsageWindow | null>(null)
const recentHit = ref<number | null>(null)
const loading = ref(true)

const recentHitLabel = computed(() => formatRate(recentHit.value))

/** tokens/s of the latest settled request — ≈-prefixed when duration is missing. */
const speedLabel = computed(() => {
  const entry = lastEntry.value
  if (!entry?.usage) return '—'
  const output = entry.usage.output.totalTokens
  if (output <= 0) return '—'
  if (entry.durationMs && entry.durationMs > 0) {
    return `${Math.round(output / (entry.durationMs / 1000))} ${t('agent.contextPanel.tokensPerSec')}`
  }
  return `≈${output} ${t('agent.contextPanel.tokensPerSec')}`
})

/** The provider-reported counters, shown only when the provider sent them. */
const providerRows = computed(() => {
  const usage = lastEntry.value?.usage
  if (!usage) return []
  const rows: Array<{ label: string; value: string }> = [
    { label: t('agent.contextPanel.input'), value: formatTokens(usage.input.totalTokens) },
    { label: t('agent.contextPanel.output'), value: formatTokens(usage.output.totalTokens) },
  ]
  if (usage.output.reasoningTokens != null && usage.output.reasoningTokens > 0) {
    rows.push({ label: t('agent.contextPanel.reasoning'), value: formatTokens(usage.output.reasoningTokens) })
  }
  if (usage.cache.readTokens != null) {
    rows.push({ label: t('agent.contextPanel.cacheRead'), value: formatTokens(usage.cache.readTokens) })
  }
  if (usage.cache.hitRatio != null) {
    rows.push({ label: t('agent.contextPanel.cacheHitShort'), value: formatRate(usage.cache.hitRatio) })
  }
  if (usage.cache.writeTokens != null) {
    rows.push({ label: t('agent.contextPanel.cacheWrite'), value: formatTokens(usage.cache.writeTokens) })
  }
  return rows
})

function formatCost(value: number): string {
  if (value === 0) return '$0'
  if (value < 1) return `$${value.toFixed(value < 0.01 ? 4 : 3)}`
  return `$${value.toFixed(2)}`
}

function windowSummary(window: UsageWindow | null): string {
  if (!window || window.requests === 0) return t('agent.contextPanel.noData')
  const parts = [`${window.requests} ${t('agent.contextPanel.requests')}`, formatTokens(window.tokens)]
  if (window.cost != null && window.cost > 0) parts.push(formatCost(window.cost))
  return parts.join(' · ')
}

async function refresh() {
  try {
    // Aggregates come from the main process over the FULL ledger (stats IPC);
    // a capped renderer page under-counted these windows on busy ledgers.
    const [last, five, seven] = await Promise.all([
      listUsage({ limit: 1 }),
      getUsageStats('5h'),
      getUsageStats('7d'),
    ])
    // The ledger lists oldest→newest; the panel speaks about THE latest
    // settled request.
    lastEntry.value = [...last].reverse().find((entry) => entry.status === 'ok') ?? null
    fiveHours.value = toWindow(five)
    sevenDays.value = toWindow(seven)
    recentHit.value = seven?.totals.cacheHitRatio ?? null
  } catch {
    // Aggregates are best-effort; the panel still shows the live capacity.
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

// The panel can stay open across a whole turn: ride the ledger's live append
// stream (debounced like StatisticsPanel) so the windows and the last-request
// readout settle with the turn instead of going stale.
let refreshTimer: ReturnType<typeof setTimeout> | null = null
const stopUsage = subscribeUsage(() => {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { void refresh() }, 300)
})
onScopeDispose(() => {
  stopUsage()
  if (refreshTimer) clearTimeout(refreshTimer)
})

function toWindow(stats: import('@/ai/core/usage-stats').UsageStats | null): UsageWindow | null {
  if (!stats) return null
  return { requests: stats.totals.requests, tokens: stats.totals.totalTokens, cost: stats.totals.costTotal }
}
</script>

<style scoped>
.ctx-panel {
  min-width: 272px;
  padding: var(--space-3);
  background: var(--elev-2-bg, var(--color-bg));
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md, var(--shadow-sm));
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ctx-panel__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.ctx-panel__heading {
  display: flex;
  align-items: baseline;
  gap: var(--space-1-5);
}

.ctx-panel__heading-value {
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--color-text);
  font-family: var(--font-mono);
}

.ctx-panel__heading-unit {
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

/* The remaining-% chip carries the level colour: comfortable is quiet,
   warning/critical speak in the status channels. */
.ctx-panel__heading-pct {
  margin-left: auto;
  padding: 0 var(--space-1-5);
  border-radius: 999px;
  font-size: var(--text-label);
  font-family: var(--font-mono);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}
.ctx-panel__heading-pct[data-level='warning'] {
  background: color-mix(in srgb, var(--color-warning) 18%, transparent);
  color: var(--color-warning);
}
.ctx-panel__heading-pct[data-level='critical'] {
  background: color-mix(in srgb, var(--status-failed) 18%, transparent);
  color: var(--status-failed);
}

.ctx-panel__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.ctx-panel__row--sub { font-size: var(--text-label); }

.ctx-panel__title {
  font-size: var(--text-label);
  font-weight: 600;
  color: var(--color-text);
}
.ctx-panel__value {
  font-size: var(--text-label);
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
  white-space: nowrap;
}
.ctx-panel__muted {
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

.ctx-panel__kpi {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
}
.ctx-panel__kpi-label {
  font-size: var(--text-label);
  color: var(--color-text-muted);
}
.ctx-panel__kpi-value {
  font-size: var(--text-label);
  font-family: var(--font-mono);
  color: var(--color-text);
}

.ctx-panel__bar {
  height: 6px;
  border-radius: 999px;
  background: var(--color-bg-tertiary);
  overflow: hidden;
}
.ctx-panel__bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--color-primary);
  transition: width var(--dur-normal, 0.2s) var(--ease-out);
}
.ctx-panel__bar-fill[data-level='warning'] {
  background: var(--color-warning);
}
.ctx-panel__bar-fill[data-level='critical'] {
  background: var(--status-failed);
}
</style>
