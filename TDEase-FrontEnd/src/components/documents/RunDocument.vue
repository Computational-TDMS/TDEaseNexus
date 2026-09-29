<!--
  S1 honest placeholder: the fixed status header (status mark + text,
  editable-in-a-later-slice title, duration, the Run menu) is real. The five
  stable subviews (Summary · Results · DAG · Activity · Provenance) are still
  S2 scope and are not faked here with inert placeholders.

  KNOWN GAP, stated rather than hidden: these actions call `runsStore.*`
  directly, NOT `registry.invoke`. §7.1's agent-parity invariant ("every
  button, menu item, shortcut and context-menu entry in this shell calls
  `registry.run(id, args)`") is therefore not structurally held here, and the
  user menu and the Agent's `runs.*` tools are two paths that can drift. An
  earlier revision of this comment claimed the opposite; it was wrong.
  Tracked in docs/STATUS.md.

  Verb vocabulary bans an
  ambiguous generic rerun: `Continue` (same definition, `--rerun-incomplete`,
  finished results untouched) and `Recompute all results` (force). The store's
  transport-level `'resume' | 'overwrite'` argument is an engine detail and is
  never the user's word.

  What the body now carries is the Files/Artifacts listing this task adds:
  "the verification layer reachable from every scientific surface"
  — a real list of this Run's
  files, each opening as a `file` document through `ViewerSurface` or
  the plain read-only text view (`FileDocument.vue`). The Backend does not
  lists the Backend result manifest. Execution-private Node rule snapshots,
  index shards, logs and run.json remain available through explicit technical
  file queries, but are not presented as user artifacts.
-->
<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import { Download } from '@element-plus/icons-vue'
import { BackendFailure } from '@/studio/domain/backend-failure'
import { useI18n } from 'vue-i18n'
import StatusMark, { type RunStatus as MarkStatus } from '@/components/primitives/StatusMark.vue'
import CopyableId from '@/components/primitives/CopyableId.vue'
import AppButton from '@/components/primitives/AppButton.vue'
import Empty from '@/components/primitives/Empty.vue'
import ErrorCard from '@/components/primitives/ErrorCard.vue'
import Skeleton from '@/components/primitives/Skeleton.vue'
import { formatByteSize } from '@/services/visualization/fileIngress'
import type { RunFileEntry, RunRevision } from '@/studio/ports/backend-gateway'
import type { RunStatus } from '@/services/backend/backend'
import type { RunSummary } from '@/studio/domain/run'
import type { StructuredError } from '@/studio/domain/errors'
import { useRunsStore } from '@/stores/runs'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import { useUiLayoutStore } from '@/stores/uiLayout'
import { useConfirmDialogStore } from '@/stores/confirmDialog'
import { desktopResultFileSystem, isDesktopFileOpsAvailable } from '@/services/workspace/desktopWorkspace'
import { workspacePathForManifestEntry } from '@/services/workspace/run-file-status'
import RunWorkflowGraph from './RunWorkflowGraph.vue'
import type { WorkflowGraph } from '@/studio/ports/backend-gateway'
import type { RunEvent } from '@/studio/domain/run'

const props = defineProps<{ runId: string }>()

const { t } = useI18n()
const runsStore = useRunsStore()
const documentsStore = useDocumentsStore()
const workspaceStore = useWorkspaceStore()
const uiLayout = useUiLayoutStore()
const confirmDialog = useConfirmDialogStore()

const run = computed<RunSummary | undefined>(() =>
  runsStore.active.get(props.runId) ?? runsStore.history.find((entry) => entry.id === props.runId))

const isTrashed = computed(() => runsStore.trashed.some((entry) => entry.id === props.runId))

function toMarkStatus(status: RunStatus): MarkStatus {
  return status.toLowerCase() as MarkStatus
}

const isActive = computed(() => run.value?.status === 'QUEUED' || run.value?.status === 'RUNNING')
const isTerminal = computed(() => !!run.value && !isActive.value)

