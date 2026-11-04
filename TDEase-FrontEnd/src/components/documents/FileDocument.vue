<!--
  Opens a file from EITHER of the shell's two file origins, with one
  downstream rendering path for the bytes:

    - a Run's file — the document key is the `runFile` variant and `runId`
      is bound; the bytes come from `documentsStore.fetchRunFile`, which
      wraps the same `TDEaseBackendGateway` the Run surface uses.
    - a Workspace file — no `runId`; the Navigator's Files section opens
      these, and the bytes come from
      `documentsStore.readWorkspaceFile`, which resolves through the views
      filesystem adapter.

  Origin is the key's identity (`runId` present or not), never inferred from
  the path string. §5.2's rule is that the surface "cannot tell whether bytes
  came from disk or cache, and must not care" — so both origins produce a
  `Blob` and meet in the same `classifyFile` dispatch below. This component
  never reads a file itself.

  Role dispatch happens before extension dispatch. Workflow files expose DAG
  and Source targets in one document. The DAG target does not infer topology
  from source: until native dry-run projection is available it renders the
  contract's explicit unavailable state.

  For ordinary files, §5.6's dispatch table wants CodeMirror for source/config,
  an `AgGridTable` for delimited data, a `MediaViewer` for images, and a
  header-summary card for binary (`*.raw`). CodeMirror is not installed, so:

    - table/media → `ViewerSurface`, after this document has opened and
                    normalized the bytes.
    - text   → a plain read-only `<pre>` where §5.6 wants CodeMirror. Honest
               downgrade: the content is all there, the editing affordances
               are simply absent rather than faked.
    - binary → the type/size card, which states what the file is and offers
               the two actions that really do reach the bytes today (the
               desktop shell's Open-with / Reveal). Never raw bytes.

  These views are read-only; editing remains a separate capability.
-->
<template>
  <div class="file-document">
    <header class="file-document__header">
      <span class="file-document__name">{{ fileName }}</span>
      <span class="file-document__spacer" />
      <div v-if="renderTargets.length > 1" class="file-document__targets" role="tablist">
        <button
          v-for="target in renderTargets"
          :key="target"
          type="button"
          role="tab"
          class="file-document__target"
          :class="{ 'is-active': activeTarget === target }"
          :aria-selected="activeTarget === target"
          @click="activeTarget = target"
        >
          {{ targetLabel(target) }}
        </button>
      </div>
      <!-- External open for EVERY renderable kind (media included — an image or
           an HTML report opens in the OS viewer, not only the unsupported card). -->
      <div v-if="desktopAvailable" class="file-document__actions">
        <AppButton size="sm" @click="openExternally">
          {{ t('workbench.fileDocument.openExternalAction') }}
        </AppButton>
      </div>
    </header>

    <div class="file-document__body">
      <div v-if="status === 'loading'" class="file-document__loading">
        <Skeleton variant="block" :height="240" />
      </div>

      <ErrorCard
        v-else-if="status === 'error'"
        :error="fetchError"
        @retry="load"
      />

      <!-- A Run's binary file: the bytes are on the Backend, so none of the
           desktop actions on the Workspace card apply to it. -->
      <Empty
        v-else-if="status === 'unsupported' && origin === 'run'"
        :title="t('workbench.fileDocument.unsupportedTitle')"
        :description="t('workbench.fileDocument.unsupportedDescription')"
      />

      <section
        v-else-if="status === 'unsupported'"
        class="file-document__card"
        data-state="type-card"
        :aria-label="t('workbench.fileDocument.typeCardTitle', { name: fileName })"
      >
        <h3 class="file-document__card-title">
          {{ t('workbench.fileDocument.typeCardTitle', { name: fileName }) }}
        </h3>
        <p class="file-document__card-description">
          {{ kind === 'media'
            ? t('workbench.fileDocument.mediaCardDescription', { ext: extLabel })
            : t('workbench.fileDocument.binaryCardDescription', { ext: extLabel }) }}
        </p>

        <dl class="file-document__meta">
          <div class="file-document__meta-row">
            <dt>{{ t('workbench.fileDocument.metaType') }}</dt>
            <dd>{{ extLabel }}</dd>
          </div>
          <div class="file-document__meta-row">
            <dt>{{ t('workbench.fileDocument.metaSize') }}</dt>
            <dd>{{ sizeLabel }}</dd>
          </div>
          <div class="file-document__meta-row">
            <dt>{{ t('workbench.fileDocument.metaPath') }}</dt>
            <dd class="file-document__meta-path">{{ targetPath }}</dd>
          </div>
        </dl>

        <div v-if="desktopAvailable" class="file-document__card-actions">
          <AppButton variant="primary" size="sm" @click="openExternally">
            {{ t('workbench.fileDocument.openExternalAction') }}
          </AppButton>
          <AppButton size="sm" @click="revealInFileManager">
            {{ t('workbench.fileDocument.revealAction') }}
          </AppButton>
        </div>
        <p v-else class="file-document__card-hint">
          {{ t('workbench.fileDocument.desktopOnlyHint') }}
        </p>

        <p v-if="actionFailed" class="file-document__card-hint" role="status" aria-live="polite">
          {{ t('workbench.fileDocument.actionFailed') }}
        </p>
      </section>

      <section
        v-else-if="role === 'fasta' && activeTarget === 'formatted'"
        class="file-document__fasta"
      >
        <FastaViewer :source="textContent" />
      </section>

      <!-- TopPIC prsm/proteoform TSVs: the Variants target reference-aligns
           the identified proteins against the sibling FASTA. Loaded lazily on
           first entry; the family filter rebuilds from the cached FASTA. -->
      <section
        v-else-if="role === 'toppic-proteins' && activeTarget === 'variants'"
        class="file-document__variants"
        data-render-target="toppic-variants"
      >
        <div class="file-document__variants-toolbar">
          <input
            v-model="variantFilter"
            class="file-document__variants-filter"
            type="search"
            :placeholder="t('workbench.fileDocument.variants.filterPlaceholder')"
          />
        </div>
        <Skeleton v-if="variantStatus === 'loading'" variant="block" :height="280" />
        <ErrorCard v-else-if="variantStatus === 'error'" :error="variantFailure" @retry="loadVariants" />
        <VariantAlignmentViewer
          v-else-if="variantModel"
          :model="variantModel"
          :fasta-name="variantFastaName"
        />
      </section>

      <section
        v-else-if="role === 'workflow' && activeTarget === 'dag'"
        class="file-document__dag"
        data-render-target="workflow-dag"
      >
        <Skeleton v-if="dagStatus === 'loading'" variant="block" :height="280" />
        <ErrorCard v-else-if="dagStatus === 'error'" :error="dagFetchError" @retry="loadDag" />
        <WorkflowDagViewer v-else-if="dagProjection" :projection="dagProjection" />
      </section>

      <section
        v-else-if="activeTarget === 'discrimination' && discrimination"
        class="file-document__discrimination"
        data-render-target="ms2-discrimination"
      >
        <Ms2DiscriminationViewer :model="discrimination" :directive="viewDirective" />
      </section>

      <!-- Kernel resolve-shift result: the shift's mass ledger. -->
      <section
        v-else-if="activeTarget === 'ledger' && ledger"
        class="file-document__ledger"
        data-render-target="mass-ledger"
      >
        <MassLedgerViewer :model="ledger" />
      </section>

      <!-- TopFD `.msalign` / mzML: the shared spectrum-list browser. mzML
           entries carry no peaks in the index — peakLoader decodes the
           selected spectrum lazily from its byte range. -->
      <MsAlignDocument
        v-else-if="activeTarget === 'spectrum' && (msalignSpectra || mzmlIndex)"
        class="file-document__msalign"
        :spectra="msalignSpectra ?? mzmlIndex!.spectra"
        :file-name="fileName"
        :peak-loader="mzmlPeakLoaderFn"
      />

      <!-- Ag-grid / media viewer for delimited data and images. For `.feature`
           this is the explicit `table` target; for every other ordinary file
           it is the single implicit target (no tab bar). `source` only reaches
           the `<pre>` below when the file actually offers Source as a peer
           target (TopFD formats, fasta/workflow). -->
      <ViewerSurface v-else-if="viewerInput" :input="viewerInput" />

      <pre v-else class="file-document__text">{{ textContent }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@/components/primitives/AppButton.vue'
import FastaViewer from './FastaViewer.vue'
import VariantAlignmentViewer from './VariantAlignmentViewer.vue'
import WorkflowDagViewer from './WorkflowDagViewer.vue'
import MsAlignDocument from './MsAlignDocument.vue'
import Empty from '@/components/primitives/Empty.vue'
import ErrorCard from '@/components/primitives/ErrorCard.vue'
import Skeleton from '@/components/primitives/Skeleton.vue'
import ViewerSurface from '@/components/visualization/ViewerSurface.vue'
import Ms2DiscriminationViewer from '@/components/visualization/Ms2DiscriminationViewer.vue'
import { compareSiblingPath, isDiscriminationPayload, parseDiscrimination, type DiscriminationModel } from '@/services/visualization/ms2Discrimination'
import MassLedgerViewer from '@/components/visualization/MassLedgerViewer.vue'
import { isMassLedgerPayload, parseMassLedger, type MassLedgerModel } from '@/services/visualization/massLedger'
import { useAgentViewStore } from '@/stores/agentView'
import { BackendFailure } from '@/studio/domain/backend-failure'
import { getDesktopFileOps, isDesktopFileOpsAvailable } from '@/services/workspace/desktopWorkspace'
import { workspaceFilePath } from '@/services/workspace/workspaceAddress'
import type { FastaDocument } from '@/services/fasta'
import { parseFastaOffscreen } from '@/services/fastaParseClient'
import {
  aggregateProteinFacts,
  buildVariantAlignment,
  extractDatabaseFileName,
  scanFastaRecords,
  wantedFastaKeys,
} from '@/services/sequence/variantAlignment'
import type { VariantAlignmentModel } from '@/services/sequence/variantAlignment'
import type { MsAlignSpectrum } from '@/services/visualization/msalign'
import type { MzmlIndex, MzmlSource } from '@/services/visualization/mzml'
import { mzmlPeakLoader, parseMzmlIndex, prepareMzmlSource, prepareRangeMzmlSource } from '@/services/visualization/mzml'
import { bindMedia, bindSingleDataset, datasetFromRows } from '@/services/visualization/viewerIngress'
import type { ViewerRenderInput } from '@/types/visualization'
import {
  baseName,
  classifyFile,
  delimiterFor,
  extensionOf,
  formatByteSize,
  mediaMimeType,
} from '@/services/visualization/fileIngress'
import { parseFile } from '@/services/documents/fileParseClient'
import { useDocumentsStore } from '@/stores/documents'
import { useWorkspaceStore } from '@/stores/workspace'
import type { FileTreeNode } from '@/types/workspace-data'
import type { StructuredError } from '@/studio/domain/errors'
import type { DryRunProjection } from '@/studio/ports/backend-gateway'

/**
 * `runId` is bound exactly when the document key is the `runFile` variant —
 * the Backend owns the bytes and `path` is Run-relative. Without it the file
 * is a Workspace file and `path` is Workspace-relative.
 */
const props = defineProps<{ workspaceId: string; path: string; runId?: string; citedByAgent?: boolean }>()

const { t } = useI18n()
const documentsStore = useDocumentsStore()
const workspaceStore = useWorkspaceStore()

type Status = 'loading' | 'success' | 'error' | 'unsupported'
type FileRole = 'ordinary' | 'workflow' | 'fasta' | 'toppic-proteins'
type RenderTarget = 'source' | 'dag' | 'graph' | 'formatted' | 'table' | 'featuremap' | 'spectrum' | 'variants' | 'discrimination' | 'ledger'

const status = ref<Status>('loading')
/** The Backend's own failure envelope for the current load, when it gave one. */
const backendFailure = ref<StructuredError | null>(null)
// Both hold whole arrays that only ag-grid / the spectrum list read — deep
// proxies would double the memory and tax every row access, so they follow
// the discrimination/ledger pattern: shallow refs replaced whole-value.
const tableData = shallowRef<{ columns: string[]; rows: Record<string, string>[] } | null>(null)
/** Parsed spectra for the `msalign` kind — `null` for every other kind. */
const msalignSpectra = shallowRef<MsAlignSpectrum[] | null>(null)
/** mzML: the streamed index (spectra + TIC) plus the random-access source. */
const mzmlIndex = ref<MzmlIndex | null>(null)
const mzmlSource = ref<MzmlSource | null>(null)
const objectUrl = ref<string | null>(null)
const textContent = ref('')
/** chart-forge candidate-discrimination payload (+ sibling fragment-compare),
 *  parsed once per load — `null` for every other file. */
const discrimination = shallowRef<DiscriminationModel | null>(null)
/** Kernel resolve-shift result — the shift's mass ledger — `null` otherwise. */
const ledger = shallowRef<MassLedgerModel | null>(null)
const agentView = useAgentViewStore()
const viewDirective = computed(() => agentView.directiveFor(targetPath.value))
const actionFailed = ref(false)
const activeTarget = ref<RenderTarget>('source')
const dagStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const dagProjection = ref<DryRunProjection | null>(null)
const dagError = ref<StructuredError | null>(null)
const dagDiagnostic = ref('')
// ── Variants target (TopPIC prsm/proteoform TSVs) ──────────────────────────
/** `Protein database file:` from the TSV preamble — names the sibling FASTA. */
const toppicDatabaseFile = ref<string | null>(null)
const variantStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
const variantError = ref<StructuredError | null>(null)
const variantModel = ref<VariantAlignmentModel | null>(null)
const variantFastaDoc = ref<FastaDocument | null>(null)
const variantFastaName = ref('')
const variantFilter = ref('')
let variantLoadVersion = 0
let variantFilterTimer: ReturnType<typeof setTimeout> | null = null
let loadVersion = 0

/* ── Raw-text memory: drop after parsing, re-read lazily ─────────────────── */

/**
 * True once a specialized model (msalign spectra, discrimination/ledger JSON)
 * has replaced `textContent` in memory. The Source target re-reads the bytes
 * on demand — no file keeps two full copies of its own content alive.
 */
const sourceTextDropped = ref(false)
/** Re-reads this load's bytes as text through the same origin it came from. */
let sourceReloader: (() => Promise<string>) | null = null

function makeSourceReloader(run: { runId: string; path: string } | null): () => Promise<string> {
  return async () => {
    const blob = run
      ? await documentsStore.fetchRunFile(run.runId, run.path)
      : await documentsStore.readWorkspaceFile(targetPath.value)
    return blob.text()
  }
}

/** Release the raw text a specialized model replaced (unless Source is live). */
function dropSourceText(run: { runId: string; path: string } | null): void {
  sourceReloader = makeSourceReloader(run)
  sourceTextDropped.value = true
  if (activeTarget.value === 'source') {
    void ensureSourceText()
  } else {
    textContent.value = ''
  }
}

async function ensureSourceText(): Promise<void> {
  if (!sourceTextDropped.value || textContent.value !== '' || !sourceReloader) return
  const version = loadVersion
  const text = await sourceReloader()
  if (version !== loadVersion) return
  textContent.value = text
}

/** The Run origin facts — bound exactly when the document key is the
 *  `runFile` variant (`runId` present); `path` is Run-relative then. */
const runTarget = computed<{ runId: string; path: string } | null>(() =>
  props.runId ? { runId: props.runId, path: props.path } : null)
const origin = computed<'run' | 'workspace'>(() => (runTarget.value ? 'run' : 'workspace'))
/** The path *within* its origin — the Run-relative path, or the Workspace-relative one. */
const targetPath = computed(() => props.path)
const kind = computed(() => classifyFile(targetPath.value))
const fileName = computed(() => baseName(targetPath.value))
const extLabel = computed(() => extensionOf(targetPath.value).toUpperCase())
const role = computed<FileRole>(() => {
  const path = targetPath.value.replaceAll('\\', '/')
  const lowerName = fileName.value.toLowerCase()
  if (lowerName === 'snakefile' || lowerName.endsWith('.smk')) return 'workflow'
  if (['fasta', 'fa', 'faa', 'fna', 'fas'].includes(extensionOf(path))) return 'fasta'
  if (/^(?:.*_)?(?:prsm|proteoform)(?:_single)?\.tsv$/i.test(lowerName)) return 'toppic-proteins'
  return 'ordinary'
})
const renderTargets = computed<RenderTarget[]>(() => {
  if (role.value === 'workflow') return ['dag', 'source']
  if (role.value === 'fasta') return ['formatted', 'source']
  if (role.value === 'toppic-proteins') return ['table', 'variants', 'source']
  if (discrimination.value) return ['discrimination', 'source']
  if (ledger.value) return ['ledger', 'source']
  // Kind-driven targets for the two TopFD text formats. `.feature` is already
  // classified `table`, so its default target is the ag-grid table and the
  // Feature Map target reuses the same parsed rows. `.msalign` has no table
  // form — its primary target is the spectrum-list viewer. Every other file
  // keeps the single implicit target (no tab bar); its kind decides the view.
  if (kind.value === 'msalign' || kind.value === 'mzml') return ['spectrum', ...(kind.value === 'msalign' ? ['source' as RenderTarget] : [])]
  if (extensionOf(targetPath.value) === 'feature') return ['table', 'featuremap', 'source']
  return ['source']
})

function targetLabel(target: RenderTarget): string {
  return t(`workbench.fileDocument.target.${target}`)
}

const renderable = computed(() => kind.value !== 'binary')

/** Bound only for mzML — decodes the selected scan from its byte range. */
const mzmlPeakLoaderFn = computed(() =>
  mzmlSource.value && mzmlIndex.value ? mzmlPeakLoader(mzmlSource.value, mzmlIndex.value.spectra) : undefined)

/** Size from the Workspace tree the Navigator already loaded — never a second stat() of our own. */
const knownSize = computed<number | null>(() => {
  if (origin.value !== 'workspace') return null
  const wanted = targetPath.value
  const find = (nodes: readonly FileTreeNode[]): FileTreeNode | null => {
    for (const node of nodes) {
      if (node.path === wanted) return node
      const hit = node.children ? find(node.children) : null
      if (hit) return hit
    }
    return null
  }
  const node = find(workspaceStore.fileTree)
    ?? find(Array.from(workspaceStore.directoryCache.values()).flat())
  return typeof node?.size === 'number' ? node.size : null
})

const sizeLabel = computed(() =>
  knownSize.value === null ? t('workbench.fileDocument.metaSizeUnknown') : formatByteSize(knownSize.value))

const desktopAvailable = computed(() =>
  origin.value === 'workspace' && !!workspaceStore.workspacePath && isDesktopFileOpsAvailable())

const absolutePath = computed(() => {
  const root = workspaceStore.workspacePath
  if (!root || !targetPath.value.trim()) return null
  // A relative part that fails containment resolves to nothing the OS shell
  // may open — the actions disappear rather than aiming outside the root.
  try {
    return workspaceFilePath(root, targetPath.value)
  } catch {
    return null
  }
})

async function openExternally() {
  const abs = absolutePath.value
  if (!abs) return
  actionFailed.value = false
  try {
    await getDesktopFileOps().openExternal(abs)
  } catch (error) {
    console.error(error)
    actionFailed.value = true
  }
}

async function revealInFileManager() {
  const abs = absolutePath.value
  if (!abs) return
  actionFailed.value = false
  try {
    await getDesktopFileOps().showInFolder(abs)
  } catch (error) {
    console.error(error)
    actionFailed.value = true
  }
}

function revokeObjectUrl() {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = null
  }
}

/** Candidate-discrimination JSON → native viewer model. The sibling
 *  `_compare.json` (ghost ions) is read through the SAME origin as the file;
 *  its absence only drops the ghosts. */
async function readDiscrimination(text: string, run: { runId: string; path: string } | null): Promise<DiscriminationModel | null> {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!isDiscriminationPayload(parsed)) return null
  let compare: unknown
  const sibling = compareSiblingPath(targetPath.value)
  if (sibling) {
    try {
      const blob = run ? await documentsStore.fetchRunFile(run.runId, sibling) : await documentsStore.readWorkspaceFile(sibling)
      compare = JSON.parse(await blob.text())
    } catch { compare = undefined }
  }
  try { return parseDiscrimination(parsed, compare) } catch { return null }
}

