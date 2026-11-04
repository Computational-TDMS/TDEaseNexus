<template>
  <ViewerErrorBoundary context="viewer-surface">
    <component
      :is="registration.component"
      v-bind="rendererProps"
      @selection-change="onSelectionChange"
      @config-change="$emit('paramsChange', $event)"
    />
  </ViewerErrorBoundary>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import ViewerErrorBoundary from './ViewerErrorBoundary.vue'
import { viewerRegistry } from '@/services/visualization/ViewerRegistry'
import type {
  Dataset,
  SelectionState,
  ViewerRenderInput,
  ViewerSelectionEvent,
} from '@/types/visualization'

const props = defineProps<{ input: ViewerRenderInput }>()

const emit = defineEmits<{
  selection: [selection: ViewerSelectionEvent]
  paramsChange: [params: Record<string, unknown>]
}>()

const registration = computed(() => viewerRegistry.require(props.input.viewer))

const datasets = computed<Dataset[]>(() => {
  const ports = registration.value.ports.data
  const unknown = Object.keys(props.input.inputs).filter(id => !ports.some(port => port.id === id))
  if (unknown.length) throw new Error(`Unknown data port for ${registration.value.id}: ${unknown.join(', ')}`)

  return ports.flatMap(port => {
    const binding = props.input.inputs[port.id]
    if (binding == null) {
      if (port.required) throw new Error(`Missing data port for ${registration.value.id}: ${port.id}`)
      return []
    }
    const values = Array.isArray(binding) ? binding : [binding]
    if (port.cardinality !== 'many' && values.length > 1) {
      throw new Error(`Data port ${registration.value.id}.${port.id} accepts one dataset`)
    }
    for (const dataset of values) {
      if (!port.accepts.includes(dataset.kind)) {
        throw new Error(`Data kind ${dataset.kind} is not accepted by ${registration.value.id}.${port.id}`)
      }
      const columns = new Set(dataset.columns.map((column: Dataset['columns'][number]) => column.name))
      const missing = (port.requiredColumns ?? []).filter(column => !columns.has(column))
      if (missing.length) {
        throw new Error(`Canonical fields missing for ${registration.value.id}.${port.id}: ${missing.join(', ')}`)
      }
    }
    return values
  })
})

const selection = computed<SelectionState | null>(() => {
  const selections = Object.entries(props.input.selections ?? {}).filter(
    (entry): entry is [string, NonNullable<typeof entry[1]>] => entry[1] != null,
  )
  if (!selections.length) return null

  const selectedRefs = selections.flatMap(([portId, value]) => {
    const port = registration.value.ports.selectionInputs?.find(item => item.id === portId)
    if (!port) throw new Error(`Unknown selection port for ${registration.value.id}: ${portId}`)
    if (port.kind !== value.kind) {
      throw new Error(`Selection kind ${value.kind} is not accepted by ${registration.value.id}.${portId}`)
    }
    return value.keys.map(key => ({ field: port.keyField, value: key }))
  })

  return {
    selectedIndices: new Set(),
    selectedRefs,
    filterCriteria: [],
    brushRegion: null,
  }
})

const compiled = computed(() => {
  const validatedDatasets = datasets.value
  const validatedSelection = selection.value
  return registration.value.compile?.({
    inputs: props.input.inputs,
    selections: props.input.selections ?? {},
    params: props.input.params ?? {},
  }) ?? {
    datasets: validatedDatasets,
    selection: validatedSelection,
  }
})

const rendererProps = computed(() => ({
  datasets: compiled.value.datasets,
  viewSpec: props.input.params ?? {},
  config: props.input.params ?? {},
  selection: compiled.value.selection ?? selection.value,
}))

function onSelectionChange(value: SelectionState): void {
  const outputs = registration.value.ports.selectionOutputs ?? []
  if (!outputs.length) return
  const output = outputs.find(port =>
    value.selectedRefs?.some(ref => ref.field === port.keyField),
  ) ?? outputs[0]
  const keys = (value.selectedRefs ?? [])
    .filter(ref => ref.field === output.keyField || outputs.length === 1)
    .map(ref => ref.value)
    .filter((key): key is string | number | boolean =>
      typeof key === 'string' || typeof key === 'number' || typeof key === 'boolean',
    )
  emit('selection', { port: output.id, kind: output.kind, keys })
}
</script>
