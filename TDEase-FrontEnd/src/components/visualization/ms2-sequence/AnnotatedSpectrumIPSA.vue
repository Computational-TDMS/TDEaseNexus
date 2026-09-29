<template>
  <div class="annotated-spectrum-ipsa">
    <div class="viewer-header">
      <div class="topmsv-peak-links">
        <a href="#spectrum" :class="{ active: peakDisplayMode === 'all' }" @click.prevent="peakDisplayMode = 'all'">
          {{ t('visualization.viewer.allPeaks', { count: peaks.length }) }}
        </a>
        <a href="#spectrum" :class="{ active: peakDisplayMode === 'matched' }" @click.prevent="peakDisplayMode = 'matched'">
          {{ t('visualization.viewer.matchedPeaks', { count: matchedPeakCount }) }}
        </a>
        <a href="#spectrum" :class="{ active: peakDisplayMode === 'unmatched' }" @click.prevent="peakDisplayMode = 'unmatched'">
          {{ t('visualization.viewer.notMatchedPeaks', { count: unmatchedPeakCount }) }}
        </a>
      </div>
      <div class="viewer-controls">
        <el-switch v-model="showAnnotations" :active-text="t('visualization.viewer.annotations')" size="small" />
        <el-switch v-model="showLabels" :active-text="t('visualization.viewer.labels')" size="small" />
      </div>
    </div>

    <textarea class="topmsv-sequence-data" :value="topmsvSequenceText" readonly />

    <div ref="rootRef" class="chart-root" :style="chartRootStyle">
      <svg
        ref="svgRef"
        :width="width"
        :height="height"
        :viewBox="`0 0 ${width} ${height}`"
        preserveAspectRatio="xMidYMid meet"
        class="chart-svg"
      ></svg>
      <div v-show="tooltip.visible" class="tooltip" :style="tooltipStyle">
        <div v-for="(line, index) in tooltip.lines" :key="index" class="tooltip-line">
          <strong v-if="line.strong">{{ line.text }}</strong>
          <span v-else>{{ line.text }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// Named imports, not `import * as d3`: a namespace import defeats Rollup's
// tree-shaking and pulls the whole d3 barrel (~30 submodules) into this lazy
// chunk, while this component only touches selection/scale/axis/group/pointer.
import { axisBottom, axisLeft, group, pointer, scaleLinear, select } from 'd3'
import type { Selection } from 'd3'
import type { MatchedFragment, Modification, SpectrumPeak } from '@/composables/ms2-sequence/fragmentation'
import { DEFAULT_MZ_RANGE, getSpectrumMzRange, pickFragmentForInteraction } from './layout'

interface Props {
  sequence: string
  modifications?: Modification[]
  breakpoints?: number[]
  peaks: SpectrumPeak[]
  matchedFragments: MatchedFragment[]
  highlightedResidues?: number[]
  highlightedFragments?: MatchedFragment[]
  highlightedPeakIndices?: number[]
  width?: number
  height?: number
  minWidth?: number
}

const props = withDefaults(defineProps<Props>(), {
  modifications: () => [],
  breakpoints: () => [],
  highlightedResidues: () => [],
  highlightedFragments: () => [],
  highlightedPeakIndices: () => [],
  width: 800,
  height: 520,
    minWidth: 1000,
})

const emit = defineEmits<{
  peakHover: [peak: SpectrumPeak | null]
  peakLeave: []
  peakClick: [peak: SpectrumPeak]
  fragmentHover: [fragment: MatchedFragment]
  fragmentLeave: []
  residueHover: [position: number]
  residueLeave: []
  mzRangeChange: [range: [number, number]]
}>()

const svgRef = ref<SVGSVGElement | null>(null)
const rootRef = ref<HTMLDivElement | null>(null)
const { t } = useI18n()

const showAnnotations = ref(true)
const showLabels = ref(false)
const peakDisplayMode = ref<'all' | 'matched' | 'unmatched'>('all')

const BASE_HEIGHT = 520
const BASE_LAYOUT = { errorHeight: 96 }

const layoutScale = computed(() => Math.max(props.height, 340) / BASE_HEIGHT)
const PRSM_ROW_LENGTH = 30
const PRSM_BLOCK_LENGTH = 10
const PRSM_LETTER_WIDTH = 28
const PRSM_GAP_WIDTH = 20
const PRSM_ROW_HEIGHT = 40
const PRSM_TOP_MARGIN = 46
const PRSM_LEFT_MARGIN = 50
const PRSM_NUMERICAL_WIDTH = 20
const PRSM_FONT_WIDTH = 12
const PRSM_FONT_HEIGHT = 18
const sequenceRows = computed(() => {
  const rows: Array<{ start: number; end: number; text: string }> = []
  const seq = props.sequence || ''
  const perRow = PRSM_ROW_LENGTH
  for (let start = 1; start <= seq.length; start += perRow) {
    const end = Math.min(start + perRow - 1, seq.length)
    rows.push({ start, end, text: seq.slice(start - 1, end) })
  }
  return rows.length > 0 ? rows : [{ start: 1, end: 0, text: '' }]
})
const titleHeight = computed(() => {
  const rowCount = Math.max(sequenceRows.value.length, 1)
  return (PRSM_TOP_MARGIN + ((rowCount - 1) * PRSM_ROW_HEIGHT) + 34) * layoutScale.value
})
const layout = computed(() => ({
  titleHeight: titleHeight.value,
  spectrumHeight: Math.max(210, props.height - titleHeight.value - (BASE_LAYOUT.errorHeight * layoutScale.value)),
  errorHeight: BASE_LAYOUT.errorHeight * layoutScale.value,
}))

const BASE_GRID = { left: 70, right: 50, top: 20, bottom: 50 }
const grid = computed(() => ({
  left: BASE_GRID.left,
  right: BASE_GRID.right,
  top: BASE_GRID.top * layoutScale.value,
  bottom: BASE_GRID.bottom * layoutScale.value,
}))
const clipId = `ipsa-spectrum-clip-${Math.random().toString(36).slice(2, 8)}`

const mzRangeBase = computed<[number, number]>(() => getSpectrumMzRange(props.peaks))
const viewMzRange = ref<[number, number]>(mzRangeBase.value)

watch(mzRangeBase, range => {
  viewMzRange.value = range
  emit('mzRangeChange', range)
})

const basePeak = computed(() => {
  if (props.peaks.length === 0) return 1
  return Math.max(...props.peaks.map(peak => Number(peak.intensity) || 0), 1)
})

const viewIntensityMax = ref(100)

const xScale = computed(() =>
  scaleLinear()
    .domain([Number(viewMzRange.value[0]), Number(viewMzRange.value[1])])
    .range([grid.value.left, props.width - grid.value.right])
)

const spectrumYScale = computed(() =>
  scaleLinear()
    .domain([0, viewIntensityMax.value])
    .range([
      layout.value.titleHeight + layout.value.spectrumHeight - grid.value.bottom,
      layout.value.titleHeight + grid.value.top,
    ])
)

const errorExtent = computed<[number, number]>(() => {
  const errors = props.matchedFragments
    .filter(fragment => fragment.isMatched && fragment.matchErrorPpm !== undefined)
    .map(fragment => fragment.matchErrorPpm as number)

  if (errors.length === 0) return [-20, 20]
  const maxAbs = Math.max(...errors.map(value => Math.abs(value)))
  const limit = Math.max(20, Math.ceil(maxAbs / 10) * 10)
  return [-limit, limit]
})

const errorYScale = computed(() =>
  scaleLinear()
    .domain([Number(errorExtent.value[0]), Number(errorExtent.value[1])])
    .range([
      layout.value.titleHeight + layout.value.spectrumHeight + layout.value.errorHeight - (18 * layoutScale.value),
      layout.value.titleHeight + layout.value.spectrumHeight + (18 * layoutScale.value),
    ])
)

const tooltip = reactive({
  visible: false,
  lines: [] as Array<{ text: string; strong?: boolean }>,
  x: 0,
  y: 0,
})

const tooltipStyle = computed(() => ({
  left: `${tooltip.x}px`,
  top: `${tooltip.y}px`,
}))

const chartRootStyle = computed(() => ({
  '--chart-min-width': `${props.minWidth}px`,
}))

const matchedPeakIndices = computed(() => new Set(
  props.matchedFragments
    .filter(fragment => fragment.isMatched && fragment.matchedPeak)
    .map(fragment => fragment.matchedPeak!.index)
))
const matchedFragmentByPeakIndex = computed(() => {
  const grouped = group(
    props.matchedFragments.filter(fragment => fragment.isMatched && fragment.matchedPeak),
    fragment => fragment.matchedPeak!.index,
  )
  const result = new Map<number, MatchedFragment>()
  for (const [peakIndex, fragments] of grouped.entries()) {
    const fragment = pickFragmentForInteraction(fragments) || fragments[0]
    result.set(peakIndex, fragment)
  }
  return result
})
const matchedPeakCount = computed(() => matchedPeakIndices.value.size)
const unmatchedPeakCount = computed(() => Math.max(props.peaks.length - matchedPeakCount.value, 0))
const visiblePeaks = computed(() => {
  if (peakDisplayMode.value === 'matched') {
    return props.peaks.filter(peak => matchedPeakIndices.value.has(peak.index))
  }
  if (peakDisplayMode.value === 'unmatched') {
    return props.peaks.filter(peak => !matchedPeakIndices.value.has(peak.index))
  }
  return props.peaks
})
const topmsvSequenceText = computed(() => {
  if (!props.sequence) return ''
  const byPosition = new Map<number, Modification[]>()
  for (const mod of props.modifications) {
    const mods = byPosition.get(mod.position) ?? []
    mods.push(mod)
    byPosition.set(mod.position, mods)
  }
  const chunks: string[] = []
  for (let index = 0; index < props.sequence.length; index++) {
    const position = index + 1
    chunks.push(props.sequence[index])
    for (const mod of byPosition.get(position) ?? []) {
      const mass = Number(mod.massShift)
      const text = Number.isFinite(mass) && mass !== 0
        ? (mass >= 0 ? `+${mass.toFixed(4)}` : mass.toFixed(4))
        : mod.name
      chunks.push(`[${text}]`)
    }
  }
  return chunks.join('')
})

// Resolve a design-token color at draw time so SVG fills track the active
// theme. Matches the cssVar() convention in services/visualization/plotlyTheme.
function chartVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!value || value.includes('color-mix') || value.includes('var(')) return fallback
  return value
}

