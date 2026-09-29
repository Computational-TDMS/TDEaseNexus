<!--
  MsAlignDocument — spectrum-list browser shared by TopFD `.msalign` files
  and mzML indexes (`visualization/mzml.ts` emits `MsAlignSpectrum`-shaped
  entries for exactly this component).

  A spectrum file carries tens of thousands of scans, so the left pane is a
  *multi-dimensional filter* first (MS level, scan range, precursor m/z
  range, RT range when the format has it — mzML does, msalign does not) and
  a bounded list second. Selecting a row renders that one spectrum in the
  right pane through the existing `SpectrumViewer` — no second parser and no
  second Plotly path. mzML entries carry no peaks in the index; their
  `peakLoader` decodes the selected spectrum lazily from its byte range,
  cached per spectrum.

  Limits: the list caps the number of *rows it renders* (not the data) and
  says so when it does.
-->
<template>
  <div class="msalign-document">
    <aside class="msalign-document__list" :aria-label="t('workbench.fileDocument.msalign.listLabel')">
      <div class="msalign-document__list-head">
        <div class="msalign-document__filters">
          <label class="msalign-document__filter msalign-document__filter--level">
            <span class="msalign-document__filter-label">{{ t('workbench.fileDocument.msalign.filterLevel') }}</span>
            <select v-model="levelFilter" class="msalign-document__select" :aria-label="t('workbench.fileDocument.msalign.filterLevel')">
              <option value="">{{ t('workbench.fileDocument.msalign.filterLevelAll') }}</option>
              <option value="1">MS1</option>
              <option value="2">MS2</option>
              <option value="3+">MS3+</option>
            </select>
          </label>
          <label class="msalign-document__filter">
            <span class="msalign-document__filter-label">{{ t('workbench.fileDocument.msalign.filterScan') }}</span>
            <span class="msalign-document__range">
              <input v-model="scanMin" data-field="scan-min" type="number" min="0" class="msalign-document__range-input" :aria-label="t('workbench.fileDocument.msalign.filterScanMin')" />
              <span aria-hidden="true">–</span>
              <input v-model="scanMax" data-field="scan-max" type="number" min="0" class="msalign-document__range-input" :aria-label="t('workbench.fileDocument.msalign.filterScanMax')" />
            </span>
          </label>
          <label v-if="hasPrecursor" class="msalign-document__filter">
            <span class="msalign-document__filter-label">{{ t('workbench.fileDocument.msalign.filterPrecursor') }}</span>
            <span class="msalign-document__range">
              <input v-model="mzMin" data-field="mz-min" type="number" min="0" step="any" class="msalign-document__range-input" :aria-label="t('workbench.fileDocument.msalign.filterPrecursorMin')" />
              <span aria-hidden="true">–</span>
              <input v-model="mzMax" data-field="mz-max" type="number" min="0" step="any" class="msalign-document__range-input" :aria-label="t('workbench.fileDocument.msalign.filterPrecursorMax')" />
            </span>
          </label>
          <label v-if="hasRt" class="msalign-document__filter">
            <span class="msalign-document__filter-label">{{ t('workbench.fileDocument.msalign.filterRt') }}</span>
            <span class="msalign-document__range">
              <input v-model="rtMin" data-field="rt-min" type="number" min="0" step="any" class="msalign-document__range-input" :aria-label="t('workbench.fileDocument.msalign.filterRtMin')" />
              <span aria-hidden="true">–</span>
              <input v-model="rtMax" data-field="rt-max" type="number" min="0" step="any" class="msalign-document__range-input" :aria-label="t('workbench.fileDocument.msalign.filterRtMax')" />
            </span>
          </label>
        </div>
        <span class="msalign-document__count">{{ listSummary }}</span>
      </div>

      <ol v-if="visibleSpectra.length > 0" class="msalign-document__items" role="listbox" :aria-label="t('workbench.fileDocument.msalign.listLabel')">
        <li v-for="entry in visibleSpectra" :key="entry.spectrumId">
          <button
            type="button"
            role="option"
            :aria-selected="entry.spectrumId === selectedId"
            class="msalign-document__item"
            :class="{ 'is-active': entry.spectrumId === selectedId }"
            @click="selectedId = entry.spectrumId"
          >
            <span class="msalign-document__item-id">
              <span class="msalign-document__scan">#{{ entry.spectrumId }}</span>
              <span v-if="entry.scan" class="msalign-document__scan-num">{{ t('workbench.fileDocument.scanLabel') }} {{ entry.scan }}</span>
            </span>
            <span class="msalign-document__item-meta">
              <span v-if="levelOf(entry)" class="msalign-document__tag msalign-document__tag--level">MS{{ levelOf(entry) }}</span>
              <span v-if="entry.activation" class="msalign-document__tag">{{ entry.activation }}</span>
              <span v-if="rtOf(entry)" class="msalign-document__tag">{{ rtOf(entry) }}</span>
              <span v-if="entry.precursorMz" class="msalign-document__precursor">
                {{ formatMz(entry.precursorMz) }}<template v-if="entry.precursorCharge"> z={{ entry.precursorCharge }}</template>
              </span>
            </span>
            <span class="msalign-document__peaks">{{ peakCountOf(entry) }} {{ t('workbench.fileDocument.msalign.peaksUnit') }}</span>
          </button>
        </li>
      </ol>
      <p v-else class="msalign-document__empty">{{ t('workbench.fileDocument.msalign.empty') }}</p>

      <p v-if="truncated" class="msalign-document__truncated" role="status">
        {{ t('workbench.fileDocument.msalign.truncated', { count: filteredSpectra.length, shown: MAX_LIST_ROWS }) }}
      </p>
    </aside>

    <section class="msalign-document__view">
      <div v-if="peakError" class="msalign-document__view-empty" role="alert">
        {{ t('workbench.fileDocument.msalign.decodeError', { message: peakError }) }}
      </div>
      <div v-else-if="selectedSpectrum && displayPeaks.length > 0" class="msalign-document__view-inner">
        <SpectrumViewer :data="selectedTable" :view-spec="viewSpec" />
      </div>
      <div v-else-if="decoding" class="msalign-document__view-empty">
        {{ t('workbench.fileDocument.msalign.decoding') }}
      </div>
      <div v-else class="msalign-document__view-empty">
        {{ spectra.length === 0 ? t('workbench.fileDocument.msalign.empty') : t('workbench.fileDocument.msalign.selectHint') }}
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SpectrumViewer from '@/components/visualization/SpectrumViewer.vue'
import type { SpectrumPeak } from '@/composables/ms2-sequence'
import type { MsAlignSpectrum } from '@/services/visualization/msalign'
import type { TableData } from '@/types/visualization'

