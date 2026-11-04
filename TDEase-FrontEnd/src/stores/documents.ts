/**
 * documentStore — STUDIO-FRONTEND-BUSINESS-LOGIC.md §9.2.
 *
 * Owns every open document, the active document, the tab lifecycle
 * (preview / open / pinned) and the single subview-override slot. One
 * projection function, one override slot — components read this store,
 * they never each decide what to show.
 *
 * `DocumentKey` and `OpenDocument` are defined in `studio/domain/document.ts`
 * and used as-is here, not redefined.
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { DocumentKey, OpenDocument } from '@/studio/domain/document'
import { defaultDocumentSubview, type DocumentSubview } from '@/studio/projections/document-projection'
import { asRelativePath, asRunId, asWorkspaceId } from '@/studio/domain/identity'
import type { RunFileEntry } from '@/studio/ports/backend-gateway'
import { createLocalUiStateRepository } from '@/services/storage/uiStateRepository'
import { studioInfrastructure } from '@/services/backend/studioInfrastructure'
import { desktopResultCache } from '@/services/storage/resultCacheStorage'
import { getViewsFS } from '@/services/workspace/views-fs'
import { workspaceFilePath } from '@/services/workspace/workspaceAddress'
import type { BackendGateway } from '@/studio/ports/backend-gateway'
import type { PublishedResult, ResultRef } from '@/studio/domain/result'
import type { ResultCache, ResultResource } from '@/studio/ports/result-cache'
import { projectResultAvailability, type ResultAvailability } from '@/studio/projections/result-availability'
import {
  branch as branchNode,
  groupLeaf,
  groupIdsOf as treeGroupIds,
  isGroupInTree as treeHasGroup,
  parentBranchOf as treeParentBranch,
  removeLeaf as treeRemoveLeaf,
  replaceLeaf as treeReplaceLeaf,
  replaceNode as treeReplaceNode,
  type LayoutNode,
} from './editorLayout'
import { useWorkspaceStore } from './workspace'
import { useUiLayoutStore } from './uiLayout'
import { DesktopWorkspaceRepository } from '@/services/workspace/studioWorkspaceRepository'
import { DEFAULT_SNAPSHOT_SELECTION, prepareAnalysis } from '@/studio/use-cases/prepare-analysis'
import { dryRunAnalysis } from '@/studio/use-cases/dry-run-analysis'
import { PlanRegistry } from '@/studio/runtime/plan-registry'
import type { DryRunProjection } from '@/studio/ports/backend-gateway'

const repository = createLocalUiStateRepository()

/**
 * One editor group's own tab stack (VSCode model). Groups are the leaves of
 * `LayoutNode`; the same document id may be open in several groups at once.
 */
export interface EditorGroupState {
  id: string
  /** Document ids in strip order. */
  tabs: string[]
  activeId: string | null
}

/**
 * Resolved per call, never cached at module scope: `studioInfrastructure()`
 * is keyed on the current client, so calling it fresh is what makes a client
 * swap (`initializeTDEaseClient()`) take effect here. The assembly of the
 * gateway itself -- which client, which actor, whether it may submit -- is
 * not this store's decision; see `services/studioInfrastructure.ts`.
 */
function backendGateway(): BackendGateway {
  return studioInfrastructure().gateway
}

/**
 * The `run-files/` convention — the single id↔key boundary for Backend Run
 * files.
 *
 * Run files live under the Backend's `runs/<run_id>/` directory (AGENTS.md's
 * three-tier data layout), never inside the Workspace, so they key as
 * `DocumentKey`'s explicit `runFile` variant (`studio/domain/document.ts`).
 * `documentId` serializes that variant with a `run-files/<runId>/<path>`
 * segment — `encodeRunFilePath` — and `normalizeRestoredKey` reads it back —
 * `decodeRunFilePath`. Nothing else in the store or any component may create
 * or parse the prefix: identity is the variant, the prefix is only its
 * persisted spelling.
 *
 * The prefix is `run-files/`, not `runs/`, because the Workspace now
 * genuinely contains a top-level `runs/<run-name>/` directory (user-authored
 * run drafts, flat layout — see FILE-LAYOUT.md §4). Using `runs/` here would
 * collide with that real directory and make `decodeRunFilePath` misread a
 * Workspace path like `runs/chlamy-h4/Snakefile` as "Backend run chlamy-h4's
 * file Snakefile". `run-files/` is a virtual namespace that never exists on
 * disk, so the two cannot collide.
 */
const RUN_FILE_PREFIX = 'run-files/'

function encodeRunFilePath(runId: string, path: string): string {
  return `${RUN_FILE_PREFIX}${runId}/${path}`
}

interface DecodedRunFilePath {
  runId: string
  path: string
}