// Ion-type colors resolve to the --domain-ion-* tokens (single source of
// truth in unified-design-tokens.css). chartVar() reads the computed value at
// draw time so the SVG fills track the active theme; the hex fallback mirrors
// the token so a non-resolvable theme still renders the canonical ion hue.
// The default/unknown ion falls back to the themed axis color.
const ION_COLORS: Array<{ types: string[]; token: string; fallback: string }> = [
  { types: ['a'], token: '--domain-ion-a', fallback: '#7c3aed' },
  { types: ['b'], token: '--domain-ion-b', fallback: '#1e66b3' },
  { types: ['c'], token: '--domain-ion-c', fallback: '#008c95' },
  { types: ['x'], token: '--domain-ion-x', fallback: '#c2410c' },
  { types: ['y'], token: '--domain-ion-y', fallback: '#15803d' },
  { types: ['z'], token: '--domain-ion-z', fallback: '#be185d' },
]

function getIonColor(ionType: string): string {
  const entry = ION_COLORS.find(e => e.types.includes(ionType))
  return entry ? chartVar(entry.token, entry.fallback) : chartVar('--chart-axis', '#6c6f85')
}

function getPeakColor(peak: SpectrumPeak): string {
  if (props.highlightedPeakIndices.includes(peak.index)) return chartVar('--color-error', '#d20f39')
  const fragment = matchedFragmentByPeakIndex.value.get(peak.index)
  return fragment ? getIonColor(fragment.ionType) : chartVar('--color-text', '#4c4f69')
}

