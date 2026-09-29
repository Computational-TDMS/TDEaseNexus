export type DeploymentMode = 'local' | 'remote'
export type MaterializationStrategy = 'local_workspace_hardlink' | 'blob_store'

export interface WorkspaceIdentity {
  id: string
  name: string
  server?: string | null
  createdAt: string
}

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'

export interface TreeEntry {
  path: string
  blob_hash: string
  size: number
  mode?: 'file'
  executable?: boolean
}

export interface CommitWarning {
  code: string
  path?: string
  message: string
}

export interface NodeBinding {
  id: string
  version: string
  digest: string
  rules: string[]
}

/**
 * The Backend capability document, `GET /api/capabilities`.
 *
 * Mirrors `CapabilitiesResponse` in `app/api/capabilities.py` field for field,
 * on purpose: this is the one place the Client is allowed to know the shape,
 * and a helpful-looking rearrangement here is how the two drift. Unauthenticated
 * by design -- the document describes how to authenticate, so requiring auth to
 * read it would deadlock the bootstrap.
 */
export interface CapabilitiesDocument {
  protocol_version: 3
  auth: { scheme: string; bootstrap: string | null }
  materialization: { strategies: string[] }
  limits: {
    max_cores: number
    max_memory_mb: number
    total_logical_cpus: number
    reserved_service_cpus: number
    total_memory_mb: number
    reserved_service_memory_mb: number
    max_concurrent_runs: 1
    dry_run_timeout_seconds: number
    log_tail_default_lines: number
    log_tail_max_lines: number
  }
  engine: { name: string; version: string; execution_profile: string }
  features: {
    run_definition: boolean
    published_results: boolean
    native_dry_run_projection: boolean
    mutable_run_title: boolean
    cursor_logs: boolean
  }
  multi_user: boolean
}

/**
 * A Published Result the commit declares. Mirrors `ResultSpec` in
 * `src/contracts/run.py`.
 *
 * Published Results are *declared here and never inferred from a path*
 * (CORE-ARCHITECTURE.md 3): readiness is the join of `output` against the Run's
 * file manifest, so a file the commit never declared is structurally invisible
 * to `GET /runs/{id}/results` no matter where it lands on disk.
 */
export interface ResultSpecDeclaration {
  /** Stable within this Run, e.g. `feature-table:sample-a`. */
  result_id: string
  name: string
  /** Groups and drives selectors, e.g. `feature_table`. */
  kind: string
  /** Declared dimension values, e.g. `{ sample: 'sample-a' }`. */
  dimensions: Record<string, string>
  /** Run-root-relative path, joined against the manifest to decide readiness. */
  output: string
}

export interface CommitPlan {
  runId: string
  idempotencyKey: string
  workspaceId: string
  workspaceTreeHash: string
  workspaceFiles: TreeEntry[]
  excludedFiles: string[]
  snakefile: string
  localRootId?: string
  localRunPath?: string
  workspaceRunPath?: string
  materializationStrategy: MaterializationStrategy
  targets: string[]
  // No compute envelope fields: the Backend owns cores/memory outright and
  // rejects a caller-declared value by name (spec/WORKFLOW-RUN.md §1).
  config: Record<string, unknown>
  nodes: NodeBinding[]
  warnings: CommitWarning[]
  /** Declared Published Results. Absent means the Run publishes nothing. */
  resultSpecs?: ResultSpecDeclaration[]
}

export interface WorkflowGraph {
  run_id: string
  nodes: Array<{ id: number; rule: string; label: string; initial_status: 'waiting' | 'up_to_date'; status: 'waiting' | 'up_to_date' | 'running' | 'succeeded' | 'failed' | 'cancelled'; wildcards: Record<string, string> }>
  edges: Array<{ source: number; target: number }>
}

export interface RunInfo {
  run_id: string
  name: string
  workspace_id: string
  workspace_run_path?: string | null
  current_revision?: string | null
  active_revision?: string | null
  queued_revision?: string | null
  execution_count?: number
  status: RunStatus
  cores: number
  pid?: number | null
  exit_code?: number | null
  error?: string | null
  rerun_mode: 'resume' | 'overwrite'
  labels: Record<string, string>
  result_file_count: number
  created_at: string
  started_at?: string | null
  finished_at?: string | null
  event_seq_last: number
  idempotent?: boolean
}

export interface RunRevision {
  revision_id: string
  parent_revision_id?: string | null
  created_at: string
  file_count: number
  workflow_file_count: number
}

export interface RunDefinitionRevision {
  definition_revision_id: string
  created_at: string
  workspace_tree_hash?: string
  status?: RunStatus | null
  result_revision_id?: string | null
  file_count: number
  workflow_file_count: number
}

export interface RunDefinitionRaw {
  run_id: string
  definition_revision_id: string
  created_at?: string
  workspace_tree_hash?: string
  snakefile: string
  config?: Record<string, unknown>
  nodes?: Array<{ id: string; digest: string }>
  targets?: string[]
  result_specs?: Array<Record<string, unknown>>
  workspace_files?: Array<{ path: string; blob_hash: string; size: number }>
}

export interface TrashedRunInfo {
  run_id: string
  name: string
  workspace_id: string
  previous_status: RunStatus
  deleted_at: string
  deleted_by: string
}

export interface RunEvent {
  schema_version: number
  run_id: string
  seq: number
  timestamp: string
  type: string
  level: string
  message: string
  runtime_ref?: string | null
  data: Record<string, unknown>
}

export interface FileState {
  path: string
  localDigest?: string
  remoteDigest?: string
  committedDigest?: string
  materialization: 'local-only' | 'remote-only' | 'cached' | 'dirty' | 'uploading' | 'verifying' | 'conflict'
}

export interface RunFileEntry { path: string; size: number; sha256: string | null; role?: 'result' | 'workflow' }
