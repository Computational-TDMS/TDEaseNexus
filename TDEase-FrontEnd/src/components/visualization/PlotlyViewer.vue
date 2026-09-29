<template>
  <div class="plotly-viewer" data-testid="plotly-viewer">
    <div ref="canvasEl" class="plotly-viewer__canvas">
      <div v-if="plotData.length === 0" class="plotly-viewer__state">
        <pre>{{ emptyStateMessage }}</pre>
      </div>
      <div
        v-show="plotData.length > 0 && !loadError"
        ref="plotEl"
        class="plotly-viewer__plot"
        data-testid="plotly-canvas"
      />
      <div v-if="loading && plotData.length > 0" class="plotly-viewer__state plotly-viewer__state--overlay">
        {{ t('visualization.viewer.loading') }}
      </div>
      <div v-if="loadError" class="plotly-viewer__fallback">
        <div class="plotly-viewer__state plotly-viewer__state--warn">
          <pre>{{ renderErrorMessage }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import PlotlyModule from 'plotly.js-dist-min'
import type { Dataset, SelectionState } from '@/types/visualization'

const { t } = useI18n()

interface PlotlyFigure {
  data?: Array<Record<string, unknown>>
  layout?: Record<string, unknown>
  config?: Record<string, unknown>
}

interface PlotlyApi {
  newPlot: (
    element: HTMLElement,
    data: Array<Record<string, unknown>>,
    layout: Record<string, unknown>,
    config: Record<string, unknown>,
  ) => Promise<unknown> | unknown
  react?: PlotlyApi['newPlot']
  purge?: (element: HTMLElement) => void
  Plots?: {
    resize?: (element: HTMLElement) => Promise<unknown> | unknown
  }
}

interface Props {
  /** Reserved for back-compat with viewer hosts still passing datasets. The
   *  PlotlyViewer no longer reads rows — it renders the figure inside
   *  ``viewSpec.figure`` verbatim. The backend binder compiles that figure. */
  datasets?: Dataset[]
  viewSpec?: Record<string, unknown>
  data?: unknown
  config?: Record<string, unknown>
  selection?: SelectionState | null
}

const props = defineProps<Props>()
const emit = defineEmits<{
  selectionChange: [selection: SelectionState]
  configChange: [config: Record<string, unknown>]
}>()

const plotEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLElement | null>(null)
const plotly = PlotlyModule as PlotlyApi
const loading = shallowRef(false)
const loadError = shallowRef<unknown>(null)
const plottedOnce = shallowRef(false)
const eventsBound = shallowRef(false)
let resizeObserver: ResizeObserver | null = null
let resizeFrame: number | null = null

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const figure = computed<PlotlyFigure>(() => {
  const spec = props.viewSpec ?? {}
  const explicit = asRecord(spec.figure)
  if (explicit) {
    return {
      data: Array.isArray(explicit.data) ? explicit.data as Array<Record<string, unknown>> : [],
      layout: asRecord(explicit.layout) ?? {},
      config: asRecord(explicit.config) ?? {},
    }
  }
  const fallback = compileFallbackFigure()
  if (fallback) return fallback
  return { data: [], layout: {}, config: {} }
})

const plotData = computed(() => figure.value.data ?? [])
const inputRows = computed(() => rowsFromInput(Array.isArray(props.datasets) ? props.datasets : [], props.data))
const plotLayout = computed<Record<string, unknown>>(() => ({
  autosize: true,
  margin: { l: 56, r: 24, t: 40, b: 48 },
  ...(figure.value.layout ?? {}),
}))
const plotConfig = computed<Record<string, unknown>>(() => ({
  responsive: true,
  displaylogo: false,
  ...(figure.value.config ?? {}),
  ...(props.config ?? {}),
}))
const emptyStateMessage = computed(() => {
  const spec = props.viewSpec ?? {}
  const explicitError = stringValue(spec._error) ?? stringValue(asRecord(props.data)?.visualizationError)
  if (explicitError) return explicitError
  if (asRecord(spec.figure)) return t('visualization.viewer.emptyTraces')
  if (asRecord(spec.chart) && inputRows.value.length === 0) {
    return t('visualization.viewer.emptyNotBound')
  }
  return t('common.status.noData')
})
const renderErrorMessage = computed(() => {
  if (loadError.value instanceof Error && loadError.value.message) {
    return t('visualization.viewer.renderFailedPrefix', { error: loadError.value.message })
  }
  if (typeof loadError.value === 'string' && loadError.value.trim()) {
    return t('visualization.viewer.renderFailedPrefix', { error: loadError.value })
  }
  return t('visualization.viewer.renderFailed')
})

async function renderPlot() {
  const element = plotEl.value
  if (!element || plotData.value.length === 0 || loadError.value) return
  await nextTick()
  const render = plottedOnce.value && plotly.react ? plotly.react : plotly.newPlot
  try {
    await render(
      element,
      clonePlain(plotData.value),
      clonePlain(plotLayout.value),
      clonePlain(plotConfig.value),
    )
    bindPlotEvents(element)
    plottedOnce.value = true
    schedulePlotResize()
  } catch (error) {
    loadError.value = error
  }
}

function schedulePlotResize() {
  const element = plotEl.value
  if (!element || !plottedOnce.value || !plotly.Plots?.resize) return
  if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
  resizeFrame = window.requestAnimationFrame(() => {
    resizeFrame = null
    try { void plotly.Plots?.resize?.(element) } catch { /* ignore Plotly resize errors */ }
  })
}

function bindPlotEvents(element: HTMLElement) {
  if (eventsBound.value) return
  const eventElement = element as HTMLElement & {
    on?: (event: string, handler: (payload: unknown) => void) => void
  }
  eventElement.on?.('plotly_click', handleClick)
  eventElement.on?.('plotly_selected', handleClick)
  eventsBound.value = true
}

function unbindPlotEvents() {
  const element = plotEl.value as (HTMLElement & {
    removeAllListeners?: (event?: string) => void
  }) | null
  if (element) {
    element.removeAllListeners?.('plotly_click')
    element.removeAllListeners?.('plotly_selected')
  }
  eventsBound.value = false
}

// Resource lifecycle that survives KeepAlive. The Plotly plot is bound to the
// canvas DOM node, which KeepAlive keeps alive in its cache (hidden, detached)
// across tab switches — so the plot itself must NOT be purged on deactivate.
// What must pause is the work that only matters while visible: the
// ResizeObserver polling, the resize rAF, and the click/selected listeners
// (no point dispatching clicks into a hidden plot). On re-activation the
// container may have a new size, so re-observe and force one resize tick.
function observeContainer() {
  if (resizeObserver || typeof ResizeObserver === 'undefined') return
  if (!canvasEl.value) return
  resizeObserver = new ResizeObserver(() => schedulePlotResize())
  resizeObserver.observe(canvasEl.value)
}

function unobserveContainer() {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (resizeFrame !== null) {
    window.cancelAnimationFrame(resizeFrame)
    resizeFrame = null
  }
}

onMounted(async () => {
  observeContainer()
  await renderPlot()
})

onActivated(() => {
  // Re-attach the observers/listeners that were paused on deactivate, then
  // force one resize: the cached plot drew against the last visible size and
  // the container may have changed geometry while hidden.
  observeContainer()
  if (plottedOnce.value) schedulePlotResize()
})

onDeactivated(() => {
  // Pause visible-only work; keep the plot alive in cache (no purge).
  unobserveContainer()
  unbindPlotEvents()
})

// plotData/plotLayout/plotConfig are computeds that re-emit on every change,
// so reference equality fires this watcher. `deep: true` walked the whole
// Plotly object tree on each tick for nothing.
watch([plotData, plotLayout, plotConfig], () => {
  void renderPlot()
})

onBeforeUnmount(() => {
  // True teardown: cache is being evicted, destroy the plot for real.
  unobserveContainer()
  unbindPlotEvents()
  const element = plotEl.value
  if (element) {
    try { plotly.purge?.(element) } catch { /* ignore Plotly teardown errors */ }
  }
})

function handleClick(event: unknown) {
  const record = asRecord(event)
  const points = Array.isArray(record?.points) ? record.points : []
  const indices = points
    .map((point) => {
      const pointRecord = asRecord(point)
      return typeof pointRecord?.customdata === 'number'
        ? pointRecord.customdata
        : pointRecord?.pointIndex
    })
    .filter((index): index is number => typeof index === 'number')
  if (indices.length === 0) return
  emit('selectionChange', {
    selectedIndices: new Set(indices),
    selectedRefs: [],
    filterCriteria: [],
    brushRegion: null,
  })
}

function compileFallbackFigure(): PlotlyFigure | null {
  const spec = props.viewSpec ?? {}
  const chart = asRecord(spec.chart) ?? asRecord(spec) ?? {}
  const datasets = Array.isArray(props.datasets) ? props.datasets : []
  const rows = rowsFromInput(datasets, props.data)
  if (rows.length === 0) return null

  const xColumn = stringValue(chart.x)
    ?? stringValue(chart.xColumn)
    ?? stringValue(spec.mzColumn)
    ?? inferColumn(rows, ['mz', 'm/z', 'mass', 'monomass', 'x'])
  const yColumn = stringValue(chart.y)
    ?? stringValue(chart.yColumn)
    ?? stringValue(spec.intensityColumn)
    ?? inferColumn(rows, ['intensity', 'height', 'abundance', 'y'])
  if (!xColumn || !yColumn) return null

  const type = stringValue(chart.type) ?? (datasets.some((dataset) => dataset.kind === 'peak_table') ? 'bar' : 'scatter')
  const x = rows.map((row) => toFiniteNumber(row[xColumn])).filter((value): value is number => value !== null)
  const y = rows.map((row) => toFiniteNumber(row[yColumn])).filter((value): value is number => value !== null)
  if (x.length === 0 || y.length === 0 || x.length !== y.length) return null

  return {
    data: [{
      type: type === 'line' ? 'scatter' : type,
      mode: type === 'line' ? 'lines' : type === 'scatter' ? 'markers' : undefined,
      x,
      y,
      customdata: rows.map((_, index) => index),
      marker: asRecord(chart.marker) ?? undefined,
      name: stringValue(chart.name) ?? datasets[0]?.label ?? 'Data',
    }],
    layout: {
      title: stringValue(spec.title) ? { text: stringValue(spec.title) } : undefined,
      xaxis: { title: { text: xColumn } },
      yaxis: { title: { text: yColumn } },
    },
    config: {},
  }
}

function rowsFromInput(datasets: Dataset[], data: unknown): Array<Record<string, unknown>> {
  const datasetRows = datasets.flatMap((dataset) => Array.isArray(dataset.rows) ? dataset.rows : [])
  if (datasetRows.length > 0) return datasetRows
  const record = asRecord(data)
  if (Array.isArray(record?.rows)) return record.rows.filter(isRecord)
  if (Array.isArray(data)) return data.filter(isRecord)
  return []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function inferColumn(rows: Array<Record<string, unknown>>, candidates: string[]): string | undefined {
  const keys = Object.keys(rows[0] ?? {})
  return keys.find((key) => candidates.some((candidate) => key.toLowerCase() === candidate.toLowerCase()))
    ?? keys.find((key) => candidates.some((candidate) => key.toLowerCase().includes(candidate.toLowerCase())))
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
</script>

<style scoped>
.plotly-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 320px;
  background: var(--color-bg-secondary, var(--color-bg));
  color: var(--color-text, var(--color-text));
}

.plotly-viewer__canvas {
  flex: 1;
  min-height: 260px;
  position: relative;
}

.plotly-viewer__plot {
  width: 100%;
  height: 100%;
  min-height: 260px;
}

.plotly-viewer__state {
  height: 100%;
  min-height: 240px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  color: var(--color-text-muted, var(--color-text-secondary));
  text-align: center;
}

.plotly-viewer__state pre {
  margin: 0;
  white-space: pre-wrap;
  font: inherit;
}

.plotly-viewer__state--overlay {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--color-bg-secondary, var(--color-bg)) 88%, transparent);
}

.plotly-viewer__state--warn {
  min-height: 44px;
  justify-content: flex-start;
  color: var(--color-warning, var(--color-warning));
}

.plotly-viewer__fallback {
  height: 100%;
  min-height: 260px;
  overflow: auto;
}

.plotly-viewer__fallback pre {
  margin: 0;
  padding: var(--space-3);
  font-size: var(--text-label);
  line-height: 1.45;
  color: var(--color-text-muted, var(--color-text-secondary));
}
</style>