function setTooltipFromEvent(event: MouseEvent, lines: Array<{ text: string; strong?: boolean }>) {
  const root = rootRef.value
  if (!root) return
  const rect = root.getBoundingClientRect()
  tooltip.visible = true
  tooltip.lines = lines
  tooltip.x = event.clientX - rect.left + 12
  tooltip.y = event.clientY - rect.top + 12
}

function hideTooltip() {
  tooltip.visible = false
  tooltip.lines = []
}

function fragmentKey(fragment: MatchedFragment): string {
  return `${fragment.ionType}-${fragment.position}-${fragment.charge}-${fragment.neutralLoss || ''}`
}

function peakToPercent(peak: SpectrumPeak): number {
  const intensity = Number(peak.intensity) || 0
  return (intensity / basePeak.value) * 100
}

function getPeakTooltipLines(peak: SpectrumPeak): Array<{ text: string; strong?: boolean }> {
  const fragments = props.matchedFragments.filter(
    fragment => fragment.isMatched && fragment.matchedPeak?.index === peak.index
  )

  const lines: Array<{ text: string; strong?: boolean }> = [
    { text: `m/z: ${Number(peak.mz).toFixed(4)}` },
    { text: `Intensity: ${Number(peak.intensity).toFixed(0)}` },
    { text: `Relative abundance: ${peakToPercent(peak).toFixed(2)}%` },
  ]

  if (fragments.length > 0) {
    lines.push({ text: '' })
    lines.push({ text: 'Fragments:', strong: true })
    fragments.forEach(fragment => {
      lines.push({ text: formatFragmentLabel(fragment) })
    })
  }

  return lines
}

function formatFragmentLabel(fragment: MatchedFragment): string {
  const chargeSuffix = fragment.charge > 1 ? `^${fragment.charge}+` : '^1+'
  const neutralLoss = fragment.neutralLoss ? `-${fragment.neutralLoss}` : ''
  return `${fragment.ionType}${fragment.position}${chargeSuffix}${neutralLoss}`
}

