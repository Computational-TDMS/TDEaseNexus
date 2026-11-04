import type { CapabilitiesDocument, CommitPlan, RunEvent as RunEventDto, RunInfo } from './client-contracts'
import type { RunResultEntry, TDEaseClient } from './backend'
import { asRelativePath, asResultId, asRunId, asSha256, asWorkspaceId } from '@/studio/domain/identity'
import type { AnalysisCommit } from '@/studio/domain/analysis-plan'
import type { PublishedResult } from '@/studio/domain/result'
import type { RunEvent, RunSummary } from '@/studio/domain/run'
import {
  UnsupportedBackendCapabilityError,
  type BackendCapabilities,
  type BackendGateway,
  type NodeDetail,
  type RunFileEntry,
  type RunDefinitionContent,
  type RunDefinitionRevision,
  type RunQuery,
} from '@/studio/ports/backend-gateway'

/**
 * Map the Backend's document into the port's shape. Snake to camel only -- no
 * defaults, no invented fields. If the Backend stops sending something, that is
 * drift to surface, not a gap to paper over with a plausible `false`.
 */
function mapCapabilities(document: CapabilitiesDocument): BackendCapabilities {
  return {
    protocolVersion: document.protocol_version,
    auth: { scheme: document.auth.scheme, bootstrap: document.auth.bootstrap },
    materializationStrategies: document.materialization.strategies,
    limits: {
      maxCores: document.limits.max_cores,
      maxMemoryMb: document.limits.max_memory_mb,
      totalLogicalCpus: document.limits.total_logical_cpus,
      reservedServiceCpus: document.limits.reserved_service_cpus,
      totalMemoryMb: document.limits.total_memory_mb,
      reservedServiceMemoryMb: document.limits.reserved_service_memory_mb,
      maxConcurrentRuns: document.limits.max_concurrent_runs,
      dryRunTimeoutSeconds: document.limits.dry_run_timeout_seconds,
      logTailDefaultLines: document.limits.log_tail_default_lines,
      logTailMaxLines: document.limits.log_tail_max_lines,
    },
    engine: {
      name: document.engine.name,
      version: document.engine.version,
      executionProfile: document.engine.execution_profile,
    },
    features: {
      runDefinition: document.features.run_definition,
      publishedResults: document.features.published_results,
      nativeDryRunProjection: document.features.native_dry_run_projection,
      mutableRunTitle: document.features.mutable_run_title,
      cursorLogs: document.features.cursor_logs,
    },
    multiUser: document.multi_user,
  }
}

export class TDEaseBackendGateway implements BackendGateway {
  constructor(
    private readonly client: TDEaseClient,
    private readonly actor: 'user' | 'ai' = 'user',
    private readonly workspaceRoot?: string,
    private readonly readWorkspaceBlob?: (relative: string) => Promise<Blob>,
  ) {}

  /** In flight or resolved; never re-requested. */
  private capabilityDocument?: Promise<BackendCapabilities>
  private localRootCapability?: Promise<string>

  /**
   * Ask the Backend. Memoized per gateway because the Backend freezes its own
   * document at import time -- it cannot change while a gateway lives, and a
   * gateway does not outlive the client it is bound to.
   */
  async capabilities(): Promise<BackendCapabilities> {
    this.capabilityDocument ??= this.client.getCapabilities().then(mapCapabilities)
    return this.capabilityDocument
  }

  async listNodes() {
    return (await this.client.listNodes()).map(({ id, version, digest, description }) => ({
      id, version, digest: asSha256(digest), description,
    }))
  }

  async getNode(id: string): Promise<NodeDetail> {
    const node = await this.client.getNode(id)
    return { ...node, digest: asSha256(node.digest) }
  }

  async dryRun(commit: AnalysisCommit) {
    const plan = await this.materializePlan(commit)
    const result = await this.client.dryRun(plan, this.actor)
    return {
      valid: result.valid,
      exitCode: result.exit_code,
      engine: result.engine,
      output: result.output,
      ...(result.projection ? { nativeProjection: result.projection } : {}),
    }
  }

  async submit(commit: AnalysisCommit): Promise<RunSummary> {
    const plan = await this.materializePlan(commit)
    return mapRun(await this.client.submitPlan(plan, this.actor))
  }

  async listRuns(query: RunQuery = {}) {
    const page = await this.client.listPage({
      workspaceId: query.workspaceId, offset: query.offset, limit: query.limit,
      status: query.status ? [...query.status] : undefined, query: query.query,
    })
    return {
      items: page.runs.map(mapRun), total: page.total, offset: page.offset,
      limit: page.limit, hasMore: page.has_more,
    }
  }