/** Kernel resolve-shift result → mass ledger model. A JSON that neither the
 *  discrimination nor the ledger read model claims stays plain source text. */
function readMassLedger(text: string): MassLedgerModel | null {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return null }
  if (!isMassLedgerPayload(parsed)) return null
  try { return parseMassLedger(parsed) } catch { return null }
}

async function load() {
  const currentLoad = ++loadVersion
  revokeObjectUrl()
  sourceTextDropped.value = false
  sourceReloader = null
  tableData.value = null
  msalignSpectra.value = null
  mzmlIndex.value = null
  mzmlSource.value = null
  textContent.value = ''
  discrimination.value = null
  ledger.value = null
  actionFailed.value = false
  toppicDatabaseFile.value = null
  variantLoadVersion += 1
  variantStatus.value = 'idle'
  variantError.value = null
  variantModel.value = null
  variantFastaDoc.value = null
  variantFastaName.value = ''
  variantFilter.value = ''
  activeTarget.value = role.value === 'workflow'
    ? 'dag'
    : role.value === 'fasta'
        ? 'formatted'
        : role.value === 'toppic-proteins'
          ? 'table'
          : kind.value === 'msalign' || kind.value === 'mzml'
            ? 'spectrum'
            : extensionOf(targetPath.value) === 'feature'
              ? 'table'
              : 'source'

  if (!renderable.value) {
    status.value = 'unsupported'
    return
  }

  status.value = 'loading'
  backendFailure.value = null
  const run = runTarget.value
  try {
    // mzML fast path (before any Blob fetch): a plain Workspace mzML is
    // indexed through byte-range reads, so a multi-GB file never crosses
    // the IPC boundary whole. `.gz` and Run files fall through to the Blob.
    let mzmlRangeSource: MzmlSource | null = null
    if (kind.value === 'mzml' && origin.value === 'workspace'
      && !/\.gz$/i.test(targetPath.value) && knownSize.value !== null) {
      const probe = await documentsStore.readWorkspaceByteRange(targetPath.value, 0, Math.min(64, knownSize.value))
      if (probe) {
        mzmlRangeSource = prepareRangeMzmlSource(knownSize.value, (start, end) =>
          documentsStore.readWorkspaceByteRange(targetPath.value, start, end))
      }
    }

    // The one place the two origins differ. Everything below this line sees a
    // `Blob` and cannot tell which branch produced it (§5.2).
    const blob = mzmlRangeSource ? null
      : run
        ? await documentsStore.fetchRunFile(run.runId, run.path)
        : await documentsStore.readWorkspaceFile(targetPath.value)
    if (currentLoad !== loadVersion) return

    if (kind.value === 'table') {
      // Decode + d3 parse off the main thread (fileParseClient); the bytes
      // transfer, they are not copied. The TopPIC preamble must be read on
      // this side anyway (it names the sibling FASTA), so that role keeps
      // the text and sends it along instead of the buffer.
      const delimiter = delimiterFor(targetPath.value)
      if (role.value === 'toppic-proteins') {
        const raw = await blob!.text()
        if (currentLoad !== loadVersion) return
        toppicDatabaseFile.value = extractDatabaseFileName(raw)
        const parsed = await parseFile({ kind: 'delimited', delimiter, text: raw })
        if (currentLoad !== loadVersion) return
        tableData.value = parsed.table
      } else {
        const buffer = await blob!.arrayBuffer()
        if (currentLoad !== loadVersion) return
        const parsed = await parseFile({ kind: 'delimited', delimiter, buffer })
        if (currentLoad !== loadVersion) return
        tableData.value = parsed.table
      }
    } else if (kind.value === 'msalign') {
      // Parsed off-thread like the table path. The parsed spectra own the
      // memory: the raw text is dropped and the Source target re-reads it
      // lazily (`ensureSourceText`) instead of holding a second full copy.
      const buffer = await blob!.arrayBuffer()
      if (currentLoad !== loadVersion) return
      const parsed = await parseFile({ kind: 'msalign', buffer })
      if (currentLoad !== loadVersion) return
      msalignSpectra.value = parsed.spectra
      dropSourceText(run)
    } else if (kind.value === 'mzml') {
      // Two-pass streaming: index the whole file without touching the binary
      // payloads, then decode only the scan the user selects. No Source
      // target — a mzML's raw bytes are neither text nor useful at this size.
      const source = mzmlRangeSource ?? await prepareMzmlSource(blob!, /\.gz$/i.test(targetPath.value))
      mzmlSource.value = source
      mzmlIndex.value = await parseMzmlIndex(source)
    } else if (kind.value === 'media') {
      // The img/iframe render by the blob URL's MIME — an untyped (Workspace
      // byte reader) or server-generic (Run fetch) blob renders an HTML
      // document as plain text. Stamp the type from the extension: the single
      // media MIME vocabulary decides, never the origin.
      objectUrl.value = URL.createObjectURL(new Blob([blob!], { type: mediaMimeType(targetPath.value) }))
    } else {
      textContent.value = await blob!.text()
      if (extensionOf(targetPath.value) === 'json') {
        const model = await readDiscrimination(textContent.value, run)
        if (currentLoad !== loadVersion) return
        if (model) {
          discrimination.value = model
          activeTarget.value = 'discrimination'
          // The specialized model replaces the raw JSON in memory; the
          // Source target re-reads lazily if the user asks for it.
          dropSourceText(run)
        } else {
          const ledgerModel = readMassLedger(textContent.value)
          if (currentLoad !== loadVersion) return
          if (ledgerModel) {
            ledger.value = ledgerModel
            activeTarget.value = 'ledger'
            dropSourceText(run)
          }
        }
      }
    }
    status.value = 'success'
    if (role.value === 'workflow' && origin.value === 'workspace') void loadDag()
  } catch (error) {
    if (currentLoad !== loadVersion) return
    // Prefer the Backend's own account of the failure -- its `code` is a member
    // of the closed enum and its `remedy` is written for this exact case. The
    // generic pair below is a last resort for a failure that never reached the
    // Backend at all.
    backendFailure.value = error instanceof BackendFailure ? error.structured : null
    status.value = 'error'
  }
}

