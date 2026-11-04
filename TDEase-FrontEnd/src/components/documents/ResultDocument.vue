<!--
  ResultDocument — CORE-ARCHITECTURE.md §3.

  The `result` DocumentKey's surface. Until this component existed, nothing in
  the product called `ResultCache.open()`: `services/resultCacheStorage.ts`
  held two complete Electron-backed storages and the `desktopResultCache()`
  composition point, and `studio/projections/result-availability.ts` held the
  four-state projection, and both were imported by nothing but their own
  tests. This file is the reader; `stores/documents.ts` is the wiring.

  §5.5 splits the responsibilities: **the document owns the frame** — title,
  dimension chips, the staleness mark, `Save to Workspace…` and the viewer
  switcher — and **the viewer owns only the marks**. So no viewer is written
  here. One is *resolved*, through the existing
  the static ViewerRegistry, and mounted through the same ViewerSurface used by
  FileDocument and Canvas.

  Four availability states, never one spinner (CORE-ARCHITECTURE.md §3.2-§3.4):

    cached      the local cache holds these exact bytes
    remote      publishable, not cached — opening will fetch
    conflict    the cache holds this key under a different digest
    unavailable this pinned digest is not published: superseded, or never was

  `conflict` and `unavailable` are failures with a remedy, so they render
  through `primitives/ErrorCard.vue` as the real failure envelope
  (CORE-ARCHITECTURE.md §7.1) rather than as a placeholder. `cached` and
  `remote` differ only in whether a fetch happens, so they differ only by a
  chip — they must not differ by whether the user is told anything at all.

  Opening is transparent and creates nothing the user owns. Materialization is
  the single explicit act that writes a Workspace file, which is why the
  button reads `Save to Workspace…`, carries a visible label rather than an
  icon, and opens a destination prompt.