  async getRun(runId: ReturnType<typeof asRunId>): Promise<RunSummary> {
    return mapRun(await this.client.status(runId))
  }

  async getRunGraph(runId: ReturnType<typeof asRunId>) {
    const graph = await this.client.getRunGraph(runId)
    return { runId: asRunId(graph.run_id), nodes: graph.nodes, edges: graph.edges }
  }

  subscribeRun(
    runId: ReturnType<typeof asRunId>,
    afterSeq: number,
    onEvent: (event: RunEvent) => void,
    onDone?: () => void,
  ) {
    return this.client.subscribeEvents(runId, (event) => onEvent(mapRunEvent(event)), afterSeq, onDone)
  }

  async cancelRun(runId: ReturnType<typeof asRunId>): Promise<void> {
    await this.client.cancel(runId, this.actor)
  }

  async rerun(runId: ReturnType<typeof asRunId>, mode: 'resume' | 'overwrite'): Promise<RunSummary> {
    return mapRun(await this.client.rerun(runId, mode, this.actor))
  }

  async trashRun(runId: ReturnType<typeof asRunId>): Promise<void> { await this.client.trashRun(runId, this.actor) }
  async listTrash() {
    return (await this.client.listTrash()).map((run) => ({
      id: asRunId(run.run_id), workspaceId: asWorkspaceId(run.workspace_id), title: run.name,
      previousStatus: run.previous_status, deletedAt: run.deleted_at, deletedBy: run.deleted_by,
    }))
  }
  async restoreRun(runId: ReturnType<typeof asRunId>): Promise<RunSummary> {
    return mapRun(await this.client.restoreRun(runId, this.actor))
  }
  async listResults(runId: ReturnType<typeof asRunId>): Promise<ReadonlyArray<PublishedResult>> {
    return (await this.client.listResults(runId))
      .filter((entry): entry is RunResultEntry & { digest: string } => entry.status === 'ready' && Boolean(entry.digest))
      .map((entry) => mapPublishedResult(entry))
  }
  async listTechnicalArtifacts(): Promise<never> { throw new UnsupportedBackendCapabilityError('technical-artifacts') }

  fetchRunFile(runId: ReturnType<typeof asRunId>, path: ReturnType<typeof asRelativePath>, revision?: string): Promise<Blob> {
    return this.client.fetchFile(runId, path, revision)
  }

  async listRunFiles(runId: ReturnType<typeof asRunId>, pattern?: string, revision?: string, includeWorkflow = false): Promise<ReadonlyArray<RunFileEntry>> {
    return (await this.client.listRunFiles(runId, pattern, revision, includeWorkflow)).map((file) => ({
      path: asRelativePath(file.path), size: file.size,
      digest: file.sha256 ? asSha256(file.sha256) : undefined,
      role: file.role,
    }))
  }

  async listRunRevisions(runId: ReturnType<typeof asRunId>) {
    return (await this.client.listRunRevisions(runId)).map((revision) => ({
      revisionId: revision.revision_id,
      parentRevisionId: revision.parent_revision_id ?? undefined,
      createdAt: revision.created_at,
      fileCount: revision.file_count,
      workflowFileCount: revision.workflow_file_count,
    }))
  }

  async listRunDefinitions(runId: ReturnType<typeof asRunId>): Promise<ReadonlyArray<RunDefinitionRevision>> {
    return (await this.client.listRunDefinitions(runId)).map((revision) => ({
      definitionRevisionId: revision.definition_revision_id,
      createdAt: revision.created_at,
      workspaceTreeHash: revision.workspace_tree_hash ? asSha256(revision.workspace_tree_hash) : undefined,
      status: revision.status ?? undefined,
      resultRevisionId: revision.result_revision_id ?? undefined,
      fileCount: revision.file_count,
      workflowFileCount: revision.workflow_file_count,
    }))
  }

  async readDefinition(
    runId: ReturnType<typeof asRunId>,
    definitionRevisionId: string,
  ): Promise<RunDefinitionContent> {
    const raw = await this.client.getRunDefinition(runId, definitionRevisionId)
    return {
      runId: asRunId(raw.run_id),
      definitionRevisionId: raw.definition_revision_id,
      createdAt: raw.created_at,
      workspaceTreeHash: raw.workspace_tree_hash ? asSha256(raw.workspace_tree_hash) : undefined,
      snakefile: raw.snakefile,
      config: raw.config ?? {},
      nodes: raw.nodes ?? [],
      targets: raw.targets ?? [],
      resultSpecs: raw.result_specs ?? [],
      workspaceFiles: raw.workspace_files ?? [],
    }
  }