async function loadDag() {
  if (origin.value !== 'workspace') {
    dagStatus.value = 'error'
    dagError.value = null
    return
  }
  dagStatus.value = 'loading'
  dagProjection.value = null
  dagError.value = null
  dagDiagnostic.value = ''
  try {
    dagProjection.value = await documentsStore.projectWorkspaceWorkflow(targetPath.value)
    dagStatus.value = 'success'
  } catch (error) {
    dagError.value = error instanceof BackendFailure ? error.structured : null
    dagDiagnostic.value = error instanceof Error ? error.message : String(error)
    dagStatus.value = 'error'
  }
}

// ── Variants target: sibling FASTA discovery + alignment model ─────────────

interface FastaCandidate { path: string; name: string; size: number | null }

const FASTA_NAME_PATTERN = /\.(fasta|fa|faa|fna|fas)$/i
/** Above this size a Workspace FASTA streams through byte ranges instead of one Blob. */
const WHOLE_FASTA_BYTES = 8 * 1024 * 1024

function posixDirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/**
 * The sequence database for this sample's TSV: the preamble's
 * `Protein database file:` name wins; otherwise a single FASTA sibling in the
 * same directory qualifies. More than one unnamed candidate is an error, not
 * a guess.
 */
async function findSiblingFasta(): Promise<FastaCandidate | null> {
  const directory = posixDirname(targetPath.value)
  const candidates: FastaCandidate[] = []
  const run = runTarget.value
  if (run) {
    for (const extension of ['fasta', 'fa', 'faa', 'fna', 'fas']) {
      const pattern = directory ? `${directory}/*.${extension}` : `*.${extension}`
      try {
        for (const entry of await documentsStore.listRunFiles(run.runId, pattern)) {
          candidates.push({ path: entry.path, name: baseName(entry.path), size: entry.size })
        }
      } catch {
        // a pattern miss is not a failure — the next extension may hit
      }
    }
  } else {
    const nodes = directory ? await workspaceStore.loadDirLazy(directory) : workspaceStore.fileTree
    for (const node of nodes) {
      if (node.type !== 'file' || !FASTA_NAME_PATTERN.test(node.name)) continue
      candidates.push({ path: node.path, name: node.name, size: node.size ?? null })
    }
  }
  if (candidates.length === 0) return null
  if (toppicDatabaseFile.value) {
    const named = candidates.find((candidate) => candidate.name.toLowerCase() === toppicDatabaseFile.value!.toLowerCase())
    if (named) return named
  }
  return candidates.length === 1 ? candidates[0]! : null
}