function getResidueX(position: number): number {
  const row = getResidueRow(position)
  if (!row) return grid.value.left + 12
  const posInRow = position - row.start
  const gapNum = Math.floor(posInRow / PRSM_BLOCK_LENGTH)
  return (
    PRSM_LEFT_MARGIN
    + PRSM_NUMERICAL_WIDTH
    + posInRow * PRSM_LETTER_WIDTH
    + gapNum * PRSM_GAP_WIDTH
  )
}

function getResidueY(position: number): number {
  const rowIndex = sequenceRows.value.findIndex(row => position >= row.start && position <= row.end)
  return (PRSM_TOP_MARGIN + (Math.max(rowIndex, 0) * PRSM_ROW_HEIGHT)) * layoutScale.value
}

function getResidueRow(position: number) {
  return sequenceRows.value.find(row => position >= row.start && position <= row.end)
}

function getResidueFontSize(): number {
  return 16
}

function getCleavageX(cleavageIndex: number): number {
  const left = getResidueX(cleavageIndex)
  const right = getResidueX(Math.min(cleavageIndex + 1, props.sequence.length))
  return (left + right) / 2
}

function residueIndexFromFragment(fragment: MatchedFragment): number {
  return fragment.position
}

function getCleavageDirection(ionType: string): { up: boolean; left: boolean } {
  const up = ['a', 'b', 'c'].includes(ionType)
  const left = ionType === 'b' || ionType === 'c' || ionType === 'x'
  return { up, left }
}

/**
 * Cleavage polyline: vertical segment between residues, then 120° bend to left/right.
 * Points: (x0, y0) -> (x0, yMid) [vertical] -> (x2, y2) [diagonal at 120° from vertical].
 */
function getCleavagePolylinePoints(cleavageIndex: number, ionType: string): string {
  const { up, left } = getCleavageDirection(ionType)
  const x0 = getCleavageX(cleavageIndex)
  const residueY = getResidueY(cleavageIndex)
  const yEndTop = residueY + (10 * layoutScale.value)
  const yEndBottom = residueY - (12 * layoutScale.value)

  if (up && left) return `${x0 - 2},${yEndBottom} ${x0 + 4},${yEndBottom + 2} ${x0 + 4},${yEndTop}`
  if (!up && !left) return `${x0 + 4},${yEndBottom + 2} ${x0 + 4},${yEndTop} ${x0 + 10},${yEndTop + 3}`
  return `${x0 - 2},${yEndBottom} ${x0 + 4},${yEndBottom + 2} ${x0 + 4},${yEndTop} ${x0 + 10},${yEndTop + 3}`
}

function modificationsAt(position: number): Modification[] {
  return props.modifications.filter(mod => {
    const start = mod.position
    const end = mod.positionEnd ?? start
    return position >= start && position <= end
  })
}

function formatModificationLabel(mod: Modification): string {
  const mass = Number(mod.massShift)
  if (Number.isFinite(mass) && mass !== 0) {
    return mass >= 0 ? `+${mass.toFixed(2)}` : mass.toFixed(2)
  }
  return mod.name
}

function ensureSvg(svg: Selection<SVGSVGElement, unknown, null, undefined>) {
  svg.selectAll('*').remove()

  svg.append('defs')
    .append('clipPath')
    .attr('id', clipId)
    .append('rect')
    .attr('x', grid.value.left)
    .attr('y', layout.value.titleHeight + grid.value.top)
    .attr('width', props.width - grid.value.left - grid.value.right)
    .attr('height', layout.value.spectrumHeight - grid.value.top - grid.value.bottom)

  svg.append('g').attr('class', 'title')

  svg.append('g').attr('class', 'x-axis')
    .attr('transform', `translate(0, ${layout.value.titleHeight + layout.value.spectrumHeight - grid.value.bottom})`)
  svg.append('g').attr('class', 'y-axis')
    .attr('transform', `translate(${grid.value.left}, 0)`)
  svg.append('g').attr('class', 'peaks').attr('clip-path', `url(#${clipId})`)
  svg.append('g').attr('class', 'annotations').attr('clip-path', `url(#${clipId})`)

  svg.append('g').attr('class', 'error-x-axis')
    .attr('transform', `translate(0, ${layout.value.titleHeight + layout.value.spectrumHeight + layout.value.errorHeight - (18 * layoutScale.value)})`)
  svg.append('g').attr('class', 'error-y-axis')
    .attr('transform', `translate(${grid.value.left}, 0)`)
  svg.append('g').attr('class', 'error-points')
}

