<!--
  MS2SpectrumViewer — the `fragment_spectrum` viewer registered in
  `services/visualization/registrations/ms2sequence.ts`.

  It adapts a unified PRSM dataset into the `TableData` shape MS2SequenceViewer
  expects, and — below the spectrum, never above it — composes the residue-level
  `SequenceTrack`. The track is fed from the *same* resolved dataset: the
  selected row is located with `ms2-sequence/composition.ts` (the resolver the
  spectrum already uses) and the proteoform is parsed with `utils/proforma.ts`.
  There is no second fetch and no second artifact resolution here.

  Fragment matching runs client-side: scan-attributed peak tables supplied on
  the viewer's `peaks_table` port (`peakTableToSpectra`) are matched against
  the selected proteoform with `composePrsmViewerModel` — the same model
  MS2SequenceViewer uses, so the spectrum, its table and this track can never
  disagree. When no scan-attributed peak table is supplied, the track falls
  back to `annotationState="sequence-only"`, which says in words that blank
  ion rows mean "not computed", not "no coverage found", and names whichever
  MS2 peak list the selected row points at.
-->
<template>
  <div class="ms2-spectrum-viewer">
    <!-- Primary read: the spectrum. -->
    <div class="ms2-spectrum-viewer__primary">
      <MS2SequenceViewer
        :data="resolvedData"
        :config="config"
        :selection="selection"
        :spectra="spectra"
        @selection-change="$emit('selectionChange', $event)"
        @config-change="$emit('configChange', $event)"
      />
    </div>

    <!-- Supporting read: residue-level coverage. -->
    <section v-if="resolvedData" class="ms2-spectrum-viewer__coverage">
      <button
        type="button"
        class="coverage-toggle"
        :aria-expanded="showCoverage"
        aria-controls="ms2-coverage-panel"
        @click="showCoverage = !showCoverage"
      >
        <span class="coverage-toggle__caret" :class="{ open: showCoverage }" aria-hidden="true">▸</span>
        <span class="coverage-toggle__label">{{ t('workbench.ms2Coverage.title') }}</span>
        <span class="coverage-toggle__hint">{{ t('workbench.ms2Coverage.sectionHint') }}</span>
        <span class="coverage-toggle__action">
          {{ showCoverage ? t('workbench.ms2Coverage.collapse') : t('workbench.ms2Coverage.expand') }}
        </span>
      </button>

      <div v-show="showCoverage" id="ms2-coverage-panel">
        <SequenceTrack
          :sequence="parsedProteoform.sequence"
          :modifications="parsedProteoform.modifications"
          :matched-fragments="matchedFragments"
          :annotation-state="annotationState"
          :annotation-detail="annotationDetail"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Dataset, SelectionState, TableData } from '@/types/visualization'
import type { MatchedFragment } from '@/composables/ms2-sequence/fragmentation'
import type { MsAlignSpectrum } from '@/services/visualization/msalign'
import { composePrsmViewerModel } from '@/services/visualization/prsm-viewer-model'
import { peakTableToSpectra } from '@/services/visualization/spectrumInput'
import { parseProteoformAnnotation } from '@/utils/proforma'
import MS2SequenceViewer from './MS2SequenceViewer.vue'
import SequenceTrack from './ms2-sequence/SequenceTrack.vue'
import { resolveMs2SelectionContext, tableRows } from './ms2-sequence/composition'
import { resolveMsalignSource } from './ms2-sequence/artifactSource'

const props = withDefaults(defineProps<{
  data?: TableData | null
  datasets?: Dataset[]
  config?: Record<string, unknown>
  selection?: SelectionState | null
}>(), {
  data: null,
  datasets: undefined,
  config: () => ({}),
  selection: null,
})

defineEmits<{
  selectionChange: [selection: SelectionState]
  configChange: [config: Record<string, unknown>]
}>()

const { t } = useI18n()

const showCoverage = ref(true)

const resolvedData = computed<TableData | null>(() => {
  if (props.data) return props.data
  const dataset = selectPrsmDataset(props.datasets ?? [])
  if (!dataset) return null
  return {
    columns: dataset.columns.map((column) => ({
      id: column.name,
      name: column.name,
      type: column.type === 'integer' ? 'number' : column.type as TableData['columns'][number]['type'],
      visible: true,
      sortable: true,
      filterable: true,
    })),
    rows: dataset.rows,
    totalRows: dataset.rows.length,
    sourceFile: dataset.id,
  }
})