/** Workspace FASTAs beyond the whole-read limit stream through byte ranges (mzML precedent); Run files ride the Blob path.
 * The whole-read paths decode + parse off-thread (fastaParseClient) — a multi-hundred-MB
 * proteome must never freeze the renderer main thread. */
async function loadFastaDocument(file: FastaCandidate, wanted: ReadonlySet<string>): Promise<FastaDocument> {
  const run = runTarget.value
  if (run) return parseFastaOffscreen(await (await documentsStore.fetchRunFile(run.runId, file.path)).arrayBuffer())
  if (file.size !== null && file.size > WHOLE_FASTA_BYTES) {
    const probe = await documentsStore.readWorkspaceByteRange(file.path, 0, Math.min(64, file.size))
    if (probe) {
      return scanFastaRecords(
        (start, end) => documentsStore.readWorkspaceByteRange(file.path, start, end),
        file.size,
        { wanted },
      )
    }
  }
  return parseFastaOffscreen(await (await documentsStore.readWorkspaceFile(file.path)).arrayBuffer())
}

function rebuildVariantModel() {
  if (!variantFastaDoc.value || !tableData.value) return
  variantModel.value = buildVariantAlignment({
    fasta: variantFastaDoc.value,
    facts: aggregateProteinFacts(tableData.value),
    filter: variantFilter.value,
  })
}

