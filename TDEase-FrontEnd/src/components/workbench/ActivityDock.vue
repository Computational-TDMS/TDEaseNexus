<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Close, BottomLeft, Right, FullScreen, ScaleToOriginal } from '@element-plus/icons-vue'
import AppButton from '@/components/primitives/AppButton.vue'
import Empty from '@/components/primitives/Empty.vue'
import StatusMark, { type RunStatus as MarkStatus } from '@/components/primitives/StatusMark.vue'
import type { RunStatus } from '@/services/backend/backend'
import type { RunSummary } from '@/studio/domain/run'
import { useDocumentsStore } from '@/stores/documents'
import { useRunsStore } from '@/stores/runs'
import { useUiLayoutStore, type ActivityTab } from '@/stores/uiLayout'

const { t } = useI18n()
const uiLayout = useUiLayoutStore()
const runsStore = useRunsStore()
const documentsStore = useDocumentsStore()

// Which Run the Logs tab shows lives in the uiLayout store so any surface —
// the dock's run list, a failed workflow node, the StatusBar — can aim the
// dock at the same Run.
const selectedRunId = computed({
  get: () => uiLayout.activityRunId,
  set: (id: string) => { uiLayout.activityRunId = id },
})
const logText = ref('')
const logError = ref<string | null>(null)
const logLoading = ref(false)
let logTimer: ReturnType<typeof setInterval> | null = null

// Phase 2: collapse is a layout-layer concern. WorkbenchPage renders this dock
// with v-if and sizes its split to 0 when collapsed — there is no 32px header
// strip here, and the close button below is the only collapse affordance.
const tabs = computed<Array<{ id: ActivityTab; label: string; description: string }>>(() => ([
  { id: 'runs', label: t('workbench.activityDock.tabRuns'), description: t('workbench.activityDock.emptyRuns') },
  { id: 'logs', label: t('workbench.activityDock.tabLogs'), description: t('workbench.activityDock.emptyLogs') },
]))
const activeTab = computed(() => tabs.value.find((tab) => tab.id === uiLayout.activityTab) ?? tabs.value[0])
const allRuns = computed<RunSummary[]>(() => [
  ...Array.from(runsStore.active.values()).sort(newestFirst),
  ...runsStore.history,
])
const selectedRun = computed(() => allRuns.value.find((run) => run.id === selectedRunId.value) ?? null)

const statusLabels = computed<Record<RunStatus, string>>(() => ({
  QUEUED: t('workbench.runIndex.status.queued'),
  RUNNING: t('workbench.runIndex.status.running'),
  SUCCEEDED: t('workbench.runIndex.status.succeeded'),
  FAILED: t('workbench.runIndex.status.failed'),
  CANCELLED: t('workbench.runIndex.status.cancelled'),
}))

watch(
  () => allRuns.value.map((run) => `${run.id}:${run.status}`).join('|'),
  () => {
    if (!selectedRun.value) selectedRunId.value = allRuns.value[0]?.id ?? ''
    configureLogRefresh()
  },
  { immediate: true },
)
// The dock is unmounted when collapsed (Phase 2), so there is no collapsed
// branch in configureLogRefresh to watch — the component simply stops existing.
watch([() => uiLayout.activityTab, selectedRunId], configureLogRefresh)

onMounted(() => { void runsStore.ensureLoaded() })
onBeforeUnmount(stopLogRefresh)

function newestFirst(a: RunSummary, b: RunSummary): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt)
}

function toMarkStatus(status: RunStatus): MarkStatus {
  return status.toLowerCase() as MarkStatus
}

function selectTab(id: ActivityTab) {
  uiLayout.setActivityTab(id)
}

/** Close the panel — the parent stops rendering it and gives the space back. */
function close() {
  uiLayout.togglePanelVisible()
}

/** Maximize over the center (VS Code's panel maximize), or restore. */
function toggleMaximized() {
  uiLayout.togglePanelMaximized()
}

/** Move the panel between bottom and right (a grid re-location, not a resize). */
function togglePosition() {
  uiLayout.setPanelPosition(uiLayout.panelPosition === 'bottom' ? 'right' : 'bottom')
}

function selectRun(run: RunSummary) {
  selectedRunId.value = run.id
}

function openRun(run: RunSummary) {
  documentsStore.openRun(run.id, { title: run.title || run.id.slice(0, 10), preview: false })
}

function showRunLog(run: RunSummary) {
  selectedRunId.value = run.id
  uiLayout.setActivityTab('logs')
}

function configureLogRefresh() {
  stopLogRefresh()
  if (uiLayout.activityTab !== 'logs' || !selectedRun.value) return
  void refreshLog()
  if (selectedRun.value.status === 'QUEUED' || selectedRun.value.status === 'RUNNING') {
    logTimer = setInterval(() => { void refreshLog() }, 2000)
  }
}