function drawTitle(svg: Selection<SVGSVGElement, unknown, null, undefined>) {
  // `titleGroup`, not `group`: d3.group is imported below and is used in this
  // very function (fragment cleavage grouping) — a local `group` would shadow it.
  const titleGroup = svg.select<SVGGElement>('g.title')
  titleGroup.selectAll('*').remove()

  const seq = props.sequence || ''
  const residueText = titleGroup.append('g').attr('class', 'title-seq')

  for (const row of sequenceRows.value) {
    if (row.end < row.start) continue
    const rowGroup = residueText.append('g')
      .attr('class', 'proteoform-row')
      .attr('data-start', row.start)
      .attr('data-end', row.end)
    rowGroup.append('text')
      .attr('class', 'pos-num')
      .attr('x', PRSM_LEFT_MARGIN)
      .attr('y', getResidueY(row.start))
      .attr('text-anchor', 'end')
      .text(row.start)
    rowGroup.append('text')
      .attr('class', 'pos-num')
      .attr('x', getResidueX(row.end) + PRSM_NUMERICAL_WIDTH + PRSM_FONT_WIDTH)
      .attr('y', getResidueY(row.end))
      .attr('text-anchor', 'start')
      .text(row.end)
  }

  for (let index = 0; index < seq.length; index++) {
    const position = index + 1
    const isHighlighted = props.highlightedResidues.includes(position)
    const residueMods = modificationsAt(position)
    const hasModification = residueMods.length > 0

    const residueGroup = residueText.append('g')
      .attr('class', `proteoform-residue residue${hasModification ? ' residue--modified' : ''}`)
      .attr('transform', `translate(${getResidueX(position)}, ${getResidueY(position)})`)

    if (hasModification) {
      residueGroup.append('rect')
        .attr('class', 'mod-marker')
        .attr('x', -PRSM_FONT_WIDTH * 0.1)
        .attr('y', -PRSM_FONT_HEIGHT * 0.7)
        .attr('width', PRSM_FONT_WIDTH + PRSM_LETTER_WIDTH * Math.max((residueMods[0].positionEnd ?? position) - position, 0))
        .attr('height', PRSM_FONT_HEIGHT)
    }

    if (hasModification && residueMods[0].position === position) {
      residueGroup.append('text')
        .attr('class', 'mod-label')
        .attr('x', 0)
        .attr('y', -15)
        .attr('text-anchor', 'start')
        .attr('font-size', 15)
        .text(formatModificationLabel(residueMods[0]))
    }

    residueText.append('text')
      .attr('class', 'residue-letter')
      .attr('x', getResidueX(position))
      .attr('y', getResidueY(position))
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', getResidueFontSize())
      .attr('font-weight', isHighlighted ? 700 : 500)
      .attr('fill', isHighlighted ? chartVar('--color-warning', '#df8e1d') : chartVar('--color-text', '#4c4f69'))
      .style('cursor', 'pointer')
      .text(seq[index])
      .on('mouseenter', () => emit('residueHover', position))
      .on('mouseleave', () => emit('residueLeave'))
  }

  const cleavageGroup = titleGroup.append('g').attr('class', 'title-cleavages')
  const grouped = group(props.matchedFragments, fragment => `${fragment.ionType}-${fragment.position}`)

  const isResidueModified = (position: number) =>
    modificationsAt(position).length > 0

  for (const fragments of grouped.values()) {
    const hasMatched = fragments.some(item => item.isMatched)
    if (!hasMatched) continue

    const fragment = pickFragmentForInteraction(fragments) || fragments[0]
    const cleavageIndex = residueIndexFromFragment(fragment)
    if (cleavageIndex <= 0 || cleavageIndex >= seq.length) continue
    if (getResidueRow(cleavageIndex) !== getResidueRow(cleavageIndex + 1)) continue
    if (isResidueModified(cleavageIndex) || isResidueModified(cleavageIndex + 1)) continue

    const highlighted = props.highlightedFragments.some(item => fragmentKey(item) === fragmentKey(fragment))

    cleavageGroup.append('polyline')
      .attr('points', getCleavagePolylinePoints(cleavageIndex, fragment.ionType))
      .attr('fill', 'none')
      .attr('stroke', getIonColor(fragment.ionType))
      .attr('stroke-width', highlighted ? 1.5 : 1)
      .attr('opacity', highlighted ? 1 : 0.95)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round')
      .style('cursor', 'pointer')
      .on('mouseenter', () => emit('fragmentHover', fragment))
      .on('mouseleave', () => emit('fragmentLeave'))
  }
}

function drawSpectrumAxes(svg: Selection<SVGSVGElement, unknown, null, undefined>) {
  svg.select<SVGGElement>('g.x-axis').call(axisBottom(xScale.value).ticks(8))
  svg.select<SVGGElement>('g.y-axis').call(axisLeft(spectrumYScale.value).ticks(5))
}