async function loadVariants() {
  if (!tableData.value) return
  const version = ++variantLoadVersion
  variantStatus.value = 'loading'
  variantError.value = null
  try {
    const facts = aggregateProteinFacts(tableData.value)
    const fastaFile = await findSiblingFasta()
    if (version !== variantLoadVersion) return
    if (!fastaFile) {
      variantStatus.value = 'error'
      variantError.value = {
        code: 'VARIANTS_FASTA_MISSING',
        domain: origin.value === 'run' ? 'backend' : 'workspace',
        message: t('workbench.fileDocument.variants.fastaMissingMessage'),
        remedy: t('workbench.fileDocument.variants.fastaMissingRemedy'),
        retryable: true,
      }
      return
    }
    const fasta = await loadFastaDocument(fastaFile, wantedFastaKeys(facts))
    if (version !== variantLoadVersion) return
    variantFastaDoc.value = fasta
    variantFastaName.value = fastaFile.name
    rebuildVariantModel()
    variantStatus.value = 'success'
  } catch (error) {
    if (version !== variantLoadVersion) return
    variantStatus.value = 'error'
    variantError.value = error instanceof BackendFailure ? error.structured : {
      code: 'VARIANTS_LOAD_FAILED',
      domain: origin.value === 'run' ? 'backend' : 'workspace',
      message: t('workbench.fileDocument.variants.loadFailedMessage'),
      remedy: t('workbench.fileDocument.variants.loadFailedRemedy'),
      retryable: true,
    }
  }
}