-->
<template>
  <div class="result-document">
    <header class="result-document__frame">
      <div class="result-document__titles">
        <h2 class="result-document__title">{{ displayTitle }}</h2>
        <CopyableId :value="resultRef.resultId" class="result-document__id" />
      </div>

      <div class="result-document__marks">
        <Chip v-if="overview" variant="filter">{{ availabilityLabel }}</Chip>
        <Chip v-if="overview?.supersededBy" variant="neutral" class="result-document__stale">
          {{ t('workbench.resultDocument.staleMark') }}
        </Chip>
        <Chip v-for="dimension in dimensionChips" :key="dimension.key" variant="dimension">
          {{ dimension.key }}: {{ dimension.value }}
        </Chip>
        <span v-if="overview?.published && !dimensionChips.length" class="result-document__note">
          {{ t('workbench.resultDocument.dimensionsUnknown') }}
        </span>
      </div>

      <div class="result-document__actions">
        <label v-if="viewerOptions.length" class="result-document__viewer">
          <span class="result-document__viewer-label">{{ t('workbench.resultDocument.viewerLabel') }}</span>
          <el-select
            v-model="viewerOverride"
            size="small"
            class="result-document__viewer-select"
            :placeholder="resolvedViewerLabel"
            :aria-label="t('workbench.resultDocument.viewerLabel')"
          >
            <el-option
              v-for="option in viewerOptions"
              :key="option.type"
              :label="option.label"
              :value="option.type"
            />
          </el-select>
        </label>

        <AppButton
          variant="primary"
          size="sm"
          :disabled="!canMaterialize"
          @click="onSaveToWorkspace"
        >
          {{ t('workbench.resultDocument.saveToWorkspace') }}
        </AppButton>
      </div>
    </header>

    <p v-if="overview?.cacheUnavailable" class="result-document__note result-document__note--row">
      {{ t('workbench.resultDocument.cacheUnavailable') }}
    </p>

    <ErrorCard
      v-if="saveError"
      class="result-document__save-error"
      :error="saveError"
      @retry="onSaveToWorkspace"
    />

    <div class="result-document__body">
      <div v-if="status === 'loading'" class="result-document__loading">
        <Skeleton variant="block" :height="240" />
      </div>

      <ErrorCard
        v-else-if="frameError"
        :error="frameError"
        @retry="onFrameRetry"
      />

      <Empty
        v-else-if="status === 'not-renderable'"
        :title="t('workbench.resultDocument.notRenderableTitle')"
        :description="t('workbench.resultDocument.notRenderableDescription')"
        :action-label="t('workbench.resultDocument.saveToWorkspace')"
        @action="onSaveToWorkspace"
      />

      <ViewerSurface
        v-else-if="viewerInput"
        :input="viewerInput"
      />

      <pre v-else class="result-document__text">{{ textContent }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@/components/primitives/AppButton.vue'
import Chip from '@/components/primitives/Chip.vue'
import CopyableId from '@/components/primitives/CopyableId.vue'
import Empty from '@/components/primitives/Empty.vue'
import ErrorCard from '@/components/primitives/ErrorCard.vue'
import Skeleton from '@/components/primitives/Skeleton.vue'
import ViewerSurface from '@/components/visualization/ViewerSurface.vue'
import { useConfirmDialogStore } from '@/stores/confirmDialog'
import { BackendFailure } from '@/studio/domain/backend-failure'
import {
  classifyFile,
  delimiterFor,
  mediaMimeType,
} from '@/services/visualization/fileIngress'
// Delimited results can be hundreds of MB — decode + d3 parse run in the
// file-parse Web Worker (fileParseClient), never on the renderer main
// thread. The bytes transfer, they are not copied.
import { parseFile } from '@/services/documents/fileParseClient'
import { viewerRegistry } from '@/services/visualization/ViewerRegistry'
import { bindMedia, bindSingleDataset, datasetFromRows } from '@/services/visualization/viewerIngress'
import type { ViewerRenderInput } from '@/types/visualization'
import { useDocumentsStore, type ResultOverview } from '@/stores/documents'
import type { ResultRef } from '@/studio/domain/result'
import type { StructuredError } from '@/studio/domain/errors'

const props = defineProps<{ resultRef: ResultRef }>()

const { t } = useI18n()
const documentsStore = useDocumentsStore()
const confirmDialog = useConfirmDialogStore()

type Status = 'loading' | 'ready' | 'blocked' | 'failed' | 'not-renderable'

const status = ref<Status>('loading')
const overview = ref<ResultOverview | null>(null)
/** The Backend's own envelope for the current failure, when it gave one. */
const backendFailure = ref<StructuredError | null>(null)
const table = ref<{ columns: string[]; rows: Record<string, string>[] } | null>(null)
const objectUrl = ref<string | null>(null)
const textContent = ref('')
const saveError = ref<StructuredError | null>(null)
const viewerOverride = ref<string | undefined>(undefined)

const displayTitle = computed(() => overview.value?.published?.title || props.resultRef.resultId)

const AVAILABILITY_LABEL_KEYS = {
  cached: 'workbench.resultDocument.availabilityCached',
  remote: 'workbench.resultDocument.availabilityRemote',
  conflict: 'workbench.resultDocument.availabilityConflict',
  unavailable: 'workbench.resultDocument.availabilityUnavailable',
} as const

const availabilityLabel = computed(() =>
  overview.value ? t(AVAILABILITY_LABEL_KEYS[overview.value.availability]) : '')

/**
 * The Result's scientific dimensions (CORE-ARCHITECTURE.md §4), read straight
 * off `PublishedResult.metadata` — which `studioBackendGateway.mapPublishedResult`
 * fills from `ResultSpec.dimensions`.
 *
 * Rendered in the Backend's own key order, and with the raw keys as labels,
 * because `dimension_schema` does not exist yet (docs/STATUS.md):
 * there is nothing to read for display names, ordering or units. Showing the
 * raw pairs is honest; inventing an order would not be.
 */
const dimensionChips = computed(() => {
  const metadata = overview.value?.published?.metadata
  if (!metadata) return []
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({ key, value: String(value) }))
})

const technicalPath = computed(() => overview.value?.published?.technicalPath ?? '')

function revokeObjectUrl() {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = null
  }
}

function resetContent() {
  revokeObjectUrl()
  table.value = null
  textContent.value = ''
}

/**
 * Two round trips, in this order and never merged: the frame first (which
 * states what this reference *is*), the bytes second (and only when the frame
 * says there are bytes worth asking for). Merging them is what produces a
 * spinner that resolves into a generic error for four different reasons.
 */
