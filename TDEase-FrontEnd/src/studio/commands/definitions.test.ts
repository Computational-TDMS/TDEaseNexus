import { describe, expect, it, vi } from 'vitest'
import { contextFor } from '@/services/agent/permissionMode'
import { resolvePermission } from '@/services/agent/permissionResolver'
import { asWorkspaceId } from '../domain/identity'
import type { PermissionGateway } from '../ports/permission-gateway'
import { createStudioCommandRegistry } from './definitions'
import type { CommandContext, StudioCommandSurface } from './registry'

const allow: PermissionGateway = { decide: () => 'allow', request: vi.fn() }

/** A fully-typed surface whose every member refuses: each test overrides only
 *  the members a command actually touches, and the type-checker now holds the
 *  stub to the real `StudioCommandSurface` shape (no assertion escape hatch). */
function refusedSurface(): StudioCommandSurface {
  const refused = (what: string): () => never => () => {
    throw new Error(`${what} is not exercised by this test`)
  }
  return {
    runs: {
      snapshot: refused('runs.snapshot'),
      onChange: refused('runs.onChange'),
      load: refused('runs.load'),
      loadMore: refused('runs.loadMore'),
      refresh: refused('runs.refresh'),
      listDefinitions: refused('runs.listDefinitions'),
      readDefinition: refused('runs.readDefinition'),
      wait: refused('runs.wait'),
      drainSettledRuns: refused('runs.drainSettledRuns'),
      tailLog: refused('runs.tailLog'),
      diagnose: refused('runs.diagnose'),
      listFiles: refused('runs.listFiles'),
      fetchFile: refused('runs.fetchFile'),
      pullFile: refused('runs.pullFile'),
      cancel: refused('runs.cancel'),
      rerun: refused('runs.rerun'),
      trash: refused('runs.trash'),
      restore: refused('runs.restore'),
    },
    analysis: {
      inspect: refused('analysis.inspect'),
      validate: refused('analysis.validate'),
      run: refused('analysis.run'),
      prepare: refused('analysis.prepare'),
      dryRun: refused('analysis.dryRun'),
      submit: refused('analysis.submit'),
      discard: refused('analysis.discard'),
    },
    discovery: {
      listNodes: refused('discovery.listNodes'),
      getNode: refused('discovery.getNode'),
      listTemplates: refused('discovery.listTemplates'),
      getTemplate: refused('discovery.getTemplate'),
    },
  }
}

function context(studio: StudioCommandSurface): CommandContext {
  return {
    studio, workspaceId: asWorkspaceId('workspace'), permission: allow,
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
      'session.reportBlocked',
      'subagent.spawn', 'subagent.status', 'subagent.cancel', 'subagent.wait', 'subagent.followup',
      'subagent.spawnGroup', 'subagent.list', 'subagent.peek',
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
    }, context(refusedSurface()))).resolves.toEqual({
      reported: true, reason: 'no fasta reference found', needed: 'a fasta file in the Workspace',
    })
    await expect(registry.invoke('session.reportBlocked', { reason: '' }, context(refusedSurface()))).rejects.toThrow()
  })

  it('delegates workflow and Run commands through StudioRuntime', async () => {
    const prepare = vi.fn().mockResolvedValue({ ref: 'plan_1' })
    const load = vi.fn().mockResolvedValue({
      runs: new Map([['run_1', { id: 'run_1', status: 'RUNNING' }]]),
      total: 1, offset: 0, limit: 50, hasMore: false,
    })
    const base = refusedSurface()
    const studio: StudioCommandSurface = {
      analysis: { ...base.analysis, prepare, dryRun: vi.fn(), submit: vi.fn(), discard: vi.fn() },
      runs: { ...base.runs, load },
      discovery: base.discovery,
    }
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


  it('delegates runs.pullFile to the StudioRuntime and reports the written path', async () => {
    const pullFile = vi.fn().mockResolvedValue({ written: 'runs/chlamy-h4/results/peaks.json' })
    const base = refusedSurface()
    const studio: StudioCommandSurface = { ...base, runs: { ...base.runs, pullFile } }
    const registry = createStudioCommandRegistry()
    const commandContext = context(studio)

    const definition = registry.require('runs.pullFile')
    expect(definition.mutates).toBe(true)
    expect(definition.stakes).toBeUndefined() // derives `inline` via stakesOf

    const result = await registry.invoke('runs.pullFile', { runId: 'run_1', path: 'results/peaks.json' }, commandContext)
    expect(pullFile).toHaveBeenCalledWith('run_1', 'results/peaks.json', {})
    expect(definition.renderForAgent?.(result)).toBe(JSON.stringify({ written: 'runs/chlamy-h4/results/peaks.json' }))
  })

  it('asks before preparing or resuming in Ask mode', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const permission: PermissionGateway = {
      decide: (action) => resolvePermission(contextFor('ask'), action),
      request,
    }
    const prepare = vi.fn().mockResolvedValue({ ref: 'plan_1' })
    const rerun = vi.fn().mockResolvedValue({ id: 'run_1' })
    const base = refusedSurface()
    const studio: StudioCommandSurface = {
      analysis: { ...base.analysis, prepare, dryRun: vi.fn(), submit: vi.fn(), discard: vi.fn() },
      runs: { ...base.runs, rerun },
      discovery: base.discovery,
    }
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
    const plain = context(refusedSurface())
    for (const id of ['subagent.spawn', 'subagent.status', 'subagent.cancel']) {
      expect(registry.require(id).enabled?.(plain)).toBe(false)
    }
    await expect(registry.invoke('subagent.spawn', { role: 'x', task: 'y' }, plain)).rejects.toThrow(/unavailable/)

    // With the port → gated on, and each command routes to the port.
    const commandContext = { ...context(refusedSurface()), subagents }
    expect(registry.require('subagent.spawn').enabled?.(commandContext)).toBe(true)
    expect(registry.require('subagent.status').mutates).toBe(false)
    expect(registry.require('subagent.status').permission).toBeUndefined()
    expect(registry.require('subagent.spawn').permission).toBe('subagent.spawn')
    expect(registry.require('subagent.cancel').permission).toBe('subagent.cancel')

    await expect(registry.invoke('subagent.spawn', {
      role: 'spectrum-specialist', task: 'validate scan 1164',
    }, commandContext)).resolves.toEqual({ subagentId: 'sub_test_1' })
    expect(spawn).toHaveBeenCalledWith({
      role: 'spectrum-specialist', task: 'validate scan 1164',
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