watch(activeTarget, (target) => {
  if (target === 'variants' && role.value === 'toppic-proteins' && variantStatus.value === 'idle') {
    void loadVariants()
  }
  // Entering Source after the raw text was dropped re-reads it lazily.
  if (target === 'source') void ensureSourceText()
})

const variantFailure = computed<StructuredError>(() => variantError.value ?? {
  code: 'VARIANTS_LOAD_FAILED',
  domain: 'workspace',
  message: t('workbench.fileDocument.variants.loadFailedMessage'),
  remedy: t('workbench.fileDocument.variants.loadFailedRemedy'),
  retryable: true,
})

watch(variantFilter, () => {
  if (!variantFastaDoc.value) return
  if (variantFilterTimer) clearTimeout(variantFilterTimer)
  variantFilterTimer = setTimeout(rebuildVariantModel, 300)
})

watch(() => props.path, load, { immediate: true })
onBeforeUnmount(() => {
  loadVersion += 1
  variantLoadVersion += 1
  if (variantFilterTimer) clearTimeout(variantFilterTimer)
  revokeObjectUrl()
})

const viewerInput = computed<ViewerRenderInput | null>(() => {
  if (status.value !== 'success') return null

  if (activeTarget.value === 'featuremap' && tableData.value) {
    return bindSingleDataset('featuremap', datasetFromRows(
      fileName.value,
      tableData.value.rows,
      tableData.value.columns,
      'feature_table',
    ))
  }

  if (kind.value === 'table' && tableData.value
    && (renderTargets.value.length === 1 || activeTarget.value === 'table')) {
    return bindSingleDataset('table', datasetFromRows(
      fileName.value,
      tableData.value.rows,
      tableData.value.columns,
    ))
  }

  if (kind.value === 'media' && objectUrl.value) {
    return bindMedia(objectUrl.value, mediaMimeType(targetPath.value), fileName.value)
  }

  return null
})