  async readLog(runId: ReturnType<typeof asRunId>, tail = 50) {
    return { text: await this.client.tailLog(runId, tail), lines: tail }
  }

  private async materializePlan(commit: AnalysisCommit): Promise<CommitPlan> {
    if (!this.workspaceRoot) throw new Error('Submitting a Run requires its Client Workspace root')
    const capabilities = await this.capabilities()
    if (capabilities.materializationStrategies.includes('local_workspace_hardlink')) {
      this.localRootCapability ??= this.client.registerWorkspaceRoot(this.workspaceRoot)
        .then((entry) => entry.root_id)
      return toCommitPlan(commit, {
        strategy: 'local_workspace_hardlink',
        rootId: await this.localRootCapability,
      })
    }
    if (!capabilities.materializationStrategies.includes('blob_store')) {
      throw new UnsupportedBackendCapabilityError('run-materialization')
    }
    const plan = toCommitPlan(commit, { strategy: 'blob_store' })
    await this.client.prepareRemote(plan, async (relative) => {
      if (!this.readWorkspaceBlob) throw new Error('Remote submission requires the Client Workspace byte reader')
      const path = [commit.runPath, relative].filter(Boolean).join('/')
      return this.readWorkspaceBlob(path)
    })
    return plan
  }
}

export function mapPublishedResult(entry: RunResultEntry & { digest: string }): PublishedResult {
  return {
    ref: {
      workspaceId: asWorkspaceId(entry.ref.workspace_id),
      runId: asRunId(entry.ref.run_id),
      resultId: asResultId(entry.ref.result_id),
      digest: asSha256(entry.digest),
    },
    title: entry.name,
    kind: entry.kind,
    size: entry.size ?? 0,
    technicalPath: asRelativePath(entry.output),
    metadata: entry.dimensions,
  }
}

export function mapRun(dto: RunInfo): RunSummary {
  return {
    id: asRunId(dto.run_id), workspaceId: asWorkspaceId(dto.workspace_id), title: dto.name,
    status: dto.status, cores: dto.cores, error: dto.error ?? undefined,
    rerunMode: dto.rerun_mode, labels: dto.labels,
    createdAt: dto.created_at, startedAt: dto.started_at ?? undefined,
    finishedAt: dto.finished_at ?? undefined, resultCount: dto.result_file_count,
    lastEventSeq: dto.event_seq_last,
    ...(dto.workspace_run_path ? { workspaceRunPath: dto.workspace_run_path } : {}),
    ...(dto.current_revision ? { currentRevision: dto.current_revision } : {}),
    ...(dto.active_revision ? { activeRevision: dto.active_revision } : {}),
    ...(dto.queued_revision ? { queuedRevision: dto.queued_revision } : {}),
    ...(dto.execution_count !== undefined ? { executionCount: dto.execution_count } : {}),
  }
}

export function mapRunEvent(dto: RunEventDto): RunEvent {
  return {
    runId: asRunId(dto.run_id), seq: dto.seq, type: dto.type,
    timestamp: dto.timestamp, data: dto.data,
  }
}

function toCommitPlan(
  commit: AnalysisCommit,
  materialization:
    | { strategy: 'local_workspace_hardlink'; rootId: string }
    | { strategy: 'blob_store' },
): CommitPlan {
  return {
    runId: commit.runId, idempotencyKey: commit.idempotencyKey,
    workspaceId: commit.workspaceId, workspaceTreeHash: commit.workspaceTreeHash,
    workspaceFiles: commit.files.map((file) => ({
      path: file.path, blob_hash: file.digest, size: file.size, mode: 'file', executable: false,
    })),
    excludedFiles: [], snakefile: commit.snakefile,
    localRootId: materialization.strategy === 'local_workspace_hardlink'
      ? materialization.rootId
      : undefined,
    localRunPath: materialization.strategy === 'local_workspace_hardlink'
      ? commit.runPath
      : undefined,
    workspaceRunPath: commit.runPath,
    materializationStrategy: materialization.strategy,
    targets: [...commit.targets],
    config: { ...commit.config },
    nodes: commit.nodes.map((node) => ({ ...node, digest: node.digest, rules: [...node.rules] })),
    warnings: [],
    // Optional semantic metadata. Without it, the Backend derives neutral
    // Published Results from Snakemake default targets.
    ...(commit.results?.length
      ? {
          resultSpecs: commit.results.map((result) => ({
            result_id: result.resultId,
            name: result.name,
            kind: result.kind,
            dimensions: { ...result.dimensions },
            output: result.output,
          })),
        }
      : {}),
  }
}
