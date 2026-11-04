<template>
  <div class="scatter-plot-viewer">
    <div class="scatter-plot-viewer__toolbar">
      <div class="toolbar-left">
        <el-tag v-if="totalRows > 0" type="info" size="small">
          {{ t('visualization.viewer.points', { count: totalRows }) }}
        </el-tag>
        <el-tag v-if="samplingApplied" type="warning" size="small">
          {{ t('visualization.viewer.sampled', { shown: renderedPoints.length, total: totalRows }) }}
        </el-tag>
      </div>
      <div class="toolbar-right">
        <el-select v-model="localConfig.colorScheme" size="small" style="width: 100px" @change="updateConfig">
          <el-option v-for="scheme in colorSchemes" :key="scheme.id" :label="scheme.name" :value="scheme.id" />
        </el-select>
      </div>
    </div>

    <div v-if="editMode" class="scatter-plot-viewer__config">
      <el-row :gutter="12">
        <el-col :span="6">
          <el-form-item :label="t('visualization.chart.xAxis')">
            <el-select v-model="localConfig.axisMapping.x" size="small" clearable @change="updateConfig">
              <el-option v-for="col in numericColumns" :key="col.id" :label="col.name" :value="col.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="6">
          <el-form-item :label="t('visualization.chart.yAxis')">
            <el-select v-model="localConfig.axisMapping.y" size="small" clearable @change="updateConfig">
              <el-option v-for="col in numericColumns" :key="col.id" :label="col.name" :value="col.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="6">
          <el-form-item :label="t('visualization.chart.colorBy')">
            <el-select v-model="localConfig.axisMapping.color" size="small" clearable @change="updateConfig">
              <el-option v-for="col in allColumns" :key="col.id" :label="col.name" :value="col.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="6">
          <el-form-item :label="t('visualization.chart.sizeBy')">
            <el-select v-model="localConfig.axisMapping.size" size="small" clearable @change="updateConfig">
              <el-option v-for="col in numericColumns" :key="col.id" :label="col.name" :value="col.id" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>
    </div>

    <PlotlyViewer
      :view-spec="plotlyViewSpec"
      :config="plotlyConfig"
      :selection="selection"
      @selection-change="handlePlotlySelection"
      @config-change="$emit('configChange', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ScatterConfig, SelectionState, TableData } from '@/types/visualization'
import { COLOR_SCHEMES } from '@/types/visualization'
import { plotlyAccentColor, plotlySeriesColor } from '@/services/visualization/plotlyTheme'
import PlotlyViewer from './PlotlyViewer.vue'

interface Props {
  data: TableData | null
  config?: Partial<ScatterConfig>
  selection?: SelectionState | null
  editMode?: boolean
}

interface ScatterPoint {
  x: number
  y: number
  colorValue?: number
  sizeValue?: number
  index: number
}

const props = defineProps<Props>()
const { t } = useI18n()
const emit = defineEmits<{
  selectionChange: [selection: SelectionState]
  configChange: [config: Partial<ScatterConfig> | Record<string, unknown>]
}>()

const colorSchemes = COLOR_SCHEMES
const localConfig = ref<Required<ScatterConfig>>({
  axisMapping: { x: '', y: '', z: '', color: '', size: '' },
  colorScheme: 'viridis',
  showLegend: true,
  symbolSize: 8,
  symbolType: 'circle',
})

watch(() => props.config, (newConfig) => {
  if (!newConfig) return
  if (newConfig.axisMapping) Object.assign(localConfig.value.axisMapping, newConfig.axisMapping)
  if (newConfig.colorScheme) localConfig.value.colorScheme = newConfig.colorScheme
  if (newConfig.showLegend !== undefined) localConfig.value.showLegend = newConfig.showLegend
  if (newConfig.symbolSize) localConfig.value.symbolSize = newConfig.symbolSize
  if (newConfig.symbolType) localConfig.value.symbolType = newConfig.symbolType
}, { immediate: true, deep: true })

watch(() => props.data, (newData) => {
  if (!newData || localConfig.value.axisMapping.x) return
  const numeric = newData.columns.filter((column) => column.type === 'number')
  if (numeric.length >= 2) {
    localConfig.value.axisMapping.x = numeric[0].id
    localConfig.value.axisMapping.y = numeric[1].id
  }
}, { immediate: true })

