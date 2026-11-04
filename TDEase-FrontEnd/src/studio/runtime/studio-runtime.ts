import type { PreparedPlanView } from '../domain/analysis-plan'
import type { PlanRef, RelativePath } from '../domain/identity'
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
import { createStudioRunSurface } from './run-surface'
import { RunRepository, type RunRepositorySnapshot } from './run-repository'
import { RunSubscriptions } from './run-subscriptions'
import type { RunId } from '../domain/identity'
import type { RunDiagnosis } from '../use-cases/diagnose-run'
import type { PullRunFileOptions, PullRunFileResult } from '../use-cases/pull-run-file'

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
  listFiles(runId: RunId, pattern?: string, revision?: string): Promise<ReadonlyArray<RunFileEntry>>
  fetchFile(runId: RunId, path: RelativePath, revision?: string): Promise<Blob>
  pullFile(runId: RunId, path: RelativePath, options?: PullRunFileOptions): Promise<PullRunFileResult>
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
    // The Run face is the shared surface factory — the same assembly the
    // renderer's Run store uses — so a host can never grow a divergent copy.
    this.runs = createStudioRunSurface({
      repository: this.runRepository,
      backend: dependencies.backend,
      workspace: dependencies.workspace,
      onRunsChanged: dependencies.onRunsChanged,
      onRunDispatched: dependencies.onRunDispatched,
    })
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
