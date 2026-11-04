<template>
  <div class="volcano-plot-viewer">
    <div class="volcano-plot-viewer__toolbar">
      <div class="toolbar-left">
        <el-tag v-if="significantCount.up > 0" type="danger" size="small">
          {{ t('visualization.viewer.upRegulated', { count: significantCount.up }) }}
        </el-tag>
        <el-tag v-if="significantCount.down > 0" type="primary" size="small">
          {{ t('visualization.viewer.downRegulated', { count: significantCount.down }) }}
        </el-tag>
        <el-tag v-if="data?.totalRows" type="info" size="small">
          {{ t('visualization.viewer.totalPoints', { count: data.totalRows }) }}
        </el-tag>
      </div>
      <div class="toolbar-right">
        <el-switch v-model="showThresholdLines" :active-text="t('visualization.viewer.showThresholds')" size="small" />
      </div>
    </div>

    <div v-if="editMode" class="volcano-plot-viewer__config">
      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item :label="t('visualization.viewer.xAxisFoldChange')">
            <el-select v-model="localConfig.foldChangeColumn" size="small" @change="updateConfig">
              <el-option v-for="col in numericColumns" :key="col.id" :label="col.name" :value="col.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item :label="t('visualization.viewer.yAxisPValue')">
            <el-select v-model="localConfig.pValueColumn" size="small" @change="updateConfig">
              <el-option v-for="col in numericColumns" :key="col.id" :label="col.name" :value="col.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item :label="t('visualization.viewer.nameColumn')">
            <el-select v-model="localConfig.nameColumn" size="small" clearable @change="updateConfig">
              <el-option v-for="col in allColumns" :key="col.id" :label="col.name" :value="col.id" />
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
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SelectionState, TableData, VolcanoConfig, VolcanoPoint } from '@/types/visualization'
import { plotlyVizColor } from '@/services/visualization/plotlyTheme'
import PlotlyViewer from './PlotlyViewer.vue'

interface Props {
  data: TableData | null
  config?: Partial<VolcanoConfig>
  selection?: SelectionState | null
  editMode?: boolean
}

interface VolcanoDatum {
  name: string
  log2FoldChange: number
  negLog10PValue: number
  index: number
  isSignificant: boolean
  regulation: 'up' | 'down' | 'neutral'
  foldChange: number
  pValue: number
  y: number
  isUpregulated: boolean
  isDownregulated: boolean
}

const props = defineProps<Props>()
const { t } = useI18n()
const emit = defineEmits<{
  selectionChange: [selection: SelectionState]
  configChange: [config: Partial<VolcanoConfig> | Record<string, unknown>]
  pointClick: [point: VolcanoPoint]
}>()

const showThresholdLines = ref(true)
const localConfig = reactive<Required<VolcanoConfig>>({
  foldChangeColumn: '',
  pValueColumn: '',
  nameColumn: '',
  foldChangeThreshold: 1,
  pValueThreshold: 0.05,
  upregulatedColor: plotlyVizColor('up'),
  downregulatedColor: plotlyVizColor('down'),
  neutralColor: plotlyVizColor('neutral'),
})

watch(() => props.config, (newConfig) => {
  if (newConfig) Object.assign(localConfig, newConfig)
}, { immediate: true, deep: true })

watch(() => props.data, (data) => {
  if (!data || localConfig.foldChangeColumn || localConfig.pValueColumn) return
  const numeric = data.columns.filter((column) => column.type === 'number')
  localConfig.foldChangeColumn = numeric.find((column) => /fold|fc|log2/i.test(column.name))?.id ?? numeric[0]?.id ?? ''
  localConfig.pValueColumn = numeric.find((column) => /p.?value|q.?value|fdr/i.test(column.name))?.id ?? numeric[1]?.id ?? ''
}, { immediate: true })