function stopLogRefresh() {
  if (logTimer) clearInterval(logTimer)
  logTimer = null
}

async function refreshLog() {
  const run = selectedRun.value
  if (!run || logLoading.value) return
  logLoading.value = true
  logError.value = null
  try {
    logText.value = await runsStore.readRunLog(run.id, 200)
  } catch (cause) {
    logError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    logLoading.value = false
  }
}
</script>

<template>
  <section
    class="activity-dock"
    role="complementary"
    :aria-label="t('workbench.activityDock.label')"
    tabindex="-1"
  >
    <header class="activity-dock__header">
      <div class="activity-dock__tabs" role="tablist" :aria-label="t('workbench.activityDock.label')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="activity-dock__tab"
          role="tab"
          :class="{ 'is-active': uiLayout.activityTab === tab.id }"
          :aria-selected="uiLayout.activityTab === tab.id"
          @click="selectTab(tab.id)"
        >
          {{ tab.label }}
          <span v-if="tab.id === 'runs' && runsStore.active.size" class="activity-dock__count">{{ runsStore.active.size }}</span>
        </button>
      </div>
      <div class="activity-dock__actions">
        <AppButton
          variant="subtle"
          size="sm"
          class="activity-dock__action"
          :title="uiLayout.panelPosition === 'bottom'
            ? t('workbench.activityDock.positionRight')
            : t('workbench.activityDock.positionBottom')"
          :aria-label="uiLayout.panelPosition === 'bottom'
            ? t('workbench.activityDock.positionRight')
            : t('workbench.activityDock.positionBottom')"
          @click="togglePosition"
        >
          <template #icon>
            <el-icon :size="14"><Right v-if="uiLayout.panelPosition === 'bottom'" /><BottomLeft v-else /></el-icon>
          </template>
        </AppButton>
        <AppButton
          variant="subtle"
          size="sm"
          class="activity-dock__action"
          :title="uiLayout.panelMaximized
            ? t('workbench.activityDock.restore')
            : t('workbench.activityDock.maximize')"
          :aria-label="uiLayout.panelMaximized
            ? t('workbench.activityDock.restore')
            : t('workbench.activityDock.maximize')"
          @click="toggleMaximized"
        >
          <template #icon>
            <el-icon :size="14"><ScaleToOriginal v-if="uiLayout.panelMaximized" /><FullScreen v-else /></el-icon>
          </template>
        </AppButton>
        <AppButton
          variant="subtle"
          size="sm"
          class="activity-dock__close"
          :title="t('workbench.activityDock.collapse')"
          :aria-label="t('workbench.activityDock.collapse')"
          @click="close"
        >
          <template #icon>
            <el-icon :size="16"><Close /></el-icon>
          </template>
        </AppButton>
      </div>
    </header>

    <div class="activity-dock__body">
      <template v-if="uiLayout.activityTab === 'runs'">
        <Empty v-if="!allRuns.length && !runsStore.loading" :title="activeTab.label" :description="activeTab.description" />
        <div v-else class="activity-dock__runs" role="list">
          <div
            v-for="run in allRuns"
            :key="run.id"
            class="activity-dock__run"
            :class="{ 'is-selected': run.id === selectedRunId, 'is-live': run.status === 'RUNNING' }"
            role="listitem"
            tabindex="0"
            @click="selectRun(run)"
            @dblclick="openRun(run)"
            @keydown.enter="openRun(run)"
          >
            <StatusMark :status="toMarkStatus(run.status)" size="sm" />
            <span class="activity-dock__run-name">{{ run.title || run.id }}</span>
            <span class="activity-dock__run-status">{{ statusLabels[run.status] }}</span>
            <span class="activity-dock__run-id">{{ run.id.slice(0, 16) }}</span>
            <button
              type="button"
              class="activity-dock__log-link"
              @click.stop="showRunLog(run)"
            >
              {{ t('workbench.activityDock.viewLog') }}
            </button>
          </div>
        </div>
        <p v-if="runsStore.error" class="activity-dock__error">{{ runsStore.error }}</p>
      </template>

      <template v-else-if="uiLayout.activityTab === 'logs'">
        <Empty v-if="!selectedRun" :title="activeTab.label" :description="activeTab.description" />
        <div v-else class="activity-dock__logs">
          <div class="activity-dock__log-header">
            <StatusMark :status="toMarkStatus(selectedRun.status)" size="sm" :label="statusLabels[selectedRun.status]" />
            <strong>{{ selectedRun.title || selectedRun.id }}</strong>
            <AppButton variant="subtle" size="sm" class="activity-dock__refresh" :disabled="logLoading" @click="refreshLog">
              {{ t('workbench.activityDock.refreshLog') }}
            </AppButton>
          </div>
          <p v-if="selectedRun.error" class="activity-dock__error">{{ selectedRun.error }}</p>
          <p v-if="logError" class="activity-dock__error">{{ logError }}</p>
          <pre v-if="logText" class="activity-dock__log-text">{{ logText }}</pre>
          <Empty v-else-if="!logLoading && !logError" :title="activeTab.label" :description="activeTab.description" />
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.activity-dock { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--color-bg-secondary); }
.activity-dock__header { flex: none; display: flex; align-items: center; justify-content: space-between; height: var(--header-h); min-height: var(--header-h); padding: 0 var(--space-3); }
.activity-dock__tabs { display: flex; align-items: center; gap: var(--space-1); min-width: 0; overflow: hidden; }
.activity-dock__tab { display: inline-flex; align-items: center; gap: var(--space-1-5); height: 34px; padding: 0 var(--space-2); border: none; background: transparent; color: var(--color-text-muted); font-size: var(--text-sm); border-radius: var(--radius-md); cursor: pointer; transition: color var(--dur-instant) var(--ease-out), background-color var(--dur-instant) var(--ease-out); }
.activity-dock__tab:hover { color: var(--color-text); background: var(--color-hover); }
.activity-dock__tab:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px; }
.activity-dock__tab.is-active { color: var(--color-interact-text); background: var(--color-interact-soft); font-weight: 500; }
.activity-dock__count { min-width: 18px; height: 18px; padding: 0 var(--space-1); border-radius: 50%; background: var(--status-running); color: var(--color-on-primary); font-size: var(--text-label); line-height: 18px; text-align: center; }
.activity-dock__actions { flex: none; display: flex; align-items: center; gap: var(--space-1); }
.activity-dock__action, .activity-dock__close { flex: none; }
.activity-dock__body { flex: 1 1 auto; min-height: 0; overflow: auto; background: var(--color-bg); }
.activity-dock__runs { display: grid; align-content: start; }
.activity-dock__run { display: grid; grid-template-columns: 16px minmax(140px, 1fr) 90px 150px auto; align-items: center; gap: var(--space-2); min-height: var(--row-h); padding: var(--pad-y) var(--space-3); border: 0; border-bottom: var(--line-w) solid var(--line-seam); background: transparent; color: var(--color-text); text-align: left; cursor: pointer; transition: background-color var(--dur-instant) var(--ease-out); }
.activity-dock__run:hover, .activity-dock__run.is-selected { background: var(--color-hover); }
.activity-dock__run.is-selected { background: var(--color-interact-soft); }
/* A RUNNING run is the one live thing in this list — it gets a 2px --color-live
   channel down its left edge (The Living Channel Rule, VISUAL-SYSTEM.md §6.4:
   same stroke language as the Agent page's acting edge indicator). The inset
   shadow adds no layout width, so compact density stays intact. */
