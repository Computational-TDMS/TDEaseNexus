/**
 * The Run commit surface no longer carries a caller-declared `mode`.
 *
 * The Backend selects the materialization strategy itself and *rejects* a
 * commit that declares one — `_reject_removed_commit_fields` in
 * `app/api/runs_v2.py` raises `RUN_MODE_MISMATCH` on both `POST /api/v2/runs`
 * and `POST /api/v2/runs/dry-run`, and `tests/test_runs_api.py` pins that.
 *
 * The client kept sending it long after the Backend stopped accepting it,
 * which meant every submission and every dry-run failed. Nothing on either
 * side caught the drift: the Backend's test proved the rejection worked, the
 * client's tests never inspected the wire. This file is the missing half —
 * it asserts on the bytes the client actually sends.
 *
 * Client-side transfer selection uses the concrete materialization strategy.
 * It is adapter state and does not cross the Run commit wire boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TDEaseClient } from './backend'
import type { CommitPlan } from './client-contracts'

let bodies: Array<{ url: string; body: Record<string, unknown> }> = []

beforeEach(() => {
  bodies = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const plan: CommitPlan = {
  runId: 'run_abc',
  idempotencyKey: 'ik_abc',
  workspaceId: 'ws_abc',
  workspaceTreeHash: 'sha256:tree',
  workspaceFiles: [],
  excludedFiles: [],
  snakefile: 'rule all:\n    input: []\n',
  localRootId: 'root_abc',
  localRunPath: 'runs/example',
  materializationStrategy: 'local_workspace_hardlink',
  targets: [],
  config: {},
  nodes: [],
  warnings: [],
}

function commitOf(index = 0): Record<string, unknown> {
  return bodies[index]!.body.commit as Record<string, unknown>
}

describe('the Run commit the client puts on the wire', () => {
  it('registers a local Workspace root through the public Backend protocol', async () => {
    await new TDEaseClient('http://backend').registerWorkspaceRoot('C:/work')
    expect(bodies[0]).toEqual({
      url: 'http://backend/api/workspace-roots',
      body: { path: 'C:/work' },
    })
  })

  it('omits mode when submitting a plan', async () => {
    await new TDEaseClient('http://backend').submitPlan(plan)
    expect(commitOf()).not.toHaveProperty('mode')
  })

  it('omits mode when dry-running a plan', async () => {
    await new TDEaseClient('http://backend').dryRun(plan)
    expect(bodies[0]!.url).toContain('/api/v2/runs/dry-run')
    expect(commitOf()).not.toHaveProperty('mode')
  })

  it('still sends the fields the Backend does require', async () => {
    await new TDEaseClient('http://backend').submitPlan(plan)
    const commit = commitOf()
    expect(commit.run_id).toBe('run_abc')
    expect(commit.workspace_id).toBe('ws_abc')
    expect(commit.workspace_tree_hash).toBe('sha256:tree')
    expect(commit.local_root_id).toBe('root_abc')
    expect(commit.local_run_path).toBe('runs/example')
  })
})

describe('declared Published Results on the wire', () => {
  it('sends result_specs when the plan declares results', async () => {
    await new TDEaseClient('http://backend').submitPlan({
      ...plan,
      resultSpecs: [{
        result_id: 'feature-table:sample-a',
        name: 'Feature table (sample A)',
        kind: 'feature_table',
        dimensions: { sample: 'sample-a' },
        output: 'results/features_sample-a.csv',
      }],
    })
    expect(commitOf().result_specs).toEqual([{
      result_id: 'feature-table:sample-a',
      name: 'Feature table (sample A)',
      kind: 'feature_table',
      dimensions: { sample: 'sample-a' },
      output: 'results/features_sample-a.csv',
    }])
  })

  /**
   * Omitted, not `[]`. The Backend projects declared-but-absent results as
   * `declared`; sending an
   * empty list would assert "this Run publishes nothing", which is a different
   * claim from a client that does not declare results at all.
   */
  it('omits result_specs entirely when the plan declares none', async () => {
    await new TDEaseClient('http://backend').submitPlan(plan)
    expect(commitOf()).not.toHaveProperty('result_specs')
  })
})
