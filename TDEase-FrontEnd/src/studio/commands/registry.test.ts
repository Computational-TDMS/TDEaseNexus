import { describe, expect, it, vi } from 'vitest'
import { asWorkspaceId } from '../domain/identity'
import type { PermissionGateway } from '../ports/permission-gateway'
import type { StudioRuntime } from '../runtime/studio-runtime'
import type { PermissionAction } from '@/services/agent/permissionResolver'
import {
  agentTools,
  CommandRegistrationError,
  CommandRegistry,
  type CommandContext,
  type CommandDefinition,
} from './registry'

const allow: PermissionGateway = { decide: () => 'allow', request: vi.fn() }

function definition(overrides: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    id: 'runs.status', title: 'Run status', summary: 'Read one Run status.',
    args: { type: 'object', additionalProperties: false, properties: {} },
    mutates: false, run: async () => ({ ok: true }),
    ...overrides,
  }
}

function context(permission: PermissionGateway = allow): CommandContext {
  return {
    studio: {} as StudioRuntime,
    workspaceId: asWorkspaceId('workspace'),
    permission,
    evidence: { list: async () => [], read: async () => ({}), graph: async () => ({}), write: async () => undefined, writeProvenance: async () => undefined },
  }
}

describe('CommandRegistry', () => {
  it('rejects invalid registrations at construction time', () => {
    expect(() => new CommandRegistry([definition(), definition()])).toThrow(CommandRegistrationError)
    expect(() => new CommandRegistry([definition({ id: 'invalid' })])).toThrow('noun>.<verb')
    expect(() => new CommandRegistry([definition({ id: 'runs.cancel', mutates: true })]))
      .toThrow('requires a permission')
    expect(() => new CommandRegistry([definition({ permission: 'run.cancel' })]))
      .toThrow('must not declare a permission')
    expect(() => new CommandRegistry([definition({
      id: 'runs.cancel', mutates: true, permission: 'not.a.permission' as PermissionAction,
    })])).toThrow('permission action is not registered')
    expect(() => new CommandRegistry([definition({ agentVisible: false })]))
      .toThrow('requires a reason')
    expect(() => new CommandRegistry([definition({ args: { type: 'array' } })]))
      .toThrow('object schema')
  })

  it('uses the same permission gateway for all command callers', async () => {
    const request = vi.fn().mockResolvedValue(true)
    const permission: PermissionGateway = { decide: () => 'ask', request }
    const run = vi.fn().mockResolvedValue({ cancelled: true })
    const registry = new CommandRegistry([definition({
      id: 'runs.cancel', mutates: true, permission: 'run.cancel', run,
    })])

    await expect(registry.invoke('runs.cancel', {}, context(permission))).resolves.toEqual({ cancelled: true })
    expect(request).toHaveBeenCalledWith('run.cancel', 'Run status')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('derives visible non-denied Agent tools from the registry', () => {
    const registry = new CommandRegistry([
      definition({ id: 'nodes.list' }),
      definition({ id: 'runs.cancel', mutates: true, permission: 'run.cancel' }),
      definition({ id: 'runs.trash', mutates: true, permission: 'run.trash', agentVisible: false, hiddenReason: 'UI-only bulk action' }),
    ])
    const tools = agentTools(registry, { decide: (action) => action === 'run.cancel' ? 'deny' : 'allow' })

    expect(tools).toEqual([expect.objectContaining({
      id: 'nodes.list', name: 'tdease.nodes.list', description: 'Read one Run status.',
    })])
  })
})
