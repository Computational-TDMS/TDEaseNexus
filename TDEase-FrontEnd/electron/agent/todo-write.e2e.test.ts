import path from 'node:path'
import os from 'node:os'

import { describe, expect, it } from 'vitest'

import { buildToolCeiling } from './agent-runtime'
import { createToolGateway } from './tool-gateway'
import { NodePermissionGateway } from './permission-gateway'
import { PtyTerminalService } from './pty-terminal'
import { deepFreeze, type SessionBinding } from './turn-definition'
import { createAgentToolProfile, DEFAULT_AGENT_TOOL_SETTINGS } from '../../src/agent/tool-profile'
import type { CommandContext } from '../../src/studio/commands/registry'
import type { StudioRuntime } from '../../src/studio/runtime/studio-runtime'
import { createStudioCommandRegistry } from '../../src/studio/commands/definitions'
import { asWorkspaceId } from '../../src/studio/domain/identity'
import {
  AGENT_PERMISSION_ACTIONS,
  type PermissionSnapshot,
} from '../../src/contracts/agent-runtime'

/**
 * todo_write — the session task plan, restored. The full chain on the REAL
 * gateway: profile → ceiling (buildToolCeiling consumes includeTodo) →
 * buildBuiltinTools factory → the wrapped execute (containment + permission
 * gate included). The renderer half (parseTodos / SessionTodoCard) reads the
 * tool call args off the transcript and needs no runtime cooperation, so this
 * file is the runtime's whole obligation.
 */

function makeBinding(root: string, deny?: PermissionSnapshot): SessionBinding {
  const permissionCeiling = (deny ?? Object.fromEntries(
    AGENT_PERMISSION_ACTIONS.map((action) => [action, 'allow']),
  ) as PermissionSnapshot) as PermissionSnapshot
  return deepFreeze<SessionBinding>({
    workspaceId: 'todo-write', sessionId: 'session-todo',
    workspaceRoot: root, authority: 'local-user',
    permissionCeiling, toolCeiling: { builtins: ['todo_write'], mcp: false }, generation: 1,
  })
}

function makeContext(): CommandContext {
  return {
    studio: {} as StudioRuntime,
    workspaceId: asWorkspaceId('todo-write'),
    permission: { decide: () => 'allow' as const, request: async () => true },
    evidence: {
      list: async () => [], read: async () => null, graph: async () => null,
      write: async () => null, verify: async () => null,
    },
    skills: { list: async () => [], read: async () => null, run: async () => null },
    spectra: { query: async () => null, select: async () => null, export: async () => null },
    turns: { list: async () => [] },
  } as unknown as CommandContext
}

function makeTodoTool(binding: SessionBinding) {
  const permission = new NodePermissionGateway(binding)
  const gateway = createToolGateway({
    binding,
    permission,
    workspaceRoot: binding.workspaceRoot,
    systemRoot: binding.workspaceRoot,
    terminals: new PtyTerminalService(),
    systemAssetsRoot: binding.workspaceRoot,
    resolveBashEnv: () => process.env,
    managedBinDir: path.join(binding.workspaceRoot, '.bin'),
    studioContext: makeContext(),
    commandRegistry: createStudioCommandRegistry(),
    profile: {
      allowsStudioCommand: () => false,
      runtime: { builtins: [], mcp: false } as never,
    },
  })
  const tools = gateway.buildBuiltinTools(['todo_write']) as Array<{
    execute: (callId: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>
  }>
  expect(tools).toHaveLength(1)
  return tools[0]
}

const TWO_TODOS = {
  todos: [
    { content: 'Inspect files', activeForm: 'Inspecting files', status: 'completed' },
    { content: 'Build workflow', activeForm: 'Building workflow', status: 'in_progress' },
  ],
}

describe('todo_write builtin (restored)', () => {
  it('reaches the ceiling only for executor — buildToolCeiling consumes includeTodo', () => {
    const executor = buildToolCeiling(createAgentToolProfile('executor', DEFAULT_AGENT_TOOL_SETTINGS))
    const explorer = buildToolCeiling(createAgentToolProfile('explorer', DEFAULT_AGENT_TOOL_SETTINGS))
    expect(executor.builtins).toContain('todo_write')
    expect(explorer.builtins).not.toContain('todo_write')
  })

  it('replaces the whole list: a valid payload returns the summary text the transcript fixtures use', async () => {
    const tool = makeTodoTool(makeBinding(os.tmpdir()))
    const result = await tool.execute('call-1', TWO_TODOS)
    expect(result.content[0].text).toBe('Updated 2 tasks (1 completed).')
  })

  it('is exempt from the file-permission ceiling — a denied workspace.write cannot kill the plan', async () => {
    const denyWrite = Object.fromEntries(
      AGENT_PERMISSION_ACTIONS.map((action) => [action, action === 'workspace.write' ? 'deny' : 'allow']),
    ) as PermissionSnapshot
    const tool = makeTodoTool(makeBinding(os.tmpdir(), denyWrite))
    const result = await tool.execute('call-2', TWO_TODOS)
    expect(result.content[0].text).toBe('Updated 2 tasks (1 completed).')
  })

  it('throws on an invalid item — errors travel the Pi throw path, not content', async () => {
    const tool = makeTodoTool(makeBinding(os.tmpdir()))
    await expect(tool.execute('call-3', { todos: [{ content: '', activeForm: 'x', status: 'pending' }] }))
      .rejects.toThrow('invalid todo item')
    await expect(tool.execute('call-4', { todos: [{ content: 'ok', activeForm: 'ok', status: 'done' }] }))
      .rejects.toThrow('invalid todo item')
  })
})
