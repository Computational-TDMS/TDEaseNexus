import { describe, expect, it, vi } from 'vitest'
import { asRelativePath, asRunId, asSha256, asWorkspaceId } from '../domain/identity'
import type { BackendGateway } from '../ports/backend-gateway'
import type { PermissionGateway } from '../ports/permission-gateway'
import type { WorkspaceRepository } from '../ports/workspace-repository'
import { PlanRegistry } from '../runtime/plan-registry'
import { dryRunAnalysis } from './dry-run-analysis'
import { runAnalysis } from './direct-analysis'
import { DEFAULT_SNAPSHOT_SELECTION, prepareAnalysis } from './prepare-analysis'
import { submitAnalysis } from './submit-analysis'
import { createHash } from 'node:crypto'

const snakefile = 'rule custom:\n    script: "scripts/custom.py"'
const digest = asSha256('a'.repeat(64))
const snakefileDigest = asSha256('b6e38269e7cf8c5991decf75b3b8f7ff9d54057152f70eafb359a91f01776016')

function workspace(): WorkspaceRepository {
  return {
    inspect: vi.fn().mockResolvedValue({ id: asWorkspaceId('ws'), name: 'Workspace' }),
    snapshot: vi.fn().mockResolvedValue({
      treeHash: digest,
      files: [
        { path: asRelativePath('runs/test-run/Snakefile'), digest: snakefileDigest, size: 10, role: 'workflow' },
        { path: asRelativePath('runs/test-run/scripts/custom.py'), digest, size: 20, role: 'script' },
      ],
    }),
    readText: vi.fn().mockResolvedValue(snakefile),
    writeText: vi.fn(), list: vi.fn(), watch: vi.fn().mockReturnValue(() => {}),
  }
}

function backend(): BackendGateway {
  return {
    getNode: vi.fn(), dryRun: vi.fn().mockResolvedValue({ valid: true, exitCode: 0, engine: 'tdease-workflow', output: '' }),
    submit: vi.fn().mockResolvedValue({
      id: asRunId('submitted'), workspaceId: asWorkspaceId('ws'), title: 'Run', status: 'QUEUED',
      cores: 4, rerunMode: 'resume', labels: {},
      createdAt: 'now', resultCount: 0, lastEventSeq: 0,
    }),
  } as unknown as BackendGateway
}

const allow: PermissionGateway = { decide: () => 'allow', request: vi.fn() }

