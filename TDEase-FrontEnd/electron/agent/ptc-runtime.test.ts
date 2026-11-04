import { describe, expect, it } from 'vitest'

import { classifyShellOutcome, createPtcPort, PTC_MAX_CALLS, type PtcToolLike } from './ptc-runtime'
import { createToolCallGate } from './tool-call-gate'
import type { Observers } from './contracts'
import type { ApprovalCoordinator, SessionBinding } from './contracts'
import type { AgentPermissionAction } from '../../src/contracts/agent-runtime'

/**
 * PTC workflow contract: a script's tool() calls pass the same policy gate as
 * a model-emitted call, execute the session's wrapped tools, stay inside the
 * two budgets, and surface errors/truncation honestly. The gate itself is the
 * real createToolCallGate; only the tool list and observers are fakes.
 */

function makeBinding(ceiling: Partial<Record<AgentPermissionAction, 'allow' | 'ask' | 'deny'>> = {}): SessionBinding {
  const permissionCeiling = Object.fromEntries(
    (['workspace.read', 'workspace.write', 'shell.exec'] as AgentPermissionAction[]).map(
      (action) => [action, ceiling[action] ?? 'allow'],
    ),
  )
  return {
    workspaceId: 'w', sessionId: 's', workspaceRoot: 'C:/ws', authority: 'local-user',
    permissionCeiling, toolCeiling: { builtins: ['read'], mcp: false }, generation: 1,
  } as SessionBinding
}

function makeObservers() {
  const audit: Array<{ name: string; ok: boolean }> = []
  const observers: Observers = {
    startUsage: () => 'h',
    finishUsage: () => undefined,
    errorUsage: () => undefined,
    auditTool: (_sessionId, _callId, name, _args, _result, ok) => { audit.push({ name, ok }) },
  }
  return { observers, audit }
}

const approving: ApprovalCoordinator = {
  request: async () => 'allow',
  resolve: () => undefined,
  hasSessionGrant: () => false,
  sessionRulesFor: () => [],
  cancelSession: () => undefined,
}

function fakeTool(name: string, impl?: (args: Record<string, unknown>) => unknown): PtcToolLike {
  return {
    name,
    execute: async (_callId, args) => impl
      ? impl(args)
      : { content: [{ type: 'text', text: `ok:${JSON.stringify(args)}` }], details: { n: 1 } },
  }
}

function rig({
  tools,
  binding = makeBinding(),
  actionForTool = () => 'workspace.read' as AgentPermissionAction,
}: {
  tools: ReadonlyArray<PtcToolLike>
  binding?: SessionBinding
  actionForTool?: (name: string) => AgentPermissionAction | undefined
}) {
  const { observers, audit } = makeObservers()
  const appended: unknown[] = []
  const port = createPtcPort({
    binding,
    tools: () => tools,
    gate: createToolCallGate({
      binding,
      approvals: approving,
      actionForTool,
      append: async (event) => { appended.push(event) },
      turnId: () => 'turn-1',
    }),
    observers,
  })
  return { port, audit, appended }
}

