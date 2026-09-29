import type { PreparedPlanView } from '../domain/analysis-plan'
import { asRelativePath, type PlanRef, type RelativePath } from '../domain/identity'
import type { RunSummary, RunWaitResult } from '../domain/run'
import type { BackendGateway, BoundedLogTail, NodeDetail, NodeSummary, RunDefinitionContent, RunDefinitionRevision, RunFileEntry, RunQuery, TemplateDetail, TemplateSummary, Unsubscribe } from '../ports/backend-gateway'
import type { SnapshotSelection, WorkspaceRepository } from '../ports/workspace-repository'
import { dryRunAnalysis } from '../use-cases/dry-run-analysis'
import { prepareAnalysis, type PrepareAnalysisInput } from '../use-cases/prepare-analysis'
import { submitAnalysis, type SubmitAnalysisDependencies } from '../use-cases/submit-analysis'
import {
  inspectAnalysis,
  runAnalysis,
  validateAnalysis,
  type WorkflowInspection,
  type WorkflowRunResult,
  type WorkflowValidation,
} from '../use-cases/direct-analysis'
import { PlanRegistry } from './plan-registry'
import { RunRepository, type RunRepositorySnapshot } from './run-repository'
import { RunSubscriptions } from './run-subscriptions'
import type { RunId } from '../domain/identity'
import { diagnoseRun, type RunDiagnosis } from '../use-cases/diagnose-run'
import { workspacePathForManifestEntry } from '@/services/workspace/run-file-status'

export interface StudioAnalysisRuntime {
  inspect(input: Pick<PrepareAnalysisInput, 'runPath'>): Promise<WorkflowInspection>
  validate(input: PrepareAnalysisInput): Promise<WorkflowValidation>
  run(input: PrepareAnalysisInput): Promise<WorkflowRunResult>
  prepare(input: PrepareAnalysisInput): Promise<PreparedPlanView>
  dryRun(ref: PlanRef): Promise<PreparedPlanView>
  submit(ref: PlanRef): Promise<RunSummary>
  discard(ref: PlanRef): void
}

export interface StudioRunRuntime {
  snapshot(): RunRepositorySnapshot
  onChange(listener: (snapshot: RunRepositorySnapshot) => void): Unsubscribe
  load(query?: RunQuery): Promise<RunRepositorySnapshot>
  loadMore(query?: RunQuery): Promise<RunRepositorySnapshot>
  refresh(runId: RunId): Promise<RunSummary>
  /** The Run's immutable definition history (each submitted revision with its
   *  outcome and result revision) — read-only provenance for "what changed". */
  listDefinitions(runId: RunId): Promise<ReadonlyArray<RunDefinitionRevision>>
  readDefinition(runId: RunId, definitionRevisionId: string): Promise<RunDefinitionContent>
  wait(runId: RunId, deadlineMs?: number, signal?: AbortSignal): Promise<RunWaitResult>
  /** Drains runs that went terminal while watched — the Agent context hook's
   *  settle-announcement source (see RunRepository.drainSettledRuns). */
  drainSettledRuns(): ReadonlyArray<RunSummary>
  tailLog(runId: RunId, lines?: number): Promise<BoundedLogTail>
  diagnose(runId: RunId): Promise<RunDiagnosis>
  listFiles(runId: RunId, pattern?: string): Promise<ReadonlyArray<RunFileEntry>>
  fetchFile(runId: RunId, path: RelativePath): Promise<Blob>
  pullFile(runId: RunId, path: RelativePath): Promise<{ written: RelativePath }>
  cancel(runId: RunId): Promise<void>
  rerun(runId: RunId, mode: 'resume' | 'overwrite'): Promise<RunSummary>
  trash(runId: RunId): Promise<void>
  restore(runId: RunId): Promise<RunSummary>
}