const displayTitle = computed(() => run.value?.title || props.runId.slice(0, 10))
const mappedRunPath = computed(() => run.value?.workspaceRunPath
  || (run.value?.labels.source_run ? `runs/${run.value.labels.source_run}` : undefined))

const workflowGraph = ref<WorkflowGraph | null>(null)
const graphLoading = ref(true)
const graphError = ref(false)
let stopGraphEvents: (() => void) | null = null
let graphRequest = 0

/** Failed workflow node click → aim the ActivityDock's Logs tab at this Run. */
function showRunLog() {
  uiLayout.showRunLog(props.runId)
}

async function loadGraph() {
  const request = ++graphRequest
  graphLoading.value = true
  graphError.value = false
  try {
    const graph = await documentsStore.getRunGraph(props.runId)
    if (request === graphRequest) workflowGraph.value = graph
  } catch {
    if (request === graphRequest) {
      workflowGraph.value = null
      graphError.value = true
    }
  } finally {
    if (request === graphRequest) graphLoading.value = false
  }
}

function applyGraphEvent(event: RunEvent) {
  if (event.type === 'workflow.graph') {
    workflowGraph.value = {
      runId: event.runId,
      nodes: ((event.data.nodes as WorkflowGraph['nodes'] | undefined) ?? []).map((node) => ({
        ...node, status: node.initial_status ?? 'waiting', wildcards: {},
      })),
      edges: (event.data.edges as WorkflowGraph['edges'] | undefined) ?? [],
    }
    return
  }
  const status = ({ 'job.started': 'running', 'job.succeeded': 'succeeded', 'job.failed': 'failed' } as const)[event.type as 'job.started' | 'job.succeeded' | 'job.failed']
  const jobId = event.data.job_id
  if (!status || typeof jobId !== 'number' || !workflowGraph.value) return
  workflowGraph.value = {
    ...workflowGraph.value,
    nodes: workflowGraph.value.nodes.map((node) => node.id === jobId
      ? { ...node, status, wildcards: (event.data.wildcards as Record<string, string> | undefined) ?? node.wildcards }
      : node),
  }
}

function configureGraphRefresh() {
  stopGraphEvents?.()
  stopGraphEvents = null
  void loadGraph()
  if (isActive.value) stopGraphEvents = documentsStore.subscribeRunEvents(props.runId, applyGraphEvent)
}

watch([() => props.runId, () => run.value?.status], configureGraphRefresh, { immediate: true })

async function onCancel() {
  await runsStore.cancel(props.runId)
}

/** `Continue` — same frozen definition, `--rerun-incomplete`, finished results kept. */
async function onContinue() {
  await runsStore.rerun(props.runId, 'resume')
}

/**
 * `Recompute all results` — the one destructive action here, so it is the only
 * one that confirms. The dialog names the run, states the consequence and
 * labels both buttons with what they do; "Are you sure?" with OK/Cancel is
 * what it replaces.
 */
async function onRecomputeAll() {
  const ok = await confirmDialog.request({
    title: t('workbench.runDocument.recomputeConfirmTitle', { title: displayTitle.value }),
    message: t('workbench.runDocument.recomputeConfirmBody'),
    confirmLabel: t('workbench.runDocument.recomputeConfirmAccept'),
    cancelLabel: t('workbench.runDocument.recomputeConfirmCancel'),
    danger: true,
  })
  if (!ok) return // dismissed — Esc, backdrop and the cancel button all land here
  await runsStore.rerun(props.runId, 'overwrite')
}

/**
 * Trash does NOT confirm. It is recoverable by design (`Restore from trash`
 * is right there), and a confirmation on a reversible action is the habit
 * that teaches users to dismiss confirmations without reading them — which is
 * what makes the one above useless.
 */
async function onTrash() {
  await runsStore.trash(props.runId)
}
async function onRestore() {
  await runsStore.restore(props.runId)
}

