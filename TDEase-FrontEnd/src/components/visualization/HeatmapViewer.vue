<template>
  <div class="heatmap-viewer">
    <div class="heatmap-viewer__toolbar">
      <div class="toolbar-left">
        <el-tag v-if="data?.totalRows" type="info" size="small">
          {{ t('visualization.viewer.rowsByCols', { rows: data.totalRows, cols: columnCount }) }}
        </el-tag>
      </div>
    </div>

    <PlotlyViewer
      :view-spec="plotlyViewSpec"
      :config="plotlyConfig"
      :selection="selection"
      @selection-change="handlePlotlySelection"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HeatmapConfig, SelectionState, TableData } from '@/types/visualization'
import { COLOR_SCHEMES } from '@/types/visualization'
import { plotlySeriesColor, plotlyTokenColor } from '@/services/visualization/plotlyTheme'
import PlotlyViewer from './PlotlyViewer.vue'

interface Props {
  data: TableData | null
  config?: Partial<HeatmapConfig>
  selection?: SelectionState | null
}

interface HeatmapCell {
  row: string
  column: string
  value: number | null
  index: number
}

const props = defineProps<Props>()
const { t } = useI18n()
const emit = defineEmits<{
  selectionChange: [selection: SelectionState]
}>()

const config = computed(() => ({
  rowColumn: props.config?.rowColumn || 'row',
  columnColumn: props.config?.columnColumn || 'column',
  valueColumn: props.config?.valueColumn || 'value',
  colorScheme: props.config?.colorScheme || 'viridis',
  showRowLabels: props.config?.showRowLabels ?? true,
  showColumnLabels: props.config?.showColumnLabels ?? true,
  missingValueColor: props.config?.missingValueColor || plotlyTokenColor('--ctp-surface1', '#d3d3d3'),
}))
const heatmapCells = computed<HeatmapCell[]>(() => {
  if (!props.data) return []
  return props.data.rows.map((row, index) => ({
    row: String(row[config.value.rowColumn] ?? `Row${index}`),
    column: String(row[config.value.columnColumn] ?? `Col${index}`),
    value: toFiniteNumber(row[config.value.valueColumn]),
    index,
  }))
})
const rowLabels = computed(() => Array.from(new Set(heatmapCells.value.map((cell) => cell.row))).sort())
const columnLabels = computed(() => Array.from(new Set(heatmapCells.value.map((cell) => cell.column))).sort())
const columnCount = computed(() => columnLabels.value.length || 1)
const plotlyViewSpec = computed(() => ({
  figure: buildFigure(),
}))
const plotlyConfig = computed(() => ({
  responsive: true,
  displaylogo: false,
}))

function buildFigure() {
  const lookup = new Map(heatmapCells.value.map((cell) => [`${cell.row}\u0000${cell.column}`, cell]))
  const z = rowLabels.value.map((row) => columnLabels.value.map((column) => lookup.get(`${row}\u0000${column}`)?.value ?? null))
  const customdata = rowLabels.value.map((row) => columnLabels.value.map((column) => lookup.get(`${row}\u0000${column}`)?.index ?? null))
  return {
    data: heatmapCells.value.length > 0 ? [{
      type: 'heatmap',
      name: 'Heatmap',
      x: columnLabels.value,
      y: rowLabels.value,
      z,
      customdata,
      colorscale: toPlotlyColorscale(getColorList()),
      hoverongaps: false,
      hovertemplate: 'Column: %{x}<br>Row: %{y}<br>Value: %{z}<extra></extra>',
      colorbar: { title: { text: config.value.valueColumn } },
    }] : [],
    layout: {
      title: { text: 'Heatmap' },
      xaxis: { title: { text: config.value.showColumnLabels ? config.value.columnColumn : '' } },
      yaxis: { title: { text: config.value.showRowLabels ? config.value.rowColumn : '' }, autorange: 'reversed' },
      dragmode: 'select',
    },
  }
}

function handlePlotlySelection(selection: SelectionState) {
  emit('selectionChange', {
    ...selection,
    selectedIndices: new Set(selection.selectedIndices),
  })
}

function getColorList(): string[] {
  return COLOR_SCHEMES.find((scheme) => scheme.id === config.value.colorScheme)?.colors ?? COLOR_SCHEMES[0].colors
}

function toPlotlyColorscale(colors: string[]) {
  if (colors.length <= 1) return [[0, colors[0] ?? plotlySeriesColor(0)], [1, colors[0] ?? plotlySeriesColor(0)]]
  return colors.map((color, index) => [index / (colors.length - 1), color])
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(parsed) ? parsed : null
}
</script>

<script lang="ts">
export default {
  name: 'HeatmapViewer',
}
</script>

<style scoped>
.heatmap-viewer {
  display: flex;
  flex-direction: column;
  min-height: 320px;
  height: 100%;
}

.heatmap-viewer__toolbar,
.toolbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.heatmap-viewer__toolbar {
  justify-content: space-between;
  padding: var(--space-2);
  border-bottom: var(--line-w) solid var(--line-hairline);
}
</style>
