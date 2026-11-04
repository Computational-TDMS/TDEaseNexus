<!--
  SequenceTrack — residue-level fragment coverage for an MS2 identification.

  This is the read that justifies an MS2 viewer existing for a proteomics user:
  which backbone cleavage sites are actually supported by observed fragment
  ions, and where the modifications sit relative to them.

  Two rules govern this component, because coverage is a scientific claim:

  1. It never renders a blank ribbon that could be mistaken for "no coverage".
     When no fragment matches have been supplied, it says so in words and
     explains what the drawing does and does not cover (`annotationState`).
  2. Nothing is encoded in colour alone (PRODUCT.md, WCAG AA). Ion series each
     get their own labelled row; matched vs. unmatched is solid vs. dashed as
     well as coloured; a modified residue is underlined as well as tinted.
-->
<template>
  <section class="sequence-track" :aria-label="t('workbench.ms2Coverage.title')">
    <header class="track-header">
      <h3 class="track-title">{{ t('workbench.ms2Coverage.title') }}</h3>
      <div class="track-controls">
        <template v-if="hasSequence">
          <el-checkbox v-model="showPrefixIons" size="small">
            {{ t('workbench.ms2Coverage.nTermIons') }}
          </el-checkbox>
          <el-checkbox v-model="showSuffixIons" size="small">
            {{ t('workbench.ms2Coverage.cTermIons') }}
          </el-checkbox>
          <span class="track-info">{{ t('workbench.ms2Coverage.residueCount', { count: sequence.length }) }}</span>
          <span v-if="modifiedSiteCount > 0" class="track-info">
            {{ t('workbench.ms2Coverage.modSites', { count: modifiedSiteCount }) }}
          </span>
        </template>
      </div>
    </header>

    <!-- What this drawing is a claim about. Never omitted. -->
    <div class="track-status" :class="`track-status--${statusTone}`" role="status">
      <p class="track-status__headline">{{ statusHeadline }}</p>
      <p v-for="line in statusDetails" :key="line" class="track-status__detail">{{ line }}</p>
    </div>

    <div v-if="hasSequence" ref="containerRef" class="sequence-container">
      <!-- Position Ruler -->
      <div class="ruler-row">
        <span class="row-label"></span>
        <div class="ruler-markers" :style="trackStyle">
          <span
            v-for="pos in visiblePositions"
            :key="`ruler-${pos}`"
            class="ruler-marker"
            :class="{ tens: pos % 10 === 0 }"
            :style="cellStyle"
          >
            {{ pos % 10 === 0 ? pos : '' }}
          </span>
        </div>
      </div>

      <!-- Sequence -->
      <div class="sequence-row">
        <span id="ms2-seq-row-label" class="row-label">{{ t('workbench.ms2Coverage.rowSeq') }}</span>
        <div
          class="sequence-residues"
          role="group"
          :aria-label="t('workbench.ms2Coverage.sequenceGroupLabel')"
          :style="trackStyle"
          @keydown="handleSequenceKeydown"
        >
          <span
            v-for="residue in visibleResidues"
            :key="residue.position"
            class="residue"
            :class="{
              modified: residue.hasModification,
              highlighted: highlightedResidues.includes(residue.position),
              breakpoint: residue.hasBreakpoint,
            }"
            :style="cellStyle"
            :title="getResidueTooltip(residue)"
            :aria-label="getResidueTooltip(residue)"
            :tabindex="residue.position === activePosition ? 0 : -1"
            @mouseenter="handleResidueHover(residue.position)"
            @mouseleave="handleResidueLeave"
            @focus="handleResidueFocus(residue.position)"
            @blur="handleResidueLeave"
          >
            {{ residue.char }}
          </span>
        </div>
      </div>

      <!-- N-term ions (a/b/c) as polylines -->
      <template v-if="showPrefixIons">
        <div v-for="ionType in PREFIX_ION_TYPES" :key="`prefix-${ionType}`" class="ion-row prefix-ions">
          <span class="row-label ion-label" :style="{ color: ionColorVar(ionType) }">{{ ionType }}</span>
          <div class="ion-track" :style="trackStyle">
            <svg :width="trackWidth" :height="24" class="ion-svg" role="presentation">
              <g v-for="pos in visiblePositions" :key="`${ionType}-pos-${pos}`">
                <polyline
                  :points="getFragmentLinePoints(ionType, pos)"
                  :style="getFragmentLineStyle(ionType, pos)"
                  fill="none"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="fragment-line"
                  :class="{ highlighted: isPositionHighlighted(ionType, pos) }"
                  @mouseenter="handleFragmentLineHover(ionType, pos)"
                  @mouseleave="handleFragmentLeave"
                >
                  <title>{{ getFragmentLineTooltip(ionType, pos) }}</title>
                </polyline>
                <text
                  v-if="hasMultiChargeFragment(ionType, pos)"
                  :x="getFragmentLineLabelX(ionType, pos)"
                  :y="8"
                  text-anchor="middle"
                  font-size="9"
                  :style="{ fill: ionColorVar(ionType) }"
                  class="charge-label"
                >
                  {{ `${getMaxCharge(ionType, pos)}+` }}
                </text>
              </g>
            </svg>
          </div>
        </div>
      </template>

      <!-- C-term ions (x/y/z) as polylines -->
      <template v-if="showSuffixIons">
        <div v-for="ionType in SUFFIX_ION_TYPES" :key="`suffix-${ionType}`" class="ion-row suffix-ions">
          <span class="row-label ion-label" :style="{ color: ionColorVar(ionType) }">{{ ionType }}</span>
          <div class="ion-track" :style="trackStyle">
            <svg :width="trackWidth" :height="24" class="ion-svg" role="presentation">
              <g v-for="pos in visiblePositions" :key="`${ionType}-pos-${pos}`">
                <polyline
                  :points="getFragmentLinePoints(ionType, pos)"
                  :style="getFragmentLineStyle(ionType, pos)"
                  fill="none"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="fragment-line"
                  :class="{ highlighted: isPositionHighlighted(ionType, pos) }"
                  @mouseenter="handleFragmentLineHover(ionType, pos)"
                  @mouseleave="handleFragmentLeave"
                >
                  <title>{{ getFragmentLineTooltip(ionType, pos) }}</title>
                </polyline>
                <text
                  v-if="hasMultiChargeFragment(ionType, pos)"
                  :x="getFragmentLineLabelX(ionType, pos)"
                  :y="18"
                  text-anchor="middle"
                  font-size="9"
                  :style="{ fill: ionColorVar(ionType) }"
                  class="charge-label"
                >
                  {{ `${getMaxCharge(ionType, pos)}+` }}
                </text>
              </g>
            </svg>
          </div>
        </div>
      </template>

      <!-- Modifications -->
      <div v-if="modifications.length > 0" class="mod-row">
        <span class="row-label">{{ t('workbench.ms2Coverage.rowMod') }}</span>
        <div class="mod-markers" :style="trackStyle">
          <span
            v-for="mod in visibleModifications"
            :key="mod.id"
            class="mod-marker"
            role="button"
            tabindex="0"
            :style="cellStyle"
            :title="getModTooltip(mod)"
            :aria-label="getModTooltip(mod)"
            @click="handleModClick(mod)"
            @keydown.enter.prevent="handleModClick(mod)"
            @keydown.space.prevent="handleModClick(mod)"
          >
            {{ getModSymbol(mod) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Legend. Every entry names a non-colour channel as well as a colour. -->
    <div v-if="hasSequence" class="track-legend">
      <div class="legend-item">
        <svg class="legend-line" width="24" height="10" role="presentation">
          <line x1="1" y1="5" x2="23" y2="5" stroke="currentColor" stroke-width="2" />
        </svg>
        <span class="legend-text">{{ t('workbench.ms2Coverage.legendMatched') }}</span>
      </div>
      <div class="legend-item legend-item--muted">
        <svg class="legend-line" width="24" height="10" role="presentation">
          <line x1="1" y1="5" x2="23" y2="5" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3" />
        </svg>
        <span class="legend-text">{{ t('workbench.ms2Coverage.legendUnmatched') }}</span>
      </div>
      <div class="legend-item">
        <span class="legend-symbol modified">A</span>
        <span class="legend-text">{{ t('workbench.ms2Coverage.legendModified') }}</span>
      </div>
      <div class="legend-item">
        <span class="legend-colors">
          <span
            v-for="ionType in ALL_ION_TYPES"
            :key="`legend-${ionType}`"
            class="color-key"
            :style="{ color: ionColorVar(ionType) }"
          >
            <span class="color-dot" :style="{ background: ionColorVar(ionType) }"></span>{{ ionType }}
          </span>
        </span>
        <span class="legend-text">{{ t('workbench.ms2Coverage.legendIonSeries') }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MatchedFragment, Modification } from '@/composables/ms2-sequence/fragmentation'
import {
  computeMatchedCount,
  validateAASequence,
} from '@/services/visualization/ms2-sequence-helpers'
import { getCleavageLineX, pickFragmentForInteraction, SEQUENCE_CELL_WIDTH } from './layout'

/**
 * What the drawing is a claim about.
 *
 * - `matched`       fragment matches were supplied; the ion rows are evidence.
 * - `sequence-only` a proteoform is known but nothing has been matched against
 *                   it, so blank ion rows mean "not computed", not "not found".
 * - `no-sequence`   there is no proteoform to draw at all.
 *
 * When omitted it is derived from the props, so the component can never be
 * mounted into a state where it overstates its inputs.
 */
export type SequenceAnnotationState = 'matched' | 'sequence-only' | 'no-sequence'

interface Props {
  sequence: string
  modifications?: Modification[]
  breakpoints?: number[]
  matchedFragments: MatchedFragment[]
  highlightedResidues?: number[]
  highlightedFragments?: MatchedFragment[]
  maxVisibleLength?: number
  annotationState?: SequenceAnnotationState | null
  /** Extra provenance line, e.g. which MS2 peak list the row names. */
  annotationDetail?: string
}

const props = withDefaults(defineProps<Props>(), {
  modifications: () => [],
  breakpoints: () => [],
  highlightedResidues: () => [],
  highlightedFragments: () => [],
  maxVisibleLength: 200,
  annotationState: null,
  annotationDetail: '',
})

const emit = defineEmits<{
  'residue-hover': [position: number]
  'residue-leave': []
  'fragment-hover': [fragment: MatchedFragment]
  'fragment-leave': []
  'mod-click': [mod: Modification]
}>()

const { t } = useI18n()

const PREFIX_ION_TYPES = ['c', 'b', 'a'] as const
const SUFFIX_ION_TYPES = ['x', 'y', 'z'] as const
const ALL_ION_TYPES = ['a', 'b', 'c', 'x', 'y', 'z'] as const

const containerRef = ref<HTMLDivElement>()
const showPrefixIons = ref(true)
const showSuffixIons = ref(true)
/** Roving-tabindex cursor: exactly one residue is in the tab order. */
const activePosition = ref(1)

const cellWidth = SEQUENCE_CELL_WIDTH
const cellStyle = {
  width: `${cellWidth}px`,
  minWidth: `${cellWidth}px`,
  padding: '0',
  boxSizing: 'border-box' as const,
}

const hasSequence = computed(() => props.sequence.length > 0)

const visibleRange = computed(() => {
  const length = props.sequence.length
  if (length <= props.maxVisibleLength) return { start: 0, end: length }
  return { start: 0, end: props.maxVisibleLength }
})

const visiblePositions = computed(() => {
  const { start, end } = visibleRange.value
  return Array.from({ length: end - start }, (_, i) => start + i + 1)
})

const trackWidth = computed(() => visiblePositions.value.length * cellWidth)
const trackStyle = computed(() => ({
  width: `${trackWidth.value}px`,
  minWidth: `${trackWidth.value}px`,
}))

interface ResidueView {
  position: number
  char: string
  hasModification: boolean
  hasBreakpoint: boolean
  modifications: Modification[]
}

const residues = computed<ResidueView[]>(() => {
  const seq = props.sequence
  if (!seq) return []

  const breakpointSet = new Set(props.breakpoints)

  return Array.from(seq).map((char, idx) => {
    const position = idx + 1
    const mods = props.modifications.filter(mod => {
      const start = mod.position
      const end = mod.positionEnd ?? start
      return position >= start && position <= end
    })

    return {
      position,
      char,
      hasModification: mods.length > 0,
      hasBreakpoint: breakpointSet.has(position),
      modifications: mods,
    }
  })
})

const visibleResidues = computed(() => {
  const { start, end } = visibleRange.value
  return residues.value.slice(start, end)
})

const visibleModifications = computed(() => {
  const { start, end } = visibleRange.value
  return props.modifications.filter(mod => {
    const modStart = mod.position
    const modEnd = mod.positionEnd ?? modStart
    return modEnd >= start + 1 && modStart <= end
  })
})

// ---------------------------------------------------------------------------
// What this drawing is a claim about
// ---------------------------------------------------------------------------

/** Distinct backbone positions carrying at least one matched fragment. */
const coveredCleavageSites = computed(() => {
  const positions = new Set<number>()
  for (const fragment of props.matchedFragments) {
    if (fragment.isMatched) positions.add(fragment.position)
  }
  return positions.size
})

const totalCleavageSites = computed(() => Math.max(props.sequence.length - 1, 0))

/** Reuses the shared helper so the badge and the editor agree on the count. */
const modifiedSiteCount = computed(() =>
  computeMatchedCount(props.sequence, props.modifications))

const sequenceIsWellFormed = computed(() =>
  !hasSequence.value || validateAASequence(props.sequence).valid)

const effectiveState = computed<SequenceAnnotationState>(() => {
  if (props.annotationState) return props.annotationState
  if (!hasSequence.value) return 'no-sequence'
  return props.matchedFragments.length > 0 ? 'matched' : 'sequence-only'
})

const statusTone = computed(() => (effectiveState.value === 'matched' ? 'evidence' : 'caveat'))

const statusHeadline = computed(() => {
  if (effectiveState.value === 'no-sequence') {
    return t('workbench.ms2Coverage.stateNoSequenceHeadline')
  }
  if (effectiveState.value === 'sequence-only') {
    return t('workbench.ms2Coverage.stateSequenceOnlyHeadline')
  }
  const total = totalCleavageSites.value
  const covered = coveredCleavageSites.value
  const percent = total > 0 ? `${((covered / total) * 100).toFixed(1)}%` : '0.0%'
  return t('workbench.ms2Coverage.stateMatchedHeadline', { covered, total, percent })
})

const statusDetails = computed<string[]>(() => {
  const lines: string[] = []

  if (effectiveState.value === 'no-sequence') {
    lines.push(t('workbench.ms2Coverage.stateNoSequenceDetail'))
    return lines
  }

  if (effectiveState.value === 'sequence-only') {
    lines.push(t('workbench.ms2Coverage.stateSequenceOnlyDetail'))
    lines.push(props.annotationDetail
      ? t('workbench.ms2Coverage.stateSequenceOnlySource', { source: props.annotationDetail })
      : t('workbench.ms2Coverage.stateSequenceOnlyNoSource'))
  } else if (props.annotationDetail) {
    lines.push(t('workbench.ms2Coverage.stateSequenceOnlySource', { source: props.annotationDetail }))
  }

  if (!sequenceIsWellFormed.value) {
    lines.push(t('workbench.ms2Coverage.sequenceInvalid'))
  }

  if (props.sequence.length > visiblePositions.value.length) {
    lines.push(t('workbench.ms2Coverage.truncated', {
      shown: visiblePositions.value.length,
      total: props.sequence.length,
    }))
  }

  return lines
})

// ---------------------------------------------------------------------------
// Fragment geometry
// ---------------------------------------------------------------------------

const prefixIonsByType = computed(() => {
  const ions: Record<string, MatchedFragment[]> = { a: [], b: [], c: [] }
  props.matchedFragments
    .filter(f => ['a', 'b', 'c'].includes(f.ionType))
    .forEach(f => {
      if (!ions[f.ionType]) ions[f.ionType] = []
      ions[f.ionType].push(f)
    })

  Object.keys(ions).forEach(type => {
    ions[type].sort((a, b) => a.position - b.position)
  })

  return ions
})

const suffixIonsByType = computed(() => {
  const ions: Record<string, MatchedFragment[]> = { x: [], y: [], z: [] }
  props.matchedFragments
    .filter(f => ['x', 'y', 'z'].includes(f.ionType))
    .forEach(f => {
      if (!ions[f.ionType]) ions[f.ionType] = []
      ions[f.ionType].push(f)
    })

  Object.keys(ions).forEach(type => {
    ions[type].sort((a, b) => a.position - b.position)
  })

  return ions
})

// 120° elbow: diagonal + vertical. Use 30° vs horizontal for the diagonal.
const elbowDx = computed(() => cellWidth * 0.6)
const diagDx = computed(() => elbowDx.value * 0.5)
const diagDy = computed(() => elbowDx.value * 0.866)

function getFragmentLineX(position: number): number {
  const { start } = visibleRange.value
  return getCleavageLineX(position, start, cellWidth)
}

function getFragmentLinePoints(ionType: string, position: number): string {
  const isUp = ['a', 'b', 'c'].includes(ionType)
  // b/c: up-left, a: up-right; y/z: down-right, x: down-left
  const isLeft = ionType === 'b' || ionType === 'c' || ionType === 'x'

  const x0 = getFragmentLineX(position)
  const y0 = isUp ? 22 : 2

  const y2 = isUp ? 4 : 20
  const x2 = isLeft ? x0 - elbowDx.value : x0 + elbowDx.value

  const x1 = isLeft ? x0 - diagDx.value : x0 + diagDx.value
  const y1 = isUp ? 12 - diagDy.value : 12 + diagDy.value

  return `${x0},${y0} ${x1},${y1} ${x2},${y2}`
}

function getFragmentsAtPosition(ionType: string, position: number): MatchedFragment[] {
  const isPrefix = ['a', 'b', 'c'].includes(ionType)
  const ions = isPrefix ? prefixIonsByType.value : suffixIonsByType.value
  return (ions[ionType] || []).filter(f => f.position === position)
}

/** Ion hue as a design token, never a literal. */
function ionColorVar(ionType: string): string {
  return `var(--ms2-ion-${ionType}, var(--color-text-muted))`
}

/**
 * Colour carries the ion series, but never alone: matched fragments are solid
 * and thick, unmatched theoretical ones are dashed and thin, and each series
 * already sits on its own labelled row.
 */
function getFragmentLineStyle(ionType: string, position: number): Record<string, string> {
  const fragments = getFragmentsAtPosition(ionType, position)
  const hasMatched = fragments.some(f => f.isMatched)
  const highlighted = isPositionHighlighted(ionType, position)

  if (fragments.length === 0) {
    return {
      stroke: 'var(--ms2-ion-absent)',
      strokeWidth: '1',
      strokeDasharray: '2 4',
      opacity: '0.35',
    }
  }

  return {
    stroke: hasMatched ? ionColorVar(ionType) : 'var(--ms2-ion-absent)',
    strokeWidth: highlighted ? '3' : hasMatched ? '2' : '1',
    strokeDasharray: hasMatched ? 'none' : '3 3',
    opacity: hasMatched ? '1' : '0.55',
  }
}

function isPositionHighlighted(ionType: string, position: number): boolean {
  const fragments = getFragmentsAtPosition(ionType, position)
  return fragments.some(f => isFragmentHighlighted(f))
}

function hasMultiChargeFragment(ionType: string, position: number): boolean {
  const fragments = getFragmentsAtPosition(ionType, position)
  return fragments.some(f => f.charge > 1 && f.isMatched)
}

function getMaxCharge(ionType: string, position: number): number {
  const fragments = getFragmentsAtPosition(ionType, position)
  const charges = fragments.filter(f => f.isMatched).map(f => f.charge)
  return charges.length > 0 ? Math.max(...charges) : 1
}

function getFragmentLineLabelX(ionType: string, position: number): number {
  const isLeft = ionType === 'b' || ionType === 'c' || ionType === 'x'
  const x0 = getFragmentLineX(position)
  return isLeft ? x0 - elbowDx.value * 0.65 : x0 + elbowDx.value * 0.65
}

function getFragmentLineTooltip(ionType: string, position: number): string {
  const fragments = getFragmentsAtPosition(ionType, position)
  if (fragments.length === 0) {
    return t('workbench.ms2Coverage.tooltipNoFragments', { label: `${ionType}${position}` })
  }

  const parts: string[] = []
  fragments.forEach(f => {
    parts.push(`${f.ionType}${f.position}^${f.charge}+${f.neutralLoss ? `-${f.neutralLoss}` : ''}`)
    parts.push(`  ${t('workbench.ms2Coverage.tooltipTheoretical', { value: f.theoreticalMz.toFixed(4) })}`)
    if (f.isMatched && f.matchedPeak) {
      parts.push(`  ${t('workbench.ms2Coverage.tooltipObserved', { value: f.matchedPeak.mz.toFixed(4) })}`)
      parts.push(`  ${t('workbench.ms2Coverage.tooltipError', { value: f.matchErrorPpm?.toFixed(2) ?? '—' })}`)
    }
  })
  return parts.join('\n')
}

function handleFragmentLineHover(ionType: string, position: number) {
  const fragments = getFragmentsAtPosition(ionType, position)
  const fragment = pickFragmentForInteraction(fragments)
  if (!fragment) return
  emit('fragment-hover', fragment)
}

function getModSymbol(mod: Modification): string {
  const symbols: Record<string, string> = {
    ptm: '★',
    massShift: '◆',
    label: '■',
  }
  return symbols[mod.type] || '■'
}

function getResidueTooltip(residue: ResidueView): string {
  const parts = [t('workbench.ms2Coverage.tooltipPosition', {
    position: residue.position,
    residue: residue.char,
  })]
  if (residue.modifications.length > 0) {
    parts.push(t('workbench.ms2Coverage.tooltipModifications'))
    residue.modifications.forEach(m => {
      const sign = m.massShift >= 0 ? '+' : ''
      parts.push(`  ${m.name} (${sign}${m.massShift.toFixed(4)} Da)`)
    })
  }
  return parts.join('\n')
}

function getModTooltip(mod: Modification): string {
  const range = mod.positionEnd ? `${mod.position}-${mod.positionEnd}` : `${mod.position}`
  const sign = mod.massShift >= 0 ? '+' : ''
  const parts = [
    mod.name,
    t('workbench.ms2Coverage.tooltipModPosition', { range }),
    t('workbench.ms2Coverage.tooltipMassShift', { value: `${sign}${mod.massShift.toFixed(4)}` }),
  ]
  if (mod.composition) {
    parts.push(t('workbench.ms2Coverage.tooltipComposition', { value: mod.composition }))
  }
  return parts.join('\n')
}

function isFragmentHighlighted(fragment: MatchedFragment): boolean {
  return props.highlightedFragments.some(
    f => f.ionType === fragment.ionType && f.position === fragment.position && f.charge === fragment.charge
  )
}

function handleResidueHover(position: number) {
  emit('residue-hover', position)
}

function handleResidueFocus(position: number) {
  activePosition.value = position
  emit('residue-hover', position)
}

/** Arrow / Home / End move the roving cursor, so the track is fully keyboard-reachable. */
function handleSequenceKeydown(event: KeyboardEvent) {
  const positions = visiblePositions.value
  if (positions.length === 0) return

  const first = positions[0]
  const last = positions[positions.length - 1]
  let next: number | null = null

  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(activePosition.value + 1, last)
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = Math.max(activePosition.value - 1, first)
  else if (event.key === 'Home') next = first
  else if (event.key === 'End') next = last
  if (next === null) return

  event.preventDefault()
  activePosition.value = next

  const host = event.currentTarget as HTMLElement | null
  const target = host?.children[next - first] as HTMLElement | undefined
  target?.focus()
}

function handleResidueLeave() {
  emit('residue-leave')
}

function handleFragmentLeave() {
  emit('fragment-leave')
}

function handleModClick(mod: Modification) {
  emit('mod-click', mod)
}

defineExpose({ containerRef })
</script>

<style scoped>
.sequence-track {
  /* Ion-series hues, declared once so SVG and labels cannot drift apart. */
  --ms2-ion-a: var(--domain-ion-a);
  --ms2-ion-b: var(--domain-ion-b);
  --ms2-ion-c: var(--domain-ion-c);
  --ms2-ion-x: var(--domain-ion-x);
  --ms2-ion-y: var(--domain-ion-y);
  --ms2-ion-z: var(--domain-ion-z);
  --ms2-ion-absent: var(--color-text-disabled);

  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.track-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.track-title {
  margin: 0;
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
  font-weight: 600;
  color: var(--color-text);
}

.track-controls {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  flex-wrap: wrap;
}

.track-info {
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}

.track-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg-muted);
}

.track-status--caveat {
  border-color: color-mix(in srgb, var(--color-warning) 55%, var(--line-hairline));
  background: color-mix(in srgb, var(--color-warning) 12%, var(--color-bg-secondary));
}

.track-status__headline {
  margin: 0;
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
  font-weight: 600;
  color: var(--color-text);
}

.track-status__detail {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}

.sequence-container {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: var(--font-mono);
  overflow-x: auto;
  overflow-y: hidden;
}

.ruler-row,
.sequence-row,
.ion-row,
.mod-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 24px;
}

