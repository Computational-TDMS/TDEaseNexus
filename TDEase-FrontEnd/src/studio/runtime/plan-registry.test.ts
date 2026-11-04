import { describe, expect, it } from 'vitest'
import { asPlanRef, asRelativePath, asRunId, asSha256, asWorkspaceId } from '../domain/identity'
import type { AnalysisCommit, PreparedPlanView } from '../domain/analysis-plan'
import { PlanRegistry } from './plan-registry'

const digest = asSha256('a'.repeat(64))
const ref = asPlanRef('plan-1')
const commit: AnalysisCommit = {
  runId: asRunId('run-1'), idempotencyKey: 'ik-1', workspaceId: asWorkspaceId('ws'),
  runPath: asRelativePath('runs/soybean-all'),
  workspaceTreeHash: digest, files: [{ path: asRelativePath('Snakefile'), digest, size: 10 }],
  snakefile: 'rule all:',
  targets: [], cores: 4, config: {}, nodes: [],
}
const view: PreparedPlanView = {
  ref, digest, workspaceTreeHash: digest, state: 'prepared', snakefilePath: asRelativePath('Snakefile'),
  nodes: [], scripts: [], inputSummary: [], config: {}, targets: [], resources: { cores: 4 }, warnings: [],
}

describe('PlanRegistry', () => {
  it('rejects submission before successful validation', () => {
    const registry = new PlanRegistry()
    registry.add(commit, view, () => true)
    expect(() => registry.beginSubmit(ref)).toThrow('successful dry-run')
  })

  it('allows exactly the validated immutable commit to submit and consume', () => {
    const registry = new PlanRegistry()
    registry.add(commit, view, () => true)
    registry.beginValidation(ref)
    registry.completeValidation(ref, { valid: true, exitCode: 0, engine: 'tdease-workflow', output: '' })
    expect(registry.beginSubmit(ref)).toBe(commit)
    expect(registry.consume(ref).state).toBe('consumed')
    expect(() => registry.beginSubmit(ref)).toThrow()
  })

  it('expires plans when a frozen Workspace file changes', () => {
    const registry = new PlanRegistry()
    registry.add(commit, view, () => true)
    expect(registry.expireWorkspace(commit.workspaceId, asRelativePath('runs/soybean-all/Snakefile'))).toEqual([ref])
    expect(registry.get(ref).state).toBe('expired')
    expect(() => registry.beginValidation(ref)).toThrow()
  })

  it('expires when a newly added path belongs to the original snapshot policy', () => {
    const registry = new PlanRegistry()
    registry.add(commit, view, (path) => path.startsWith('scripts/'))
    expect(registry.expireWorkspace(commit.workspaceId, asRelativePath('runs/soybean-all/scripts/new.py'))).toEqual([ref])
    expect(registry.get(ref).state).toBe('expired')
  })

  it('ignores Agent audit writes and changes in sibling Runs', () => {
    const registry = new PlanRegistry()
    registry.add(commit, view, () => true)
    expect(registry.expireWorkspace(commit.workspaceId, asRelativePath('.tdease/sessions/s1/events.jsonl'))).toEqual([])
    expect(registry.expireWorkspace(commit.workspaceId, asRelativePath('runs/other/Snakefile'))).toEqual([])
    expect(registry.get(ref).state).toBe('prepared')
  })
})
