import type { RunSummary } from '../domain/run'
import type { BackendGateway } from '../ports/backend-gateway'
import type { WorkspaceRepository } from '../ports/workspace-repository'
import { diagnoseRun } from '../use-cases/diagnose-run'
import type { RunRepository } from './run-repository'
import type { StudioRunRuntime } from './studio-runtime'
import { pullRunFile } from '../use-cases/pull-run-file'

/**
 * Everything the Run face of Studio needs, shared by every host that assembles
 * one: the full `StudioRuntime` (Agent/main) and the renderer's Run store, which
 * owns its own repository and must not build a second `StudioRuntime` next to
 * the Agent's (that would open a second Workspace file watcher).
 */
export interface StudioRunSurfaceDependencies {
  repository: RunRepository
  backend: BackendGateway
  /** Present in the full StudioRuntime; absent hosts refuse `pullFile` rather
   *  than silently no-op. */
  workspace?: WorkspaceRepository
  onRunsChanged?: () => void
  /** A run this surface DISPATCHED (runs.rerun) — the session-scoped run
   *  channel's record source, mirroring StudioRuntimeDependencies. */
  onRunDispatched?: (run: RunSummary) => void
}

/**
 * The `StudioRunRuntime` face over one RunRepository — migrated verbatim from
 * the StudioRuntime constructor's `this.runs` literal.
 */
export function createStudioRunSurface(deps: StudioRunSurfaceDependencies): StudioRunRuntime {
  const { repository, backend } = deps
  return {
    snapshot: () => repository.snapshot(),
    onChange: (listener) => repository.onChange(listener),
    load: (query) => repository.load(query),
    loadMore: (query) => repository.loadMore(query),
    // Every run-addressed call resolves first: callers name a run by its
    // Workspace data folder (`soybean-all` / `runs/soybean-all`) and the
    // repository maps that to the backend RunId. See RunRepository.resolveRunId.
    refresh: async (runId) => repository.refresh(await repository.resolveRunId(runId)),
    listDefinitions: async (runId) => repository.listDefinitions(await repository.resolveRunId(runId)),
    readDefinition: async (runId, definitionRevisionId) => repository.readDefinition(await repository.resolveRunId(runId), definitionRevisionId),
    wait: async (runId, deadlineMs, signal) => repository.wait(await repository.resolveRunId(runId), deadlineMs, signal),
    drainSettledRuns: () => repository.drainSettledRuns(),
    tailLog: async (runId, lines) => backend.readLog(await repository.resolveRunId(runId), lines),
    diagnose: async (runId) => diagnoseRun(await repository.resolveRunId(runId), backend),
    listFiles: async (runId, pattern, revision) => backend.listRunFiles(await repository.resolveRunId(runId), pattern, revision),
    fetchFile: async (runId, path, revision) => backend.fetchRunFile(await repository.resolveRunId(runId), path, revision),
    pullFile: async (runId, path, options) => {
      if (!deps.workspace) throw new Error('pullFile is not available without a Workspace')
      return pullRunFile(await repository.resolveRunId(runId), path, { backend: deps.backend, workspace: deps.workspace }, options)
    },
    cancel: async (runId) => {
      await repository.cancel(await repository.resolveRunId(runId))
      deps.onRunsChanged?.()
    },
    rerun: async (runId, mode) => {
      const run = await repository.rerun(await repository.resolveRunId(runId), mode)
      deps.onRunsChanged?.()
      deps.onRunDispatched?.(run)
      return run
    },
    trash: async (runId) => {
      await repository.trash(await repository.resolveRunId(runId))
      deps.onRunsChanged?.()
    },
    restore: async (runId) => {
      const run = await repository.restore(await repository.resolveRunId(runId))
      deps.onRunsChanged?.()
      return run
    },
  }
}
