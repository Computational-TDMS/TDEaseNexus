<template>
  <div class="table-viewer">
    <AgGridTable
      :row-data="rowData"
      :column-defs="columnDefs"
      :default-col-def="defaultColDef"
      :pagination="true"
      :page-size="50"
      :selection="selection || null"
      :selection-key-field="selectionKeyField"
      row-selection="single"
      :export="{ csv: true, excel: true, fileBaseName: 'table_export' }"
      @selection-change="forwardSelectionChange"
      @cell-clicked="onLinkCellClicked"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TableData, SelectionState, Dataset, InteractionConfig } from '@/types/visualization'
import AgGridTable from '@/components/table/AgGridTable.vue'
import type { SelectionRef, SelectionRefValue } from '@/services/visualization/runtime-types'

interface Props {
  data?: TableData | null
  config?: Record<string, unknown>
  selection?: SelectionState | null
  datasets?: Dataset[]
  viewSpec?: Record<string, unknown>
}

const props = withDefaults(defineProps<Props>(), {
  data: null,
  datasets: () => [],
  config: () => ({}),
  selection: null,
  viewSpec: () => ({}),
})
const emit = defineEmits<{
  selectionChange: [selection: SelectionState]
}>()

// ── Datasets path (unified contract) ──
const useDatasetsMode = computed(() => !!(props.datasets && props.datasets.length > 0))

function getInteractionConfig(): InteractionConfig | undefined {
  return props.viewSpec?.interactionConfig as InteractionConfig | undefined
}

/** Resolve source rows from either datasets (new) or data (legacy). */
function getSourceRows(): Record<string, unknown>[] {
  if (useDatasetsMode.value && props.datasets && props.datasets.length > 0) {
    return props.datasets[0].rows as Record<string, unknown>[]
  }
  return (props.data?.rows || []) as Record<string, unknown>[]
}

/**
 * linkColumns: a { 'columnName': 'semanticType' } mapping,
 * supplied via viewSpec.interactionConfig.linkColumns or config.linkColumns.
 */
const linkColumns = computed<Record<string, string>>(() => {
  // viewSpec.interactionConfig.linkColumns takes precedence
  const icLinkCols = getInteractionConfig()?.linkColumns
  if (icLinkCols && typeof icLinkCols === 'object' && !Array.isArray(icLinkCols)) {
    return icLinkCols as Record<string, string>
  }
  const raw = props.config?.linkColumns
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, string>
  }
  return {}
})

const selectionKeyField = computed<string | null>(() => {
  // viewSpec interactionConfig.selectionKeyField takes precedence
  const icKey = getInteractionConfig()?.selectionKeyField
  if (icKey && typeof icKey === 'string' && icKey.trim()) return icKey.trim()

  const cfg = props.config || {}
  const key = (cfg.selectionKeyField || cfg.selection_key_field) as string | undefined
  if (key && typeof key === 'string') {
    const trimmed = key.trim()
    if (trimmed) return trimmed
  }

  // Auto-detect stable ID column for TopMSV/PrSM tables when explicit config is absent.
  const candidateKeys = ['Prsm ID', 'prsm_id']
  for (const candidate of candidateKeys) {
    if (props.data?.columns?.some((col) => col.id === candidate || col.name === candidate)) {
      return candidate
    }
  }
  return null
})

// Column definitions with link column support
const columnDefs = computed<any[]>(() => {
  const linkCols = linkColumns.value

  // Datasets mode: use first dataset's columns
  if (useDatasetsMode.value && props.datasets && props.datasets.length > 0) {
    return (props.datasets[0].columns || []).map(col => ({
      field: col.name,
      headerName: col.name,
      sortable: true,
      filter: true,
      resizable: true,
      flex: 1,
      minWidth: 100,
      cellClass: col.name in linkCols ? 'link-cell' : undefined,
    }))
  }

  if (!props.data?.columns) return []
  return props.data.columns.map(col => {
    const def: any = {
      field: col.id,
      headerName: col.name,
      sortable: col.sortable ?? true,
      filter: col.filterable ?? true,
      resizable: true,
      flex: 1,
      minWidth: 100,
    }
    if (col.name in linkCols) {
      def.cellClass = 'link-cell'
    }
    return def
  })
})

const defaultColDef: any = {
  sortable: true,
  filter: true,
  resizable: true,
  flex: 1,
}

function toSelectionRefValue(value: unknown, fallback: number): SelectionRefValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value
  }
  return fallback
}

const rowData = computed(() => {
  if (useDatasetsMode.value && props.datasets && props.datasets.length > 0) {
    return props.datasets[0].rows
  }
  if (!props.data?.rows) return []
  return props.data.rows
})

