import { describe, expect, it, vi } from 'vitest'
import { asRunId, asWorkspaceId } from '../domain/identity'
import type { BackendGateway } from '../ports/backend-gateway'
import { diagnoseRun } from './diagnose-run'

describe('diagnoseRun', () => {
  it('classifies an orphaned Backend execution and recommends resume', async () => {
    const backend = {
      getRun: vi.fn().mockResolvedValue({
        id: asRunId('run_1'), workspaceId: asWorkspaceId('ws'), title: 'Run', status: 'FAILED',
        cores: 28, error: 'orphaned: worker process not found (backend restarted)',
        rerunMode: 'resume', labels: {}, createdAt: 'now', resultCount: 0, lastEventSeq: 4,
      }),
      getRunGraph: vi.fn().mockResolvedValue({ runId: asRunId('run_1'), nodes: [], edges: [] }),
      readLog: vi.fn().mockResolvedValue({ text: '', lines: 0 }),
      listRunFiles: vi.fn().mockResolvedValue([]),
    } as unknown as BackendGateway

    await expect(diagnoseRun(asRunId('run_1'), backend)).resolves.toMatchObject({
      errorClass: 'BACKEND_ORPHANED', recommendedAction: 'runs.resume',
    })
  })

  it('returns failed DAG jobs and routes definition failures to editing', async () => {
    const backend = {
      getRun: vi.fn().mockResolvedValue({
        id: asRunId('run_2'), workspaceId: asWorkspaceId('ws'), title: 'Run', status: 'FAILED',
        cores: 4, error: 'RuleException: invalid config', rerunMode: 'resume',
        labels: {}, createdAt: 'now', resultCount: 0, lastEventSeq: 8,
      }),
      getRunGraph: vi.fn().mockResolvedValue({
        runId: asRunId('run_2'), edges: [],
        nodes: [{ id: 3, rule: 'search', label: 'search', initial_status: 'waiting', status: 'failed', wildcards: { sample: 'A' } }],
      }),
      readLog: vi.fn().mockResolvedValue({ text: 'Config file is invalid', lines: 1 }),
      listRunFiles: vi.fn().mockResolvedValue([]),
    } as unknown as BackendGateway

    const result = await diagnoseRun(asRunId('run_2'), backend)
    expect(result.errorClass).toBe('WORKFLOW_DEFINITION')
    expect(result.failedJobs).toEqual([{ id: 3, rule: 'search', wildcards: { sample: 'A' } }])
    expect(result.recommendedAction).toBe('workspace.edit')
  })
})
