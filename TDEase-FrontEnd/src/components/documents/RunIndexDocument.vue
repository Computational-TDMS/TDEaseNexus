<!--
  A dense `ag-grid` table, never a card grid, with the six fixed columns:
  Status · Title · Samples · Submitted · Duration · Results. `AgGridTable`
  (components/table/AgGridTable.vue) assumes a generic toolbar (export,
  reset, a single quick-filter box) this document does not want — a text +
  status filter pair that is view state, not a command (§7.2) — so this
  document drives `ag-grid-vue3` directly, per the H-slice instructions.

  `result_specs` now exists on both sides -- declared on `AnalysisCommit`,
  carried to the Backend's `RunCommit`, and projected by
  `GET /api/v2/runs/{run_id}/results`. The Results column can be filled the
  moment this document reads that projection; it still renders `—` because
  nothing here calls `listResults` yet, not because the Backend cannot answer.

  `dimension_schema` genuinely does not exist on either side, so Samples keeps
  the honest `—` with its explanatory tooltip rather than a guessed value.

  The four onboarding goals that used to live in this document's empty state
  are gone. They were rendered here as inert `<li>`s AND in `agent/EmptyState.vue`
  as clickable buttons — the product said the same thing twice, and the copy on
  this surface could not be acted on because the composer is not here. A
  Workspace with no
  Runs now opens in Focus mode, which is where those goals belong; this empty
  state is one line that points at it.
-->
<script setup lang="ts">
import { computed, defineComponent, h, ref, type PropType } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTimeAgo } from '@vueuse/core'
import { AgGridVue } from 'ag-grid-vue3'
import type { ColDef, GetRowIdFunc, ICellRendererParams, RowClickedEvent, RowDoubleClickedEvent } from 'ag-grid-community'
import StatusMark, { type RunStatus as MarkStatus } from '@/components/primitives/StatusMark.vue'
import Empty from '@/components/primitives/Empty.vue'
import { ensureAgGridModulesRegistered } from '@/components/table/ag-grid-modules'
import type { RunStatus } from '@/services/backend/backend'
import type { RunSummary } from '@/studio/domain/run'
import { useRunsStore } from '@/stores/runs'
import { useDocumentsStore } from '@/stores/documents'
import { useUiLayoutStore } from '@/stores/uiLayout'

import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-alpine.css'

ensureAgGridModulesRegistered()

const { t } = useI18n()
const runsStore = useRunsStore()
const documentsStore = useDocumentsStore()
const uiLayoutStore = useUiLayoutStore()

function toMarkStatus(status: RunStatus): MarkStatus {
  return status.toLowerCase() as MarkStatus
}

const statusLabels: Record<RunStatus, string> = {
  QUEUED: t('workbench.runIndex.status.queued'),
  RUNNING: t('workbench.runIndex.status.running'),
  SUCCEEDED: t('workbench.runIndex.status.succeeded'),
  FAILED: t('workbench.runIndex.status.failed'),
  CANCELLED: t('workbench.runIndex.status.cancelled'),
}

/** ag-grid-vue3 cell renderer: a mark plus visible text, never colour alone. */
const StatusCell = defineComponent({
  props: { params: { type: Object as PropType<ICellRendererParams>, required: true } },
  setup(props) {
    return () => {
      const run = props.params.data as RunSummary
      return h(StatusMark, { status: toMarkStatus(run.status), size: 'sm', label: statusLabels[run.status] })
    }
  },
})

function rowTitle(run: RunSummary): string {
  return run.title || run.id.slice(0, 10)
}