async function load() {
  resetContent()
  saveError.value = null
  backendFailure.value = null
  overview.value = null
  status.value = 'loading'

  let described: ResultOverview
  try {
    described = await documentsStore.describeResult(props.resultRef)
  } catch (error) {
    backendFailure.value = error instanceof BackendFailure ? error.structured : null
    status.value = 'failed'
    return
  }
  overview.value = described

  // `unavailable` and `conflict` are answered by the frame alone: there is
  // nothing to fetch, and both carry a remedy the ErrorCard states.
  if (described.availability === 'unavailable' || described.availability === 'conflict') {
    status.value = 'blocked'
    return
  }

  const kind = classifyFile(technicalPath.value)
  if (kind === 'binary') {
    // The bytes are real and saveable — only inline rendering is impossible.
    status.value = 'not-renderable'
    return
  }

  try {
    const resource = await documentsStore.openResultContent(props.resultRef)
    if (kind === 'table') {
      // Off-thread decode + parse (see the fileParseClient import note).
      const buffer = await resource.blob.arrayBuffer()
      if (status.value !== 'loading') return
      const parsed = await parseFile({ kind: 'delimited', delimiter: delimiterFor(technicalPath.value), buffer })
      if (status.value !== 'loading') return
      table.value = parsed.table
    } else if (kind === 'media') {
      objectUrl.value = URL.createObjectURL(resource.blob)
    } else {
      textContent.value = await resource.blob.text()
    }
    status.value = 'ready'
  } catch (error) {
    backendFailure.value = error instanceof BackendFailure ? error.structured : null
    status.value = 'failed'
  }
}

watch(() => documentIdentity(props.resultRef), load, { immediate: true })
onBeforeUnmount(revokeObjectUrl)

/** All four fields decide identity (§3.2), so all four decide a reload. */
function documentIdentity(ref: ResultRef): string {
  return `${ref.workspaceId}/${ref.runId}/${ref.resultId}/${ref.digest}`
}

/* ---------------------------------------------------------------------------
 * Viewer resolution — §5.5's "by kind and media type", through the existing
 * registry. No viewer is defined here.
 * ------------------------------------------------------------------------- */

const resolvedViewer = computed(() => {
  const published = overview.value?.published
  if (!published || !table.value) return undefined
  const explicit = viewerRegistry.get(published.kind)
  if (explicit) return explicit
  const compatible = viewerRegistry.viewersAccepting(published.kind)
  return compatible.length === 1 ? compatible[0] : viewerRegistry.get('table')
})

const viewerOptions = computed(() => {
  if (!table.value) return []
  const kind = overview.value?.published?.kind ?? 'table'
  const compatible = new Map([
    ...viewerRegistry.viewersAccepting(kind),
    ...viewerRegistry.viewersAccepting('table'),
  ].map(registration => [registration.id, registration]))
  return Array.from(compatible.values())
    .map((registration) => ({ type: registration.id, label: registration.label }))
    .sort((a, b) => a.label.localeCompare(b.label))
})

const resolvedViewerLabel = computed(() => resolvedViewer.value?.label ?? '')

/** The user's pick wins; the registry's answer is the default, never a lock. */
const effectiveViewer = computed(() => viewerOverride.value ?? resolvedViewer.value?.id)

// A new Result resolves its own default viewer, so a pick made against the
// previous one is dropped rather than silently applied to different bytes.
watch(() => documentIdentity(props.resultRef), () => { viewerOverride.value = undefined })

const viewerInput = computed<ViewerRenderInput | null>(() => {
  if (status.value !== 'ready') return null

  if (table.value && effectiveViewer.value) {
    const publishedKind = overview.value?.published?.kind ?? 'table'
    const datasetKind = viewerRegistry.compatiblePorts(effectiveViewer.value, publishedKind).length
      ? publishedKind
      : 'table'
    return bindSingleDataset(effectiveViewer.value, datasetFromRows(
      technicalPath.value,
      table.value.rows,
      table.value.columns,
      datasetKind,
    ))
  }

  if (objectUrl.value) {
    return bindMedia(objectUrl.value, mediaMimeType(technicalPath.value), displayTitle.value)
  }

  return null
})

/* ---------------------------------------------------------------------------
 * Failure envelopes. One per distinguishable cause — CORE-ARCHITECTURE.md §7.1.
 * ------------------------------------------------------------------------- */