function decodeRunFilePath(path: string): DecodedRunFilePath | null {
  if (!path.startsWith(RUN_FILE_PREFIX)) return null
  const rest = path.slice(RUN_FILE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  return { runId: rest.slice(0, slash), path: rest.slice(slash + 1) }
}

/**
 * The one id→key normalization. Keys are never BORN with the prefix —
 * `openRunFile` constructs the `runFile` variant directly — so a `file` key
 * whose path carries it can only come from persistence (or another external
 * id) written before the variant existed. Restoring rewrites it to the
 * variant; `documentId` spells both shapes identically, so the stored id
 * stays valid and the tab, its MRU entry and its group slot survive.
 */
function normalizeRestoredKey(key: DocumentKey): DocumentKey {
  if (key.kind !== 'file') return key
  const decoded = decodeRunFilePath(key.path)
  if (!decoded) return key
  return {
    kind: 'runFile',
    workspaceId: key.workspaceId,
    runId: asRunId(decoded.runId),
    path: asRelativePath(decoded.path),
  }
}

export function workspaceWorkflowScope(path: string) {
  const normalized = path.replaceAll('\\', '/')
  const match = /^(runs\/[^/]+)\/Snakefile$/.exec(normalized)
  if (!match) throw new Error('Workflow documents must be runs/<run>/Snakefile')
  return match[1]
}

/** Canonical id for a DocumentKey — stable, collision-free; used for tabs, MRU and persistence. */
export function documentId(key: DocumentKey): string {
  switch (key.kind) {
    case 'run-index': return `run-index:${key.workspaceId}`
    case 'run': return `run:${key.runId}`
    case 'result': return `result:${key.ref.workspaceId}:${key.ref.runId}:${key.ref.resultId}:${key.ref.digest}`
    case 'file': return `file:${key.workspaceId}:${key.path}`
    // The runFile variant spells the exact string the former file-path
    // encoding produced, so persisted tab ids, MRU entries and group layouts
    // written before the variant existed keep resolving to the same document.
    case 'runFile': return `file:${key.workspaceId}:${encodeRunFilePath(key.runId, key.path)}`
    case 'wiki': return `wiki:${key.scope}:${key.page}`
    case 'wiki-index': return 'wiki-index'
    case 'analysis-review': return `analysis-review:${key.planRef}`
    // Not Workspace-scoped: providers, credentials and MCP servers are
    // application-wide, and the key carries no section, so there is exactly
    // one Settings tab.
    case 'settings': return 'settings'
  }
}

/**
 * §9.2 rule 2: a document keyed on a session-scoped handle (a `planRef` that
 * expires with the session it was prepared in) is dropped on restore, never
 * restored broken.
 */
function isSessionScoped(key: DocumentKey): boolean {
  return key.kind === 'analysis-review'
}

function isRestorableDocument(value: unknown, workspaceId: string): value is OpenDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<OpenDocument>
  if (!doc.key || typeof doc.key !== 'object' || typeof doc.id !== 'string'
    || typeof doc.title !== 'string' || typeof doc.pinned !== 'boolean'
    || typeof doc.lastActiveAt !== 'number' || !Number.isFinite(doc.lastActiveAt)) return false

  const key = doc.key as Record<string, unknown>
  switch (key.kind) {
    case 'run-index':
    case 'file':
    case 'runFile':
      if (key.workspaceId !== workspaceId) return false
      break
    case 'result': {
      const ref = key.ref as Record<string, unknown> | undefined
      if (!ref || ref.workspaceId !== workspaceId) return false
      break
    }
    case 'run':
    case 'wiki':
    case 'wiki-index':
    case 'settings':
    case 'analysis-review':
      break
    default:
      return false
  }

  try {
    return documentId(doc.key as DocumentKey) === doc.id
  } catch {
    return false
  }
}

/**
 * Everything `ResultDocument.vue` needs to render the frame **before** any
 * bytes move — ("opening is transparent and creates
 * nothing"), CORE-ARCHITECTURE.md §3.2-§3.4.
 *
 * `availability` is the four-state projection from
 * `studio/projections/result-availability.ts`, not the three-state one
 * `ResultCache.availability()` returns. The difference is the fourth state:
 * `ResultCache` only knows the local cache, so it can say `remote` about a
 * digest the Backend no longer publishes. Joining its answer with the
 * Published Result projection is what turns that case into `unavailable`,
 * which §3.4 insists is "not an error to be papered over".
 */
export interface ResultOverview {
  ref: ResultRef
  availability: ResultAvailability
  /** The Published Result this exact `ResultRef` names, when it is still published. */
  published: PublishedResult | null
  /**
   * §3.4's `superseded` reason, made concrete: the digest the same `resultId`
   * currently carries, when this reference pins one that is no longer it.
   * Null when the result was never published at all — a different sentence.
   */
  supersededBy: string | null
  /**
   * True when this build has no local Result cache to consult (the Electron
   * `result-cache:*` bridge is absent — a browser dev server, a test). The
   * availability facts are then all false, which projects to `remote`; that is
   * literally true, but the document says so rather than implying a cache hit
   * is merely cold.
   */
  cacheUnavailable: boolean
}

export type { LayoutNode } from './editorLayout'

/**
 * The Settings document's sections. The section is VIEW state, not identity
 * (`DocumentKey`'s settings variant carries no section — §5.7), so a palette
 * request for a specific section travels as this one-shot ref: `openSettings`
 * seeds it, `SettingsDocument` consumes it on its next activation. A section-
 * less `openSettings` (the side-bar button) clears it — the request never
 * outlives the interaction that made it.
 */
export type SettingsSectionId =
  | 'general' | 'providers' | 'mcp' | 'statistics'
  | 'permissions' | 'agent-tools' | 'sharing' | 'appearance'

