<template>
  <div class="ms2-sequence-viewer">
    <!-- Toolbar -->
    <div class="viewer-toolbar">
      <div class="toolbar-left">
        <el-tag v-if="selectedPrsmId !== null" type="info" size="small">
          {{ t('visualization.ms2.prsmLabel', { id: selectedPrsmId }) }}
        </el-tag>
        <el-tag v-if="proteinAccession && !isCompactLayout" type="success" size="small">
          {{ proteinAccession }}
        </el-tag>
        <el-tag v-if="sequence.length > 0" type="warning" size="small">
          {{ t('workbench.ms2Coverage.residueCount', { count: sequence.length }) }}
        </el-tag>
        <el-tag v-if="activationMethod && !isCompactLayout" type="danger" size="small">
          {{ activationMethod }}
        </el-tag>
        <el-tag v-if="matchedCount > 0 && !isCompactLayout" type="primary" size="small">
          {{ t('visualization.ms2.matched', { count: matchedCount }) }}
        </el-tag>
        <el-tag v-if="buffer.hasUnsavedChanges() && !isCompactLayout" type="danger" size="small">
          {{ t('visualization.ms2.modified') }}
        </el-tag>
      </div>
      <div class="toolbar-right">
        <div class="segmented-toggle">
          <AppButton size="sm" :variant="currentPage === 'visualization' ? 'primary' : 'default'" @click="currentPage = 'visualization'">
            {{ t('visualization.ms2.visualization') }}
          </AppButton>
          <AppButton size="sm" :variant="currentPage === 'table' ? 'primary' : 'default'" @click="currentPage = 'table'">
            {{ t('visualization.ms2.table') }}
          </AppButton>
        </div>
        <AppButton
          size="sm"
          :variant="showConfigPanel ? 'primary' : 'default'"
          @click="showConfigPanel = !showConfigPanel"
        >
          <template #icon><el-icon><Setting /></el-icon></template>
          {{ t('visualization.ms2.config') }}
        </AppButton>
        <el-switch
          v-model="config.showNeutralLosses"
          size="small"
          inline-prompt
          :active-text="t('visualization.ms2.nlOn')"
          :inactive-text="t('visualization.ms2.nlOff')"
        />
        <AppButton
          v-if="config.enableBuffer"
          size="sm"
          :variant="isEditing ? 'primary' : 'default'"
          @click="toggleEditMode"
        >
          {{ isEditing ? t('visualization.ms2.done') : t('visualization.ms2.edit') }}
        </AppButton>
      </div>
    </div>

    <!-- Config Panel -->
    <el-collapse-transition>
      <div v-show="showConfigPanel" class="config-section">
        <ConfigPanel :config="config" @change="updateConfig" @reset="resetConfig" />
      </div>
    </el-collapse-transition>

    <!-- Edit Panel -->
    <el-collapse-transition>
      <div v-if="isEditing" class="edit-container">
        <div class="edit-tabs">
          <div
            :class="['edit-tab', { active: editTab === 'sequence' }]"
            @click="editTab = 'sequence'"
          >
            {{ t('visualization.ms2.sequence') }}
          </div>
          <div
            :class="['edit-tab', { active: editTab === 'modifications' }]"
            @click="editTab = 'modifications'"
          >
            {{ t('visualization.ms2.modifications', { count: modifications.length }) }}
          </div>
        </div>

        <div v-if="editTab === 'sequence'" class="edit-panel">
          <div class="edit-section">
            <div class="edit-label">{{ t('visualization.ms2.sequence') }}</div>
            <el-input
              v-model="editedSequence"
              type="textarea"
              :rows="3"
              :placeholder="t('visualization.ms2.enterSequence')"
              @input="handleSequenceChange"
            />
            <div class="sequence-validation">
              <span v-if="sequenceValidation.valid" class="valid">
                {{ t('visualization.ms2.validSequence', { n: editedSequence.length }) }}
              </span>
              <span v-else class="invalid">
                <el-icon :size="12" aria-hidden="true"><Close /></el-icon>
                {{ sequenceValidation.error }}
              </span>
            </div>
          </div>
          <div class="edit-actions">
            <AppButton size="sm" variant="primary" @click="applyEdit">{{ t('visualization.ms2.apply') }}</AppButton>
            <AppButton size="sm" @click="discardEdit">{{ t('visualization.ms2.discard') }}</AppButton>
            <AppButton size="sm" @click="resetToOriginal">{{ t('common.button.reset') }}</AppButton>
          </div>
        </div>

        <div v-if="editTab === 'modifications'" class="edit-panel">
          <ModificationEditor
            :modifications="modifications"
            :sequence-length="sequence.length"
            @add="addModification"
            @update="updateModification"
            @delete="deleteModification"
            @select="selectModification"
          />
        </div>
      </div>
    </el-collapse-transition>

    <!-- Main Content -->
    <div v-if="selectedPrsmId === null" class="state-pane">
      {{ t('visualization.ms2.selectPrsm') }}
    </div>
    <div v-else-if="loading" class="state-pane">
      <el-icon class="loading-icon"><Loading /></el-icon>
      {{ t('common.status.loading') }}
    </div>
    <div v-else-if="errorMessage" class="state-pane error-pane">
      {{ errorMessage }}
    </div>
    <div v-else-if="!hasData" class="state-pane">
      {{ t('common.status.noData') }}
    </div>
    <div v-else class="viewer-content">
      <!-- Page 1: Visualization -->
      <div v-show="currentPage === 'visualization'" class="visualization-page">
        <div class="viz-subnav">
          <div class="segmented-toggle">
            <AppButton
              size="sm"
              :variant="visualizationSubPage === 'spectrum' ? 'primary' : 'default'"
              @click="visualizationSubPage = 'spectrum'"
            >
              {{ t('visualization.ms2.spectrum') }}
            </AppButton>
            <AppButton
              size="sm"
              :variant="visualizationSubPage === 'details' ? 'primary' : 'default'"
              @click="visualizationSubPage = 'details'"
            >
              {{ t('visualization.ms2.details') }}
            </AppButton>
          </div>
          <div class="viz-subnav__meta">
            <span>{{ visualizationSubPage === 'spectrum' ? '1' : '2' }}/2</span>
          </div>
        </div>

        <div v-show="visualizationSubPage === 'details'" class="viz-details-page">
          <div v-if="annotationWarning" class="annotation-warning">
            {{ annotationWarning }}
          </div>
          <div class="match-summary">
            <div class="match-summary__item">
              <span>{{ t('visualization.ms2.ionSeries') }}</span>
              <strong>{{ matchSummary.ionTypes }}</strong>
            </div>
            <div class="match-summary__item">
              <span>{{ t('visualization.ms2.maxCharge') }}</span>
              <strong>{{ matchSummary.maxCharge }}</strong>
            </div>
            <div class="match-summary__item">
              <span>{{ t('visualization.ms2.tolerance') }}</span>
              <strong>{{ matchSummary.tolerance }}</strong>
            </div>
            <div class="match-summary__item">
              <span>{{ t('visualization.ms2.neutralLosses') }}</span>
              <strong>{{ matchSummary.neutralLosses }}</strong>
            </div>
            <div class="match-summary__item">
              <span>{{ t('visualization.ms2.primaryCoverage') }}</span>
              <strong>{{ matchSummary.primaryCoverage }}</strong>
            </div>
            <div class="match-summary__item">
              <span>{{ t('visualization.ms2.lossOnlyCoverage') }}</span>
              <strong>{{ matchSummary.lossOnlyCoverage }}</strong>
            </div>
          </div>
          <div class="proforma-panel">
            <div class="proforma-row">
              <span class="proforma-label">{{ t('visualization.ms2.proforma') }}</span>
              <code class="proforma-code">{{ displayProforma }}</code>
            </div>
            <div v-if="modificationSummary.length > 0" class="mod-summary">
              <span class="proforma-label">{{ t('visualization.ms2.massShifts') }}</span>
              <div class="mod-tags">
                <el-tag
                  v-for="item in modificationSummary"
                  :key="item.id"
                  size="small"
                  type="warning"
                  effect="plain"
                >
                  {{ item.text }}
                </el-tag>
              </div>
            </div>
          </div>
        </div>

        <div v-show="visualizationSubPage === 'spectrum'" ref="spectrumStageRef" class="spectrum-stage">
          <AnnotatedSpectrumIPSA
            :sequence="sequence"
            :modifications="modifications"
            :breakpoints="breakpoints"
            :peaks="peaks"
            :matched-fragments="matchedFragments"
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
        </div>
      </div>

      <!-- Page 2: Data Table -->
      <div v-show="currentPage === 'table'" class="table-page">
        <AgGridTable
          :row-data="matchTableData"
          :column-defs="matchTableColumnDefs"
          :pagination="true"
          :page-size="50"
          :export="{ csv: true, excel: false, fileBaseName: 'ms2_match_table' }"
          :row-selection="false"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Setting, Loading, Close } from '@element-plus/icons-vue'