describe('PtcRuntime exec', () => {
  it('runs a script whose tool() calls execute the gated tools and return their text', async () => {
    const { port, audit } = rig({ tools: [fakeTool('read')] })
    const result = await port.exec({ script: `const r = await tool('read', { path: 'a.txt' }); return r.text + '|' + r.details.n` })
    expect(result.ok).toBe(true)
    expect(result.result).toBe('ok:{"path":"a.txt"}|1')
    expect(result.calls).toEqual([{ name: 'read', ok: true }])
    expect(audit).toEqual([{ name: 'read', ok: true }])
  })

  it('throws when the gate denies the action, surfacing the block reason', async () => {
    const { port } = rig({
      tools: [fakeTool('bash')],
      binding: makeBinding({ 'shell.exec': 'deny' }),
      actionForTool: () => 'shell.exec',
    })
    const result = await port.exec({ script: `await tool('bash', { command: 'ls' })` })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('blocked')
    expect(result.error).toContain('Permission denied: shell.exec')
  })

  it('resolves an ask action through the approval flow before executing', async () => {
    const { port, appended } = rig({
      tools: [fakeTool('bash')],
      binding: makeBinding({ 'shell.exec': 'ask' }),
      actionForTool: () => 'shell.exec',
    })
    const result = await port.exec({ script: `return (await tool('bash', { command: 'rg -n x' })).text` })
    expect(result.ok).toBe(true)
    expect(result.result).toContain('ok:')
    // The approval audit events rode the same append track the hook uses.
    const kinds = (appended as Array<{ type: string }>).map((event) => event.type)
    expect(kinds).toContain('approval.requested')
    expect(kinds).toContain('approval.resolved')
  })

  it('enforces the call budget with a clear error', async () => {
    const { port } = rig({ tools: [fakeTool('read')] })
    const result = await port.exec({ script: `for (let i = 0; i <= ${PTC_MAX_CALLS}; i++) await tool('read', { path: 'x' })` })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('call budget exhausted')
  })

  it('rejects an unknown tool name instead of silently skipping', async () => {
    const { port } = rig({ tools: [fakeTool('read')] })
    const result = await port.exec({ script: `await tool('nope', {})` })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unknown tool')
  })

  it('notes produced paths for successful writes, like the tool_result hook', async () => {
    const noted: string[] = []
    const { observers } = makeObservers()
    const port = createPtcPort({
      binding: makeBinding(),
      tools: () => [fakeTool('write')],
      gate: createToolCallGate({
        binding: makeBinding(),
        approvals: approving,
        actionForTool: () => 'workspace.write',
        append: async () => undefined,
        turnId: () => 't',
      }),
      observers,
      producedPaths: { note: (p) => noted.push(p), covers: () => false },
    })
    await port.exec({ script: `await tool('write', { path: 'runs/r1/out.json', content: 'x' })` })
    expect(noted).toEqual(['runs/r1/out.json'])
  })

  it('truncates an oversized return value head/tail', async () => {
    const { port } = rig({ tools: [fakeTool('read', () => ({ content: [{ type: 'text', text: 'x' }], details: {} }))] })
    const result = await port.exec({ script: `return 'y'.repeat(200000)` })
    expect(result.ok).toBe(true)
    expect(result.result!.length).toBeLessThan(100000)
    expect(result.result).toContain('truncated')
  })

  it('surfaces a tool failure as a script error naming the tool', async () => {
    const boom: PtcToolLike = {
      name: 'read',
      execute: async () => { throw new Error('ENOENT') },
    }
    const { port, audit } = rig({ tools: [boom] })
    const result = await port.exec({ script: `await tool('read', { path: 'gone' })` })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('tool(read) failed: ENOENT')
    expect(audit).toEqual([{ name: 'read', ok: false }])
  })

  it('executes in an isolated realm: process/require are unreachable from script code', async () => {
    const { port } = rig({ tools: [fakeTool('read')] })
    const result = await port.exec({
      script: [
        'const probes = [typeof process, typeof require, typeof globalThis.process]',
        // The classic vm escape: reach a Function constructor and ask it for
        // the host's process. Every function the script can name was created
        // inside the VM realm, so string compilation lands back here too —
        // where `process` has no binding at all (ReferenceError, not a value).
        'try { probes.push(String(tool.constructor.constructor("return process")())) }',
        'catch (error) { probes.push("blocked:" + error.constructor.name) }',
        'probes.push(typeof (function () { return this })().process)',
        'return probes.join(",")',
      ].join('\n'),
    })
    expect(result.ok).toBe(true)
    expect(result.result).toBe('undefined,undefined,undefined,blocked:ReferenceError,undefined')
  })
})

describe('classifyShellOutcome (O1: bash outcomes reported, not thrown)', () => {
  it('classifies the three stable Pi bash outcome markers into structured results', () => {
    expect(classifyShellOutcome('bash', new Error('(no output)\n\nCommand exited with code 3'))).toEqual({
      text: '(no output)', exitCode: 3,
    })
    expect(classifyShellOutcome('bash', new Error('Command exited with code 1'))).toEqual({
      text: '', exitCode: 1,
    })
    expect(classifyShellOutcome('bash', new Error('partial\n\nCommand timed out after 2 seconds'))).toEqual({
      text: 'partial', timedOut: true,
    })
    expect(classifyShellOutcome('bash', new Error('x\n\nCommand aborted'))).toEqual({
      text: 'x', aborted: true,
    })
  })

  it('ignores non-shell tools and genuine infrastructure failures', () => {
    expect(classifyShellOutcome('read', new Error('(no output)\n\nCommand exited with code 1'))).toBeUndefined()
    expect(classifyShellOutcome('bash', new Error('Working directory does not exist: C:/x'))).toBeUndefined()
    expect(classifyShellOutcome('bash', new Error('ENOENT'))).toBeUndefined()
  })
})
