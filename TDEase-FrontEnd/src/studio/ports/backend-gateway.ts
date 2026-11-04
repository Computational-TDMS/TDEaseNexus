import type { AnalysisCommit } from '../domain/analysis-plan'
import type { RelativePath, RunId, Sha256 } from '../domain/identity'
import type { PublishedResult, TechnicalArtifactRef } from '../domain/result'
import type { RunEvent, RunStatus, RunSummary, TrashedRunSummary } from '../domain/run'

export type Unsubscribe = () => void

export class UnsupportedBackendCapabilityError extends Error {
  constructor(readonly capability: string) {
    super(`Backend capability is unavailable: ${capability}`)
    this.name = 'UnsupportedBackendCapabilityError'
  }
}

/**
 * What the Backend says it can do, from `GET /api/capabilities`.
 *
 * Structurally mirrors the Backend's own document rather than flattening it.
 * The previous shape was flat and carried a `discovery` field the Backend has
 * no concept of, while every flag was a hardcoded `false` no one ever read --
 * three independent ways for the same mechanism to be inert.
 *
 * Every flag on the Backend side is now *derived from its own contract*
 * (`_has_published_results` and friends read `RunCommit.model_fields`), so
 * these cannot claim a capability that is not actually there.
 */
export interface BackendCapabilities {
  protocolVersion: number
  auth: { scheme: string; bootstrap: string | null }
  /** How the Backend gets Workspace bytes, e.g. `local_workspace_hardlink`. */
  materializationStrategies: ReadonlyArray<string>
  limits: {
    maxCores: number
    maxMemoryMb: number
    totalLogicalCpus: number
    reservedServiceCpus: number
    totalMemoryMb: number
    reservedServiceMemoryMb: number
    maxConcurrentRuns: 1
    dryRunTimeoutSeconds: number
    logTailDefaultLines: number
    logTailMaxLines: number
  }
  engine: { name: string; version: string; executionProfile: string }
  features: {
    runDefinition: boolean
    publishedResults: boolean
    nativeDryRunProjection: boolean
    mutableRunTitle: boolean
    cursorLogs: boolean
  }
  multiUser: boolean
}

export interface NodeSummary { id: string; version: string; digest: Sha256; description: string }
export interface NodeDetail extends NodeSummary {
  platforms: ReadonlyArray<string>
  capabilities: ReadonlyArray<{
    name: string
    inputs: ReadonlyArray<{ name: string; pattern: string }>
    outputs: ReadonlyArray<{ name: string; pattern: string }>
    params: ReadonlyArray<{ name: string; pattern: string; comment?: string }>
    message: string
    /** The rule's `shell:` template — the invocation contract (explicit path, never a bare name). */
    shell?: string
  }>
  rulesText: string
  readme: string
}

/** One frozen definition's full content — the exact bytes a revision ran. */
export interface RunDefinitionContent {
  runId: RunId
  definitionRevisionId: string
  createdAt?: string
  workspaceTreeHash?: Sha256
  snakefile: string
  config: Readonly<Record<string, unknown>>
  nodes: ReadonlyArray<{ id: string; digest: string }>
  targets: ReadonlyArray<string>
  resultSpecs: ReadonlyArray<Record<string, unknown>>
  workspaceFiles: ReadonlyArray<{ path: string; blob_hash: string; size: number }>
}

export interface TemplateSummary {
  id: string; version: string; name: string; description: string
  nodes: ReadonlyArray<string>; digest: Sha256
}
export interface TemplateDetail extends TemplateSummary {
  files: Readonly<Record<string, string>>
  readme: string
}

export interface DryRunDagNode { id: number; rule: string; label: string }
export interface DryRunDagEdge { source: number; target: number }
export interface DryRunProjection {
  nodes: ReadonlyArray<DryRunDagNode>
  edges: ReadonlyArray<DryRunDagEdge>
}

export interface DryRunResult {
  valid: boolean
  exitCode: number
  engine: string
  output: string
  nativeProjection?: DryRunProjection
}

export interface RunQuery {
  workspaceId?: string
  offset?: number
  limit?: number
  status?: ReadonlyArray<RunStatus>
  query?: string
}

export interface Page<T> {
  items: ReadonlyArray<T>
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface BoundedLogTail { text: string; lines: number }

export interface RunFileEntry {
  path: RelativePath
  size: number
  digest?: Sha256
  role?: 'result' | 'workflow'
}
export interface RunRevision {
  revisionId: string
  parentRevisionId?: string
  createdAt: string
  fileCount: number
  workflowFileCount: number
}
export interface RunDefinitionRevision {
  definitionRevisionId: string
  createdAt: string
  workspaceTreeHash?: Sha256
  status?: RunStatus
  resultRevisionId?: string
  fileCount: number
  workflowFileCount: number
}
export interface WorkflowGraph {
  runId: RunId
  nodes: ReadonlyArray<{ id: number; rule: string; label: string; initial_status: 'waiting' | 'up_to_date'; status: 'waiting' | 'up_to_date' | 'running' | 'succeeded' | 'failed' | 'cancelled'; wildcards: Readonly<Record<string, string>> }>
  edges: ReadonlyArray<{ source: number; target: number }>
}

export interface BackendGateway {
  capabilities(): Promise<BackendCapabilities>
  listNodes(): Promise<ReadonlyArray<NodeSummary>>
  getNode(id: string): Promise<NodeDetail>
  dryRun(commit: AnalysisCommit): Promise<DryRunResult>
  submit(commit: AnalysisCommit): Promise<RunSummary>
  listRuns(query?: RunQuery): Promise<Page<RunSummary>>
  getRun(runId: RunId): Promise<RunSummary>
  getRunGraph(runId: RunId): Promise<WorkflowGraph>
  subscribeRun(
    runId: RunId,
    afterSeq: number,
    onEvent: (event: RunEvent) => void,
    onDone?: () => void,
  ): Unsubscribe
  cancelRun(runId: RunId): Promise<void>
  rerun(runId: RunId, mode: 'resume' | 'overwrite'): Promise<RunSummary>
  trashRun(runId: RunId): Promise<void>
  listTrash(): Promise<ReadonlyArray<TrashedRunSummary>>
  restoreRun(runId: RunId): Promise<RunSummary>
  listResults(runId: RunId): Promise<ReadonlyArray<PublishedResult>>
  listTechnicalArtifacts(runId: RunId): Promise<ReadonlyArray<TechnicalArtifactRef>>
  fetchRunFile(runId: RunId, path: RelativePath, revision?: string): Promise<Blob>
  listRunFiles(runId: RunId, pattern?: string, revision?: string, includeWorkflow?: boolean): Promise<ReadonlyArray<RunFileEntry>>
  listRunRevisions(runId: RunId): Promise<ReadonlyArray<RunRevision>>
  listRunDefinitions(runId: RunId): Promise<ReadonlyArray<RunDefinitionRevision>>
  readDefinition(runId: RunId, definitionRevisionId: string): Promise<RunDefinitionContent>
  readLog(runId: RunId, tail?: number): Promise<BoundedLogTail>
}