import type { SelectionState, TableData } from '@/types/visualization'
import { buildProformaString } from '@/utils/proforma'
import type { MsAlignSpectrum } from '@/services/visualization/msalign'
import { composePrsmViewerModel } from '@/services/visualization/prsm-viewer-model'
import {
  InteractionManager,
  EditBuffer,
  DEFAULT_CONFIG,
  type ViewerConfig,
  type Modification,
  type MatchedFragment,
  type SpectrumPeak,
  type InteractionState,
} from '@/composables/ms2-sequence'
import {
  resolveMs2SelectionContext,
  tableRows,
} from './ms2-sequence/composition'
import {
  buildMatchTableColumnDefs,
  buildMatchTableData,
  buildModificationSummary,
} from './ms2-sequence/viewer-model'
import AnnotatedSpectrumIPSA from './ms2-sequence/AnnotatedSpectrumIPSA.vue'
import ConfigPanel from './ms2-sequence/ConfigPanel.vue'
import ModificationEditor from './ms2-sequence/ModificationEditor.vue'
import AgGridTable from '@/components/table/AgGridTable.vue'
import AppButton from '@/components/primitives/AppButton.vue'

const { t } = useI18n()

interface Props {
  data: TableData | null
  config?: Record<string, unknown>
  selection?: SelectionState | null
  runId?: string | null
  spectra?: MsAlignSpectrum[]
}