// ── Files / Artifacts listing ────────────────────────────────────────────

type FilesStatus = 'loading' | 'success' | 'error'

const files = ref<ReadonlyArray<RunFileEntry>>([])
const filesStatus = ref<FilesStatus>('loading')
const filesRefreshing = ref(false)
let filesTimer: ReturnType<typeof setInterval> | null = null
/** The Backend's own failure envelope for the current load, when it gave one. */
const backendFailure = ref<StructuredError | null>(null)

async function loadFiles(background = false) {
  if (filesRefreshing.value) return
  filesRefreshing.value = true
  if (!background) filesStatus.value = 'loading'
  backendFailure.value = null
  try {
    const entries = await documentsStore.listRunFiles(props.runId)
    files.value = entries
    filesStatus.value = 'success'
  } catch (error) {
    backendFailure.value = error instanceof BackendFailure ? error.structured : null
    files.value = []
    filesStatus.value = 'error'
  } finally {
    filesRefreshing.value = false
  }
}

function configureFilesRefresh() {
  if (filesTimer) clearInterval(filesTimer)
  filesTimer = null
  void loadFiles(filesStatus.value === 'success')
  // Poll only while the run can still change its outputs; stop once terminal.
  const status = run.value?.status
  const running = status === 'QUEUED' || status === 'RUNNING'
  if (isActive.value && running) {
    filesTimer = setInterval(() => { void loadFiles(true) }, 2000)
  }
}

watch([() => props.runId, () => run.value?.status], configureFilesRefresh, { immediate: true })

// KeepAlive: pause the live polling + graph-event subscription while this run
// document is cached/hidden (no point fetching file lists or streaming graph
// events the user can't see), resume both on re-activation. Terminal runs have
// no polling/subscription anyway, so the pause/resume is a no-op for them.
function pauseLiveUpdates() {
  if (filesTimer) { clearInterval(filesTimer); filesTimer = null }
  stopGraphEvents?.()
  stopGraphEvents = null
}

function resumeLiveUpdates() {
  configureFilesRefresh()
  configureGraphRefresh()
}

onActivated(() => { resumeLiveUpdates() })
onDeactivated(() => { pauseLiveUpdates() })

onBeforeUnmount(() => {
  graphRequest += 1
  pauseLiveUpdates()
})

function openFile(entry: RunFileEntry) {
  documentsStore.openRunFile(props.runId, entry.path)
}

const pullingFilePath = ref<string | null>(null)
const canPullFiles = computed(() => Boolean(workspaceStore.workspacePath)
  && Boolean(mappedRunPath.value)
  && isDesktopFileOpsAvailable())

/** Pull a Backend artifact into its owning Workspace Run; its destination is not user-selected. */
async function pullFile(entry: RunFileEntry) {
  const root = workspaceStore.workspacePath
  if (!root || pullingFilePath.value) return
  pullingFilePath.value = entry.path
  try {
    const blob = await documentsStore.fetchRunFile(props.runId, entry.path)
    await desktopResultFileSystem(root).writeBlobAtomic(
      workspacePathForManifestEntry(mappedRunPath.value!, entry.path),
      blob,
    )
  } finally {
    pullingFilePath.value = null
  }
}

// ── Retained revisions ──────────────────────────────────────────────────

const revisions = ref<ReadonlyArray<RunRevision>>([])
const selectedRevision = ref('')
const revisionFiles = ref<ReadonlyArray<RunFileEntry>>([])
const revisionsLoading = ref(false)
const revisionAction = ref<'results' | 'workflow' | 'preview' | null>(null)
const workflowPreview = ref('')

const selectedRevisionInfo = computed(() => revisions.value.find((item) => item.revisionId === selectedRevision.value))
const revisionResultFiles = computed(() => revisionFiles.value.filter((entry) => entry.role !== 'workflow'))
const revisionWorkflowFiles = computed(() => revisionFiles.value.filter((entry) => entry.role === 'workflow'))
const canRestoreRevision = computed(() => canPullFiles.value && Boolean(mappedRunPath.value) && Boolean(selectedRevision.value))