export interface StudioRuntimeDependencies {
  backend: BackendGateway
  workspace: WorkspaceRepository
  snapshotSelection: SnapshotSelection
  templates: {
    list(): Promise<ReadonlyArray<TemplateSummary>>
    get(id: string): Promise<TemplateDetail>
  }
  prepareTransport?: SubmitAnalysisDependencies['prepareTransport']
  randomId?: () => string
  runSubscriptions?: RunSubscriptions
  runRepository?: RunRepository
  onRunsChanged?: () => void
  /** A run this runtime DISPATCHED (analysis run/submit, runs.rerun) — the
   *  session-scoped run channel's record source (see RunRepository for the
   *  live status stream). Observation-only reads never fire this. */
  onRunDispatched?: (run: RunSummary) => void
}

export class StudioRuntime {
  readonly analysis: StudioAnalysisRuntime
  readonly runs: StudioRunRuntime
  readonly discovery: {
    listNodes(): Promise<ReadonlyArray<NodeSummary>>
    getNode(id: string): Promise<NodeDetail>
    listTemplates(): Promise<ReadonlyArray<TemplateSummary>>
    getTemplate(id: string): Promise<TemplateDetail>
  }
  private readonly registry = new PlanRegistry()
  private readonly runSubscriptions: RunSubscriptions
  private readonly runRepository: RunRepository
  private readonly ownsRunSubscriptions: boolean
  private readonly ownsRunRepository: boolean
  private readonly stopWorkspaceWatch: () => void

  constructor(dependencies: StudioRuntimeDependencies) {
    this.runSubscriptions = dependencies.runSubscriptions ?? new RunSubscriptions(dependencies.backend)
    this.ownsRunSubscriptions = !dependencies.runSubscriptions
    this.runRepository = dependencies.runRepository ?? new RunRepository(dependencies.backend, this.runSubscriptions)
    this.ownsRunRepository = !dependencies.runRepository
    this.analysis = {
      inspect: (input) => inspectAnalysis(input, {
        backend: dependencies.backend, workspace: dependencies.workspace,
      }),
      validate: (input) => validateAnalysis(input, {
        backend: dependencies.backend, workspace: dependencies.workspace,
        registry: this.registry, snapshotSelection: dependencies.snapshotSelection,
        prepareTransport: dependencies.prepareTransport, randomId: dependencies.randomId,
      }),
      run: async (input) => {
        const result = await runAnalysis(input, {
          backend: dependencies.backend, workspace: dependencies.workspace,
          registry: this.registry, snapshotSelection: dependencies.snapshotSelection,
          prepareTransport: dependencies.prepareTransport, randomId: dependencies.randomId,
        })
        if (result.status === 'submitted') {
          this.runRepository.track(result.run)
          dependencies.onRunsChanged?.()
          dependencies.onRunDispatched?.(result.run)
        }
        return result
      },
      prepare: (input) => prepareAnalysis(input, {
        backend: dependencies.backend, workspace: dependencies.workspace,
        registry: this.registry,
        snapshotSelection: dependencies.snapshotSelection, randomId: dependencies.randomId,
      }),
      dryRun: (ref) => dryRunAnalysis(ref, dependencies.backend, this.registry),
      submit: async (ref) => {
        const run = await submitAnalysis(ref, {
          backend: dependencies.backend, registry: this.registry, prepareTransport: dependencies.prepareTransport,
        })
        this.runRepository.track(run)
        dependencies.onRunsChanged?.()
        dependencies.onRunDispatched?.(run)
        return run
      },
      discard: (ref) => this.registry.discard(ref),
    }
    this.runs = {
      snapshot: () => this.runRepository.snapshot(),
      onChange: (listener) => this.runRepository.onChange(listener),
      load: (query) => this.runRepository.load(query),
      loadMore: (query) => this.runRepository.loadMore(query),
      // Every run-addressed call resolves first: callers name a run by its
      // Workspace data folder (`soybean-all` / `runs/soybean-all`) and the
      // repository maps that to the backend RunId. See RunRepository.resolveRunId.
      refresh: async (runId) => this.runRepository.refresh(await this.runRepository.resolveRunId(runId)),
      listDefinitions: async (runId) => this.runRepository.listDefinitions(await this.runRepository.resolveRunId(runId)),
      readDefinition: async (runId, definitionRevisionId) => this.runRepository.readDefinition(await this.runRepository.resolveRunId(runId), definitionRevisionId),
      wait: async (runId, deadlineMs, signal) => this.runRepository.wait(await this.runRepository.resolveRunId(runId), deadlineMs, signal),
      drainSettledRuns: () => this.runRepository.drainSettledRuns(),
      tailLog: async (runId, lines) => dependencies.backend.readLog(await this.runRepository.resolveRunId(runId), lines),
      diagnose: async (runId) => diagnoseRun(await this.runRepository.resolveRunId(runId), dependencies.backend),
      listFiles: async (runId, pattern) => dependencies.backend.listRunFiles(await this.runRepository.resolveRunId(runId), pattern),
      fetchFile: async (runId, path) => dependencies.backend.fetchRunFile(await this.runRepository.resolveRunId(runId), path),
      pullFile: async (runId, path) => pullRunFile(await this.runRepository.resolveRunId(runId), path, dependencies),
      cancel: async (runId) => {
        await this.runRepository.cancel(await this.runRepository.resolveRunId(runId))
        dependencies.onRunsChanged?.()
      },
      rerun: async (runId, mode) => {
        const run = await this.runRepository.rerun(await this.runRepository.resolveRunId(runId), mode)
        dependencies.onRunsChanged?.()
        dependencies.onRunDispatched?.(run)
        return run
      },
      trash: async (runId) => {
        await this.runRepository.trash(await this.runRepository.resolveRunId(runId))
        dependencies.onRunsChanged?.()
      },
      restore: async (runId) => {
        const run = await this.runRepository.restore(await this.runRepository.resolveRunId(runId))
        dependencies.onRunsChanged?.()
        return run
      },
    }
    this.discovery = {
      listNodes: () => dependencies.backend.listNodes(),
      getNode: (id) => dependencies.backend.getNode(id),
      listTemplates: () => dependencies.templates.list(),
      getTemplate: (id) => dependencies.templates.get(id),
    }
    this.stopWorkspaceWatch = dependencies.workspace.watch((change) => {
      void dependencies.workspace.inspect().then((workspace) => {
        this.registry.expireWorkspace(workspace.id, change.path)
      })
    })
  }