const props = defineProps<Props>()

defineEmits<{
  selectionChange: [selection: SelectionState]
  configChange: [config: Record<string, unknown>]
}>()

// State
const loading = ref(false)
const errorMessage = ref('')
const annotationWarning = ref('')
const baseSequence = ref('')
const baseModifications = ref<Modification[]>([])
const basePeaks = ref<SpectrumPeak[]>([])
const proteinAccession = ref('')
const activationMethod = ref('')
const currentPage = ref<'visualization' | 'table'>('visualization')
const showConfigPanel = ref(false)
const visualizationSubPage = ref<'spectrum' | 'details'>('spectrum')
const spectrumStageRef = ref<HTMLElement | null>(null)
const spectrumStageSize = ref({ width: 1000, height: 760 })
let spectrumStageResizeObserver: ResizeObserver | null = null
const spectrumMinWidth = 1000

// Config
// eslint-disable-next-line vue/no-dupe-keys
const config = ref<ViewerConfig>({ ...DEFAULT_CONFIG })

// Buffer editing
const buffer = new EditBuffer()
const isEditing = ref(false)
const editTab = ref<'sequence' | 'modifications'>('sequence')
const editedSequence = ref('')

const interactionManager = new InteractionManager()
const interactionState = ref<InteractionState>({
  highlightedFragments: [],
  highlightedPeaks: [],
  highlightedResidues: [],
})
const matchedFragments = ref<MatchedFragment[]>([])

// Sequence validation
const sequenceValidation = computed(() => {
  const seq = editedSequence.value.toUpperCase()
  const validAA = /^[ACDEFGHIKLMNPQRSTVWY]*$/

  if (!seq) {
    return { valid: false, error: t('visualization.ms2.errorEmpty') }
  }
  if (!validAA.test(seq)) {
    const invalid = seq.split('').filter(c => !'ACDEFGHIKLMNPQRSTVWY'.includes(c))
    return { valid: false, error: t('visualization.ms2.errorInvalidAA', { aa: invalid.join(', ') }) }
  }
  return { valid: true, error: '' }
})

// Computed
const selectionContext = computed(() =>
  resolveMs2SelectionContext(tableRows(props.data), props.selection)
)
const selectedPrsmId = computed<number | null>(() => selectionContext.value.selectedPrsmId)