const numericColumns = computed(() => props.data?.columns.filter((column) => column.type === 'number') ?? [])
const allColumns = computed(() => props.data?.columns ?? [])
const volcanoData = computed<VolcanoDatum[]>(() => {
  if (!props.data || !localConfig.foldChangeColumn || !localConfig.pValueColumn) return []
  return props.data.rows
    .map((row, index) => {
      const foldChange = toFiniteNumber(row[localConfig.foldChangeColumn])
      const pValue = toFiniteNumber(row[localConfig.pValueColumn])
      if (foldChange === null || pValue === null) return null
      const name = localConfig.nameColumn ? String(row[localConfig.nameColumn] ?? `Point${index}`) : `Point${index}`
      const y = -Math.log10(Math.max(pValue, Number.MIN_VALUE))
      const isUpregulated = foldChange >= localConfig.foldChangeThreshold && pValue < localConfig.pValueThreshold
      const isDownregulated = foldChange <= -localConfig.foldChangeThreshold && pValue < localConfig.pValueThreshold
      const point: VolcanoDatum = {
        name,
        log2FoldChange: foldChange,
        negLog10PValue: y,
        foldChange,
        pValue,
        index,
        y,
        isSignificant: isUpregulated || isDownregulated,
        regulation: isUpregulated ? 'up' : isDownregulated ? 'down' : 'neutral',
        isUpregulated,
        isDownregulated,
      }
      return point
    })
    .filter((point): point is VolcanoDatum => point !== null && Number.isFinite(point.y))
})
const significantCount = computed(() => ({
  up: volcanoData.value.filter((point) => point.isUpregulated).length,
  down: volcanoData.value.filter((point) => point.isDownregulated).length,
  neutral: volcanoData.value.filter((point) => !point.isUpregulated && !point.isDownregulated).length,
}))
const plotlyViewSpec = computed(() => ({
  figure: buildFigure(volcanoData.value),
}))
const plotlyConfig = computed(() => ({
  responsive: true,
  displaylogo: false,
}))

function buildFigure(points: VolcanoDatum[]) {
  const selected = props.selection?.selectedIndices ?? new Set<number>()
  const selectedPoints = points.filter((point) => selected.has(point.index))
  const base = points.filter((point) => !selected.has(point.index))
  const maxY = Math.max(...points.map((point) => point.y), 1)
  return {
    data: [
      buildTrace(base.filter((point) => point.isUpregulated), 'Up-regulated', localConfig.upregulatedColor),
      buildTrace(base.filter((point) => point.isDownregulated), 'Down-regulated', localConfig.downregulatedColor),
      buildTrace(base.filter((point) => !point.isUpregulated && !point.isDownregulated), 'Not significant', localConfig.neutralColor),
      buildTrace(selectedPoints, 'Selected', plotlyVizColor('highlight'), 12),
    ].filter((trace) => trace.x.length > 0),
    layout: {
      title: { text: 'Volcano plot' },
      xaxis: { title: { text: 'Fold Change' }, zeroline: true },
      yaxis: { title: { text: '-log10(P-value)' }, zeroline: false },
      showlegend: true,
      dragmode: 'select',
      shapes: showThresholdLines.value ? [
        vLine(localConfig.foldChangeThreshold, maxY, localConfig.upregulatedColor),
        vLine(-localConfig.foldChangeThreshold, maxY, localConfig.downregulatedColor),
        hLine(-Math.log10(localConfig.pValueThreshold), localConfig.neutralColor),
      ] : [],
    },
  }
}

function buildTrace(points: VolcanoDatum[], name: string, color: string, size = 8) {
  return {
    type: 'scattergl',
    mode: 'markers',
    name,
    x: points.map((point) => point.foldChange),
    y: points.map((point) => point.y),
    customdata: points.map((point) => point.index),
    text: points.map((point) => `${point.name}<br>FC: ${point.foldChange.toFixed(2)}<br>-log10(p): ${point.y.toFixed(2)}`),
    hovertemplate: '%{text}<extra>%{fullData.name}</extra>',
    marker: { color, size, opacity: name === 'Selected' ? 1 : 0.72 },
  }
}

function handlePlotlySelection(selection: SelectionState) {
  const selectedIndices = new Set(selection.selectedIndices)
  const selectedPoint = volcanoData.value.find((point) => selectedIndices.has(point.index))
  if (selectedPoint) emit('pointClick', selectedPoint)
  emit('selectionChange', {
    ...selection,
    selectedIndices,
  })
}

function updateConfig() {
  emit('configChange', { ...localConfig })
}

function vLine(x: number, maxY: number, color: string) {
  return { type: 'line', x0: x, x1: x, y0: 0, y1: maxY, line: { color, dash: 'dash' } }
}

function hLine(y: number, color: string) {
  return { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: y, y1: y, line: { color, dash: 'dash' } }
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : null
}
</script>

<script lang="ts">
export default {
  name: 'VolcanoPlotViewer',
}
</script>

<style scoped>
.volcano-plot-viewer {
  display: flex;
  flex-direction: column;
  min-height: 320px;
  height: 100%;
}

.volcano-plot-viewer__toolbar,
.volcano-plot-viewer__config {
  padding: var(--space-2);
  border-bottom: var(--line-w) solid var(--line-hairline);
}

.volcano-plot-viewer__toolbar,
.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.volcano-plot-viewer__toolbar {
  justify-content: space-between;
}
</style>
