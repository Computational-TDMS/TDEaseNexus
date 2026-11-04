<template>
  <div ref="containerRef" class="fragment-annotation-viewer">
    <!-- Stats bar -->
    <div class="fa-stats">
      <span class="stat">{{ t('visualization.viewer.fragments') }}: <strong>{{ annotationRows.length }}</strong></span>
      <span class="stat">{{ t('visualization.viewer.matched') }}: <strong>{{ matchedCount }}</strong></span>
      <span class="stat">{{ t('visualization.viewer.sequence') }}: <strong>{{ sequence.length }} AA</strong></span>
      <span v-if="precursorCharge" class="stat">z=<strong>{{ precursorCharge }}</strong></span>
      <span v-if="activationMethod" class="stat">{{ activationMethod }}</span>
    </div>

    <!-- D3 Annotated Spectrum (IPSA-style) -->
    <AnnotatedSpectrumIPSA
      :sequence="sequence"
      :modifications="modifications"
      :peaks="peaks"
      :matched-fragments="matchedFragments"
      :breakpoints="breakpoints"
      :highlighted-residues="interactionState.highlightedResidues"
      :highlighted-fragments="interactionState.highlightedFragments"
      :highlighted-peak-indices="interactionState.highlightedPeaks"
      :width="spectrumWidth"
      :height="spectrumHeight"
      :min-width="spectrumMinWidth"
      @residue-hover="handleResidueHover"
      @residue-leave="handleInteractionLeave"
      @fragment-hover="handleFragmentHover"
      @fragment-leave="handleInteractionLeave"
      @peak-hover="handlePeakHover"
      @peak-leave="handleInteractionLeave"
    />

    <!-- Per-ion-type error heatmaps from bindings -->
    <div v-if="errorMapBindings.length > 0" class="heatmap-section">
      <div class="heatmap-section__header">
        <span class="heatmap-section__title">{{ t('visualization.viewer.perIonErrorMaps') }}</span>
      </div>
      <div class="heatmap-grid">
        <div
          v-for="(em, idx) in errorMapBindings"
          :key="em.id ?? idx"
          class="heatmap-cell"
        >
          <ErrorHeatmapViewer
            :view-spec="emViewSpec(em)"
            :datasets="emDatasets(em)"
          />
        </div>
      </div>
    </div>

    <!-- Fallback -->
    <div v-if="!hasData" class="fa-empty">
      <p>{{ t('visualization.viewer.noFragmentAnnotation') }}</p>
      <p class="fa-empty__hint">
        {{ t('visualization.viewer.noFragmentAnnotationHint') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * FragmentAnnotationViewer — consumes pre-bound annotation data via
 * ``viewSpec.bindings`` (evaluated by ViewSpecBinder at payload time).
 *
 * Data contract (from binder):
 *
 * .. code-block:: json
 *
 *    {
 *      "viewer": "fragment_annotation",
 *      "viewSpec": {
 *        "bindings": {
 *          "spectrum": {
 *            "rows": [{"mz": 401.23, "intensity": 8500, "charge": 1}, ...]
 *          },
 *          "annotations": {
 *            "rows": [{"ion_type": "c5", "position": 5, ...}, ...]
 *          },
 *          "errorMaps": [
 *            {"id": "c", "rows": [{"position": 5, "charge": 1, "value": 2.3}, ...]},
 *            {"id": "z", "rows": [...]}
 *          ]
 *        },
 *        "sequence": "APAPAAAAPAAEKPAA...",
 *        "modifications": [...],
 *        "activationMethod": "ETD"
 *      }
 *    }
 */
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Dataset } from '@/types/visualization'
import type { MatchedFragment, Modification, SpectrumPeak } from '@/composables/ms2-sequence'
import { InteractionManager } from '@/composables/ms2-sequence'
import AnnotatedSpectrumIPSA from './ms2-sequence/AnnotatedSpectrumIPSA.vue'
import ErrorHeatmapViewer from './ErrorHeatmapViewer.vue'

interface Props {
  datasets?: Dataset[]
  viewSpec?: Record<string, unknown>
  config?: Record<string, unknown>
}

const props = withDefaults(defineProps<Props>(), {
  datasets: () => [],
  viewSpec: () => ({}),
})
const { t } = useI18n()

defineEmits<{
  selectionChange: [selection: unknown]
  configChange: [config: Record<string, unknown>]
}>()

// ── Interaction state ──
const interactionManager = new InteractionManager()
const interactionState = ref({
  highlightedFragments: [] as MatchedFragment[],
  highlightedPeaks: [] as number[],
  highlightedResidues: [] as number[],
})

// ── Responsive container sizing ──
const containerRef = ref<HTMLElement | null>(null)
const containerSize = ref({ width: 1000, height: 760 })
const spectrumMinWidth = 800
let resizeObserver: ResizeObserver | null = null

function updateContainerSize() {
  const el = containerRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (rect.width > 0) {
    containerSize.value = { width: rect.width - 4, height: 760 }
  }
}

// KeepAlive lifecycle: pause the ResizeObserver while hidden (no point
// recomputing geometry for a detached node), re-attach + re-measure on
// activate (container may have a new size after the tab switch).
function observeContainer() {
  if (resizeObserver || typeof ResizeObserver === 'undefined') return
  if (!containerRef.value) return
  resizeObserver = new ResizeObserver(() => updateContainerSize())
  resizeObserver.observe(containerRef.value)
}

function unobserveContainer() {
  resizeObserver?.disconnect()
  resizeObserver = null
}

onMounted(() => {
  updateContainerSize()
  observeContainer()
})

onActivated(() => {
  observeContainer()
  updateContainerSize()
})

onDeactivated(() => { unobserveContainer() })

onBeforeUnmount(() => { unobserveContainer() })

const spectrumWidth = computed(() => Math.max(spectrumMinWidth, Math.floor(containerSize.value.width)))
const spectrumHeight = 760

// ── Extract bindings from viewSpec ──
// Binder-evaluated bindings live in viewSpec.bindings (when coming through
// the payload path), or in viewSpec as direct option fields (legacy compat).

const rawBindings = computed<Record<string, unknown>>(() => {
  const b = (props.viewSpec as Record<string, unknown>)?.bindings
  return (b && typeof b === 'object' ? b : {}) as Record<string, unknown>
})

/** Binding with evaluated rows. */
interface EvalBinding {
  id?: string
  rows: Record<string, unknown>[]
  columns: Record<string, string>
}

function bindingRows(spec: unknown): Record<string, unknown>[] {
  if (!spec || typeof spec !== 'object') return []
  const rows = (spec as Record<string, unknown>).rows
  return Array.isArray(rows) ? rows as Record<string, unknown>[] : []
}

// ── Spectrum peaks from bindings.spectrum ──
const spectrumBinding = computed(() => rawBindings.value.spectrum)

const peaks = computed<SpectrumPeak[]>(() => {
  const rows = bindingRows(spectrumBinding.value)
  return rows.map((row, idx) => ({
    index: idx,
    mz: safeNumber(row.mz) ?? 0,
    intensity: safeNumber(row.intensity) ?? 0,
    charge: safeNumber(row.charge) ?? 1,
  })).filter((p) => p.mz > 0)
})

// ── Annotations from bindings.annotations ──
const annotationsBinding = computed(() => rawBindings.value.annotations)

const annotationRows = computed<Record<string, unknown>[]>(() =>
  bindingRows(annotationsBinding.value)
)

const matchedFragments = computed<MatchedFragment[]>(() =>
  annotationRows.value
    .map((row) => annotationToMatchedFragment(row, peaks.value))
    .filter((f): f is MatchedFragment => f !== null)
)

const matchedCount = computed(() =>
  matchedFragments.value.filter((f) => f.isMatched).length
)

const breakpoints = computed(() => {
  const unique = new Set<number>()
  matchedFragments.value.forEach((f) => {
    if (f.isMatched) unique.add(f.position)
  })
  return Array.from(unique).sort((a, b) => a - b)
})

// ── Error maps from bindings.errorMaps (array) ──
const errorMapBindings = computed<EvalBinding[]>(() => {
  const raw = rawBindings.value.errorMaps
  if (!Array.isArray(raw)) return []
  return raw.map((item) => {
    if (!item || typeof item !== 'object') return { rows: [], columns: {} }
    const obj = item as Record<string, unknown>
    return {
      id: String(obj.id ?? ''),
      rows: bindingRows(obj),
      columns: (obj.columns as Record<string, string>) ?? {},
    }
  })
})

// ── ViewSpec metadata ──
const viewSpecOptions = computed<Record<string, unknown>>(() => {
  const o = (props.viewSpec as Record<string, unknown>)?.options
  return (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
})

const sequence = computed<string>(() =>
  String((props.viewSpec as Record<string, unknown>)?.sequence ?? viewSpecOptions.value.sequence ?? '')
)

const rawModifications = computed<Array<Record<string, unknown>>>(() => {
  const mods = (props.viewSpec as Record<string, unknown>)?.modifications
  return Array.isArray(mods) ? mods : []
})

const precursorCharge = computed<number | undefined>(() =>
  safeNumber((props.viewSpec as Record<string, unknown>)?.precursorCharge)
)

const activationMethod = computed<string>(() => {
  const vs = props.viewSpec as Record<string, unknown>
  return String(vs?.activationMethod ?? vs?.activation ?? '')
})

// ── Build Modification[] from viewSpec ──
const modifications = computed<Modification[]>(() =>
  rawModifications.value.map((m, idx): Modification => ({
    id: String(m.id ?? `mod-${idx}`),
    name: String(m.name ?? 'Modification'),
    type: (m.type as Modification['type']) ?? 'ptm',
    position: safeNumber(m.position) ?? 1,
    positionEnd: safeNumber(m.positionEnd),
    massShift: safeNumber(m.massShift) ?? 0,
    unimodId: m.unimodId ? String(m.unimodId) : undefined,
    composition: m.composition ? String(m.composition) : undefined,
  }))
)

const hasData = computed(() =>
  sequence.value.length > 0 && peaks.value.length > 0
)

// ── Heatmap proxying ──
const vsRecord = computed(() => props.viewSpec as Record<string, unknown>)

function emViewSpec(em: EvalBinding): Record<string, unknown> {
  const highlight = vsRecord.value?.highlightSite
  const spec: Record<string, unknown> = {
    title: em.id ? `${em.id}-ion error` : 'Error map',
    bindings: { grid: { rows: em.rows, columns: em.columns } },
  }
  if (highlight != null) spec.highlightSite = highlight
  return spec
}

function emDatasets(_em: EvalBinding): Dataset[] {
  // ErrorHeatmapViewer can consume bindings from viewSpec directly;
  // datasets are empty here to avoid column guessing on raw tables.
  return []
}

// ── Interaction handlers ──
function handleResidueHover(position: number) {
  interactionState.value = interactionManager.highlightByResidue(position, matchedFragments.value)
}
function handleFragmentHover(fragment: MatchedFragment) {
  interactionState.value = interactionManager.highlightByFragment(fragment)
}
function handlePeakHover(peak: SpectrumPeak | null) {
  if (peak) {
    interactionState.value = interactionManager.highlightByPeak(peak, matchedFragments.value)
  }
}
function handleInteractionLeave() {
  interactionState.value = interactionManager.clearHighlight()
}

// ── Helpers ──

function annotationToMatchedFragment(
  row: Record<string, unknown>,
  peakList: SpectrumPeak[],
): MatchedFragment | null {
  const ionToken = String(row.ion_type ?? row.type ?? '').trim()
  const parsed = /^([abcxyz])(\d+)/i.exec(ionToken)
  if (!parsed) return null
  const ionType = parsed[1].toLowerCase() as MatchedFragment['ionType']
  const position = safeNumber(row.position) ?? Number(parsed[2])
  const charge = safeNumber(row.charge) ?? 1
  const theoMz = safeNumber(row.theo_mz ?? row.mz)
  const obsMz = safeNumber(row.obs_mz ?? row.matched_mz)
  const errorPpm = safeNumber(row.ppm_error ?? row.error)
  if (theoMz == null || obsMz == null || errorPpm == null) return null

  const matchedPeak = peakList.find(
    (p) => Math.abs(p.mz - obsMz) < (theoMz * 20) / 1e6,
  )

  const lossText = row.neutral_loss ? String(row.neutral_loss).toUpperCase() : ''
  const neutralLoss: MatchedFragment['neutralLoss'] =
    lossText === 'H2O' || lossText === 'NH3' ? lossText : undefined

  const seqLen = sequence.value.length
  const isPrefix = ionType === 'a' || ionType === 'b' || ionType === 'c'
  const sequenceRange: [number, number] = isPrefix
    ? [1, Math.min(position, seqLen)]
    : [Math.max(seqLen - position + 1, 1), seqLen]

  return {
    ionType,
    position,
    charge,
    theoreticalMass: 0,
    theoreticalMz: theoMz,
    sequenceRange,
    neutralLoss,
    matchedPeak: matchedPeak ?? undefined,
    matchErrorPpm: errorPpm,
    matchErrorDa: matchedPeak ? Math.abs(matchedPeak.mz - theoMz) : undefined,
    isMatched: true,
    peakIntensity: matchedPeak?.intensity,
    relativeIntensity: undefined,
  }
}

function safeNumber(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
</script>

<style scoped>
.fragment-annotation-viewer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-2-5);
  min-height: 400px;
}

.fa-stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--text-label);
}
.fa-stats .stat {
  color: var(--color-text-secondary);
  background: var(--color-bg);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-xs);
  padding: 2px var(--space-1-5);
}
.fa-stats strong {
  color: var(--color-text);
}

.heatmap-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}
.heatmap-section__header {
  border-top: var(--line-w) solid var(--line-hairline);
  padding-top: var(--space-2);
  margin-top: var(--space-1);
}
.heatmap-section__title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
}
.heatmap-grid {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.heatmap-cell {
  flex: 1;
  min-width: 320px;
}

.fa-empty {
  padding: var(--space-5);
  text-align: center;
  color: var(--color-text-muted);
  border: var(--line-w) dashed var(--line-hairline);
  border-radius: var(--radius-md);
}
.fa-empty__hint {
  font-size: var(--text-sm);
  color: var(--color-text-disabled);
  margin-top: var(--space-2);
}
.fa-empty code {
  background: var(--color-bg);
  padding: 1px var(--space-1);
  border-radius: var(--radius-xs);
  font-size: var(--text-label);
}
</style>