/**
 * Hard cap on how many list rows we render. The data model holds every
 * spectrum; only the DOM is bounded so a Run-scale file does not freeze the
 * tab. The truncation notice names both numbers so the user knows what is
 * hidden.
 */
const MAX_LIST_ROWS = 2000

const props = defineProps<{
  spectra: MsAlignSpectrum[]
  fileName: string
  /**
   * Lazy peak decoding for indexes that carry no peaks (mzML). Called once
   * per selected spectrum; the result is cached so re-selecting a spectrum
   * never decodes it twice.
   */
  peakLoader?: (spectrum: MsAlignSpectrum) => Promise<SpectrumPeak[]>
}>()
const { t } = useI18n()

const selectedId = ref<number | null>(props.spectra[0]?.spectrumId ?? null)

/* ── Multi-dimensional filter ─────────────────────────────────────────── */

const levelFilter = ref('')
const scanMin = ref('')
const scanMax = ref('')
const mzMin = ref('')
const mzMax = ref('')
const rtMin = ref('')
const rtMax = ref('')

/** RT only exists in mzML indexes — hide the row for scan-only formats. */
const hasRt = computed(() => props.spectra.some(s => s.metadata.RT !== undefined))
const hasPrecursor = computed(() => props.spectra.some(s => s.precursorMz !== undefined))

