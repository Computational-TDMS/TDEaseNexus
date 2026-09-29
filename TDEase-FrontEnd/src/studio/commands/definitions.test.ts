import { describe, expect, it, vi } from 'vitest'
import { contextFor } from '@/services/agent/permissionMode'
import { resolvePermission } from '@/services/agent/permissionResolver'
import { asWorkspaceId } from '../domain/identity'
import type { PermissionGateway } from '../ports/permission-gateway'
import type { StudioRuntime } from '../runtime/studio-runtime'
import { createStudioCommandRegistry } from './definitions'
import type { CommandContext } from './registry'

const allow: PermissionGateway = { decide: () => 'allow', request: vi.fn() }

function context(studio: StudioRuntime): CommandContext {
  return {
    studio, workspaceId: asWorkspaceId('workspace'), permission: allow,
    evidence: { list: vi.fn().mockResolvedValue([]), read: vi.fn(), graph: vi.fn(), write: vi.fn(), verify: vi.fn() },
  }
}

describe('Studio command definitions', () => {
  it('covers every current TDEase client capability from one registry', () => {
    const ids = createStudioCommandRegistry().list().map((definition) => definition.id)
    expect(ids).toEqual([
      'nodes.list', 'nodes.get', 'nodes.install', 'templates.list', 'templates.get',
      'workflow.inspect', 'workflow.validate', 'workflow.run',
      'workflow.prepare', 'workflow.dryRun', 'workflow.submit',
      'runs.list', 'runs.status', 'runs.wait', 'runs.tailLog', 'runs.listDefinitions', 'runs.readDefinition', 'runs.diagnose', 'runs.listFiles', 'runs.fetchFile', 'runs.pullFile',
      'runs.resume', 'runs.overwrite', 'runs.cancel', 'runs.trash', 'runs.restore',
      'uniprot.get', 'uniprot.query', 'uniprot.map', 'uniprot.blast', 'uniprot.note', 'uniprot.revise',
      'skill.read',
      'evidence.list', 'evidence.graph', 'evidence.read', 'evidence.write', 'evidence.verify',
      'turns.list', 'turns.read',
      'session.reportBlocked',
      'subagent.spawn', 'subagent.status', 'subagent.cancel', 'subagent.wait', 'subagent.followup',
      'subagent.spawnGroup', 'subagent.list', 'subagent.peek',
      'orchestrate.run', 'orchestrate.wait', 'orchestrate.status',
      'ptc.exec',
      'job.start', 'job.wait', 'job.status', 'job.peek', 'job.cancel', 'job.list',
      'view.open', 'view.focus', 'view.select',
    ])
  })

  it('registers session.reportBlocked as an allow-by-default, read-only settle tool', async () => {
    const registry = createStudioCommandRegistry()
    const definition = registry.require('session.reportBlocked')
    expect(definition.mutates).toBe(false)
    expect(definition.permission).toBeUndefined()
    await expect(registry.invoke('session.reportBlocked', {
      reason: 'no fasta reference found', needed: 'a fasta file in the Workspace',
    }, context({} as StudioRuntime))).resolves.toEqual({
      reported: true, reason: 'no fasta reference found', needed: 'a fasta file in the Workspace',
    })
    await expect(registry.invoke('session.reportBlocked', { reason: '' }, context({} as StudioRuntime))).rejects.toThrow()
  })

  it('delegates workflow and Run commands through StudioRuntime', async () => {
    const prepare = vi.fn().mockResolvedValue({ ref: 'plan_1' })
    const load = vi.fn().mockResolvedValue({
      runs: new Map([['run_1', { id: 'run_1', status: 'RUNNING' }]]),
      total: 1, offset: 0, limit: 50, hasMore: false,
    })
    const studio = {
      analysis: { prepare, dryRun: vi.fn(), submit: vi.fn(), discard: vi.fn() },
      runs: { load },
    } as unknown as StudioRuntime
    const registry = createStudioCommandRegistry()
    const commandContext = context(studio)

    await expect(registry.invoke('workflow.prepare', {
      runPath: 'runs/test-run', targets: ['results/out.tsv'],
    }, commandContext))
      .resolves.toEqual({ ref: 'plan_1' })
    expect(prepare).toHaveBeenCalledWith({ targets: ['results/out.tsv'], runPath: 'runs/test-run', managedNodes: undefined, config: undefined })

    await expect(registry.invoke('runs.list', {}, commandContext)).resolves.toEqual({
      items: [{ id: 'run_1', status: 'RUNNING' }], total: 1, offset: 0, limit: 50, hasMore: false,
    })
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: asWorkspaceId('workspace') }))
  })

  it('routes evidence writes through the command permission boundary', async () => {
    const write = vi.fn().mockResolvedValue(undefined)
    const permission: PermissionGateway = { decide: () => 'ask', request: vi.fn().mockResolvedValue(true) }
    const registry = createStudioCommandRegistry()
    const commandContext = {
      ...context({} as StudioRuntime), permission, evidence: { list: vi.fn(), read: vi.fn(), graph: vi.fn(), write, verify: vi.fn() },
    }
    const claim = {
      scope: { kind: 'workspace' }, statement: 'Observed signal', status: 'proposed',
      activity: { type: 'observation', label: 'Inspect spectrum' },
      entities: [{ path: 'runs/run_1/result.csv', role: 'support' }],
    }

    await registry.invoke('evidence.write', claim, commandContext)
    expect(permission.request).toHaveBeenCalledWith('workspace.write', 'Write Evidence')
    expect(write).toHaveBeenCalledWith(claim)
  })

  it('delegates runs.pullFile to the StudioRuntime and reports the written path', async () => {
    const pullFile = vi.fn().mockResolvedValue({ written: 'runs/chlamy-h4/results/peaks.json' })
    const studio = { runs: { pullFile } } as unknown as StudioRuntime
    const registry = createStudioCommandRegistry()
    const commandContext = context(studio)

    const definition = registry.require('runs.pullFile')
    expect(definition.mutates).toBe(true)
    expect(definition.stakes).toBeUndefined() // derives `inline` via stakesOf

    const result = await registry.invoke('runs.pullFile', { runId: 'run_1', path: 'results/peaks.json' }, commandContext)
    expect(pullFile).toHaveBeenCalledWith('run_1', 'results/peaks.json')
    expect(definition.renderForAgent?.(result as { written: string })).toBe(JSON.stringify({ written: 'runs/chlamy-h4/results/peaks.json' }))
  })

  it('projects turn cards in turns.list and returns the full card in turns.read', async () => {
    const card = {
      turnId: 'turn_1', sessionId: 'session', index: 0, ts: '2026-07-28T00:00:00.000Z',
      intent: 'check the qc run', outcome: 'resolved' as const,
      toolSummary: { 'tdease.runs.status': 2 }, runIds: ['run_1'],
      durationMs: 1200, tokens: { input: 3, output: 4 },
    }
    const registry = createStudioCommandRegistry()
    const commandContext: CommandContext = {
      ...context({} as StudioRuntime),
      turns: { list: vi.fn().mockResolvedValue([card]) },
    }

    const listed = await registry.invoke('turns.list', {}, commandContext) as Array<Record<string, unknown>>
    expect(listed).toEqual([{
      turnId: 'turn_1', index: 0, intent: 'check the qc run', outcome: 'resolved', ts: card.ts,
    }])
    expect(listed[0]).not.toHaveProperty('toolSummary')
    expect(listed[0]).not.toHaveProperty('tokens')

    await expect(registry.invoke('turns.read', { turnId: 'turn_1' }, commandContext)).resolves.toEqual(card)
    await expect(registry.invoke('turns.read', { turnId: 'turn_missing' }, commandContext)).rejects.toThrow(/No turn card/)

    // A context without the port does not advertise the commands.
    const plain = context({} as StudioRuntime)
    expect(registry.require('turns.list').enabled?.(plain)).toBe(false)
    await expect(registry.invoke('turns.list', {}, plain)).rejects.toThrow(/unavailable/)
  })

  it('asks before preparing or resuming in Ask mode', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const permission: PermissionGateway = {
      decide: (action) => resolvePermission(contextFor('ask'), action),
      request,
    }
    const prepare = vi.fn().mockResolvedValue({ ref: 'plan_1' })
    const rerun = vi.fn().mockResolvedValue({ id: 'run_1' })
    const studio = {
      analysis: { prepare, dryRun: vi.fn(), submit: vi.fn(), discard: vi.fn() },
      runs: { rerun },
    } as unknown as StudioRuntime
    const registry = createStudioCommandRegistry()
    const commandContext = { ...context(studio), permission }

    await registry.invoke('workflow.prepare', { runPath: 'runs/test-run' }, commandContext)
    await registry.invoke('runs.resume', { runId: 'run_1' }, commandContext)

    expect(request).toHaveBeenNthCalledWith(1, 'workflow.preflight', 'Prepare Workflow')
    expect(request).toHaveBeenNthCalledWith(2, 'run.resume', 'Resume Run')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(rerun).toHaveBeenCalledWith('run_1', 'resume')
  })

  it('registers the subagent three-primitives behind the subagents port gate', async () => {
    const registry = createStudioCommandRegistry()
    const spawn = vi.fn().mockResolvedValue({ subagentId: 'sub_test_1' })
    const status = vi.fn().mockResolvedValue({
      subagentId: 'sub_test_1', role: 'test', state: 'running', createdAt: 0, elapsedS: 0,
    })
    const cancel = vi.fn().mockResolvedValue({ ok: true })
    const subagents = { spawn, status, cancel }

    // No port → the commands are not advertised and refuse to run.
    const plain = context({} as StudioRuntime)
    for (const id of ['subagent.spawn', 'subagent.status', 'subagent.cancel']) {
      expect(registry.require(id).enabled?.(plain)).toBe(false)
    }
    await expect(registry.invoke('subagent.spawn', { role: 'x', task: 'y' }, plain)).rejects.toThrow(/unavailable/)

    // With the port → gated on, and each command routes to the port.
    const commandContext = { ...context({} as StudioRuntime), subagents }
    expect(registry.require('subagent.spawn').enabled?.(commandContext)).toBe(true)
    expect(registry.require('subagent.status').mutates).toBe(false)
    expect(registry.require('subagent.status').permission).toBeUndefined()
    expect(registry.require('subagent.spawn').permission).toBe('subagent.spawn')
    expect(registry.require('subagent.cancel').permission).toBe('subagent.cancel')

    await expect(registry.invoke('subagent.spawn', {
      role: 'evidence-specialist', task: 'validate scan 1164',
    }, commandContext)).resolves.toEqual({ subagentId: 'sub_test_1' })
    expect(spawn).toHaveBeenCalledWith({
      role: 'evidence-specialist', task: 'validate scan 1164',
      input: undefined, toolAllowlist: undefined, context: 'fresh', timeoutS: undefined,
    })

    await expect(registry.invoke('subagent.status', { subagentId: 'sub_test_1' }, commandContext))
      .resolves.toEqual({ subagentId: 'sub_test_1', role: 'test', state: 'running', createdAt: 0, elapsedS: 0 })
    expect(status).toHaveBeenCalledWith('sub_test_1')

    await expect(registry.invoke('subagent.cancel', { subagentId: 'sub_test_1' }, commandContext))
      .resolves.toEqual({ ok: true })
    expect(cancel).toHaveBeenCalledWith('sub_test_1')
  })
})
