<template>
  <div class="spectrum-viewer">
    <div class="spectrum-viewer__toolbar">
      <div class="toolbar-left">
        <el-tag v-if="peakCount > 0" type="info" size="small">
          {{ t('visualization.viewer.peaks', { count: peakCount }) }}
        </el-tag>
        <el-tag v-if="peakCount > 0" type="info" size="small">
          {{ mzLabel }} / {{ intensityLabel }}
        </el-tag>
        <el-tag v-if="selectedPeaks > 0" type="success" size="small">
          {{ t('visualization.viewer.peaksSelected', { count: selectedPeaks }) }}
        </el-tag>
      </div>
    </div>

    <div class="spectrum-container">
      <div v-if="!loadError && figure.data.length === 0" class="spectrum-container__state">
        {{ t('common.status.noData') }}
      </div>
      <div
        v-show="figure.data.length > 0 && !loadError"
        ref="plotEl"
        class="spectrum-container__canvas"
      />
      <div v-if="loadError" class="spectrum-container__fallback">
        <div class="spectrum-container__state spectrum-container__state--warn">
          {{ t('visualization.viewer.renderFailed') }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Self-contained spectrum viewer.
 *
 * TWO RENDERING PATHS:
 *   Datasets path (primary) — resolves columns via spectrumInput.ts, builds
 *     bar traces from peak data, manages Plotly lifecycle directly.
 *   DSL path (backward compat) — when viewSpec.figure is present, renders
 *     it verbatim through Plotly.
 *
 * Lifecycle: onMounted → Plotly.react → bind events
 *            watch(figure, deep) → Plotly.react
 *            onBeforeUnmount → Plotly.purge
 */
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import PlotlyModule from 'plotly.js-dist-min'
import type { Dataset, FilterDef, SelectionState, TableData } from '@/types/visualization'
import { normalizeSpectrumViewerInput } from '@/services/visualization/spectrumInput'
import { projectSpectrumBrushToFeatureIds } from '@/services/visualization/viewerCompilers'
import { plotlyAccentColor, plotlyAxisStyle, plotlyBaseLayout, plotlyPrimaryFill, plotlySeriesColor } from '@/services/visualization/plotlyTheme'

/* ── Types ──────────────────────────────────────────────────────────── */

interface PlotlyFigure {
  data: Array<Record<string, unknown>>
  layout: Record<string, unknown>
  config: Record<string, unknown>
}

interface PlotlyApi {
  react: (
    el: HTMLElement,
    data: Array<Record<string, unknown>>,
    layout: Record<string, unknown>,
    config: Record<string, unknown>,
  ) => Promise<unknown>
  purge: (el: HTMLElement) => void
  Plots: { resize: (el: HTMLElement) => void }
}

interface Props {
  data?: TableData | null
  config?: Record<string, unknown>
  selection?: SelectionState | null
  datasets?: Dataset[]
  viewSpec?: Record<string, unknown>
}

/* ── Props & emit ───────────────────────────────────────────────────── */

const props = defineProps<Props>()
const { t } = useI18n()
const emit = defineEmits<{
  selectionChange: [selection: SelectionState]
  peakClick: [peak: unknown]
}>()

/* ── Plotly refs ────────────────────────────────────────────────────── */

const plotly = PlotlyModule as unknown as PlotlyApi
const plotEl = ref<HTMLElement | null>(null)
const plottedOnce = shallowRef(false)
const eventsBound = shallowRef(false)
const loadError = shallowRef<unknown>(null)

/* ── Local state ────────────────────────────────────────────────────── */

const localSelectedCount = ref(0)

/* ── Data parsing ───────────────────────────────────────────────────── */

const spectrumInput = computed(() => normalizeSpectrumViewerInput({
  data: props.data,
  config: props.config,
  datasets: props.datasets,
  viewSpec: props.viewSpec,
  selection: props.selection,
}))

const peakCount = computed(() =>
  spectrumInput.value.series.reduce((total, s) => total + s.peaks.length, 0),
)
const selectedPeaks = computed(() => localSelectedCount.value)
const mzLabel = computed(() => spectrumInput.value.series[0]?.mzColumn ?? 'Mass')
const intensityLabel = computed(() => spectrumInput.value.series[0]?.intensityColumn ?? 'intensity')

/* ── Plotly styling: token-driven theme (services/visualization/plotlyTheme) ── */

/* ── Figure building ────────────────────────────────────────────────── */

const figure = computed(() => buildFigure())

function buildFigure(): PlotlyFigure {
  // ── DSL path: pass through viewSpec.figure verbatim ──
  if (props.viewSpec?.figure) {
    const fig = props.viewSpec.figure as Record<string, unknown>
    return {
      data: Array.isArray(fig.data) ? fig.data as Array<Record<string, unknown>> : [],
      layout: (fig.layout as Record<string, unknown>) ?? {},
      config: (fig.config as Record<string, unknown>) ?? {},
    }
  }

  // ── Datasets path: build bar traces from spectrum series ──
  return {
    data: spectrumInput.value.series.map((entry, index) => {
      const direction = entry.direction === 'down' ? -1 : 1
      return {
        type: 'bar',
        name: entry.label || entry.id || `Dataset ${index + 1}`,
        x: entry.peaks.map((p) => p.mz),
        y: entry.peaks.map((p) => direction * Math.abs(p.intensity)),
        marker: { color: entry.color || plotlySeriesColor(index) },
        customdata: entry.peaks.map((p) => p.index),
        hovertemplate: 'Mass: %{x:.4f}<br>Intensity: %{y:.0f}<extra>%{fullData.name}</extra>',
      }
    }),
    layout: {
      ...plotlyBaseLayout(),
      title: { text: stringValue(props.viewSpec?.title) ?? 'Mass spectrum' },
      barmode: 'overlay',
      bargap: 0.05,
      xaxis: {
        ...plotlyAxisStyle(),
        title: { text: 'Mass' },
        ...(spectrumInput.value.mzRange ? { range: spectrumInput.value.mzRange } : {}),
      },
      yaxis: {
        ...plotlyAxisStyle(),
        title: { text: 'Intensity' },
        zeroline: true,
      },
      shapes: annotationShapes(),
      annotations: annotationLabels(),
    },
    config: { responsive: true, displaylogo: false },
  }
}

function annotationShapes(): Array<Record<string, unknown>> {
  const shapes: Array<Record<string, unknown>> = []
  for (const annotation of spectrumInput.value.annotations) {
    if (annotation.type === 'vline' && typeof annotation.x === 'number') {
      shapes.push({
        type: 'line',
        x0: annotation.x, x1: annotation.x, y0: 0, y1: 1,
        yref: 'paper',
        line: {
          color: annotation.color || plotlyAccentColor(),
          width: 1,
          dash: annotation.dash ? 'dash' : 'solid',
        },
      })
      continue
    }
    if (annotation.type === 'region' && Array.isArray(annotation.x)) {
      shapes.push({
        type: 'rect',
        x0: annotation.x[0], x1: annotation.x[1],
        y0: Array.isArray(annotation.y) ? annotation.y[0] : 0,
        y1: Array.isArray(annotation.y) ? annotation.y[1] : 1,
        yref: Array.isArray(annotation.y) ? 'y' : 'paper',
        fillcolor: annotation.fill || plotlyPrimaryFill(0.2),
        line: { width: 0 },
      })
    }
  }
  return shapes
}

function annotationLabels() {
  return spectrumInput.value.annotations
    .filter((a) => a.label && typeof a.x === 'number')
    .map((a) => ({
      x: a.x, y: 1, yref: 'paper',
      text: a.label,
      showarrow: false,
      font: { size: 10, color: a.color || plotlyAccentColor() },
    }))
}

/* ── Plotly lifecycle ───────────────────────────────────────────────── */

async function renderPlot() {
  const el = plotEl.value
  if (!el || figure.value.data.length === 0 || loadError.value) return
  await nextTick()
  const cloned = clonePlain(figure.value)
  const render = plotly.react.bind(plotly)
  try {
    await render(el, cloned.data, cloned.layout, cloned.config)
    bindPlotEvents(el)
    plottedOnce.value = true
  } catch (error) {
    loadError.value = error
  }
}

function bindPlotEvents(el: HTMLElement) {
  if (eventsBound.value) return
  const evt = el as HTMLElement & { on?: (event: string, handler: (...args: unknown[]) => void) => void }
  evt.on?.('plotly_selected', handleSelectionChange)
  evt.on?.('plotly_click', handlePeakClick)
  eventsBound.value = true
}

function unbindPlotEvents() {
  const el = plotEl.value as (HTMLElement & { removeAllListeners?: (event?: string) => void }) | null
  if (el) {
    el.removeAllListeners?.('plotly_click')
    el.removeAllListeners?.('plotly_selected')
  }
  eventsBound.value = false
}

onMounted(async () => { await renderPlot() })

// KeepAlive support: the Plotly plot is bound to the canvas DOM node, which
// KeepAlive keeps in its cache across tab switches. Pause click/selection
// listeners on deactivate (no point dispatching into a hidden plot) but do NOT
// purge — the plot stays rendered. True purge only on cache eviction.
onActivated(() => {
  if (plottedOnce.value && plotEl.value) bindPlotEvents(plotEl.value)
})
onDeactivated(() => { unbindPlotEvents() })

// `figure` is a computed that re-emits a new object on every change, so
// reference equality fires this watcher correctly. `deep: true` walked the
// whole Plotly figure tree on every tick for no reason.
watch(figure, () => { void renderPlot() })

onBeforeUnmount(() => {
  unbindPlotEvents()
  const el = plotEl.value
  if (el) {
    try { plotly.purge(el) } catch { /* ignore */ }
  }
})

/* ── Selection handlers ─────────────────────────────────────────────── */

function handleSelectionChange(eventData: unknown) {
  const record = eventData as Record<string, unknown> | null
  const points = Array.isArray(record?.points) ? record.points as Array<Record<string, unknown>> : []
  const range = isRecord(record?.range) && Array.isArray(record.range.x)
    ? record.range.x.map(Number)
    : []
  const projectedFeatureIds = range.length === 2
    ? projectSpectrumBrushToFeatureIds(props.datasets ?? [], range[0], range[1])
    : []

  if (points.length === 0 && projectedFeatureIds.length === 0) {
    localSelectedCount.value = 0
    emit('selectionChange', {
      selectedIndices: new Set(),
      selectedRefs: [],
      filterCriteria: [],
      brushRegion: null,
    })
    return
  }

  const indices = extractIndices(points)
  localSelectedCount.value = indices.size
  const selectedPeak = indices.size > 0
    ? spectrumInput.value.series[0]?.peaks[indices.values().next().value as number]
    : null
  if (selectedPeak) emit('peakClick', selectedPeak)

  // Enrich with broadcastColumn filter if configured
  const broadcastColumn = spectrumInput.value.interactionConfig?.broadcastColumn
  const firstIdx = indices.values().next().value
  const row = typeof firstIdx === 'number'
    ? spectrumInput.value.series[0]?.peaks[firstIdx]?.sourceRow
    : null
  const filterCriteria: FilterDef[] = []
  if (broadcastColumn && row?.[broadcastColumn] != null && row[broadcastColumn] !== '') {
    filterCriteria.push({ columnId: broadcastColumn, operator: 'eq', value: String(row[broadcastColumn]) })
  }

  emit('selectionChange', {
    selectedIndices: indices,
    selectedRefs: projectedFeatureIds.map(value => ({ field: 'feature.id', value })),
    filterCriteria,
    brushRegion: null,
  })
}

function handlePeakClick(eventData: unknown) {
  const record = eventData as Record<string, unknown> | null
  const points = Array.isArray(record?.points) ? record.points as Array<Record<string, unknown>> : []
  const indices = extractIndices(points)
  const peak = indices.size > 0
    ? spectrumInput.value.series[0]?.peaks[indices.values().next().value as number]
    : null
  if (peak) emit('peakClick', peak)
}

function extractIndices(points: Array<Record<string, unknown>>): Set<number> {
  const indices = new Set<number>()
  for (const point of points) {
    const cd = point.customdata
    if (typeof cd === 'number') indices.add(cd)
    else {
      const pi = point.pointIndex
      if (typeof pi === 'number') indices.add(pi)
    }
  }
  return indices
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
</script>

<script lang="ts">
export default { name: 'SpectrumViewer' }
</script>

<style scoped>
.spectrum-viewer {
  display: flex;
  flex-direction: column;
  min-height: 320px;
  height: 100%;
}

.spectrum-viewer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2);
  border-bottom: var(--line-w) solid var(--line-hairline);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.spectrum-container {
  flex: 1;
  min-height: 260px;
  position: relative;
}

.spectrum-container__canvas {
  width: 100%;
  height: 100%;
  min-height: 260px;
}

.spectrum-container__state {
  height: 100%;
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  color: var(--color-text-secondary);
  text-align: center;
}

.spectrum-container__state--warn {
  min-height: 44px;
  justify-content: flex-start;
  color: var(--color-warning-text);
}

.spectrum-container__fallback {
  height: 100%;
  min-height: 260px;
  overflow: auto;
}
</style>