/**
 * Prefill each range with the data's own bounds, so the form states the
 * file's span (scan 1–94123, RT 0–120.5 min) before the user narrows it.
 * The prefilled bounds exclude nothing — they ARE the range.
 */
function prefillFilters(spectra: readonly MsAlignSpectrum[]) {
  let scanLo = Infinity, scanHi = -Infinity
  let mzLo = Infinity, mzHi = -Infinity
  let rtLo = Infinity, rtHi = -Infinity
  for (const spectrum of spectra) {
    const scan = spectrum.scan ?? spectrum.spectrumId
    scanLo = Math.min(scanLo, scan)
    scanHi = Math.max(scanHi, scan)
    if (spectrum.precursorMz !== undefined) {
      mzLo = Math.min(mzLo, spectrum.precursorMz)
      mzHi = Math.max(mzHi, spectrum.precursorMz)
    }
    const rt = Number(spectrum.metadata.RT)
    if (Number.isFinite(rt)) {
      rtLo = Math.min(rtLo, rt)
      rtHi = Math.max(rtHi, rt)
    }
  }
  const fmt = (value: number) => Number.isFinite(value) ? String(Number(value.toFixed(4))) : ''
  scanMin.value = fmt(scanLo)
  scanMax.value = fmt(scanHi)
  mzMin.value = hasPrecursor.value ? fmt(mzLo) : ''
  mzMax.value = hasPrecursor.value ? fmt(mzHi) : ''
  rtMin.value = hasRt.value ? fmt(rtLo) : ''
  rtMax.value = hasRt.value ? fmt(rtHi) : ''
}

/**
 * Empty or invalid input means "unbounded" on that side, never "filter to
 * 0". `type="number"` inputs v-model to numbers, so accept both shapes.
 */