function duration(run: RunSummary): string {
  const start = run.startedAt ? Date.parse(run.startedAt) : Date.parse(run.createdAt)
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now()
  const minutes = Math.max(0, Math.round((end - start) / 60000))
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const allRuns = computed<RunSummary[]>(() => [
  ...Array.from(runsStore.active.values()),
  ...runsStore.history,
])

const filterText = ref('')
const filterStatus = ref<'all' | RunStatus>('all')
const statusOptions: ReadonlyArray<RunStatus> = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']

const filteredRuns = computed(() => allRuns.value.filter((run) => {
  if (filterStatus.value !== 'all' && run.status !== filterStatus.value) return false
  const text = filterText.value.trim().toLowerCase()
  if (!text) return true
  return rowTitle(run).toLowerCase().includes(text)
    || Object.values(run.labels ?? {}).some((label) => label.toLowerCase().includes(text))
}))

const hasAnyRuns = computed(() => allRuns.value.length > 0)

const rowHeight = computed(() => (uiLayoutStore.density === 'compact' ? 26 : 32))

const getRowId: GetRowIdFunc = (params) => (params.data as RunSummary).id

const columnDefs = computed<ColDef[]>(() => [
  {
    field: 'status', headerName: t('workbench.runIndex.columnStatus'), width: 140, sortable: true,
    cellRenderer: StatusCell,
  },
  {
    field: 'name', headerName: t('workbench.runIndex.columnTitle'), flex: 2, minWidth: 200, sortable: true,
    valueGetter: (params) => rowTitle(params.data as RunSummary),
  },
  {
    colId: 'samples', headerName: t('workbench.runIndex.columnSamples'), flex: 1, sortable: false,
    valueGetter: () => '—',
    tooltipValueGetter: () => t('workbench.runIndex.samplesUnknown'),
  },
  {
    field: 'createdAt', headerName: t('workbench.runIndex.columnSubmitted'), flex: 1, sortable: true,
    valueGetter: (params) => useTimeAgo((params.data as RunSummary).createdAt).value,
    comparator: (_a, _b, nodeA, nodeB) =>
      Date.parse((nodeA.data as RunSummary).createdAt) - Date.parse((nodeB.data as RunSummary).createdAt),
    cellClass: 'numeric',
  },
  {
    colId: 'duration', headerName: t('workbench.runIndex.columnDuration'), flex: 1, sortable: false,
    valueGetter: (params) => duration(params.data as RunSummary),
    cellClass: 'numeric',
  },
  {
    colId: 'results', headerName: t('workbench.runIndex.columnResults'), flex: 1, sortable: false,
    valueGetter: () => '—',
    tooltipValueGetter: () => t('workbench.runIndex.resultsUnknown'),
  },
])

function onRowClicked(event: RowClickedEvent) {
  const run = event.data as RunSummary | undefined
  if (!run) return
  documentsStore.openRun(run.id, { title: rowTitle(run), preview: true })
}

function onRowDoubleClicked(event: RowDoubleClickedEvent) {
  const run = event.data as RunSummary | undefined
  if (!run) return
  documentsStore.openRun(run.id, { title: rowTitle(run), preview: false })
}
</script>

<template>
  <div class="run-index">
    <Empty
      v-if="!hasAnyRuns"
      class="run-index__onboarding"
      :title="t('workbench.runIndex.emptyTitle')"
      :description="t('workbench.runIndex.emptyDescription')"
    />

    <template v-else>
      <div class="run-index__toolbar">
        <input
          v-model="filterText"
          type="text"
          class="run-index__filter-text"
          :placeholder="t('workbench.runIndex.filterPlaceholder')"
        >
        <select v-model="filterStatus" class="run-index__filter-status">
          <option value="all">{{ t('workbench.runIndex.filterAllStatus') }}</option>
          <option v-for="status in statusOptions" :key="status" :value="status">{{ statusLabels[status] }}</option>
        </select>
      </div>

      <!--
        Filtered-to-nothing is a different state from never-had-any, and it
        needs a different answer: one names the filter to clear, the other
        explains where runs come from. One shared "No runs" would be the
        shrug this document is not allowed to give.
      -->
      <Empty
        v-if="filteredRuns.length === 0"
        class="run-index__onboarding"
        :title="t('workbench.runIndex.emptyFilteredTitle')"
        :description="t('workbench.runIndex.emptyFilteredDescription')"
      />

      <div v-else class="run-index__grid ag-theme-alpine">
        <AgGridVue
          theme="legacy"
          style="width: 100%; height: 100%"
          :column-defs="columnDefs"
          :row-data="filteredRuns"
          :get-row-id="getRowId"
          :row-height="rowHeight"
          :header-height="rowHeight"
          :suppress-cell-focus="true"
          :tooltip-show-delay="200"
          @row-clicked="onRowClicked"
          @row-double-clicked="onRowDoubleClicked"
        />
      </div>

      <button
        v-if="runsStore.historyHasMore"
        type="button"
        class="run-index__load-more"
        :disabled="runsStore.loading"
        @click="runsStore.loadMoreHistory()"
      >
        {{ t('workbench.runIndex.loadMore') }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.run-index {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: var(--space-3);
  gap: var(--space-2);
}

.run-index__onboarding {
  margin: auto;
  max-width: 480px;
}

.run-index__toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.run-index__filter-text {
  flex: 1 1 auto;
  min-width: 0;
  height: var(--control-h);
  padding: 0 var(--space-2);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--text-sm);
}

.run-index__filter-status {
  flex: none;
  height: var(--control-h);
  padding: 0 var(--space-2);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--text-sm);
}

.run-index__grid {
  flex: 1 1 auto;
  min-height: 0;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  overflow: hidden;

  --ag-background-color: var(--color-bg);
  --ag-foreground-color: var(--color-text);
  --ag-header-background-color: var(--color-bg-secondary);
  --ag-header-foreground-color: var(--color-text-secondary);
  --ag-odd-row-background-color: var(--color-bg);
  --ag-row-hover-color: var(--color-bg-muted);
  --ag-border-color: var(--line-hairline);
  --ag-row-border-color: var(--line-hairline);
}

.run-index__load-more {
  flex: none;
  align-self: center;
  padding: var(--space-1) var(--space-3);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  cursor: pointer;
}

.run-index__load-more:hover {
  background: var(--color-bg-muted);
  color: var(--color-text);
}

.run-index__load-more:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