async function loadRevisions() {
  if (!isTerminal.value) return
  revisionsLoading.value = true
  try {
    revisions.value = await documentsStore.listRunRevisions(props.runId)
    const preferred = run.value?.currentRevision
    selectedRevision.value = revisions.value.some((item) => item.revisionId === preferred)
      ? preferred!
      : revisions.value[0]?.revisionId ?? ''
    await loadRevisionFiles()
  } finally {
    revisionsLoading.value = false
  }
}

async function loadRevisionFiles() {
  workflowPreview.value = ''
  if (!selectedRevision.value) {
    revisionFiles.value = []
    return
  }
  revisionFiles.value = await documentsStore.listRunFiles(
    props.runId, 'results/**', selectedRevision.value, true,
  )
}

async function restoreRevisionFiles(entries: ReadonlyArray<RunFileEntry>) {
  const root = workspaceStore.workspacePath
  const runPath = mappedRunPath.value
  if (!root || !runPath) return
  const writer = desktopResultFileSystem(root)
  for (const entry of entries) {
    const blob = await documentsStore.fetchRunFile(props.runId, entry.path, selectedRevision.value)
    await writer.writeBlobAtomic(workspacePathForManifestEntry(runPath, entry.path), blob)
  }
}

async function restoreRevisionResults() {
  if (!canRestoreRevision.value || revisionResultFiles.value.length === 0) return
  const ok = await confirmDialog.request({
    title: t('workbench.runDocument.revisionRestoreResultsTitle'),
    message: t('workbench.runDocument.revisionRestoreResultsBody', { count: revisionResultFiles.value.length }),
    confirmLabel: t('workbench.runDocument.revisionRestoreResultsAccept'),
    cancelLabel: t('workbench.runDocument.revisionCancel'),
  })
  if (!ok) return
  revisionAction.value = 'results'
  try { await restoreRevisionFiles(revisionResultFiles.value) }
  finally { revisionAction.value = null }
}

async function previewRevisionWorkflow() {
  const entry = revisionWorkflowFiles.value.find((item) => item.path === 'Snakefile')
    ?? revisionWorkflowFiles.value.find((item) => item.path.endsWith('.smk'))
  if (!entry) return
  revisionAction.value = 'preview'
  try {
    workflowPreview.value = await (await documentsStore.fetchRunFile(
      props.runId, entry.path, selectedRevision.value,
    )).text()
  } finally { revisionAction.value = null }
}

async function restoreRevisionWorkflow() {
  if (!canRestoreRevision.value || revisionWorkflowFiles.value.length === 0) return
  const ok = await confirmDialog.request({
    title: t('workbench.runDocument.revisionRestoreWorkflowTitle'),
    message: t('workbench.runDocument.revisionRestoreWorkflowBody'),
    confirmLabel: t('workbench.runDocument.revisionRestoreWorkflowAccept'),
    cancelLabel: t('workbench.runDocument.revisionCancel'),
    danger: true,
  })
  if (!ok) return
  revisionAction.value = 'workflow'
  try { await restoreRevisionFiles(revisionWorkflowFiles.value) }
  finally { revisionAction.value = null }
}

watch([() => props.runId, () => run.value?.status], () => { void loadRevisions() }, { immediate: true })

/**
 * What the Backend said, when it said anything. `RUN_FILES_LIST_FAILED` is not
 * a member of the Backend's closed `ErrorCode` enum -- it is a placeholder from
 * before the envelope was readable, kept only for a failure that carries none.
 */
const filesError = computed<StructuredError>(() => backendFailure.value ?? ({
  code: 'RUN_FILES_LIST_FAILED',
  domain: 'backend',
  message: t('workbench.runDocument.filesErrorMessage'),
  remedy: t('workbench.runDocument.filesErrorRemedy'),
  retryable: true,
}))
</script>