export const useDocumentsStore = defineStore('documents', () => {
  const openDocuments = ref<OpenDocument[]>([])
  const previewDocumentId = ref<string | null>(null)
  /** Most-recently-used order, newest first. Drives `Ctrl+Tab`. */
  const mru = ref<string[]>([])
  const subviewOverride = ref<DocumentSubview | null>(null)
  /** One-shot "open Settings focused on this section" request (see type). */
  const requestedSettingsSection = ref<SettingsSectionId | null>(null)

  // --- Editor groups (the VSCode model): every group owns its own tab
  // stack, and the group area is a recursive BINARY layout tree — a leaf
  // names a group, a branch is an orientation + two children + the first
  // child's size ratio. Splitting replaces a leaf with a branch, so any
  // group can split again in any direction; closing rebalances the tree.
  // This replaces the old "one shared tab list + two viewpoints" split: with
  // shared tabs there was no per-group ownership, no arbitrary nesting, and
  // no tab to drag anywhere — the surface looked like VSCode and did not
  // behave like it. ---
  const groups = ref<Record<string, EditorGroupState>>({})
  // The surface boots with ONE empty group — the Welcome guide's home and
  // the landing spot for the first open(). reset() rebuilds this state.
  const layoutRoot = ref<LayoutNode>({ kind: 'group', id: 'group-1' })
  groups.value['group-1'] = { id: 'group-1', tabs: [], activeId: null }
  const focusedGroupId = ref<string | null>('group-1')
  let nextGroupSeq = 2

  let boundWorkspaceId: string | null = null
  let suspendPersist = false

  // ── Group-tree state ─────────────────────────────────────────────────
  // The tree itself is a pure module (`./editorLayout`): the type, the
  // query/rebalancing primitives and the invariants live there. This store
  // owns the reactive root, the group records and every side effect
  // (persist, focus fallback) that composes those primitives.

  function newGroupId(): string {
    return `group-${nextGroupSeq++}`
  }

  function makeGroup(tabs: string[] = [], activeId: string | null = null): EditorGroupState {
    const id = newGroupId()
    groups.value[id] = { id, tabs, activeId: activeId ?? tabs[0] ?? null }
    return groups.value[id]!
  }

  function groupOf(groupId: string): EditorGroupState | null {
    return groups.value[groupId] ?? null
  }

  /** Delete group records not present in the tree (after pruning). */
  function sweepOrphanGroups(): void {
    const live = new Set(treeGroupIds(layoutRoot.value))
    for (const id of Object.keys(groups.value)) {
      if (!live.has(id)) delete groups.value[id]
    }
  }

  /** The focused group, guaranteed — falls back to the first leaf. */
  function ensureFocusedGroup(): EditorGroupState {
    const ids = treeGroupIds(layoutRoot.value)
    if (!focusedGroupId.value || !ids.includes(focusedGroupId.value)) {
      focusedGroupId.value = ids[0]!
    }
    return groups.value[focusedGroupId.value]!
  }

  function activateInGroup(groupId: string, id: string): void {
    const group = groupOf(groupId)
    if (!group || !group.tabs.includes(id)) return
    group.activeId = id
    subviewOverride.value = null
    touchMru(id)
  }

  const activeDocumentId = computed<string | null>(() => {
    const group = focusedGroupId.value ? groupOf(focusedGroupId.value) : null
    return group?.activeId ?? null
  })

  const activeDocument = computed<OpenDocument | null>(() =>
    openDocuments.value.find((doc) => doc.id === activeDocumentId.value) ?? null)

  const activeKey = computed<DocumentKey | null>(() => activeDocument.value?.key ?? null)

  const defaultSubview = computed<DocumentSubview | null>(() =>
    activeKey.value ? defaultDocumentSubview(activeKey.value) : null)

  /** §5.4's no-steal rule: the effective subview is the user's override,
   * else the pure projection from the active document's kind — never a
   * status-driven jump once the document is open. */
  const activeSubview = computed<DocumentSubview | null>(() => subviewOverride.value ?? defaultSubview.value)

  function tierOf(doc: OpenDocument): 'pinned' | 'preview' | 'open' {
    if (doc.pinned) return 'pinned'
    if (doc.id === previewDocumentId.value) return 'preview'
    return 'open'
  }

  function touchMru(id: string) {
    mru.value = [id, ...mru.value.filter((existing) => existing !== id)]
  }

  /**
   * Opens (or refocuses) a document.
   *
   * `preview: true` (the default) creates or reuses the single preview slot
   * — a second preview replaces the first rather than accumulating a new
   * tab (§5.2). `preview: false` creates, or promotes an existing preview
   * into, an Open-tier tab. A `pinned: true` open is never a preview.
   */
  function open(key: DocumentKey, options: { title: string; preview?: boolean; pinned?: boolean; background?: boolean }): string {
    const id = documentId(key)
    // A background open (the Agent with Follow off) must not disturb what the
    // user is reading: it never takes focus and never recycles the preview
    // slot (replacing a preview the user is looking at would still yank it).
    const preview = options.pinned || options.background ? false : (options.preview ?? true)
    const existing = openDocuments.value.find((doc) => doc.id === id)

    if (existing) {
      existing.title = options.title
      if (options.pinned) existing.pinned = true
      if (!preview && previewDocumentId.value === id) previewDocumentId.value = null
      if (options.background) return id
      existing.lastActiveAt = Date.now()
      select(id)
      return id
    }

    if (preview && previewDocumentId.value) {
      const previousPreviewId = previewDocumentId.value
      const previousPreview = openDocuments.value.find((doc) => doc.id === previousPreviewId)
      if (previousPreview && !previousPreview.pinned) {
        openDocuments.value = openDocuments.value.filter((doc) => doc.id !== previousPreviewId)
        mru.value = mru.value.filter((existing2) => existing2 !== previousPreviewId)
        removeTabEverywhere(previousPreviewId)
      }
      previewDocumentId.value = null
    }

    const doc: OpenDocument = {
      key, id, title: options.title, pinned: options.pinned ?? false, dirty: false, lastActiveAt: Date.now(),
    }
    openDocuments.value = [...openDocuments.value, doc]
    if (preview) previewDocumentId.value = id
    if (options.background) {
      const group = ensureFocusedGroup()
      group.tabs = [...group.tabs, id]
      if (!group.activeId) group.activeId = id
      return id
    }
    select(id)
    return id
  }

  function openRunIndex(workspaceId: string, title = 'Runs') {
    return open({ kind: 'run-index', workspaceId: asWorkspaceId(workspaceId) }, { title, preview: false })
  }

  function openRun(runId: string, options: { title?: string; preview?: boolean } = {}) {
    return open(
      { kind: 'run', runId: asRunId(runId) },
      { title: options.title ?? runId.slice(0, 10), preview: options.preview ?? true },
    )
  }

  /**
   * Opens the single Settings document. Never a
   * preview tab: Settings is entered deliberately and edited, so it must not
   * be evicted by the next single click in the Navigator. A `section` focuses
   * the named section on activation (the palette's per-section entries);
   * omitting it clears any pending request so the plain button never lands
   * the user on a stale section.
   */
  function openSettings(title = 'Settings', section?: SettingsSectionId) {
    requestedSettingsSection.value = section ?? null
    // The Settings document lives on the Workbench page; every entry point
    // (palette, the Agent page's credential-strip action, the rail button)
    // must actually SHOW it — opening a surface the user cannot see is a
    // broken open, so the hosting page takes focus unconditionally.
    useUiLayoutStore().setActivePage('workbench')
    return open({ kind: 'settings' }, { title, preview: false })
  }

  /**
   * Lists a Run's files (results and other artifacts) through the same
   * `TDEaseBackendGateway` the Run surface already uses. This is the flat
   * file listing, not the Published Result projection: `listResults` is
   * implemented (see `describeResult` below) but `listTechnicalArtifacts`
   * still throws `UnsupportedBackendCapabilityError`, so a Run's *other*
   * files are only reachable through here — the Run Document's
   * Files/Artifacts body calls it with the widest pattern rather than the
   * `results/**` default.
   */
  async function listRunFiles(
    runId: string,
    pattern = 'results/**',
    revision?: string,
    includeWorkflow = false,
  ): Promise<ReadonlyArray<RunFileEntry>> {
    return backendGateway().listRunFiles(asRunId(runId), pattern, revision, includeWorkflow)
  }

  async function listRunRevisions(runId: string) {
    return backendGateway().listRunRevisions(asRunId(runId))
  }

  async function getRunGraph(runId: string) {
    return backendGateway().getRunGraph(asRunId(runId))
  }

  /** Bounded execution-log tail for the Run document's inline log section. */
  async function getRunLog(runId: string, tail = 400) {
    return backendGateway().readLog(asRunId(runId), tail)
  }

  function subscribeRunEvents(runId: string, listener: Parameters<ReturnType<typeof backendGateway>['subscribeRun']>[2]) {
    return studioInfrastructure().runSubscriptions.subscribe(asRunId(runId), 0, listener)
  }

  /** Bytes for one Run file, for `FileDocument.vue` — never fetched by a component directly. */
  async function fetchRunFile(runId: string, path: string, revision?: string): Promise<Blob> {
    return backendGateway().fetchRunFile(asRunId(runId), asRelativePath(path), revision)
  }

  /**
   * Bytes for one **Workspace** file, the counterpart of `fetchRunFile`.
   *
   * A Workspace file is user-owned and on disk (`FILE-LAYOUT.md`), so it does
   * not go through the Backend at all — it resolves through the views
   * filesystem adapter, which is the same adapter Canvas definitions and view
   * specs already read through. Returned as a `Blob` so `FileDocument.vue` has
   * ONE code path for bytes regardless of where they came from; §5.2's rule is
   * that a viewer "cannot tell whether bytes came from disk or cache, and must
   * not care", and that applies to the document frame too.
   *
   * The adapter returns raw bytes, so image and text readers share one Blob
   * boundary without decoding binary content in the renderer.
   */
  async function readWorkspaceFile(path: string): Promise<Blob> {
    const root = workspaceStore.workspacePath
    if (!root) throw new Error('No Workspace is attached')
    return getViewsFS().readBlob(workspaceFilePath(root, path))
  }

  /**
   * Random-access byte range of a Workspace file — how the mzML preview
   * streams and slices multi-GB files without ever holding one whole in the
   * renderer. `null` when the active adapter cannot range-read.
   */
  async function readWorkspaceByteRange(path: string, start: number, end: number): Promise<Uint8Array | null> {
    const root = workspaceStore.workspacePath
    if (!root) throw new Error('No Workspace is attached')
    return getViewsFS().readByteRange(workspaceFilePath(root, path), start, end)
  }

  async function projectWorkspaceWorkflow(path: string): Promise<DryRunProjection> {
    const workspaceRoot = workspaceStore.workspacePath
    const workspaceId = workspaceStore.workspaceId
    if (!workspaceRoot || !workspaceId) throw new Error('No Workspace is attached')
    const runPath = workspaceWorkflowScope(path)
    const infrastructure = studioInfrastructure()
    const backend = infrastructure.workspaceGateway(workspaceRoot)
    const registry = new PlanRegistry()
    const deployedNodes = await backend.listNodes()
    const prepared = await prepareAnalysis({
      runPath,
      managedNodes: deployedNodes.map((node) => ({ id: node.id, rules: [] })),
    }, {
      backend,
      workspace: new DesktopWorkspaceRepository({
        id: asWorkspaceId(workspaceId),
        name: workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? workspaceId,
      }, workspaceRoot),
      registry,
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION,
    })
    try {
      const validated = await dryRunAnalysis(prepared.ref, backend, registry)
      if (!validated.dryRun?.valid) throw new Error(validated.dryRun?.output || 'Snakemake dry-run failed')
      if (!validated.dryRun.nativeProjection) throw new Error('Backend returned no native Snakemake projection')
      return validated.dryRun.nativeProjection
    } finally {
      registry.discard(prepared.ref)
    }
  }

  /**
   * The Published Result cache for the attached Workspace.
   *
   * `services/resultCacheStorage.ts`'s module doc names this call site
   * precisely: `desktopResultCache()` is the one composition point that turns
   * `studioInfrastructure()` plus the two Electron storages into a working
   * `ResultCache`, and until this function existed nothing in the product
   * called `ResultCache.open()` at all.
   *
   * Resolved per call for the same reason `backendGateway()` above is: the
   * Workspace root can change under a running session, and a module-scope
   * cache would keep writing into the previous one.
   */
  function resultCache(): ResultCache {
    const root = workspaceStore.workspacePath
    if (!root) throw new Error('No Workspace is attached')
    return desktopResultCache(root)
  }

  /**
   * The frame facts for one `ResultRef`, without fetching a single byte.
   *
   * Both readings of `ResultRef` (CORE-ARCHITECTURE.md §3.2) are answered
   * here from one `listResults` call:
   *
   *   - *exactly this value* (the pinned reading, what `ResultRef.digest`
   *     carries today) is `published` — the entry matching id **and** digest.
   *   - *the current value of this result* (the unpinned reading) is the entry
   *     matching the id alone. When the two disagree, the reference is pinned
   *     to a superseded value, and `supersededBy` names what replaced it.
   *
   * The Client's `ResultRef` requires a digest (`studio/domain/result.ts`),
   * so an unpinned reference cannot yet be *represented*; what this function
   * can do — and does — is refuse to let a pinned one silently read as
   * current.
   */
  async function describeResult(ref: ResultRef): Promise<ResultOverview> {
    const declared = await backendGateway().listResults(ref.runId)
    const published = declared.find(
      (entry) => entry.ref.resultId === ref.resultId && entry.ref.digest === ref.digest,
    ) ?? null
    const current = declared.find((entry) => entry.ref.resultId === ref.resultId) ?? null

    let cached: 'remote' | 'cached' | 'conflict' = 'remote'
    let cacheUnavailable = false
    if (published) {
      try {
        cached = await resultCache().availability(ref)
      } catch {
        // No local cache in this build. Not a failure of the Result: the
        // bytes are still fetchable, they just will not be cached, and the
        // document says which of those two it is.
        cacheUnavailable = true
      }
    }

    return {
      ref,
      availability: projectResultAvailability({
        published: Boolean(published),
        cachedDigestMatches: cached === 'cached',
        cachedDigestConflicts: cached === 'conflict',
      }),
      published,
      supersededBy: published || !current ? null : current.ref.digest,
      cacheUnavailable,
    }
  }

  /**
   * The bytes for one Published Result — the counterpart of `fetchRunFile`
   * and `readWorkspaceFile`, and the first `ResultCache.open()` call in the
   * product.
   *
   * Opening creates nothing the user owns (§5.5): the cache may write into
   * TDEase's own store under Electron's userData, never into the Workspace.
   * `materializeResult` below is the only thing that writes a Workspace file.
   */
  async function openResultContent(ref: ResultRef): Promise<ResultResource> {
    return resultCache().open(ref)
  }

  /**
   * §5.5's single explicit act: write this Result's bytes to `destination`
   * inside the Workspace. Conflict policy is `services/fileTransfer.ts`'s
   * `canOverwrite`, applied inside `PublishedResultCache.materialize` — an
   * identical digest is a no-op, a different one throws rather than
   * overwriting the user's file.
   */
  async function materializeResult(ref: ResultRef, destination: string): Promise<void> {
    await resultCache().materialize(ref, asRelativePath(destination))
  }

  /**
   * Drops the local cache entry for a Result. The remedy for a `conflict`:
   * cache eviction "can never make a Result wrong, only slower"
   * (CORE-ARCHITECTURE.md §3.3), so re-opening after this refetches.
   */
  async function evictResult(ref: ResultRef): Promise<void> {
    await resultCache().evict(ref)
  }

  /**
   * Opens a Published Result as its own document (§5.1, §5.5).
   *
   * The title defaults to the `resultId` rather than the Result's `name`,
   * because the tab must exist before `listResults` has answered — a caller
   * that already holds a `PublishedResult` should pass its `title`.
   */
  function openResult(ref: ResultRef, options: { title?: string; preview?: boolean } = {}): string {
    return open(
      { kind: 'result', ref },
      { title: options.title ?? ref.resultId, preview: options.preview ?? true },
    )
  }

  /**
   * Opens a Run's file as its explicit `runFile` document (§5.1, §5.6). The
   * Run Document's Files/Artifacts listing is the only caller. The key names
   * the Run directly; the `run-files/` spelling exists only where `documentId`
   * serializes the key for persistence.
   */
  function openRunFile(runId: string, path: string, options: { title?: string; preview?: boolean } = {}): string {
    const workspaceId = workspaceStore.workspaceId
    if (!workspaceId) throw new Error('No Workspace is attached to the Run surface')
    const title = options.title ?? path.split('/').pop() ?? path
    return open(
      {
        kind: 'runFile',
        workspaceId: asWorkspaceId(workspaceId),
        runId: asRunId(runId),
        path: asRelativePath(path),
      },
      { title, preview: options.preview ?? true },
    )
  }

  /**
   * Opens one wiki page. Every entrance shares this: the index tab, the
   * Navigator's Wiki section, the Files tree (through `openWorkspaceFile`'s
   * role dispatch), and a wikilink click inside a rendered page.
   */
  function openWiki(
    scope: 'system' | 'workspace',
    page: string,
    options: { title?: string; preview?: boolean } = {},
  ): string {
    const normalized = page.replaceAll('\\', '/')
    const title = options.title ?? normalized.split('/').pop()?.replace(/\.md$/i, '') ?? normalized
    return open(
      { kind: 'wiki', scope, page: normalized },
      { title, preview: options.preview ?? true },
    )
  }

  /** Opens the wiki index — both scopes listed and searched. Never a preview. */
  function openWikiIndex(title = 'Wiki') {
    return open({ kind: 'wiki-index' }, { title, preview: false })
  }

  /**
   * Opens a **Workspace** file. The Navigator's Files section is the
   * caller; `openRunFile` above is the unrelated Run-directory entrance.
   *
   * Role-first dispatch, per §3.1.1's table:
   *
   *   - a page under `wiki/` → a wiki document (rendered markdown, or
   *     verbatim text for .txt), not the generic file viewer.
   *   - everything else → a `file` document, dispatched on type by §5.6.
   *
   * Workflow files deliberately retain the `file` identity:
   * `FileDocument` performs role-first dispatch and exposes their rendered and
   * Source targets in one restorable tab.
   */
  function openWorkspaceFile(
    path: string,
    options: { title?: string; preview?: boolean; background?: boolean } = {},
  ): string {
    const normalized = path.replaceAll('\\', '/')

    // Role-first dispatch: a page under `wiki/` is a wiki document (rendered
    // markdown, or verbatim text for .txt), not the generic file viewer.
    const WIKI_PREFIX = 'wiki/'
    if (normalized.startsWith(WIKI_PREFIX) && /\.(?:md|txt)$/i.test(normalized)) {
      return openWiki('workspace', normalized.slice(WIKI_PREFIX.length), options)
    }

    const workspaceId = workspaceStore.workspaceId
    if (!workspaceId) throw new Error('No Workspace is open')
    const title = options.title ?? normalized.split('/').pop() ?? normalized
    return open(
      { kind: 'file', workspaceId: asWorkspaceId(workspaceId), path: asRelativePath(normalized) },
      { title, preview: options.preview ?? false, background: options.background },
    )
  }

  /**
   * Activate a document. Open in some group → activate it THERE and focus
   * that group (VSCode's "reveal"); not open → append into the focused
   * group. This one rule serves tab clicks (per-group strips call
   * `activateInGroup` directly), the overflow menu, and Ctrl+Tab alike.
   */
  function select(id: string) {
    if (!openDocuments.value.some((doc) => doc.id === id)) return
    const owner = Object.values(groups.value).find((group) => group.tabs.includes(id))
    if (owner) {
      activateInGroup(owner.id, id)
      if (treeHasGroup(layoutRoot.value, owner.id)) focusedGroupId.value = owner.id
      return
    }
    const group = ensureFocusedGroup()
    group.tabs = [...group.tabs, id]
    group.activeId = id
    subviewOverride.value = null
    touchMru(id)
  }

  /** Strip click in one group's own tab bar: aim THAT group, focus it. */
  function activateInGroupAndFocus(groupId: string, id: string) {
    activateInGroup(groupId, id)
    focusedGroupId.value = groupId
  }

  /** Focus a group without changing its selection (clicking the surface). */
  function focusGroup(groupId: string) {
    if (treeHasGroup(layoutRoot.value, groupId)) focusedGroupId.value = groupId
  }

  /** Which group holds this tab, if any. */
  function groupContaining(id: string): EditorGroupState | null {
    return Object.values(groups.value).find((group) => group.tabs.includes(id)) ?? null
  }

  /**
   * The group a drag starts from: the group named by the drag payload when
   * it actually holds the tab, else the first holder. The explicit name
   * matters because a cloned document can live in two groups at once — the
   * first-holder scan would then steal the tab from the wrong strip.
   */
  function dragSourceGroup(id: string, fromGroupId?: string): EditorGroupState | null {
    const named = fromGroupId ? groupOf(fromGroupId) : null
    if (named && named.tabs.includes(id)) return named
    return groupContaining(id)
  }

  /** Remove a tab id from every group; groups left empty are pruned from the
   *  tree (the sibling absorbs the space) and their records swept. The last
   *  remaining group always survives — even empty — so the surface has a
   *  place for the Welcome state and the next open(). */
  function removeTabEverywhere(id: string): void {
    for (const group of Object.values(groups.value)) {
      if (!group.tabs.includes(id)) continue
      group.tabs = group.tabs.filter((tab) => tab !== id)
      if (group.activeId === id) group.activeId = group.tabs[group.tabs.length - 1] ?? null
    }
    pruneEmptyGroups()
  }

  function pruneEmptyGroups(): void {
    let root = layoutRoot.value
    if (!root) return
    const empty = treeGroupIds(root).filter((groupId) => (groups.value[groupId]?.tabs.length ?? 0) === 0)
    for (const groupId of empty) {
      const survivors = treeGroupIds(root).filter((id) => id !== groupId)
      if (survivors.length === 0) break // never prune the last group
      const nextRoot = treeRemoveLeaf(root, groupId)
      if (!nextRoot) break
      root = nextRoot
      layoutRoot.value = nextRoot
      delete groups.value[groupId]
      if (focusedGroupId.value === groupId) focusedGroupId.value = null
    }
    sweepOrphanGroups()
    ensureFocusedGroup()
  }

  /**
   * Split the FOCUSED group: its leaf becomes a branch whose new leaf clones
   * the group's active document (VSCode's Split Right/Down). No active
   * document, no split. Focus follows the new group, so the next open()
   * lands there.
   */
  function splitFocusedGroup(orientation: 'horizontal' | 'vertical'): string | null {
    const source = ensureFocusedGroup()
    const activeId = source.activeId
    if (!activeId) return null
    // A split changes the geometry the maximize is showing — VSCode exits the
    // maximized state rather than splitting into a hidden group.
    maximizedGroupId.value = null
    const clone = makeGroup([activeId], activeId)
    layoutRoot.value = treeReplaceLeaf(
      layoutRoot.value,
      source.id,
      branchNode(orientation, groupLeaf(source.id), groupLeaf(clone.id)),
    )
    focusedGroupId.value = clone.id
    touchMru(activeId)
    return clone.id
  }

  /**
   * Group maximize (VSCode's grid.maximizeView): the layout tree is untouched
   * and a maximized leaf simply renders alone at full size; a second toggle
   * (or closing/splitting) restores the tree. Runtime state only — like
   * VSCode, maximize is not persisted.
   */
  const maximizedGroupId = ref<string | null>(null)

  function toggleGroupMaximized(groupId: string): void {
    if (treeGroupIds(layoutRoot.value).length < 2) {
      maximizedGroupId.value = null
      return
    }
    maximizedGroupId.value = maximizedGroupId.value === groupId ? null : groupId
  }

  /**
   * Close a group. Tabs that also live in another group keep existing there;
   * tabs unique to this group are closed (a dirty unique tab refuses with
   * `false`, same contract as `close`). The tree rebalances: the sibling
   * absorbs the group's space.
   */
  function closeGroup(groupId: string, options: { force?: boolean } = {}): boolean {
    const group = groupOf(groupId)
    if (!group || !treeHasGroup(layoutRoot.value, groupId)) return true
    const unique = group.tabs.filter(
      (tab) => Object.values(groups.value).filter((g) => g.tabs.includes(tab)).length === 1,
    )
    const dirtyUnique = unique.some((tab) => openDocuments.value.find((doc) => doc.id === tab)?.dirty)
    if (dirtyUnique && !options.force) return false
    // Close unique tabs first (close() → removeTabEverywhere prunes empty
    // groups, which would otherwise rebalance mid-loop), then drop the leaf.
    for (const tab of unique) close(tab, { force: true })
    if (treeHasGroup(layoutRoot.value, groupId)) {
      // Removing the last group's leaf rebuilds one empty group — the
      // surface never goes blank and the next open() has a home.
      if (maximizedGroupId.value === groupId) maximizedGroupId.value = null
      layoutRoot.value = treeRemoveLeaf(layoutRoot.value, groupId)
        ?? { kind: 'group', id: makeGroup([], null).id }
      delete groups.value[groupId]
      sweepOrphanGroups()
      ensureFocusedGroup()
    }
    return true
  }

  /** Rotate the focused group's split parent (the VSCode orientation toggle,
   *  now scoped to the branch the group actually lives in). */
  function rotateFocusedBranch(): void {
    const focused = focusedGroupId.value
    if (!focused || !layoutRoot.value) return
    const branch = treeParentBranch(layoutRoot.value, focused)
    if (!branch) return
    layoutRoot.value = treeReplaceNode(
      layoutRoot.value,
      branch,
      { ...branch, orientation: branch.orientation === 'horizontal' ? 'vertical' : 'horizontal' },
    )
  }

  /** Sash drag: persist a branch's first-child ratio. */
  function setBranchRatio(branch: Extract<LayoutNode, { kind: 'branch' }>, ratio: number): void {
    branch.ratio = Math.min(0.85, Math.max(0.15, ratio))
    layoutRoot.value = { ...layoutRoot.value }
  }

  // ── Tab moves (the drag-and-drop surface) ─────────────────────────────────

  /** Move a tab into a group at `index` (default: append). A source group
   *  left empty is pruned; dropping a group's only tab onto itself is a
   *  no-op. `copy` clones the tab into the target and leaves the source
   *  group untouched (the Ctrl-drop modifier; a copy onto the tab's own
   *  group is a no-op). Returns true when the layout changed. */
  function moveTab(tabId: string, toGroupId: string, index?: number, fromGroupId?: string, options: { copy?: boolean } = {}): boolean {
    const source = dragSourceGroup(tabId, fromGroupId)
    const target = groupOf(toGroupId)
    if (!target || !treeHasGroup(layoutRoot.value, toGroupId)) return false
    if (source && source.id === toGroupId) return false
    if (source && !options.copy) {
      const from = source.tabs.indexOf(tabId)
      source.tabs = source.tabs.filter((tab) => tab !== tabId)
      if (source.activeId === tabId) source.activeId = source.tabs[Math.min(from, source.tabs.length - 1)] ?? null
    }
    const insertAt = Math.max(0, Math.min(index ?? target.tabs.length, target.tabs.length))
    const next = target.tabs.filter((tab) => tab !== tabId)
    next.splice(insertAt, 0, tabId)
    target.tabs = next
    target.activeId = tabId
    subviewOverride.value = null
    touchMru(tabId)
    if (!options.copy) pruneEmptyGroups()
    focusedGroupId.value = target.id
    return true
  }

  /**
   * Move a tab into a NEW group split off `anchorGroupId` on one side
   * (the drop-at-edge gesture). The anchor's leaf becomes a branch; the tab
   * leaves its old group, which is pruned if that empties it. `copy` adds
   * the new group WITHOUT pulling the tab out of its source group.
   */
  function moveTabToSplit(tabId: string, anchorGroupId: string, orientation: 'horizontal' | 'vertical', side: 'before' | 'after', fromGroupId?: string, options: { copy?: boolean } = {}): boolean {
    const anchor = groupOf(anchorGroupId)
    if (!anchor || !treeHasGroup(layoutRoot.value, anchorGroupId)) return false
    const source = dragSourceGroup(tabId, fromGroupId)
    if (source && source.id === anchorGroupId && source.tabs.length === 1) return false
    const moved = makeGroup([tabId], tabId)
    const anchorLeaf = groupLeaf(anchor.id)
    const movedLeaf = groupLeaf(moved.id)
    layoutRoot.value = treeReplaceLeaf(
      layoutRoot.value,
      anchorGroupId,
      branchNode(orientation, side === 'before' ? movedLeaf : anchorLeaf, side === 'before' ? anchorLeaf : movedLeaf),
    )
    if (source && !options.copy) {
      source.tabs = source.tabs.filter((tab) => tab !== tabId)
      if (source.activeId === tabId) source.activeId = source.tabs[source.tabs.length - 1] ?? null
    }
    subviewOverride.value = null
    touchMru(tabId)
    if (!options.copy) pruneEmptyGroups()
    focusedGroupId.value = moved.id
    return true
  }

  /** Reorder within one group's strip (the drag-over-tab gesture). */
  function reorderTab(groupId: string, tabId: string, index: number): boolean {
    const group = groupOf(groupId)
    if (!group || !group.tabs.includes(tabId)) return false
    const without = group.tabs.filter((tab) => tab !== tabId)
    without.splice(Math.max(0, Math.min(index, without.length)), 0, tabId)
    group.tabs = without
    return true
  }

  /** Promotes a preview tab to Open tier (double click, edit, explicit Keep). */
  function keep(id: string) {
    if (previewDocumentId.value === id) previewDocumentId.value = null
  }

  function pin(id: string) {
    const doc = openDocuments.value.find((entry) => entry.id === id)
    if (!doc) return
    doc.pinned = true
    if (previewDocumentId.value === id) previewDocumentId.value = null
  }

  function unpin(id: string) {
    const doc = openDocuments.value.find((entry) => entry.id === id)
    if (doc) doc.pinned = false
  }

  /** `dirty` is recomputed by whoever can tell (an editor, a form) — the
   * store only carries it, per §9.2 rule 3 it is never read back from disk. */
  function setDirty(id: string, dirty: boolean) {
    const doc = openDocuments.value.find((entry) => entry.id === id)
    if (doc) doc.dirty = dirty
  }

  /**
   * A dirty document is never closed silently (§5.2): without `force` this
   * is a no-op and returns false so the caller can confirm with the user
   * first, then retry with `force: true`.
   */
  function close(id: string, options: { force?: boolean } = {}): boolean {
    const doc = openDocuments.value.find((entry) => entry.id === id)
    if (!doc) return true
    if (doc.dirty && !options.force) return false

    openDocuments.value = openDocuments.value.filter((entry) => entry.id !== id)
    mru.value = mru.value.filter((entry) => entry !== id)
    if (previewDocumentId.value === id) previewDocumentId.value = null
    removeTabEverywhere(id)
    return true
  }

  /**
   * `Ctrl+Tab` / `Ctrl+Shift+Tab` — walks MRU order, not tab-strip order
   * (§5.2). One hop per call; the caller re-invokes on each keypress.
   */
  function selectByMruOffset(step: 1 | -1) {
    if (mru.value.length < 2) return
    const currentIndex = activeDocumentId.value ? mru.value.indexOf(activeDocumentId.value) : -1
    const total = mru.value.length
    const nextIndex = ((currentIndex === -1 ? 0 : currentIndex) + step + total) % total
    const nextId = mru.value[nextIndex]
    if (nextId) select(nextId)
  }

  function reset() {
    openDocuments.value = []
    previewDocumentId.value = null
    mru.value = []
    subviewOverride.value = null
    groups.value = {}
    nextGroupSeq = 1
    // The surface always has one group — even empty — so the Welcome guide
    // has a home and the next open() has a place to land.
    const root = makeGroup([], null)
    layoutRoot.value = { kind: 'group', id: root.id }
    focusedGroupId.value = root.id
  }

  /**
   * Restores the tab list for a Workspace. §9.2: a session-scoped document
   * is dropped rather than restored broken, and `dirty` is never trusted
   * from disk — every restored document starts clean.
   */
  function hydrate(workspaceId: string) {
    suspendPersist = true
    reset()
    boundWorkspaceId = workspaceId
    const stored = repository.read<unknown>(workspaceId, 'openDocuments', [])
    const restored = (Array.isArray(stored) ? stored : [])
      .filter((doc): doc is OpenDocument => isRestorableDocument(doc, workspaceId) && !isSessionScoped(doc.key))
      // Validation passes on the persisted key (its id still matches), then
      // the legacy run-files file encoding is normalized to the explicit
      // runFile variant — the one id→key rewrite, see normalizeRestoredKey.
      .map((doc) => ({ ...doc, key: normalizeRestoredKey(doc.key), dirty: false }))
    if (restored.length) {
      openDocuments.value = restored
      mru.value = restored.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt).map((doc) => doc.id)
    }
    // The group layout is layout, not truth: a stored tree is honored only
    // while every tab id it names names a restored document; anything stale
    // falls back to one group holding the restored tabs.
    const known = new Set(openDocuments.value.map((doc) => doc.id))
    const storedLayout = repository.read<unknown>(workspaceId, 'layout', null)
    const revived = reviveLayout(storedLayout, known)
    if (revived) {
      layoutRoot.value = revived.root
      groups.value = revived.groups
      const ids = treeGroupIds(revived.root)
      nextGroupSeq = ids.reduce((max, id) => Math.max(max, Number(id.split('-')[1]) || 0), 0) + 1
    } else {
      const tabs = openDocuments.value.map((doc) => doc.id)
      layoutRoot.value = { kind: 'group', id: makeGroup(tabs, tabs[0] ?? null).id }
    }
    ensureFocusedGroup()
    suspendPersist = false
  }

  /** Validate + rebuild a stored layout snapshot against the restored tab
   *  set. Returns null for anything malformed or stale (unknown tab id,
   *  empty group, dead branch) — the caller then falls back to one group. */
  function reviveLayout(stored: unknown, known: Set<string>): { root: LayoutNode; groups: Record<string, EditorGroupState> } | null {
    if (!stored || typeof stored !== 'object') return null
    const snapshot = stored as { root?: unknown; groups?: unknown }
    if (!Array.isArray(snapshot.groups) || snapshot.groups.length === 0) return null
    const revivedGroups: Record<string, EditorGroupState> = {}
    for (const entry of snapshot.groups) {
      const candidate = entry as Partial<EditorGroupState>
      if (typeof candidate.id !== 'string' || !Array.isArray(candidate.tabs)) return null
      const tabs = candidate.tabs.filter((tab): tab is string => typeof tab === 'string' && known.has(tab))
      if (tabs.length === 0) return null
      const activeId = typeof candidate.activeId === 'string' && tabs.includes(candidate.activeId) ? candidate.activeId : tabs[0]!
      revivedGroups[candidate.id] = { id: candidate.id, tabs, activeId }
    }
    const validLeaf = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false
      const node = value as Partial<LayoutNode>
      if (node.kind === 'group') return typeof node.id === 'string' && node.id in revivedGroups
      if (node.kind === 'branch') {
        return (node.orientation === 'horizontal' || node.orientation === 'vertical')
          && typeof node.ratio === 'number' && Number.isFinite(node.ratio)
          && validLeaf(node.left) && validLeaf(node.right)
      }
      return false
    }
    if (!validLeaf(snapshot.root)) return null
    // Every stored group must be reachable in the tree — orphans (a stale
    // branch referencing a pruned group) would render as dead slots.
    const root = snapshot.root as LayoutNode
    const reachable = new Set(treeGroupIds(root))
    for (const id of Object.keys(revivedGroups)) {
      if (!reachable.has(id)) return null
    }
    return { root, groups: revivedGroups }
  }

  /** Deleting this loses nothing but layout (§9.2 rule 1): re-derived from
   * `openDocuments` on every mutation, written through the same generic
   * key/value repository `uiLayout` uses. */
  function persist() {
    if (!boundWorkspaceId || suspendPersist) return
    repository.write(boundWorkspaceId, 'openDocuments', openDocuments.value.map((doc) => ({ ...doc, dirty: false })))
    if (layoutRoot.value) {
      repository.write(boundWorkspaceId, 'layout', {
        root: layoutRoot.value,
        groups: treeGroupIds(layoutRoot.value).map((groupId) => groups.value[groupId]).filter(Boolean),
      })
    }
  }

  watch(openDocuments, persist, { deep: true })
  watch([layoutRoot, groups, focusedGroupId], persist, { deep: true })

  const workspaceStore = useWorkspaceStore()
  watch(
    () => workspaceStore.workspaceId,
    (workspaceId, previous) => {
      if (workspaceId && workspaceId !== previous) {
        hydrate(workspaceId)
        // Opening a Workspace lands on the Run Index.
        if (!openDocuments.value.length) openRunIndex(workspaceId)
      } else if (!workspaceId && previous) {
        boundWorkspaceId = null
        reset()
      }
    },
    { immediate: true },
  )

  return {
    openDocuments, activeDocumentId, previewDocumentId, mru,
    activeDocument, activeKey, activeSubview,
    groups, layoutRoot, focusedGroupId, maximizedGroupId,
    groupOf, groupIdsOf: treeGroupIds, groupContaining, ensureFocusedGroup, isGroupInTree: treeHasGroup,
    splitFocusedGroup, closeGroup, rotateFocusedBranch, setBranchRatio,
    toggleGroupMaximized,
    activateInGroup, activateInGroupAndFocus, focusGroup,
    moveTab, moveTabToSplit, reorderTab,
    open, openRunIndex, openRun, openSettings, openResult,
    requestedSettingsSection,
    openWiki, openWikiIndex,
    listRunFiles, listRunRevisions, getRunGraph, getRunLog, subscribeRunEvents, fetchRunFile, readWorkspaceFile, readWorkspaceByteRange, projectWorkspaceWorkflow, openRunFile,
    openWorkspaceFile,
    describeResult, openResultContent, materializeResult, evictResult,
    select, keep, pin, unpin, setDirty, close,
    selectByMruOffset, tierOf, reset,
  }
})
