<template>
  <div class="metrics-card-viewer">
    <div v-if="!metrics.length" class="metrics-empty">{{ t('workbench.metricsCard.empty') }}</div>
    <div v-else class="metrics-body" :class="layoutClass">
      <div
        v-for="metric in metrics"
        :key="metric.name"
        class="metric-item"
        :class="`status-${statusOf(metric)}`"
      >
        <span class="metric-head">
          <span class="metric-name">{{ metric.name }}</span>
          <!--
            PRODUCT.md: status never relies on colour alone. The tinted border
            is decoration; this badge carries the word, and the glyph carries it
            again for anyone reading at a glance.
          -->
          <span
            v-if="statusOf(metric) !== 'ok'"
            class="metric-status"
            :aria-label="t(`workbench.metricsCard.status.${statusOf(metric)}Label`, { name: metric.name })"
          >
            <el-icon :size="12" aria-hidden="true" class="metric-status-icon">
              <Close v-if="statusOf(metric) === 'fail'" />
              <Warning v-else-if="statusOf(metric) === 'warn'" />
              <InfoFilled v-else />
            </el-icon>
            {{ t(`workbench.metricsCard.status.${statusOf(metric)}`) }}
          </span>
        </span>
        <span class="metric-value">
          {{ formatValue(metric.value) }}
          <span v-if="metric.unit" class="metric-unit">{{ metric.unit }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Close, Warning, InfoFilled } from '@element-plus/icons-vue'
import type { Dataset } from '@/types/visualization'

type MetricStatus = 'ok' | 'highlight' | 'warn' | 'fail'

interface MetricRow {
  name: string
  value: number
  unit?: string
  status?: string
}

const props = defineProps<{
  datasets?: Dataset[]
  viewSpec?: Record<string, unknown>
  data?: unknown
  config?: Record<string, unknown>
  selection?: unknown
}>()

const { t } = useI18n()

const metrics = computed<MetricRow[]>(() => {
  // Datasets path (new)
  if (props.datasets?.length) {
    const ds = props.datasets.find(d => d.kind === 'metrics')
    if (ds) {
      return ds.rows.map(r => ({
        name: String(r.metric ?? r.name ?? ''),
        value: Number(r.value ?? 0),
        unit: r.unit ? String(r.unit) : undefined,
        status: r.status ? String(r.status) : undefined,
      }))
    }
  }
  // Legacy path
  if (props.data && typeof props.data === 'object') {
    const d = props.data as Record<string, unknown>
    const rows = (d.tables as Record<string, unknown>[] | undefined)?.[0]?.rows as MetricRow[] | undefined
    if (rows?.length) return rows
  }
  return []
})

const highlightMetrics = computed<string[]>(() =>
  Array.isArray(props.viewSpec?.highlightMetrics)
    ? (props.viewSpec!.highlightMetrics as string[])
    : []
)

const thresholds = computed<Record<string, { warn: number; fail: number }>>(() =>
  (props.viewSpec?.thresholds as Record<string, { warn: number; fail: number }>) ?? {}
)

const layoutClass = computed(() =>
  props.viewSpec?.layout === 'list' ? 'layout-list' : 'layout-grid'
)

const statusOf = (m: MetricRow): MetricStatus => {
  const threshold = thresholds.value[m.name]
  if (threshold && m.value <= threshold.fail) return 'fail'
  if (threshold && m.value <= threshold.warn) return 'warn'
  if (highlightMetrics.value.includes(m.name)) return 'highlight'
  return 'ok'
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString()
  if (Math.abs(v) < 0.01) return v.toExponential(2)
  return v.toFixed(4)
}
</script>

<style scoped>
.metrics-card-viewer {
  padding: var(--space-3);
}
.metrics-empty {
  color: var(--icon-muted);
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
  text-align: center;
  padding: var(--space-5);
}
.metrics-body {
  display: grid;
  gap: var(--space-2);
}
.layout-grid {
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
}
.layout-list {
  grid-template-columns: 1fr;
}
.metric-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-md);
  background: var(--color-bg);
}
.metric-item.status-highlight {
  border-color: var(--color-info-text);
  background: color-mix(in srgb, var(--color-info) 8%, var(--color-bg));
}
.metric-item.status-warn {
  border-color: var(--color-warning-text);
  background: color-mix(in srgb, var(--color-warning) 8%, var(--color-bg));
}
.metric-item.status-fail {
  border-color: var(--color-error-text);
  background: color-mix(in srgb, var(--color-error) 8%, var(--color-bg));
}
.metric-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  min-width: 0;
}
.metric-name {
  font-size: var(--text-label);
  line-height: var(--text-label-lh);
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.metric-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  font-size: var(--text-label);
  line-height: var(--text-label-lh);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--color-text-secondary);
}
.metric-status-mark {
  font-weight: 700;
}
.status-highlight .metric-status { color: var(--color-info-text); }
.status-warn .metric-status { color: var(--color-warning-text); }
.status-fail .metric-status { color: var(--color-error-text); }
.metric-value {
  font-size: var(--text-xl);
  line-height: var(--text-xl-lh);
  font-weight: 700;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
.metric-unit {
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--icon-muted);
  margin-left: var(--space-1);
}
</style>