<template>
  <div class="run-document">
    <header class="run-document__header">
      <StatusMark v-if="run" :status="toMarkStatus(run.status)" :label="run.status" />
      <span class="run-document__title">{{ displayTitle }}</span>
      <CopyableId :value="props.runId" class="run-document__id" />

      <div class="run-document__menu">
        <AppButton
          v-if="isActive"
          variant="danger"
          size="sm"
          :title="t('workbench.runDocument.actionCancelHint')"
          @click="onCancel"
        >
          {{ t('workbench.runDocument.actionCancel') }}
        </AppButton>
        <template v-if="isTerminal">
          <AppButton
            variant="subtle"
            size="sm"
            :title="t('workbench.runDocument.actionContinueHint')"
            @click="onContinue"
          >
            {{ t('workbench.runDocument.actionContinue') }}
          </AppButton>
          <AppButton
            variant="danger"
            size="sm"
            :title="t('workbench.runDocument.actionRecomputeAllHint')"
            @click="onRecomputeAll"
          >
            {{ t('workbench.runDocument.actionRecomputeAll') }}
          </AppButton>
          <!-- Recoverable, so it is not styled as destructive and does not confirm. -->
          <AppButton
            variant="subtle"
            size="sm"
            :title="t('workbench.runDocument.actionTrashHint')"
            @click="onTrash"
          >
            {{ t('workbench.runDocument.actionTrash') }}
          </AppButton>
        </template>
        <AppButton v-if="isTrashed" variant="subtle" size="sm" @click="onRestore">
          {{ t('workbench.runDocument.actionRestore') }}
        </AppButton>
      </div>
    </header>

    <div class="run-document__body">
      <RunWorkflowGraph
        :graph="workflowGraph"
        :loading="graphLoading"
        :error="graphError"
        :terminal="isTerminal"
        @retry="loadGraph"
        @inspect="showRunLog"
      />
      <section class="run-document__files">
        <header class="run-document__files-head">
          <h3 class="run-document__files-title">{{ t('workbench.runDocument.filesTitle') }}</h3>
          <AppButton variant="subtle" size="sm" :disabled="filesRefreshing" @click="loadFiles(false)">
            {{ t('workbench.runDocument.filesRefresh') }}
          </AppButton>
        </header>

        <div v-if="isTerminal && (revisionsLoading || revisions.length)" class="run-document__revisions">
          <div class="run-document__revision-controls">
            <label class="run-document__revision-label" :for="`run-revision-${props.runId}`">
              {{ t('workbench.runDocument.revisionLabel') }}
            </label>
            <select
              :id="`run-revision-${props.runId}`"
              v-model="selectedRevision"
              class="run-document__revision-select"
              :disabled="revisionsLoading"
              @change="loadRevisionFiles"
            >
              <option v-for="revision in revisions" :key="revision.revisionId" :value="revision.revisionId">
                {{ revision.revisionId }} · {{ new Date(revision.createdAt).toLocaleString() }}
              </option>
            </select>
            <span v-if="selectedRevisionInfo" class="run-document__revision-counts">
              {{ t('workbench.runDocument.revisionCounts', {
                results: selectedRevisionInfo.fileCount,
                workflow: selectedRevisionInfo.workflowFileCount,
              }) }}
            </span>
          </div>

          <div class="run-document__revision-actions">
            <AppButton
              variant="subtle"
              size="sm"
              :disabled="!canRestoreRevision || revisionResultFiles.length === 0 || revisionAction !== null"
              @click="restoreRevisionResults"
            >
              {{ t('workbench.runDocument.revisionRestoreResults') }}
            </AppButton>
            <AppButton
              variant="subtle"
              size="sm"
              :disabled="revisionWorkflowFiles.length === 0 || revisionAction !== null"
              @click="previewRevisionWorkflow"
            >
              {{ t('workbench.runDocument.revisionPreviewWorkflow') }}
            </AppButton>
            <AppButton
              variant="subtle"
              size="sm"
              :disabled="!canRestoreRevision || revisionWorkflowFiles.length === 0 || revisionAction !== null"
              @click="restoreRevisionWorkflow"
            >
              {{ t('workbench.runDocument.revisionRestoreWorkflow') }}
            </AppButton>
          </div>

          <pre v-if="workflowPreview" class="run-document__workflow-preview">{{ workflowPreview }}</pre>
          <p v-else-if="!mappedRunPath" class="run-document__revision-warning">
            {{ t('workbench.runDocument.revisionMissingMapping') }}
          </p>
        </div>

        <Skeleton v-if="filesStatus === 'loading'" variant="row" :lines="4" />

        <ErrorCard
          v-else-if="filesStatus === 'error'"
          :error="filesError"
          @retry="loadFiles"
        />

        <Empty
          v-else-if="files.length === 0"
          :title="t('workbench.runDocument.filesEmptyTitle')"
          :description="t('workbench.runDocument.filesEmptyDescription')"
        />

        <ul v-else class="run-document__file-list" role="list">
          <li v-for="entry in files" :key="entry.path" class="run-document__file-item">
            <button type="button" class="run-document__file-row" @click="openFile(entry)">
              <span class="run-document__file-path">{{ entry.path }}</span>
              <span class="run-document__file-size">{{ formatByteSize(entry.size) }}</span>
            </button>
            <button
              v-if="canPullFiles"
              type="button"
              class="run-document__file-download"
              :title="t('workbench.runDocument.filePull')"
              :aria-label="t('workbench.runDocument.filePull')"
              :disabled="pullingFilePath === entry.path"
              @click.stop="pullFile(entry)"
            >
              <el-icon :size="14"><Download /></el-icon>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.run-document {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.run-document__header {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: calc(var(--row-h) + var(--space-2));
  padding: 0 var(--space-3);
  border-bottom: var(--line-w) solid var(--line-hairline);
  background: var(--color-bg-secondary);
}

.run-document__title {
  font-size: var(--text-md);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-document__id {
  flex: none;
}

.run-document__file-item { display: grid; grid-template-columns: minmax(0, 1fr) 32px; align-items: stretch; }
.run-document__file-download { border: 0; border-bottom: var(--line-w) solid var(--line-hairline); background: transparent; color: var(--color-text-muted); cursor: pointer; }
.run-document__file-download:hover { color: var(--color-text); background: var(--color-hover); }

.run-document__menu {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.run-document__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.run-document__files {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 100%;
  min-height: 0;
  padding: var(--space-3);
}

.run-document__files-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.run-document__files-title {
  margin: 0;
  font-size: var(--text-md);
  color: var(--color-text);
}

.run-document__revisions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-block: var(--space-2);
  border-top: var(--line-w) solid var(--line-hairline);
  border-bottom: var(--line-w) solid var(--line-hairline);
}

.run-document__revision-controls,
.run-document__revision-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.run-document__revision-label,
.run-document__revision-counts,
.run-document__revision-warning {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.run-document__revision-select {
  min-width: 240px;
  max-width: min(440px, 100%);
  height: var(--control-h);
  padding: 0 var(--space-2);
  border: var(--line-w) solid var(--line-seam-strong);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font: inherit;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.run-document__revision-select:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}

.run-document__workflow-preview {
  max-height: 280px;
  overflow: auto;
  margin: 0;
  padding: var(--space-3);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.5;
  white-space: pre;
}

.run-document__revision-warning {
  margin: 0;
}

.run-document__file-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.run-document__file-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  height: var(--row-h);
  padding: 0 var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.run-document__file-row:hover,
.run-document__file-row:focus-visible {
  background: var(--color-bg-hover);
  border-color: var(--line-hairline);
}

.run-document__file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.run-document__file-size {
  flex: none;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
</style>