const frameError = computed<StructuredError | null>(() => {
  if (status.value === 'failed') {
    // The Backend's own account first: its `code` is a member of the closed
    // enum and its `remedy` is written for the exact case.
    return backendFailure.value ?? {
      code: 'RESULT_OPEN_FAILED',
      domain: 'backend',
      message: t('workbench.resultDocument.openFailedMessage'),
      remedy: t('workbench.resultDocument.openFailedRemedy'),
      retryable: true,
      details: { resultId: props.resultRef.resultId, runId: props.resultRef.runId },
    }
  }

  if (status.value !== 'blocked' || !overview.value) return null

  if (overview.value.availability === 'conflict') {
    return {
      code: 'RESULT_CACHE_CONFLICT',
      domain: 'environment',
      message: t('workbench.resultDocument.conflictMessage'),
      remedy: t('workbench.resultDocument.conflictRemedy'),
      retryable: true,
      details: { resultId: props.resultRef.resultId, digest: props.resultRef.digest },
    }
  }

  // §3.4, and the two readings are different sentences: a digest that was
  // replaced is not the same event as one that was never published.
  if (overview.value.supersededBy) {
    return {
      code: 'RESULT_SUPERSEDED',
      domain: 'run',
      message: t('workbench.resultDocument.supersededMessage'),
      remedy: t('workbench.resultDocument.supersededRemedy'),
      retryable: false,
      details: {
        resultId: props.resultRef.resultId,
        pinnedDigest: props.resultRef.digest,
        currentDigest: overview.value.supersededBy,
      },
      cause: { runId: props.resultRef.runId },
    }
  }

  return {
    code: 'RESULT_NOT_PUBLISHED',
    domain: 'run',
    message: t('workbench.resultDocument.notPublishedMessage'),
    remedy: t('workbench.resultDocument.notPublishedRemedy'),
    retryable: false,
    details: { resultId: props.resultRef.resultId, digest: props.resultRef.digest },
    cause: { runId: props.resultRef.runId },
  }
})

/**
 * Retrying a cache conflict means evicting first: §3.3 — "cache eviction can
 * never make a Result wrong, only slower". Every other retry is a plain
 * reload, so a Backend failure never quietly deletes cached bytes.
 */
async function onFrameRetry() {
  if (overview.value?.availability === 'conflict') {
    try {
      await documentsStore.evictResult(props.resultRef)
    } catch {
      // Eviction failing is not worth a second envelope: the reload below
      // re-derives the same conflict and states it again.
    }
  }
  await load()
}

/* ---------------------------------------------------------------------------
 * Materialization — the one act that writes a file the user owns (§5.5).
 * ------------------------------------------------------------------------- */

const canMaterialize = computed(() =>
  Boolean(overview.value?.published) && overview.value?.availability !== 'unavailable')

function defaultDestination(): string {
  const name = technicalPath.value.split('/').pop() || props.resultRef.resultId
  return `results/${name}`
}

async function onSaveToWorkspace() {
  if (!canMaterialize.value) return
  saveError.value = null

  // Same rule the old inputPattern encoded: no leading or trailing slash, no
  // backslashes anywhere (relative workspace path).
  const destination = await confirmDialog.requestText({
    title: t('workbench.resultDocument.savePromptTitle', { title: displayTitle.value }),
    message: t('workbench.resultDocument.savePromptBody'),
    confirmLabel: t('workbench.resultDocument.savePromptConfirm'),
    cancelLabel: t('workbench.resultDocument.savePromptCancel'),
    initialValue: defaultDestination(),
    validate: (value) => (/^[^/\\][^\\]*[^/]$/.test(value) ? null : t('workbench.resultDocument.savePromptInvalid')),
  })
  if (destination === null) return // dismissed — Esc, backdrop and Cancel all land here

  try {
    await documentsStore.materializeResult(props.resultRef, destination)
  } catch (error) {
    // `PublishedResultCache.materialize` refuses rather than overwriting when
    // the destination already holds different bytes (`fileTransfer.canOverwrite`),
    // so this is a decision the user has to make, not a retry.
    saveError.value = error instanceof BackendFailure ? error.structured : {
      code: 'RESULT_MATERIALIZE_FAILED',
      domain: 'workspace',
      message: t('workbench.resultDocument.saveFailedMessage', { destination }),
      remedy: t('workbench.resultDocument.saveFailedRemedy'),
      retryable: false,
      details: { destination, resultId: props.resultRef.resultId },
    }
  }
}
</script>

<style scoped>
.result-document {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.result-document__frame {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-hairline);
  background: var(--color-bg-secondary);
}

.result-document__titles {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.result-document__title {
  margin: 0;
  font-size: var(--text-md);
  line-height: var(--text-md-lh);
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-document__id {
  flex: none;
}

.result-document__marks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.result-document__stale {
  border-color: var(--color-warning, var(--line-hairline));
}

.result-document__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-left: auto;
}

.result-document__viewer {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.result-document__viewer-label {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.result-document__viewer-select {
  width: 12rem;
}

.result-document__viewer-select :deep(.el-input__wrapper:focus-within) {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}

.result-document__note {
  margin: 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}

.result-document__note--row {
  flex: none;
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-hairline);
}

.result-document__save-error {
  flex: none;
  margin: var(--space-3) var(--space-3) 0;
}

.result-document__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  padding: var(--space-3);
}

.result-document__loading {
  width: 100%;
}

.result-document__text {
  width: 100%;
  margin: 0;
  padding: var(--space-3);
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
}
</style>