const selectedRow = computed<Record<string, unknown> | null>(() => selectionContext.value.selectedRow)

// Data from buffer (when editing) or base refs (when loaded)
const currentInput = computed(() => buffer.getCurrent())

const sequence = computed(() => currentInput.value?.sequence.value || baseSequence.value)
const modifications = computed<Modification[]>(() => {
  if (currentInput.value?.modifications) {
    return currentInput.value.modifications
  }
  return baseModifications.value
})
const peaks = computed<SpectrumPeak[]>(() => {
  if (currentInput.value?.spectrum?.peaks) {
    return currentInput.value.spectrum.peaks
  }
  return basePeaks.value
})

const displayProforma = computed(() => buildProformaString(sequence.value, modifications.value))

const modificationSummary = computed(() => buildModificationSummary(modifications.value))
const hasData = computed(() => baseSequence.value.length > 0)

const breakpoints = computed(() => {
  const unique = new Set<number>()
  matchedFragments.value.forEach(fragment => {
    if (fragment.isMatched) unique.add(fragment.position)
  })
  return Array.from(unique).sort((a, b) => a - b)
})

const matchedCount = computed(() => matchedFragments.value.filter(f => f.isMatched).length)
const matchSummary = computed(() => {
  const primaryPositions = new Set<number>()
  const lossOnlyPositions = new Set<number>()
  for (const fragment of matchedFragments.value) {
    if (!fragment.isMatched) continue
    if (fragment.neutralLoss) {
      lossOnlyPositions.add(fragment.position)
    } else {
      primaryPositions.add(fragment.position)
    }
  }
  for (const position of primaryPositions) {
    lossOnlyPositions.delete(position)
  }
  const denominator = Math.max(sequence.value.length - 1, 1)
  const percent = (count: number) => `${((count / denominator) * 100).toFixed(1)}%`
  return {
    ionTypes: config.value.ionTypes.join(', ') || 'b, y',
    maxCharge: String(config.value.maxFragmentCharge),
    tolerance: `${config.value.tolerancePpm} ppm`,
    neutralLosses: config.value.showNeutralLosses ? 'on' : 'off',
    primaryCoverage: `${primaryPositions.size}/${denominator} (${percent(primaryPositions.size)})`,
    lossOnlyCoverage: `${lossOnlyPositions.size}/${denominator} (${percent(lossOnlyPositions.size)})`,
  }
})
const spectrumWidth = computed(() => Math.max(spectrumMinWidth, Math.floor(spectrumStageSize.value.width)))
const spectrumHeight = computed(() => Math.max(720, Math.floor(spectrumStageSize.value.height)))
const isCompactLayout = computed(() => spectrumWidth.value < 760)

const matchTableData = computed(() => buildMatchTableData(matchedFragments.value))

const matchTableColumnDefs = computed(() => buildMatchTableColumnDefs())

async function loadPrsmDetail() {
  if (selectedPrsmId.value === null || !selectedRow.value) {
    baseSequence.value = ''
    baseModifications.value = []
    basePeaks.value = []
    proteinAccession.value = ''
    activationMethod.value = ''
    matchedFragments.value = []
    errorMessage.value = ''
    return
  }

  const model = composePrsmViewerModel(selectedRow.value, props.spectra ?? [], {
    ionTypes: config.value.ionTypes,
    maxCharge: config.value.maxFragmentCharge,
    tolerancePpm: config.value.tolerancePpm,
    includeNeutralLosses: config.value.showNeutralLosses,
  })
  if (!model) {
    baseSequence.value = ''
    baseModifications.value = []
    basePeaks.value = []
    matchedFragments.value = []
    errorMessage.value = t('visualization.ms2.errorNoSpectrum')
    loading.value = false
    return
  }
  baseSequence.value = model.sequence
  baseModifications.value = model.modifications
  basePeaks.value = model.spectrum.peaks
  activationMethod.value = model.spectrum.activation ?? ''
  proteinAccession.value = String(
    selectedRow.value['Protein accession'] ?? selectedRow.value['Protein Accession'] ?? selectedRow.value['protein_accession'] ?? '',
  )
  matchedFragments.value = model.matchedFragments
  errorMessage.value = ''
  loading.value = false
}