function drawSpectrum(svg: Selection<SVGSVGElement, unknown, null, undefined>) {
  const peaksGroup = svg.select<SVGGElement>('g.peaks')
  const annotationsGroup = svg.select<SVGGElement>('g.annotations')
  peaksGroup.selectAll('*').remove()
  annotationsGroup.selectAll('*').remove()

  if (visiblePeaks.value.length === 0) {
    peaksGroup.append('text')
      .attr('class', 'empty-state')
      .attr('x', (grid.value.left + props.width - grid.value.right) / 2)
      .attr('y', layout.value.titleHeight + layout.value.spectrumHeight / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', chartVar('--color-text-disabled', '#9ca0b0'))
      .attr('font-size', 13)
      .text(t('visualization.viewer.noSpectrumPeaks'))
    return
  }

  const highlighted = new Set(props.highlightedPeakIndices)
  const plotWidth = props.width - grid.value.left - grid.value.right
  const barWidth = Math.max(1, Math.min(2, (plotWidth / Math.max(visiblePeaks.value.length, 400)) * 2.5))

  peaksGroup.selectAll<SVGRectElement, SpectrumPeak>('rect.peak')
    .data(visiblePeaks.value, peak => String(peak.index))
    .enter()
    .append('rect')
    .attr('class', 'peak')
    .attr('x', peak => xScale.value(Number(peak.mz)) - barWidth / 2)
    .attr('width', barWidth)
    .attr('y', peak => spectrumYScale.value(peakToPercent(peak)))
    .attr('height', peak => Math.max(1, spectrumYScale.value(0) - spectrumYScale.value(peakToPercent(peak))))
    .attr('fill', peak => getPeakColor(peak))
    .attr('stroke', peak => getPeakColor(peak))
    .attr('stroke-width', peak => highlighted.has(peak.index) ? 2 : 1)
    .attr('opacity', 1)
    .style('cursor', 'pointer')
    .on('mouseenter', (event, peak) => {
      emit('peakHover', peak)
      setTooltipFromEvent(event, getPeakTooltipLines(peak))
    })
    .on('mousemove', (event, peak) => {
      if (tooltip.visible) setTooltipFromEvent(event, getPeakTooltipLines(peak))
    })
    .on('mouseleave', () => {
      emit('peakLeave')
      hideTooltip()
    })
    .on('click', (_event, peak) => emit('peakClick', peak))

  if (!showAnnotations.value) return

  const matched = props.matchedFragments.filter(fragment => fragment.isMatched && fragment.matchedPeak)
  const byPeak = group(matched, fragment => fragment.matchedPeak!.index)
  for (const fragments of byPeak.values()) {
    const fragment = pickFragmentForInteraction(fragments) || fragments[0]
    const peak = fragment.matchedPeak
    if (!peak) continue

    const label = formatFragmentLabel(fragment)

    annotationsGroup.append('text')
      .attr('class', 'annotation')
      .attr('x', xScale.value(Number(peak.mz)))
      .attr('y', spectrumYScale.value(peakToPercent(peak)) - 6)
      .attr('text-anchor', 'middle')
      .attr('font-size', showLabels.value ? 12 : 10)
      .attr('font-weight', showLabels.value ? 700 : 400)
      .attr('fill', getIonColor(fragment.ionType))
      .style('cursor', 'pointer')
      .text(label)
      .on('mouseenter', () => emit('fragmentHover', fragment))
      .on('mouseleave', () => emit('fragmentLeave'))
  }
}

function drawErrorPlot(svg: Selection<SVGSVGElement, unknown, null, undefined>) {
  const pointsGroup = svg.select<SVGGElement>('g.error-points')
  pointsGroup.selectAll('*').remove()

  svg.select<SVGGElement>('g.error-x-axis').call(axisBottom(xScale.value).ticks(8))
  svg.select<SVGGElement>('g.error-y-axis').call(axisLeft(errorYScale.value).ticks(5))

    pointsGroup.append('line')
    .attr('x1', grid.value.left)
    .attr('x2', props.width - grid.value.right)
    .attr('y1', errorYScale.value(0))
    .attr('y2', errorYScale.value(0))
    .attr('stroke', chartVar('--chart-grid', '#bcc0cc'))
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', '5,3')

  const points = props.matchedFragments
    .filter(fragment => fragment.isMatched && fragment.matchedPeak && fragment.matchErrorPpm !== undefined)
    .map(fragment => ({
      id: fragmentKey(fragment),
      fragment,
      mz: Number(fragment.matchedPeak!.mz),
      error: fragment.matchErrorPpm as number,
      highlighted: props.highlightedFragments.some(item => fragmentKey(item) === fragmentKey(fragment)),
    }))

  if (points.length === 0) {
    pointsGroup.append('text')
      .attr('class', 'empty-state')
      .attr('x', (grid.value.left + props.width - grid.value.right) / 2)
      .attr('y', layout.value.titleHeight + layout.value.spectrumHeight + layout.value.errorHeight / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', chartVar('--color-text-disabled', '#9ca0b0'))
      .attr('font-size', 12)
      .text(t('visualization.viewer.noMatchedFragments'))
    return
  }

  pointsGroup.selectAll<SVGCircleElement, (typeof points)[number]>('circle.err')
    .data(points, point => point.id)
    .enter()
    .append('circle')
    .attr('class', 'err')
    .attr('cx', point => xScale.value(point.mz))
    .attr('cy', point => errorYScale.value(point.error))
    .attr('r', point => point.highlighted ? 5 : 3)
    .attr('fill', point => point.highlighted ? chartVar('--color-error', '#d20f39') : getIonColor(point.fragment.ionType))
    .attr('stroke', 'none')
    .attr('stroke-width', 0)
    .style('cursor', 'pointer')
    .on('mouseenter', (_event, point) => emit('fragmentHover', point.fragment))
    .on('mouseleave', () => emit('fragmentLeave'))
}

function redraw(svg: Selection<SVGSVGElement, unknown, null, undefined>, resetRange = false) {
  const range = mzRangeBase.value
  const min = Math.min(range[0], range[1])
  const max = Math.max(range[0], range[1])
  if (resetRange) viewMzRange.value = [min, max]
  if (resetRange) viewIntensityMax.value = 100
  drawTitle(svg)
  drawSpectrumAxes(svg)
  drawSpectrum(svg)
  drawErrorPlot(svg)
}

function applyZoom(svg: Selection<SVGSVGElement, unknown, null, undefined>) {
  let dragStartX: number | null = null
  let dragStartRange: [number, number] | null = null

  svg.on('wheel.topmsv', (event: WheelEvent) => {
    event.preventDefault()
    const [mouseX, mouseY] = pointer(event, svg.node())
    const ratio = event.deltaY < 0 ? 1.4 : 0.9
    const xAxisY = layout.value.titleHeight + layout.value.spectrumHeight - grid.value.bottom
    if (mouseY > xAxisY) {
      zoomMz(mouseX, ratio)
    } else {
      zoomIntensity(ratio)
    }
    redraw(svg)
  })

  svg.on('mousedown.topmsv', (event: MouseEvent) => {
    dragStartX = pointer(event, svg.node())[0]
    dragStartRange = [...viewMzRange.value] as [number, number]
  })
  svg.on('mousemove.topmsv', (event: MouseEvent) => {
    if (dragStartX === null || dragStartRange === null || event.buttons !== 1) return
    const currentX = pointer(event, svg.node())[0]
    const plotWidth = Math.max(props.width - grid.value.left - grid.value.right, 1)
    const mzPerPx = (dragStartRange[1] - dragStartRange[0]) / plotWidth
    const shift = (dragStartX - currentX) * mzPerPx
    setMzRange([dragStartRange[0] + shift, dragStartRange[1] + shift])
    redraw(svg)
  })
  svg.on('mouseup.topmsv mouseleave.topmsv', () => {
    dragStartX = null
    dragStartRange = null
  })
}

function zoomMz(mouseSvgX: number, ratio: number) {
  const [min, max] = viewMzRange.value
  const plotLeft = grid.value.left
  const plotRight = props.width - grid.value.right
  const plotWidth = Math.max(plotRight - plotLeft, 1)
  const mouseRatio = Math.min(1, Math.max(0, (mouseSvgX - plotLeft) / plotWidth))
  const centerMz = min + (max - min) * mouseRatio
  const nextWidth = (max - min) / ratio
  const nextMin = centerMz - nextWidth * mouseRatio
  const nextMax = centerMz + nextWidth * (1 - mouseRatio)
  setMzRange([nextMin, nextMax])
}

function zoomIntensity(ratio: number) {
  const next = ratio > 1
    ? viewIntensityMax.value / 1.4
    : viewIntensityMax.value / 0.9
  viewIntensityMax.value = Math.min(140, Math.max(1, next))
}

function setMzRange(next: [number, number]) {
  const base = mzRangeBase.value.length ? mzRangeBase.value : DEFAULT_MZ_RANGE
  const dataMin = Math.min(base[0], base[1]) - 50
  const dataMax = Math.max(base[0], base[1]) + 300
  const width = Math.max(next[1] - next[0], 0.000001)
  let min = next[0]
  let max = next[1]
  if (min < dataMin) {
    min = dataMin
    max = min + width
  }
  if (max > dataMax) {
    max = dataMax
    min = max - width
  }
  viewMzRange.value = [min, max]
  emit('mzRangeChange', [min, max])
}

let cleanup: (() => void) | null = null

// KeepAlive lifecycle: the D3 SVG DOM (rendered peaks/fragments) is kept in
// the cache across tab switches. Pause the interaction handlers (.topmsv
// wheel/mouse bindings) + tooltip on deactivate, re-bind on activate. The
// static SVG structure survives — redraw is only needed to reflect any prop
// changes that arrived while hidden.
onMounted(() => {
  const element = svgRef.value
  if (!element) return
  const svg = select(element)
  ensureSvg(svg)
  applyZoom(svg)
  redraw(svg, true)
  cleanup = () => {
    hideTooltip()
    svg.on('.topmsv', null)
  }
})

onActivated(() => {
  const element = svgRef.value
  if (!element || !cleanup) return
  const svg = select(element)
  applyZoom(svg)
  redraw(svg)
})

onDeactivated(() => {
  cleanup?.()
})

onUnmounted(() => {
  cleanup?.()
  cleanup = null
})

watch(
  () => [
    props.sequence,
    props.modifications,
    props.breakpoints,
    props.peaks,
    props.matchedFragments,
    props.width,
    props.height,
  ],
  () => {
    const element = svgRef.value
    if (!element) return
    const svg = select(element)
    ensureSvg(svg)
    applyZoom(svg)
    redraw(svg, true)
  },
  { deep: true }
)

watch(
  () => [
    props.highlightedResidues,
    props.highlightedFragments,
    props.highlightedPeakIndices,
    showAnnotations.value,
    showLabels.value,
    peakDisplayMode.value,
  ],
  () => {
    const element = svgRef.value
    if (!element) return
    const svg = select(element)
    ensureSvg(svg)
    applyZoom(svg)
    redraw(svg)
  },
  { deep: true }
)
</script>

<style scoped>
.annotated-spectrum-ipsa {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-md);
  padding: var(--space-2-5);
}

.viewer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: var(--control-h);
}

