import { describe, expect, it, vi } from 'vitest'
import type { RunResultEntry, TDEaseClient } from './backend'
import { TDEaseBackendGateway, mapRun, mapRunEvent } from './studioBackendGateway'
import { UnsupportedBackendCapabilityError } from '@/studio/ports/backend-gateway'
import { asRelativePath, asRunId, asSha256, asWorkspaceId } from '@/studio/domain/identity'
import type { AnalysisCommit } from '@/studio/domain/analysis-plan'
import { BackendFailure } from '@/studio/domain/backend-failure'

describe('TDEaseBackendGateway', () => {
  it('normalizes Run and event DTO fields once', () => {
    expect(mapRun({
      run_id: 'run-1', name: 'Example', workspace_id: 'ws-1', status: 'RUNNING',
      cores: 4, rerun_mode: 'resume', labels: {}, result_file_count: 2,
      created_at: 'created', started_at: null, finished_at: null, event_seq_last: 7,
    })).toEqual({
      id: 'run-1', workspaceId: 'ws-1', title: 'Example', status: 'RUNNING',
      cores: 4, error: undefined, rerunMode: 'resume', labels: {},
      createdAt: 'created', startedAt: undefined, finishedAt: undefined,
      resultCount: 2, lastEventSeq: 7,
    })
    expect(mapRunEvent({
      schema_version: 3, run_id: 'run-1', seq: 8, timestamp: 'now', type: 'job.started',
      level: 'info', message: '', data: { job: 1 },
    })).toEqual({ runId: 'run-1', seq: 8, timestamp: 'now', type: 'job.started', data: { job: 1 } })
  })

  it('reports unavailable contracts instead of synthesizing them', async () => {
    const gateway = new TDEaseBackendGateway({} as TDEaseClient)
    await expect(
      // A backend that never wired definitions surfaces the capability gap
      // instead of inventing an empty history.
      gateway.listRunDefinitions(asRunId('run-1')),
    ).rejects.toThrow()
  })

  it('keeps observable running files without inventing an immutable digest', async () => {
    const client = {
      listRunFiles: vi.fn().mockResolvedValue([{ path: 'sample.tsv', size: 7, sha256: null }]),
    }
    const gateway = new TDEaseBackendGateway(client as unknown as TDEaseClient)

    await expect(gateway.listRunFiles(asRunId('run-1'))).resolves.toEqual([
      { path: 'sample.tsv', size: 7, digest: undefined, role: undefined },
    ])
  })

  it('projects only ready Results, and reports declared-but-absent ones by omission from the Published list', async () => {
    const entries: RunResultEntry[] = [
      {
        result_id: 'feature-table:sample-a', name: 'Features -- sample-a', kind: 'feature_table',
        dimensions: { sample: 'sample-a' }, output: 'results/sample-a/features.tsv', status: 'ready',
        digest: 'a'.repeat(64), size: 42,
        ref: { workspace_id: 'ws-1', run_id: 'run-1', result_id: 'feature-table:sample-a', digest: 'a'.repeat(64) },
      },
      {
        result_id: 'feature-table:sample-b', name: 'Features -- sample-b', kind: 'feature_table',
        dimensions: { sample: 'sample-b' }, output: 'results/sample-b/features.tsv', status: 'declared',
        digest: null, size: null,
        ref: { workspace_id: 'ws-1', run_id: 'run-1', result_id: 'feature-table:sample-b', digest: null },
      },
    ]
    const client = { listResults: vi.fn().mockResolvedValue(entries) }
    const gateway = new TDEaseBackendGateway(client as unknown as TDEaseClient)
    const results = await gateway.listResults(asRunId('run-1'))
    expect(client.listResults).toHaveBeenCalledWith('run-1')
    expect(results).toEqual([{
      ref: { workspaceId: 'ws-1', runId: 'run-1', resultId: 'feature-table:sample-a', digest: 'a'.repeat(64) },
      title: 'Features -- sample-a', kind: 'feature_table', size: 42,
      technicalPath: 'results/sample-a/features.tsv', metadata: { sample: 'sample-a' },
    }])
  })

  it('maps pagination without leaking has_more', async () => {
    const client = { listPage: vi.fn().mockResolvedValue({ runs: [], total: 0, offset: 0, limit: 20, has_more: false }) }
    await expect(new TDEaseBackendGateway(client as unknown as TDEaseClient).listRuns()).resolves.toEqual({
      items: [], total: 0, offset: 0, limit: 20, hasMore: false,
    })
  })

  it('injects materialization configuration only at the Backend adapter boundary', async () => {
    const digest = asSha256('a'.repeat(64))
    const commit: AnalysisCommit = {
      runId: asRunId('run-1'), idempotencyKey: 'ik-1', workspaceId: asWorkspaceId('ws'),
      runPath: asRelativePath('runs/soybean-all'),
      workspaceTreeHash: digest, files: [{ path: asRelativePath('Snakefile'), digest, size: 1 }],
      snakefile: 'rule all:', targets: [],
      cores: 4, config: {}, nodes: [],
    }
    const registerWorkspaceRoot = vi.fn().mockResolvedValue({ root_id: 'root_abc', path: 'C:/workspace' })
    const getCapabilities = vi.fn().mockResolvedValue({
      protocol_version: 3, auth: { scheme: 'none', bootstrap: null },
      materialization: { strategies: ['local_workspace_hardlink'] },
      limits: { max_cores: 256, max_memory_mb: 24576, total_logical_cpus: 256, reserved_service_cpus: 4, total_memory_mb: 32768, reserved_service_memory_mb: 8192, max_concurrent_runs: 1, dry_run_timeout_seconds: 300, log_tail_default_lines: 200, log_tail_max_lines: 10000 },
      engine: { name: 'snakemake', version: '1', execution_profile: 'desktop-local' },
      features: { run_definition: false, published_results: true, native_dry_run_projection: false, mutable_run_title: false, cursor_logs: false },
      multi_user: false,
    })
    const dryRun = vi.fn().mockResolvedValue({ valid: true, exit_code: 0, engine: 'tdease-workflow', output: '' })
    const submitPlan = vi.fn().mockResolvedValue({
      run_id: 'run-1', name: 'run-1', workspace_id: 'ws', status: 'QUEUED',
      cores: 4, rerun_mode: 'resume', labels: {}, result_file_count: 0,
      created_at: 'now', started_at: null, finished_at: null, event_seq_last: 1,
    })
    const gateway = new TDEaseBackendGateway(
      { dryRun, submitPlan, registerWorkspaceRoot, getCapabilities } as unknown as TDEaseClient,
      'ai',
      'C:/workspace',
    )
    await gateway.dryRun(commit)
    expect(registerWorkspaceRoot).toHaveBeenCalledWith('C:/workspace')
    expect(registerWorkspaceRoot.mock.invocationCallOrder[0]).toBeLessThan(dryRun.mock.invocationCallOrder[0]!)
    expect(dryRun).toHaveBeenCalledWith(expect.objectContaining({
      materializationStrategy: 'local_workspace_hardlink',
      localRootId: 'root_abc', localRunPath: 'runs/soybean-all',
    }), 'ai')
    expect(commit).not.toHaveProperty('mode')
    expect(commit).not.toHaveProperty('localWorkspaceRoot')

    await gateway.submit(commit)
    expect(registerWorkspaceRoot).toHaveBeenCalledTimes(1)
    expect(submitPlan).toHaveBeenCalledWith(expect.objectContaining({
      localRootId: 'root_abc', localRunPath: 'runs/soybean-all',
    }), 'ai')
  })

  it('does not retry a revoked durable capability as if it were a transient reload', async () => {
    const digest = asSha256('a'.repeat(64))
    const commit: AnalysisCommit = {
      runId: asRunId('run-1'), idempotencyKey: 'ik-1', workspaceId: asWorkspaceId('ws'),
      runPath: asRelativePath('runs/soybean-all'), workspaceTreeHash: digest,
      files: [{ path: asRelativePath('Snakefile'), digest, size: 1 }],
      snakefile: 'rule all:', targets: [], cores: 4, config: {}, nodes: [],
    }
    const escaped = new BackendFailure({
      code: 'WORKSPACE_PATH_ESCAPE', domain: 'workspace', message: 'root approval was lost',
      remedy: 'Register the Workspace root and retry.', retryable: false,
    }, true, 403)
    const registerWorkspaceRoot = vi.fn().mockResolvedValue({ root_id: 'root_abc', path: 'C:/workspace' })
    const getCapabilities = vi.fn().mockResolvedValue({
      protocol_version: 3, auth: { scheme: 'none', bootstrap: null },
      materialization: { strategies: ['local_workspace_hardlink'] },
      limits: { max_cores: 256, max_memory_mb: 24576, total_logical_cpus: 256, reserved_service_cpus: 4, total_memory_mb: 32768, reserved_service_memory_mb: 8192, max_concurrent_runs: 1, dry_run_timeout_seconds: 300, log_tail_default_lines: 200, log_tail_max_lines: 10000 },
      engine: { name: 'snakemake', version: '1', execution_profile: 'desktop-local' },
      features: { run_definition: false, published_results: true, native_dry_run_projection: false, mutable_run_title: false, cursor_logs: false },
      multi_user: false,
    })
    const dryRun = vi.fn().mockRejectedValue(escaped)
    const gateway = new TDEaseBackendGateway(
      { dryRun, registerWorkspaceRoot, getCapabilities } as unknown as TDEaseClient,
      'ai',
      'C:/workspace',
    )

    await expect(gateway.dryRun(commit)).rejects.toBe(escaped)
    expect(registerWorkspaceRoot).toHaveBeenCalledTimes(1)
    expect(dryRun).toHaveBeenCalledTimes(1)
  })
})