async function loadFragmentAnnotations() {
  if (!sequence.value || peaks.value.length === 0) {
    matchedFragments.value = []
    return
  }

  if (!selectedRow.value) return
  const model = composePrsmViewerModel(selectedRow.value, props.spectra ?? [], {
    ionTypes: config.value.ionTypes,
    maxCharge: config.value.maxFragmentCharge,
    tolerancePpm: config.value.tolerancePpm,
    includeNeutralLosses: config.value.showNeutralLosses,
  })
  matchedFragments.value = model?.matchedFragments ?? []
}

watch(
  () => [selectedPrsmId.value, props.data?.rows?.length],
  () => {
    void loadPrsmDetail()
  },
  { immediate: true }
)

watch(
  () => [
    sequence.value,
    modifications.value.map(mod => `${mod.position}:${mod.massShift}:${mod.name}`).join('|'),
    config.value.ionTypes.join(''),
    config.value.maxFragmentCharge,
    config.value.showNeutralLosses,
    config.value.tolerancePpm,
    peaks.value.length,
  ],
  () => {
    void loadFragmentAnnotations()
  }
)

// Interaction handlers
function handleResidueHover(position: number) {
  interactionState.value = interactionManager.highlightByResidue(position, matchedFragments.value)
}

function handleFragmentHover(fragment: any) {
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

// Config handlers
function updateConfig(newConfig: ViewerConfig) {
  config.value = newConfig
}

function resetConfig() {
  config.value = { ...DEFAULT_CONFIG }
}

// Edit mode handlers
function toggleEditMode() {
  if (isEditing.value) {
    isEditing.value = false
  } else {
    if (baseSequence.value) {
      buffer.startEdit({
        sequence: { value: sequence.value, length: sequence.value.length },
        spectrum: {
          peaks: peaks.value,
          precursorMz: 0,
          precursorCharge: 0,
        },
        modifications: [...modifications.value],
        breakpoints: breakpoints.value,
      })
      editedSequence.value = sequence.value
    }
    isEditing.value = true
    editTab.value = 'sequence'
  }
}

function handleSequenceChange() {
  if (sequenceValidation.value.valid) {
    buffer.editSequence(editedSequence.value.toUpperCase())
  }
}

function applyEdit() {
  buffer.apply()
  isEditing.value = false
}

function discardEdit() {
  buffer.discard()
  isEditing.value = false
  editedSequence.value = sequence.value
}

function resetToOriginal() {
  buffer.reset()
  editedSequence.value = baseSequence.value
  isEditing.value = false
}

// Modification handlers
function addModification(mod: Omit<Modification, 'id'>) {
  const newMod: Modification = {
    ...mod,
    id: `mod-custom-${Date.now()}`,
  }
  buffer.addModification(newMod)
}

function updateModification(id: string, updates: Partial<Modification>) {
  buffer.updateModification(id, updates)
}

function deleteModification(id: string) {
  buffer.removeModification(id)
}

function selectModification(mod: Modification | null) {
  void mod
}

watch(() => props.data, () => {
  matchedFragments.value = []
  annotationWarning.value = ''
})

function updateSpectrumStageSize() {
  const root = spectrumStageRef.value
  if (!root) return
  const rect = root.getBoundingClientRect()
  const nextWidth = Math.floor(rect.width - 2)
  const nextHeight = Math.max(720, Math.floor(rect.height - 2))
  if (Number.isFinite(nextWidth) && nextWidth > 0 && Number.isFinite(nextHeight) && nextHeight > 0) {
    spectrumStageSize.value = { width: nextWidth, height: nextHeight }
  }
}

// KeepAlive lifecycle: pause geometry tracking while hidden (ResizeObserver
// OR a window-resize listener, mutually exclusive), re-attach + re-measure on
// activate. The sequence/SVG DOM stays mounted in the cache.
function observeStage() {
  if (spectrumStageResizeObserver || typeof ResizeObserver === 'undefined' || !spectrumStageRef.value) {
    if (!spectrumStageResizeObserver) window.addEventListener('resize', updateSpectrumStageSize)
    return
  }
  spectrumStageResizeObserver = new ResizeObserver(() => updateSpectrumStageSize())
  spectrumStageResizeObserver.observe(spectrumStageRef.value)
}

function unobserveStage() {
  if (spectrumStageResizeObserver) {
    spectrumStageResizeObserver.disconnect()
    spectrumStageResizeObserver = null
  }
  window.removeEventListener('resize', updateSpectrumStageSize)
}

onMounted(() => {
  updateSpectrumStageSize()
  observeStage()
})

onActivated(() => {
  observeStage()
  updateSpectrumStageSize()
})

onDeactivated(() => { unobserveStage() })

watch(currentPage, async (page) => {
  if (page !== 'visualization') return
  visualizationSubPage.value = 'spectrum'
  await nextTick()
  updateSpectrumStageSize()
})

watch(visualizationSubPage, async (page) => {
  if (page !== 'spectrum') return
  await nextTick()
  updateSpectrumStageSize()
})

onBeforeUnmount(() => { unobserveStage() })
</script>

<script lang="ts">
export default {
  name: 'MS2SequenceViewer',
}
</script>

<style scoped>
.ms2-sequence-viewer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  height: 100%;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow: auto;
}

