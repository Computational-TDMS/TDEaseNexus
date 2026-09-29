<template>
  <MS2SequenceViewer
    :data="prsmTable"
    :spectra="spectra"
    :config="config"
    :selection="selection"
    @selection-change="$emit('selectionChange', $event)"
    @config-change="$emit('configChange', $event)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Dataset, SelectionState, TableData } from '@/types/visualization'
import type { MsAlignSpectrum } from '@/services/visualization/msalign'
import MS2SequenceViewer from './MS2SequenceViewer.vue'

const props = withDefaults(defineProps<{
  datasets?: Dataset[]
  config?: Record<string, unknown>
  selection?: SelectionState | null
}>(), {
  datasets: () => [],
  config: () => ({}),
  selection: null,
})

defineEmits<{
  selectionChange: [selection: SelectionState]
  configChange: [config: Record<string, unknown>]
}>()

const prsmTable = computed<TableData | null>(() => {
  const dataset = props.datasets.find(item => item.kind === 'prsm_table')
  if (!dataset) return null
  return {
    columns: dataset.columns.map(column => ({
      id: column.name,
      name: column.name,
      type: column.type === 'string' ? 'text' : column.type === 'integer' ? 'number' : column.type,
      visible: true,
      sortable: true,
      filterable: true,
    })),
    rows: dataset.rows,
    totalRows: dataset.rows.length,
    sourceFile: dataset.id,
  }
})

const spectra = computed<MsAlignSpectrum[]>(() => {
  const dataset = props.datasets.find(item =>
    item.kind === 'ms2_spectra' || item.kind === 'msalign_spectra',
  )
  return (dataset?.rows ?? []) as unknown as MsAlignSpectrum[]
})
</script>

<script lang="ts">
export default { name: 'PrsmViewer' }
</script>