function forwardSelectionChange(selection: SelectionState) {
  const keyField = selectionKeyField.value
  const rows = getSourceRows()
  const incomingRefs = keyField
    ? (selection.selectedRefs ?? []).filter(ref => ref.field === keyField)
    : selection.selectedRefs ?? []
  const selectedRefs: SelectionRef[] = incomingRefs.length > 0
    ? incomingRefs
    : keyField
      ? Array.from(selection.selectedIndices).map((index) => {
        const row = rows[index] as Record<string, unknown> | undefined
        const value = row?.[keyField]
        return {
          field: keyField,
          value: toSelectionRefValue(value, index),
        }
      })
      : []

  emit('selectionChange', {
    ...selection,
    selectedRefs,
  })
}

/**
 * Handle click on a link column cell.
 * Finds all rows matching the cell value, selects them,
 * and emits selectionChange so downstream viewers respond.
 */
function onLinkCellClicked(event: { colId: string; value: unknown; data: Record<string, unknown> }) {
  const linkCols = linkColumns.value
  if (!linkCols[event.colId]) return

  const rows = getSourceRows()
  const matchingIndices = new Set<number>()

  rows.forEach((row, idx) => {
    if (String(row[event.colId]) === String(event.value)) {
      matchingIndices.add(idx)
    }
  })

  emit('selectionChange', {
    selectedIndices: matchingIndices,
    selectedRefs: selectionKeyField.value
      ? Array.from(matchingIndices).map((index) => ({
          field: selectionKeyField.value as string,
          value: toSelectionRefValue(rows[index]?.[selectionKeyField.value as string], index),
        }))
      : [],
    filterCriteria: [{
      columnId: event.colId,
      operator: 'eq',
      value: event.value,
    }],
    brushRegion: null,
  })
}

// Guard flag to prevent infinite loops when applying upstream filterCriteria
const isApplyingUpstreamFilters = ref(false)

watch(
  () => props.selection,
  (newSelection) => {
    if (isApplyingUpstreamFilters.value) return

    const upstreamFilters = newSelection?.filterCriteria
    if (!upstreamFilters || upstreamFilters.length === 0 || !props.data?.rows) return

    isApplyingUpstreamFilters.value = true
    try {
      const matchingIndices = new Set<number>()
      const rows = props.data.rows as Record<string, unknown>[]
      rows.forEach((row, idx) => {
        for (const filter of upstreamFilters) {
          if (String(row[filter.columnId] ?? '') === String(filter.value)) {
            matchingIndices.add(idx)
            break
          }
        }
      })
      if (matchingIndices.size > 0) {
        emit('selectionChange', {
          selectedIndices: matchingIndices,
          selectedRefs: selectionKeyField.value
            ? Array.from(matchingIndices).map((index) => ({
                field: selectionKeyField.value as string,
                value: toSelectionRefValue(rows[index]?.[selectionKeyField.value as string], index),
              }))
            : [],
          filterCriteria: upstreamFilters,
          brushRegion: null,
        })
      }
    } finally {
      isApplyingUpstreamFilters.value = false
    }
  },
  { deep: true }
)
</script>

<style scoped>
.table-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.viewer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm, 8px);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm, 5px);
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm, 8px);
}

/* AG Grid theme customization */
:deep(.ag-theme-alpine) {
  --ag-font-size: var(--text-label);
  --ag-grid-size: 4px;
  --ag-header-height: 28px;
  --ag-row-height: 26px;
  font-size: var(--text-label);
}

:deep(.ag-theme-alpine .ag-cell) {
  line-height: 26px;
}

:deep(.ag-theme-alpine .ag-header-cell) {
  font-weight: 600;
}

:deep(.ag-theme-alpine .ag-row-selected) {
  background-color: var(--table-row-selected) !important;
}

:deep(.ag-theme-alpine .ag-cell-range-selected:not(.ag-cell-focus)) {
  background-color: var(--table-row-selected) !important;
}

/* Link column cells */
:deep(.ag-cell.link-cell) {
  color: var(--color-primary);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

:deep(.ag-cell.link-cell:hover) {
  color: var(--color-primary-hover);
  background-color: var(--color-primary-soft);
}

:deep(.table-toolbar) {
  min-height: 30px;
  padding: 3px var(--space-1-5);
  gap: var(--space-1-5);
}

:deep(.table-toolbar .toolbar-right) {
  min-width: 0;
  gap: var(--space-1);
}

:deep(.table-toolbar .el-input) {
  width: min(150px, 46%) !important;
}

:deep(.ag-paging-panel) {
  min-height: 28px;
  height: 28px;
  padding: 0 var(--space-1-5);
  gap: var(--space-1);
  font-size: var(--domain-text-meta);
}

:deep(.ag-paging-row-summary-panel),
:deep(.ag-paging-page-summary-panel) {
  margin: 0;
}
</style>
