import { describe, expect, it } from 'vitest'
import type { RunInfo } from '../../src/services/backend/client-contracts'
import type { RunResultEntry } from '../../src/services/backend/backend'

import { resolveRunReference } from './mention-resolvers'

/**
 * `resolveRunReference` is the @run resolver's pure logic point: exact run-ID
 * match first, then fall back to workspace run path / name / labels.name so a
 * human `@run:<ref>` reference resolves a Run whose id is a versioned revision
 * string (e.g. `<ref>-v2-<date>`) but whose workspace path is `runs/<ref>`. The
 * fallback is what fixed the "not found" defect where the @run token resolved
 * to NOT FOUND and the agent had to rediscover the anchor via tdease.runs.list.
 *
 * Test data is deliberately neutral placeholders — no real run, protein, or
 * dataset identifier — so this file carries no case knowledge.
 */

function baseRun(overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    run_id: 'alpha-run-v2',
    name: 'alpha-run-v2',
    workspace_id: 'ws-test',
    workspace_run_path: 'runs/alpha-run',
    current_revision: 'rev-00000019',
    status: 'SUCCEEDED',
    cores: 30,
    pid: null,
    exit_code: null,
    error: null,
    rerun_mode: 'resume',
    labels: { revision: 'v2', source_run: 'alpha-run' },
    result_file_count: 42,
    created_at: '2026-07-28T02:00:08Z',
    started_at: null,
    finished_at: '2026-07-30T08:04:38Z',
    event_seq_last: 20,
    idempotent: false,
    ...overrides,
  }
}

function result(overrides: Partial<RunResultEntry> = {}): RunResultEntry {
  return {
    result_id: 'res1',
    name: 'table',
    kind: 'table',
    dimensions: {},
    output: 'output.tsv',
    status: 'ready',
    digest: 'abc',
    size: 12700,
    ref: { workspace_id: 'ws-test', run_id: 'alpha-run-v2', result_id: 'res1', digest: 'abc' },
    ...overrides,
  }
}

function mockClient(overrides: {
  status?: (runId: string) => Promise<RunInfo>
  listResults?: (runId: string) => Promise<RunResultEntry[]>
  list?: (workspaceId?: string) => Promise<RunInfo[]>
} = {}) {
  const status = overrides.status
    ? overrides.status
    : async function (runId: string): Promise<RunInfo> {
        if (runId === 'alpha-run-v2') return baseRun()
        throw new Error(`run not found: ${runId}`)
      }
  const listResults = overrides.listResults ?? (async function () { return [result()] })
  const list = overrides.list ?? (async function () { return [baseRun()] })
  return { status, listResults, list } as unknown as import('../../src/services/backend/backend').TDEaseClient
}

describe('resolveRunReference', () => {
  it('resolves by exact run id', async () => {
    const resolved = await resolveRunReference({
      client: mockClient(),
      runId: 'alpha-run-v2',
      workspaceId: 'ws-test',
    })
    expect(resolved?.name).toBe('alpha-run-v2')
    expect(resolved?.status).toBe('SUCCEEDED')
    expect(resolved?.body).toContain('## Run alpha-run-v2')
  })

  it('falls back to workspace run path when the refId is not a real run id', async () => {
    const resolved = await resolveRunReference({
      client: mockClient({
        // status('alpha-run') fails; the fallback lists and matches
        // workspace_run_path === `runs/alpha-run`.
      }),
      runId: 'alpha-run',
      workspaceId: 'ws-test',
    })
    // The fallback resolves through the matched Run's real id, so the body
    // carries the canonical projection — not a synthetic one: the matched
    // Run's own revision line is the evidence it went through alpha-run-v2.
    expect(resolved?.name).toBe('alpha-run-v2')
    expect(resolved?.status).toBe('SUCCEEDED')
    expect(resolved?.body).toContain('## Run alpha-run-v2')
    expect(resolved?.body).toContain('- revision: rev-00000019')
  })

  it('falls back to run name when no workspace path matches', async () => {
    const resolved = await resolveRunReference({
      client: mockClient({
        list: async function () {
          return [baseRun({ workspace_run_path: 'runs/other-path', name: 'beta-alias' })]
        },
      }),
      runId: 'beta-alias',
      workspaceId: 'ws-test',
    })
    expect(resolved?.name).toBe('alpha-run-v2')
  })

  it('falls back to labels.name alias', async () => {
    const resolved = await resolveRunReference({
      client: mockClient({
        list: async function () {
          return [baseRun({ workspace_run_path: 'runs/other-path', labels: { name: 'gamma-label' } })]
        },
      }),
      runId: 'gamma-label',
      workspaceId: 'ws-test',
    })
    expect(resolved?.name).toBe('alpha-run-v2')
  })

  it('returns undefined when no run matches by id, path, name, or label', async () => {
    const resolved = await resolveRunReference({
      client: mockClient({ list: async function () { return [] } }),
      runId: 'does-not-exist',
      workspaceId: 'ws-test',
    })
    expect(resolved).toBeUndefined()
  })
})
