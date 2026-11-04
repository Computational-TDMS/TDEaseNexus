import type { PlanRef, RelativePath, RunId, Sha256, WorkspaceId } from './identity'
import type { NodeBinding } from './run'
import type { DryRunProjection } from '../ports/backend-gateway'

export type PlanState =
  | 'prepared'
  | 'validating'
  | 'invalid'
  | 'valid'
  | 'submitting'
  | 'consumed'
  | 'expired'

export interface AnalysisCommitFile {
  path: RelativePath
  digest: Sha256
  size: number
}

/**
 * A Published Result the commit declares.
 *
 * Published Results are declared, never inferred from a path
 * (CORE-ARCHITECTURE.md 3). Readiness is the join of `output` against the Run's
 * file manifest, so anything the commit does not declare here is structurally
 * invisible to the Published Results projection -- it remains reachable as a
 * raw Run file, which is exactly the distinction between a published result and
 * a technical artifact.
 */
export interface DeclaredResult {
  /** Stable within this Run, e.g. `feature-table:sample-a`. */
  resultId: string
  name: string
  /** Groups and drives selectors, e.g. `feature_table`. */
  kind: string
  /** Declared dimension values, e.g. `{ sample: 'sample-a' }`. */
  dimensions: Readonly<Record<string, string>>
  /** Run-root-relative path, joined against the manifest to decide readiness. */
  output: RelativePath
}

export interface AnalysisCommit {
  runId: RunId
  idempotencyKey: string
  workspaceId: WorkspaceId
  /** Workspace-relative directory that becomes the Backend execution root. */
  runPath: RelativePath
  workspaceTreeHash: Sha256
  files: ReadonlyArray<AnalysisCommitFile>
  snakefile: string
  targets: ReadonlyArray<string>
  config: Readonly<Record<string, unknown>>
  nodes: ReadonlyArray<NodeBinding>
  /** Optional semantic metadata. Without it, the Backend publishes Snakemake
   * default targets as neutral workflow outputs. */
  results?: ReadonlyArray<DeclaredResult>
}

export interface PreparedPlanView {
  ref: PlanRef
  digest: Sha256
  workspaceTreeHash: Sha256
  state: PlanState
  snakefilePath: RelativePath
  template?: { id: string; digest: Sha256 }
  nodes: ReadonlyArray<NodeBinding>
  scripts: ReadonlyArray<RelativePath>
  inputSummary: ReadonlyArray<{ path: RelativePath; size: number }>
  config: Readonly<Record<string, unknown>>
  targets: ReadonlyArray<string>
  warnings: ReadonlyArray<{ code: string; path?: RelativePath; message: string }>
  dryRun?: { valid: boolean; exitCode: number; engine: string; output: string; nativeProjection?: DryRunProjection }
}