  dispose(): void {
    this.stopWorkspaceWatch()
    if (this.ownsRunRepository) this.runRepository.dispose()
    if (this.ownsRunSubscriptions) this.runSubscriptions.dispose()
    this.registry.clear()
  }
}

/**
 * Fetch one Run result file from the Backend and materialize it into the
 * owning Workspace Run directory (`runs/<source_run>/results/<path>`).
 *
 * The disk-writing twin of `fetchFile`: `fetchFile` returns the bytes as a Blob
 * (metadata-only to the agent), while `pullFile` lands them on the workspace so
 * a later analysis pass can read them locally. The destination
 * follows the same `workspace_run_path` → `labels.source_run` fallback the
 * renderer's Run Files tab uses, so a Run's outputs always return to their own
 * folder — never to an arbitrary agent-chosen path.
 */
export async function pullRunFile(
  runId: RunId,
  path: RelativePath,
  dependencies: Pick<StudioRuntimeDependencies, 'backend' | 'workspace'>,
): Promise<{ written: RelativePath }> {
  const run = await dependencies.backend.getRun(runId)
  const runPath = run.workspaceRunPath ?? (run.labels.source_run ? `runs/${run.labels.source_run}` : undefined)
  if (!runPath) throw new Error(`Run ${runId} has no workspace destination path`)
  const blob = await dependencies.backend.fetchRunFile(runId, path)
  const destination = asRelativePath(workspacePathForManifestEntry(runPath, path))
  await dependencies.workspace.writeBytes(destination, new Uint8Array(await blob.arrayBuffer()))
  return { written: destination }
}