/**
 * What the Backend said, when it said anything. `RUN_FILE_FETCH_FAILED` is not
 * a member of the Backend's closed `ErrorCode` enum -- it is a placeholder this
 * component invented before the envelope was readable, and it stands in only
 * when the failure carries no envelope of its own. A Workspace read never
 * reaches the Backend at all, so it gets a `workspace`-domain envelope with a
 * remedy the user can actually act on.
 */
const fetchError = computed<StructuredError>(() => {
  if (backendFailure.value) return backendFailure.value
  if (origin.value === 'workspace') {
    // Provenance splits the same read failure into two honest stories. A
    // Navigator-opened file that won't read is a real workspace file that went
    // missing — the generic remedy applies. An Agent-cited path that won't read
    // is more often a reference to a file the model never actually wrote, so the
    // remedy names that possibility instead of sending the user looking for a
    // "deleted" file that never existed.
    const cited = props.citedByAgent
    return {
      code: 'WORKSPACE_FILE_READ_FAILED',
      domain: 'workspace',
      message: cited
        ? t('workbench.fileDocument.workspaceErrorCitedMessage')
        : t('workbench.fileDocument.workspaceErrorMessage'),
      remedy: cited
        ? t('workbench.fileDocument.workspaceErrorCitedRemedy')
        : t('workbench.fileDocument.workspaceErrorRemedy'),
      retryable: true,
    }
  }
  return {
    code: 'RUN_FILE_FETCH_FAILED',
    domain: 'backend',
    message: t('workbench.fileDocument.fetchErrorMessage'),
    remedy: t('workbench.fileDocument.fetchErrorRemedy'),
    retryable: true,
  }
})

