import { describe, expect, it, vi } from 'vitest'
import { asRelativePath, asRunId, asWorkspaceId, type RunId, type RelativePath } from '../domain/identity'
import type { RunSummary } from '../domain/run'
import type { BackendGateway } from '../ports/backend-gateway'
import type { WorkspaceRepository } from '../ports/workspace-repository'
import { StudioRuntime, pullRunFile } from './studio-runtime'
import type { RunRepository } from './run-repository'
import type { RunSubscriptions } from './run-subscriptions'

/** A minimal RunSummary that only carries what pullRunFile reads. */
function runSummary(over: Partial<RunSummary>): RunSummary {
  return {
    id: asRunId('run_1'), workspaceId: asWorkspaceId('ws'), title: 'run',
    status: 'SUCCEEDED', cores: 1, rerunMode: 'resume', labels: {},
    createdAt: '2026-07-28T00:00:00.000Z', resultCount: 0, lastEventSeq: 0,
    ...over,
  }
}

/**
 * The end-to-end core link: a Run's Backend artifact must land in its owning
 * Workspace Run directory, not an arbitrary path, and `workspaceRunPath` must
 * win over the `labels.source_run` fallback.
 */
describe('StudioRuntime pullRunFile', () => {
  it('writes the fetched file into runs/<source_run>/results/<path>', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const backend = {
      getRun: vi.fn().mockResolvedValue(runSummary({ labels: { source_run: 'chlamy-h4' } })),
      fetchRunFile: vi.fn().mockResolvedValue(new Blob([bytes])),
    } as unknown as BackendGateway
    const written = vi.fn<(path: RelativePath, data: Uint8Array) => Promise<void>>()
      .mockResolvedValue(undefined)
    const workspace = { writeBytes: written } as unknown as WorkspaceRepository

    const result = await pullRunFile(asRunId('run_1'), asRelativePath('results/peaks.json'), { backend, workspace })

    // The Run file lands under its owning folder, results/ prefix preserved.
    expect(result.written).toBe('runs/chlamy-h4/results/peaks.json')
    expect(written).toHaveBeenCalledTimes(1)
    expect(written).toHaveBeenCalledWith('runs/chlamy-h4/results/peaks.json', expect.any(Uint8Array))
    // The bytes that reached disk match what the Backend served.
    expect(Array.from(written.mock.calls[0][1])).toEqual([1, 2, 3, 4])
  })

  it('prefers workspaceRunPath over the labels.source_run fallback', async () => {
    const backend = {
      getRun: vi.fn().mockResolvedValue(runSummary({
        workspaceRunPath: 'runs/renamed-run', labels: { source_run: 'chlamy-h4' },
      })),
      fetchRunFile: vi.fn().mockResolvedValue(new Blob([9])),
    } as unknown as BackendGateway
    const written = vi.fn<(path: RelativePath, data: Uint8Array) => Promise<void>>().mockResolvedValue(undefined)
    const workspace = { writeBytes: written } as unknown as WorkspaceRepository

    const result = await pullRunFile(asRunId('run_1'), asRelativePath('ms2.msalign'), { backend, workspace })

    expect(result.written).toBe('runs/renamed-run/ms2.msalign')
  })

  it('rejects when the Run has neither a workspace path nor a source_run label', async () => {
    const backend = { getRun: vi.fn().mockResolvedValue(runSummary({ labels: {} })) } as unknown as BackendGateway
    const workspace = {} as unknown as WorkspaceRepository

    await expect(pullRunFile(asRunId('run_1'), asRelativePath('x.tsv'), { backend, workspace }))
      .rejects.toThrow(/no workspace destination path/)
  })
})

describe('StudioRuntime Run invalidation', () => {
  it('notifies the owning client only after a Run mutation succeeds', async () => {
    const changed = vi.fn()
    const rerun = vi.fn().mockResolvedValue(runSummary({ status: 'QUEUED' }))
    const runtime = new StudioRuntime({
      backend: {} as BackendGateway,
      workspace: {
        watch: () => () => {},
        inspect: vi.fn().mockResolvedValue({ id: asWorkspaceId('ws'), name: 'Workspace' }),
      } as unknown as WorkspaceRepository,
      snapshotSelection: {} as never,
      templates: { list: vi.fn().mockResolvedValue([]), get: vi.fn() },
      runRepository: { rerun, resolveRunId: vi.fn((id: RunId) => Promise.resolve(id)) } as unknown as RunRepository,
      runSubscriptions: { dispose: vi.fn() } as unknown as RunSubscriptions,
      onRunsChanged: changed,
    })

    await runtime.runs.rerun(asRunId('run_1'), 'resume')

    expect(rerun).toHaveBeenCalledWith('run_1', 'resume')
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