.activity-dock__run.is-live {
  box-shadow: inset 2px 0 0 var(--color-live), inset 4px 0 6px -2px var(--color-live-glow);
}
.activity-dock__run.is-selected.is-live {
  box-shadow: inset 2px 0 0 var(--color-live), inset 4px 0 6px -2px var(--color-live-glow);
}
.activity-dock__run-name, .activity-dock__run-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.activity-dock__run-status, .activity-dock__run-id { color: var(--color-text-muted); font-size: var(--text-xs); }
.activity-dock__log-link, .activity-dock__refresh { border: 0; background: transparent; color: var(--color-interact); font-size: var(--text-xs); cursor: pointer; }
.activity-dock__log-link { justify-self: end; padding: 2px 0; border-radius: var(--radius-sm); }
.activity-dock__logs { min-height: 100%; }
.activity-dock__log-header { position: sticky; top: 0; z-index: var(--z-raised); display: flex; align-items: center; gap: var(--space-2); min-height: var(--header-h); padding: 0 var(--space-3); border-bottom: var(--line-w) solid var(--line-seam); background: var(--color-bg); }
.activity-dock__log-header strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
.activity-dock__refresh { margin-left: auto; }
.activity-dock__refresh:disabled { opacity: 0.5; cursor: default; }
.activity-dock__log-text { min-height: 100%; margin: 0; padding: var(--space-2) var(--space-3); overflow: auto; color: var(--color-text); font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.activity-dock__error { margin: 0; padding: var(--space-2) var(--space-3); color: var(--status-failed); font-size: var(--text-xs); }
@media (max-width: 760px) { .activity-dock__run { grid-template-columns: 16px minmax(100px, 1fr) 76px auto; } .activity-dock__run-id { display: none; } }
</style>