const dagFetchError = computed<StructuredError>(() => dagError.value ?? {
  code: 'WORKFLOW_DAG_FAILED',
  domain: 'run',
  message: t('workbench.fileDocument.dagFetchError.message'),
  remedy: t('workbench.fileDocument.dagFetchError.remedy'),
  retryable: true,
  ...(dagDiagnostic.value ? { details: { diagnostic: dagDiagnostic.value } } : {}),
})
</script>

<style scoped>
.file-document {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.file-document__header {
  flex: none;
  display: flex;
  align-items: center;
  height: calc(var(--row-h) + var(--space-2));
  padding: 0 var(--space-3);
  border-bottom: var(--line-w) solid var(--line-hairline);
  background: var(--color-bg-secondary);
}

.file-document__name {
  font-size: var(--text-md);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-document__spacer {
  flex: 1 1 auto;
}

.file-document__targets {
  display: flex;
  align-items: center;
  gap: 2px;
}

.file-document__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: var(--space-2);
}

.file-document__target {
  height: 28px;
  padding: 0 var(--space-2);
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.file-document__target.is-active {
  border-bottom-color: var(--color-success-text);
  color: var(--color-text);
}

.file-document__dag {
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
}

.file-document__fasta {
  width: 100%;
  min-width: 0;
}

.file-document__variants {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
}

.file-document__variants-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--line-w) solid var(--line-hairline);
}

.file-document__variants-filter {
  height: 28px;
  min-width: 24ch;
  padding: 0 var(--space-2);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
}

.file-document__variants-filter:focus-visible {
  outline: 2px solid var(--color-ring);
  outline-offset: -1px;
}

.file-document__msalign,
.file-document__featuremap {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
}


.file-document__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  padding: var(--space-3);
}

.file-document__loading {
  width: 100%;
}

.file-document__text {
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

.file-document__card {
  align-self: flex-start;
  width: 100%;
  max-width: 68ch;
  margin: 0 auto;
  padding: var(--space-4);
  background: var(--color-bg-secondary);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
}

.file-document__card-title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.file-document__card-description {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}

.file-document__meta {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-3) 0 0;
  font-size: var(--text-label);
}

.file-document__meta-row {
  display: grid;
  grid-template-columns: 8ch minmax(0, 1fr);
  gap: var(--space-2);
}

.file-document__meta-row dt {
  color: var(--color-text-muted);
}

.file-document__meta-row dd {
  margin: 0;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.file-document__meta-path {
  font-family: var(--font-mono);
}

.file-document__card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.file-document__card-hint {
  margin: var(--space-3) 0 0;
  font-size: var(--text-label);
  line-height: var(--text-sm-lh);
  color: var(--color-text-muted);
}
</style>