.viewer-toolbar {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  flex-shrink: 0;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

/* Segmented page toggle: keeps the el-button-group "joined" look on AppButton. */
.segmented-toggle {
  display: flex;
}

.segmented-toggle .app-button + .app-button {
  margin-left: -1px;
}

.segmented-toggle .app-button:first-child {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.segmented-toggle .app-button:last-child {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.config-section {
  flex-shrink: 0;
}

.edit-container {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-warning-soft);
  border: 1px solid var(--color-warning);
  border-radius: var(--radius-md);
  flex-shrink: 0;
}

.edit-tabs {
  display: flex;
  gap: var(--space-2);
}

.edit-tab {
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-base);
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.edit-tab:hover {
  background: var(--color-hover);
}

.edit-tab.active {
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-weight: 500;
  border: var(--line-w) solid var(--line-hairline);
}

.edit-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.edit-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
}

.edit-label {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
}

.sequence-validation {
  font-size: var(--text-sm);
}

.sequence-validation .valid {
  color: var(--color-success-text);
}

.sequence-validation .invalid {
  color: var(--color-error-text);
}

.edit-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.state-pane {
  border: var(--line-w) dashed var(--line-hairline);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  color: var(--color-text-secondary);
  background: var(--color-bg);
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
}

.loading-icon {
  animation: rotating 2s linear infinite;
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.error-pane {
  color: var(--color-error-text);
}

.viewer-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  flex: 1;
  overflow: auto;
  min-width: 0;
}

.visualization-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 0;
  flex: 1;
  min-width: 0;
  overflow: auto;
}

.viz-subnav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  flex-shrink: 0;
}

.viz-subnav__meta {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.viz-details-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-height: 0;
  overflow: auto;
}

.proforma-panel {
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  padding: var(--space-2-5) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.annotation-warning {
  border: 1px solid var(--color-error);
  background: var(--color-error-soft);
  color: var(--color-error-text);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-2-5);
  font-size: var(--text-sm);
}

.match-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-2);
}

.match-summary__item {
  border: var(--line-w) solid var(--line-hairline);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-2-5);
  min-width: 0;
}

.match-summary__item span {
  display: block;
  color: var(--color-text-muted);
  font-size: var(--text-label);
  line-height: 1.3;
}

.match-summary__item strong {
  display: block;
  color: var(--color-text);
  font-size: var(--text-base);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.proforma-row,
.mod-summary {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
}

.proforma-label {
  width: 84px;
  flex-shrink: 0;
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  font-weight: 600;
  line-height: 1.8;
}

.proforma-code {
  display: block;
  flex: 1;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  padding: var(--space-1-5) var(--space-2);
  color: var(--color-text);
  font-size: var(--text-sm);
}

.mod-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
}

.spectrum-stage {
  flex: 1 1 0;
  min-height: 360px;
  min-width: 0;
  overflow: auto;
  width: 100%;
}

.spectrum-stage :deep(.annotated-spectrum-ipsa) {
  width: 100%;
  min-width: 1000px;
}

/* Removed: merged into IPSA-style single SVG component */

.table-page {
  height: 100%;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.table-pagination {
  padding-top: 8px;
  display: flex;
  justify-content: center;
  flex-shrink: 0;
}
</style>