const totalRows = computed(() => props.data?.rows.length ?? 0)
const numericColumns = computed(() => props.data?.columns.filter((column) => column.type === 'number') ?? [])
const allColumns = computed(() => props.data?.columns ?? [])
const scatterPoints = computed<ScatterPoint[]>(() => {
  const data = props.data
  const mapping = localConfig.value.axisMapping
  const xColumn = mapping.x
  const yColumn = mapping.y
  if (!data || !xColumn || !yColumn) return []
  return data.rows
    .map((row, index) => {
      const x = toFiniteNumber(row[xColumn])
      const y = toFiniteNumber(row[yColumn])
      if (x === null || y === null) return null
      const point: ScatterPoint = {
        x,
        y,
        colorValue: mapping.color ? toFiniteNumber(row[mapping.color]) ?? undefined : undefined,
        sizeValue: mapping.size ? toFiniteNumber(row[mapping.size]) ?? undefined : undefined,
        index,
      }
      return point
    })
    .filter((point): point is ScatterPoint => point !== null)
})
const renderedPoints = computed(() => {
  if (scatterPoints.value.length <= 10000) return scatterPoints.value
  const step = Math.ceil(scatterPoints.value.length / 10000)
  return scatterPoints.value.filter((_, index) => index % step === 0)
})
const samplingApplied = computed(() => renderedPoints.value.length > 0 && renderedPoints.value.length < totalRows.value)

const plotlyViewSpec = computed(() => ({
  figure: buildFigure(renderedPoints.value),
}))
const plotlyConfig = computed(() => ({
  responsive: true,
  displaylogo: false,
  ...(props.config as Record<string, unknown> | undefined),
}))

function buildFigure(points: ScatterPoint[]) {
  const selected = props.selection?.selectedIndices ?? new Set<number>()
  const selectedPoints = points.filter((point) => selected.has(point.index))
  const basePoints = points.filter((point) => !selected.has(point.index))
  return {
    data: [
      buildTrace(basePoints, 'Points', plotlySeriesColor(0), 0.72),
      buildTrace(selectedPoints, 'Selected', plotlyAccentColor(), 1),
    ].filter((trace) => trace.x.length > 0),
    layout: {
      title: { text: 'Scatter plot' },
      xaxis: { title: { text: localConfig.value.axisMapping.x || 'X' }, zeroline: false },
      yaxis: { title: { text: localConfig.value.axisMapping.y || 'Y' }, zeroline: false },
      showlegend: localConfig.value.showLegend,
      dragmode: 'select',
    },
  }
}

function buildTrace(points: ScatterPoint[], name: string, fallbackColor: string, opacity: number) {
  const colorColumn = localConfig.value.axisMapping.color
  const sizeColumn = localConfig.value.axisMapping.size
  return {
    type: 'scattergl',
    mode: 'markers',
    name,
    x: points.map((point) => point.x),
    y: points.map((point) => point.y),
    customdata: points.map((point) => point.index),
    marker: {
      color: colorColumn ? points.map((point) => point.colorValue ?? null) : fallbackColor,
      colorscale: colorColumn ? toPlotlyColorscale(getColorList()) : undefined,
      showscale: Boolean(colorColumn),
      size: sizeColumn ? points.map((point) => scaleSize(point.sizeValue)) : localConfig.value.symbolSize,
      opacity,
    },
  }
}

function handlePlotlySelection(selection: SelectionState) {
  emit('selectionChange', {
    ...selection,
    selectedIndices: new Set(selection.selectedIndices),
  })
}

function updateConfig() {
  emit('configChange', {
    axisMapping: { ...localConfig.value.axisMapping },
    colorScheme: localConfig.value.colorScheme,
    showLegend: localConfig.value.showLegend,
    symbolSize: localConfig.value.symbolSize,
    symbolType: localConfig.value.symbolType,
  })
}

function getColorList(): string[] {
  return COLOR_SCHEMES.find((scheme) => scheme.id === localConfig.value.colorScheme)?.colors ?? COLOR_SCHEMES[0].colors
}

function toPlotlyColorscale(colors: string[]) {
  if (colors.length <= 1) return [[0, colors[0] ?? plotlySeriesColor(0)], [1, colors[0] ?? plotlySeriesColor(0)]]
  return colors.map((color, index) => [index / (colors.length - 1), color])
}

function scaleSize(value: number | undefined): number {
  const fallback = typeof localConfig.value.symbolSize === 'number' ? localConfig.value.symbolSize : 8
  if (value === undefined) return fallback
  return Math.max(4, Math.min(22, Math.sqrt(Math.max(value, 0)) || fallback))
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : null
}
</script>

<script lang="ts">
export default {
  name: 'ScatterPlotViewer',
}
</script>

<style scoped>
.scatter-plot-viewer {
  display: flex;
  flex-direction: column;
  min-height: 320px;
  height: 100%;
}

.scatter-plot-viewer__toolbar,
.scatter-plot-viewer__config {
  padding: var(--space-2);
  border-bottom: var(--line-w) solid var(--line-hairline);
}

.scatter-plot-viewer__toolbar,
.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.scatter-plot-viewer__toolbar {
  justify-content: space-between;
}
</style>