function selectPrsmDataset(datasets: Dataset[]): Dataset | null {
  return datasets.find((dataset) => dataset.kind === 'prsm_table')
    ?? datasets.find((dataset) => hasPrsmColumns(dataset))
    ?? datasets[0]
    ?? null
}

function hasPrsmColumns(dataset: Dataset): boolean {
  const names = new Set(dataset.columns.map((column) => column.name.toLowerCase()))
  return names.has('prsm id')
    || names.has('prsm_id')
    || names.has('spectrum id')
    || names.has('spectrum_id')
    || names.has('proteoform')
}

// ---------------------------------------------------------------------------
// Coverage track input — derived from `resolvedData`, never re-fetched
// ---------------------------------------------------------------------------

/** The row the spectrum is already showing, resolved by the shared resolver. */
const selectedRow = computed<Record<string, unknown> | null>(() =>
  resolveMs2SelectionContext(tableRows(resolvedData.value), props.selection).selectedRow)

const PROTEOFORM_KEYS = ['Proteoform', 'proteoform', 'Proteoform annotation', 'proteoform_annotation']

const rawProteoform = computed<string>(() => {
  const row = selectedRow.value
  if (!row) return ''
  for (const key of PROTEOFORM_KEYS) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
})

const parsedProteoform = computed(() => parseProteoformAnnotation(rawProteoform.value))

/**
 * Fragment matching from the peaks the pipeline already supplied on the
 * `peaks_table` port — through the same `composePrsmViewerModel` the inner
 * viewer uses, so the track and the spectrum can never disagree. With no
 * scan-attributed peak table this stays an explicit empty list rather than a
 * fabricated one, and `annotationState` below makes the track say so.
 */
const spectra = computed<MsAlignSpectrum[]>(() =>
  (props.datasets ?? [])
    .filter((dataset) => dataset.kind === 'peak_table')
    .flatMap((dataset) => peakTableToSpectra(dataset)))

const matchedFragments = computed<MatchedFragment[]>(() => {
  const row = selectedRow.value
  if (!row || spectra.value.length === 0) return []
  return composePrsmViewerModel(row, spectra.value, {
    maxCharge: optionNumber(props.config.maxFragmentCharge),
    tolerancePpm: optionNumber(props.config.tolerancePpm),
    includeNeutralLosses: props.config.showNeutralLosses === true,
  })?.matchedFragments ?? []
})

function optionNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const annotationState = computed<'matched' | 'sequence-only' | 'no-sequence'>(() => {
  if (!parsedProteoform.value.sequence) return 'no-sequence'
  return matchedFragments.value.length > 0 ? 'matched' : 'sequence-only'
})

/** Which MS2 peak list the row names, if any — provenance, not a second fetch. */
const annotationDetail = computed<string>(() => {
  const row = selectedRow.value
  if (!row) return ''
  const source = resolveMsalignSource(row)
  if (!source) return ''
  if (source.artifactId && source.artifactId !== '__by_path__') return source.artifactId
  return source.filePath ?? ''
})
</script>

<script lang="ts">
export default {
  name: 'MS2SpectrumViewer',
}
</script>

<style scoped>
.ms2-spectrum-viewer {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
  width: 100%;
  height: 100%;
  overflow: auto;
}

.ms2-spectrum-viewer__primary {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.ms2-spectrum-viewer__coverage {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.coverage-toggle {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-family: inherit;
  font-size: var(--text-base);
  line-height: var(--text-base-lh);
  text-align: left;
  cursor: pointer;
}

.coverage-toggle:hover {
  background: var(--color-hover);
}

.coverage-toggle:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}

.coverage-toggle__caret {
  display: inline-block;
  transition: transform var(--transition-fast);
}

.coverage-toggle__caret.open {
  transform: rotate(90deg);
}

.coverage-toggle__label {
  font-weight: 600;
}

.coverage-toggle__hint {
  flex: 1 1 auto;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
}

.coverage-toggle__action {
  color: var(--color-text-muted);
  font-size: var(--text-label);
  line-height: var(--text-label-lh);
}
</style>