.topmsv-peak-links {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-left: 18px;
  font-size: var(--text-md);
}

.topmsv-peak-links a {
  color: var(--color-info-text);
  text-decoration: none;
}

.topmsv-peak-links a:hover,
.topmsv-peak-links a.active {
  color: var(--color-primary);
  text-decoration: underline;
}

.viewer-controls {
  display: flex;
  gap: var(--space-3);
  align-items: center;
}

.topmsv-sequence-data {
  width: 100%;
  min-height: 42px;
  resize: vertical;
  padding: var(--space-1-5) var(--space-2-5);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-md);
  line-height: 1.35;
}

.chart-root {
  position: relative;
  width: 100%;
  min-width: 0;
  overflow: auto;
}

.chart-svg {
  display: block;
  width: max(100%, var(--chart-min-width, 520px));
  min-width: var(--chart-min-width, 520px);
  background: var(--chart-bg);
}

.tooltip {
  position: absolute;
  max-width: 320px;
  background: var(--chart-tooltip-bg);
  color: var(--chart-tooltip-text);
  padding: var(--space-2) var(--space-2-5);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  pointer-events: none;
  z-index: var(--z-float);
}

.annotation,
.empty-state {
  user-select: none;
}

:deep(.x-axis text),
:deep(.y-axis text),
:deep(.error-x-axis text),
:deep(.error-y-axis text) {
  font-size: var(--text-label);
  fill: var(--chart-axis);
}

:deep(.x-axis path),
:deep(.x-axis line),
:deep(.y-axis path),
:deep(.y-axis line),
:deep(.error-x-axis path),
:deep(.error-x-axis line),
:deep(.error-y-axis path),
:deep(.error-y-axis line) {
  stroke: var(--chart-grid);
}

:deep(.x-axis path),
:deep(.y-axis path),
:deep(.error-x-axis path),
:deep(.error-y-axis path) {
  stroke-width: 2;
}

:deep(.title-seq text) {
  font-family: var(--font-mono);
}

:deep(.mod-marker) {
  fill: var(--color-warning);
  fill-opacity: 0.75;
  stroke-width: 1.5px;
}

:deep(.pos-num) {
  fill: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-md);
}

:deep(.mod-label) {
  fill: var(--color-text);
  font-family: var(--font-mono);
  font-weight: 400;
  pointer-events: none;
}

:deep(.peak) {
  fill: var(--color-text);
}

:deep(.annotation) {
  font-family: var(--font-body);
  opacity: 0.8;
}

:deep(.title-cleavages polyline) {
  stroke: var(--chart-series-2);
}
</style>