describe('analysis lifecycle', () => {
  it('infers Backend Nodes and config.yaml directly from the editable Run', async () => {
    const runSnakefile = 'include: "nodes/toppic/rules.smk"\nrule all:\n    input: []\n'
    const configText = 'toppic:\n  mass_error_tolerance: 15\n  decoy: true\n'
    const hash = (value: string) => asSha256(createHash('sha256').update(value).digest('hex'))
    const ws = workspace()
    vi.mocked(ws.snapshot).mockResolvedValue({
      treeHash: digest,
      files: [
        { path: asRelativePath('runs/test-run/Snakefile'), digest: hash(runSnakefile), size: runSnakefile.length, role: 'workflow' },
        { path: asRelativePath('runs/test-run/config.yaml'), digest: hash(configText), size: configText.length, role: 'workflow' },
      ],
    })
    vi.mocked(ws.readText).mockImplementation(async (path) => path.endsWith('config.yaml') ? configText : runSnakefile)
    const api = backend()
    vi.mocked(api.getNode).mockResolvedValue({
      id: 'toppic', version: '1', digest, description: '', platforms: [],
      capabilities: [], rulesText: '', readme: '',
    })
    const registry = new PlanRegistry()
    const plan = await prepareAnalysis({ runPath: 'runs/test-run' }, {
      backend: api, workspace: ws, registry,
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION, randomId: () => 'auto',
    })

    expect(plan.nodes).toEqual([{ id: 'toppic', version: '1', digest, rules: [] }])
    expect(plan.config).toEqual({ toppic: { mass_error_tolerance: 15, decoy: true } })
    expect(registry.resolveCommit(plan.ref).config).toEqual(plan.config)
  })

  it('pins only explicitly referenced managed Node rules', async () => {
    const api = backend()
    vi.mocked(api.getNode).mockResolvedValue({
      id: 'node-a', version: '1', digest, description: '', platforms: [],
      capabilities: [
        { name: 'used_rule', inputs: [], outputs: [], params: [], message: '' },
        { name: 'unused_rule', inputs: [], outputs: [], params: [], message: '' },
      ],
      rulesText: '', readme: '',
    })
    const registry = new PlanRegistry()
    let counter = 0
    const plan = await prepareAnalysis({
      runPath: 'runs/test-run', managedNodes: [{ id: 'node-a', rules: ['used_rule'] }],
    }, {
      backend: api, workspace: workspace(), registry,
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION, randomId: () => String(++counter),
    })
    expect(plan.nodes).toEqual([{ id: 'node-a', version: '1', digest, rules: ['used_rule'] }])
    expect(registry.resolveCommit(plan.ref).nodes[0]?.rules).toEqual(['used_rule'])
  })

  it('rejects managed Node rules absent from Backend detail', async () => {
    const api = backend()
    vi.mocked(api.getNode).mockResolvedValue({
      id: 'node-a', version: '1', digest, description: '', platforms: [], capabilities: [],
      rulesText: '', readme: '',
    })
    await expect(prepareAnalysis({
      runPath: 'runs/test-run', managedNodes: [{ id: 'node-a', rules: ['invented'] }],
    }, {
      backend: api, workspace: workspace(), registry: new PlanRegistry(),
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION,
    })).rejects.toThrow('does not expose rules')
  })

  it('rejects a Snakefile that changes between snapshot and content read', async () => {
    const changed = workspace()
    vi.mocked(changed.readText).mockResolvedValue('rule changed:')
    await expect(prepareAnalysis({ runPath: 'runs/test-run' }, {
      backend: backend(), workspace: changed, registry: new PlanRegistry(),
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION,
    })).rejects.toThrow('changed while')
  })

  it('prepares and submits a script-only workflow without managed Nodes', async () => {
    const registry = new PlanRegistry()
    const api = backend()
    const ws = workspace()
    let counter = 0
    const plan = await prepareAnalysis({ runPath: 'runs/test-run' }, {
      backend: api, workspace: ws, registry,
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION, randomId: () => String(++counter),
    })
    expect(plan.nodes).toEqual([])
    expect(plan.scripts).toEqual(['scripts/custom.py'])
    expect(registry.resolveCommit(plan.ref)).toMatchObject({
      runPath: 'runs/test-run',
      files: [{ path: 'Snakefile' }, { path: 'scripts/custom.py' }],
    })
    const selection = vi.mocked(ws.snapshot).mock.calls[0]?.[0]
    expect(selection?.include(asRelativePath('runs/test-run/Snakefile'))).toBe(true)
    expect(selection?.include(asRelativePath('runs/other/Snakefile'))).toBe(false)
    await dryRunAnalysis(plan.ref, api, registry)
    await expect(submitAnalysis(plan.ref, { backend: api, permission: allow, registry })).resolves.toMatchObject({ id: 'submitted' })
    expect(registry.get(plan.ref).state).toBe('consumed')
  })

  it('keeps one Backend Run identity for repeated revisions of one Workspace Run', async () => {
    const firstRegistry = new PlanRegistry()
    const secondRegistry = new PlanRegistry()
    const first = await prepareAnalysis({ runPath: 'runs/test-run' }, {
      backend: backend(), workspace: workspace(), registry: firstRegistry,
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION, randomId: () => 'first-attempt',
    })
    const second = await prepareAnalysis({ runPath: 'runs/test-run' }, {
      backend: backend(), workspace: workspace(), registry: secondRegistry,
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION, randomId: () => 'second-attempt',
    })

    expect(firstRegistry.resolveCommit(first.ref).runId).toBe(secondRegistry.resolveCommit(second.ref).runId)
    expect(firstRegistry.resolveCommit(first.ref).idempotencyKey).not.toBe(secondRegistry.resolveCommit(second.ref).idempotencyKey)
  })

  it('does not resolve or submit a commit when permission is declined', async () => {
    const registry = new PlanRegistry()
    const api = backend()
    let counter = 0
    const plan = await prepareAnalysis({ runPath: 'runs/test-run' }, {
      backend: api, workspace: workspace(), registry,
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION, randomId: () => String(++counter),
    })
    await dryRunAnalysis(plan.ref, api, registry)
    const permission: PermissionGateway = { decide: () => 'ask', request: vi.fn().mockResolvedValue(false) }
    await expect(submitAnalysis(plan.ref, { backend: api, permission, registry })).rejects.toThrow('declined')
    expect(api.submit).not.toHaveBeenCalled()
    expect(registry.get(plan.ref).state).toBe('valid')
  })

  it('returns needs_edit and never submits when the direct run dry-run is invalid', async () => {
    const api = backend()
    vi.mocked(api.dryRun).mockResolvedValue({
      valid: false,
      exitCode: 1,
      engine: 'tdease-workflow',
      output: 'MissingInputException: Missing input files for rule custom',
    })
    let counter = 0

    await expect(runAnalysis({ runPath: 'runs/test-run' }, {
      backend: api,
      workspace: workspace(),
      registry: new PlanRegistry(),
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION,
      randomId: () => String(++counter),
    })).resolves.toMatchObject({
      status: 'needs_edit',
      stage: 'dry-run',
      recommendedAction: 'workspace.edit',
      validation: {
        status: 'needs_edit',
        errorClass: 'INPUT_DATA',
        recommendedAction: 'workspace.edit',
      },
    })
    expect(api.submit).not.toHaveBeenCalled()
  })
})