function boundOf(raw: string | number): number | undefined {
  if (raw === '' || raw === null) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function scanKey(spectrum: MsAlignSpectrum): number {
  return spectrum.scan ?? spectrum.spectrumId
}

function rtKey(spectrum: MsAlignSpectrum): number | undefined {
  const parsed = Number(spectrum.metadata.RT)
  return Number.isFinite(parsed) ? parsed : undefined
}

const filteredSpectra = computed<MsAlignSpectrum[]>(() => {
  const scanLo = boundOf(scanMin.value)
  const scanHi = boundOf(scanMax.value)
  const mzLo = boundOf(mzMin.value)
  const mzHi = boundOf(mzMax.value)
  const rtLo = boundOf(rtMin.value)
  const rtHi = boundOf(rtMax.value)
  return props.spectra.filter((spectrum) => {
    if (levelFilter.value) {
      const level = levelOf(spectrum)
      if (levelFilter.value === '3+') {
        if (level === undefined || level < 3) return false
      } else if (String(level) !== levelFilter.value) return false
    }
    if (scanLo !== undefined && scanKey(spectrum) < scanLo) return false
    if (scanHi !== undefined && scanKey(spectrum) > scanHi) return false
    // The precursor dimension only exists for MS2+ — MS1 scans have no
    // precursor, so they pass this filter untouched instead of being
    // silently hidden by a prefilled range.
    if (mzLo !== undefined || mzHi !== undefined) {
      const level = levelOf(spectrum) ?? 1
      if (level >= 2) {
        if (spectrum.precursorMz === undefined) return false
        if (mzLo !== undefined && spectrum.precursorMz < mzLo) return false
        if (mzHi !== undefined && spectrum.precursorMz > mzHi) return false
      }
    }
    if (rtLo !== undefined || rtHi !== undefined) {
      const rt = rtKey(spectrum)
      if (rt === undefined) return false
      if (rtLo !== undefined && rt < rtLo) return false
      if (rtHi !== undefined && rt > rtHi) return false
    }
    return true
  })
})

const truncated = computed(() => filteredSpectra.value.length > MAX_LIST_ROWS)
const visibleSpectra = computed(() =>
  truncated.value ? filteredSpectra.value.slice(0, MAX_LIST_ROWS) : filteredSpectra.value)

const listSummary = computed(() => {
  const total = props.spectra.length
  const shown = filteredSpectra.value.length
  if (shown !== total) {
    return t('workbench.fileDocument.msalign.countFiltered', { shown, total })
  }
  return t('workbench.fileDocument.msalign.count', { total })
})

/* ── Selection + lazy decode ──────────────────────────────────────────── */

// Re-select the first spectrum and re-prefill when the source file changes
// (e.g. the user opens a different file).
watch(
  () => props.spectra,
  (next) => {
    prefillFilters(next)
    selectedId.value = next[0]?.spectrumId ?? null
  },
  { immediate: true },
)

// A selection always exists while anything is visible: when a filter
// excludes the current selection, fall to the first matching spectrum
// instead of parking the right pane in a no-selection state.
watch(
  filteredSpectra,
  (list) => {
    if (list.length === 0) return
    if (selectedId.value === null || !list.some(spectrum => spectrum.spectrumId === selectedId.value)) {
      selectedId.value = list[0].spectrumId
    }
  },
)

// Reactive so `displayPeaks` re-reads it the moment a lazy decode lands —
// a plain Map would leave the first-selected spectrum blank until the user
// switched away and back.
const peakCache = reactive(new Map<number, SpectrumPeak[]>())
const decoding = ref(false)
const peakError = ref<string | null>(null)

// Lazy decode: when a loader is wired, fetch the selected spectrum's peaks on
// demand (the mzML index carries no peaks). Failures surface verbatim — the
// parser's messages name the remedy (e.g. MS-Numpress is unsupported) — and
// only while the spectrum they belong to is still the selected one: a decode
// that settles after the user moved on must not repaint the new selection.
watch(
  selectedId,
  async (id) => {
    peakError.value = null
    if (id === null || !props.peakLoader || peakCache.has(id)) return
    const spectrum = props.spectra.find(entry => entry.spectrumId === id)
    if (!spectrum) return
    decoding.value = true
    try {
      peakCache.set(id, await props.peakLoader(spectrum))
    } catch (error) {
      if (selectedId.value === id) {
        peakError.value = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (selectedId.value === id) decoding.value = false
    }
  },
  { immediate: true },
)

const selectedSpectrum = computed<MsAlignSpectrum | null>(() => {
  if (selectedId.value === null) return null
  return props.spectra.find((spectrum) => spectrum.spectrumId === selectedId.value) ?? null
})

/** Peaks for the selected spectrum: inline (msalign) or lazily decoded (mzML). */
const displayPeaks = computed<SpectrumPeak[]>(() => {
  const spectrum = selectedSpectrum.value
  if (!spectrum) return []
  if (spectrum.peaks.length > 0) return spectrum.peaks
  if (selectedId.value === null) return []
  return peakCache.get(selectedId.value) ?? []
})

/**
 * Adapt the selected spectrum's peaks into the `TableData` shape
 * `SpectrumViewer` consumes via the datasets path (`mz` / `intensity` columns).
 * The viewer's own `normalizeSpectrumViewerInput` resolves those columns, so
 * this stays a mechanical mapping — no plot logic here.
 */
const selectedTable = computed<TableData>(() => {
  const peaks = displayPeaks.value
  const hasCharge = peaks.some((peak) => peak.charge !== undefined)
  return {
    columns: [
      { id: 'mz', name: 'mz', type: 'number' as const, visible: true },
      { id: 'intensity', name: 'intensity', type: 'number' as const, visible: true },
      ...(hasCharge
        ? [{ id: 'charge', name: 'charge', type: 'number' as const, visible: true }]
        : []),
    ],
    rows: peaks.map((peak) => {
      const row: Record<string, unknown> = { mz: peak.mz, intensity: peak.intensity }
      if (peak.charge !== undefined) row.charge = peak.charge
      return row
    }),
    totalRows: peaks.length,
    sourceFile: props.fileName,
  }
})

// Title the spectrum pane with the selected scan so the user can tell which
// spectrum they are looking at without re-reading the list.
const viewSpec = computed(() => {
  const spectrum = selectedSpectrum.value
  if (!spectrum) return {}
  const parts: string[] = [t('workbench.fileDocument.scanTitle', { id: spectrum.spectrumId })]
  if (spectrum.scan !== undefined) parts.push(`${t('workbench.fileDocument.scanLabel')} ${spectrum.scan}`)
  const level = levelOf(spectrum)
  if (level !== undefined) parts.push(`MS${level}`)
  if (spectrum.activation) parts.push(spectrum.activation)
  if (spectrum.metadata.RT) parts.push(`RT ${spectrum.metadata.RT} min`)
  return { title: parts.join(' · ') }
})

/**
 * `LEVEL` lives in the spectrum's metadata bag (parseMsAlign keeps every
 * KEY=VALUE there) rather than as a typed field, so read it out here.
 */
function levelOf(spectrum: MsAlignSpectrum): number | undefined {
  const raw = spectrum.metadata.LEVEL
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function rtOf(spectrum: MsAlignSpectrum): string {
  return spectrum.metadata.RT ? `${spectrum.metadata.RT} min` : ''
}

/**
 * Peak count for the list: the decoded array when peaks are inline, otherwise
 * the mzML `defaultArrayLength` (`PEAKS_COUNT`) — the count without a decode.
 */
function peakCountOf(spectrum: MsAlignSpectrum): number {
  if (spectrum.peaks.length > 0) return spectrum.peaks.length
  const declared = Number(spectrum.metadata.PEAKS_COUNT)
  return Number.isFinite(declared) && declared > 0 ? declared : 0
}

function formatMz(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : String(value)
}
</script>

<script lang="ts">
export default { name: 'MsAlignDocument' }
</script>

<style scoped>
.msalign-document {
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: var(--space-2);
  width: 100%;
  height: 100%;
  min-height: 0;
}

.msalign-document__list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  overflow: hidden;
}

.msalign-document__list-head {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: var(--line-w) solid var(--line-hairline);
}

.msalign-document__filters {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.msalign-document__filter {
  display: grid;
  grid-template-columns: 7ch minmax(0, 1fr);
  align-items: center;
  gap: var(--space-2);
}

.msalign-document__filter-label {
  font-size: var(--text-label);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.msalign-document__select,
.msalign-document__range-input {
  height: 26px;
  padding: 0 var(--space-1);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
  font-family: var(--font-mono);
}

.msalign-document__select {
  width: 100%;
}

.msalign-document__range {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
}

.msalign-document__range-input {
  width: 100%;
  min-width: 0;
}

.msalign-document__count {
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

.msalign-document__items {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: auto;
}

.msalign-document__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--space-2);
  border: 0;
  border-bottom: var(--line-w) solid var(--line-hairline);
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.msalign-document__item:hover {
  background: var(--color-border);
}

.msalign-document__item.is-active {
  background: var(--color-bg-active);
  box-shadow: inset 2px 0 0 var(--color-success);
}

.msalign-document__item-id {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.msalign-document__scan {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text);
}

.msalign-document__scan-num {
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

.msalign-document__item-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
}

.msalign-document__tag {
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--color-border);
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

.msalign-document__tag--level {
  background: var(--color-success);
  color: var(--color-text-inverse);
}

.msalign-document__precursor {
  font-family: var(--font-mono);
  font-size: var(--text-label);
  color: var(--color-text);
}

.msalign-document__peaks {
  font-size: var(--text-label);
  color: var(--color-text-muted);
}

.msalign-document__empty,
.msalign-document__truncated {
  margin: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.msalign-document__view {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  overflow: hidden;
}

.msalign-document__view-inner {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--space-2);
}

.msalign-document__view-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
</style>