.row-label {
  min-width: 40px;
  font-size: var(--text-label);
  line-height: var(--text-label-lh);
  font-weight: 600;
  color: var(--color-text-muted);
  text-align: right;
  flex-shrink: 0;
}

.row-label.ion-label {
  font-size: var(--text-sm);
  font-weight: 700;
}

.ruler-markers,
.sequence-residues,
.mod-markers {
  display: flex;
  gap: 0;
  flex: 0 0 auto;
}

.ion-track {
  flex: 0 0 auto;
  overflow: hidden;
}

.ion-svg {
  display: block;
}

.fragment-line {
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.fragment-line:hover {
  opacity: 1;
}

.fragment-line.highlighted {
  filter: drop-shadow(0 0 3px var(--color-warning));
}

.charge-label {
  font-weight: 600;
  pointer-events: none;
}

.ruler-marker {
  text-align: center;
  font-size: var(--text-label);
  color: var(--color-text-disabled);
}

.ruler-marker.tens {
  color: var(--color-text-muted);
  font-weight: 600;
}

.residue {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  border-radius: var(--radius-xs);
  font-size: var(--text-base);
  color: var(--color-text);
}

.residue:hover {
  background: var(--color-hover);
}

/* Modification is carried by an underline as well as a tint. */
.residue.modified {
  background: color-mix(in srgb, var(--color-warning) 18%, transparent);
  color: var(--color-text);
  font-weight: 600;
  text-decoration: underline;
  text-decoration-style: solid;
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
  text-decoration-color: var(--color-warning-text);
}

.residue.highlighted {
  background: color-mix(in srgb, var(--color-warning) 34%, transparent);
  color: var(--color-text);
  font-weight: 700;
  box-shadow: 0 0 0 2px var(--color-warning);
}

.residue.breakpoint {
  border-right: 2px solid var(--color-success);
  margin-right: var(--space-1);
}

.residue:focus-visible,
.mod-marker:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}

.mod-row {
  margin-top: var(--space-1);
  padding-top: var(--space-1);
  border-top: var(--line-w) solid var(--line-hairline);
}

.mod-marker {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--color-warning-text);
  font-size: var(--text-sm);
  transition: transform var(--transition-fast);
}

.mod-marker:hover {
  transform: scale(1.3);
}

.track-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
  padding-top: var(--space-2);
  border-top: var(--line-w) solid var(--line-hairline);
  font-size: var(--text-label);
  line-height: var(--text-label-lh);
}

.legend-item {
  display: flex;
  gap: var(--space-1);
  align-items: center;
  color: var(--color-text);
}

.legend-item--muted {
  color: var(--color-text-muted);
}

.legend-line {
  display: block;
  flex-shrink: 0;
}

.legend-symbol.modified {
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
  text-decoration-color: var(--color-warning-text);
  font-family: var(--font-mono);
}

.legend-text {
  color: var(--color-text-muted);
}

.legend-colors {
  display: flex;
  gap: var(--space-2);
}

.color-key {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-family: var(--font-mono);
  font-weight: 700;
}

.color-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
</style>
