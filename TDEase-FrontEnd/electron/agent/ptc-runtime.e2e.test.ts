import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPtcPort } from './ptc-runtime'
import { createToolCallGate } from './tool-call-gate'
import { createToolGateway } from './tool-gateway'
import { NodePermissionGateway } from './permission-gateway'
import { PtyTerminalService } from './pty-terminal'
import { deepFreeze, type SessionBinding } from './turn-definition'
import type { Observers } from './contracts'
import type { ApprovalCoordinator } from './contracts'
import type { CommandContext } from '../../src/studio/commands/registry'
import type { StudioRuntime } from '../../src/studio/runtime/studio-runtime'
import { createStudioCommandRegistry } from '../../src/studio/commands/definitions'
import { asWorkspaceId } from '../../src/studio/domain/identity'
import {
  AGENT_PERMISSION_ACTIONS,
  type PermissionSnapshot,
} from '../../src/contracts/agent-runtime'

/**
 * PTC end-to-end on the REAL tool chain: real ToolGateway (Pi's bash tool with
 * the containment + permission wrapper), real NodePermissionGateway, real
 * ToolCallGate, real Git Bash subprocess. This is the verification
 * docs/design/PTC-RELIABILITY.md O3 exists for — the unit suite runs fakes and
 * can never see how a script behaves on a real bash.
 *
 * Requires a bash on PATH / Git Bash install (Pi's getShellConfig resolves
 * Program Files\Git\bin\bash.exe on Windows).
 */

function makeContext(root: string): CommandContext {
  return {
    studio: {} as StudioRuntime,
    workspaceId: asWorkspaceId('ptc-e2e'),
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

function makeBinding(root: string, shellExec: 'allow' | 'deny' | 'ask' = 'allow'): SessionBinding {
  const ceiling = Object.fromEntries(
    AGENT_PERMISSION_ACTIONS.map((action) => [action, action === 'shell.exec' ? shellExec : 'allow']),
  ) as PermissionSnapshot
  return deepFreeze<SessionBinding>({
    workspaceId: 'ptc-e2e', sessionId: 'session-ptc-e2e',
    workspaceRoot: root, authority: 'local-user',
    permissionCeiling: ceiling, toolCeiling: { builtins: ['bash'], mcp: false }, generation: 1,
  })
}

function makeObservers() {
  const audit: Array<{ name: string; ok: boolean; result: unknown }> = []
  const observers: Observers = {
    startUsage: () => 'h',
    finishUsage: () => undefined,
    errorUsage: () => undefined,
    auditTool: (_sessionId, _callId, name, _args, result, ok) => { audit.push({ name, ok, result }) },
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

/** Real gateway + gate + permission + PTY registry, ported to a temp workspace root. */
function rig(root: string, shellExec: 'allow' | 'deny' | 'ask' = 'allow') {
  const binding = makeBinding(root, shellExec)
  const permission = new NodePermissionGateway(binding)
  const terminals = new PtyTerminalService()
  const gateway = createToolGateway({
    binding,
    permission,
    workspaceRoot: root,
    systemRoot: root,
    terminals,
    systemAssetsRoot: path.join(root, 'system-assets'),
    resolveBashEnv: () => ({ ...process.env }),
    managedBinDir: path.join(root, '.bin'),
    studioContext: makeContext(root),
    commandRegistry: createStudioCommandRegistry(),
    profile: {
      allowsStudioCommand: () => false,
      runtime: { builtins: ['bash'], mcp: false } as never,
    },
  })
  const { observers, audit } = makeObservers()
  const port = createPtcPort({
    binding,
    tools: () => gateway.buildBuiltinTools(['bash']) as never,
    gate: createToolCallGate({
      binding,
      approvals: approving,
      actionForTool: (name) => (name === 'bash' ? 'shell.exec' : 'workspace.read'),
      append: async () => undefined,
      turnId: () => 'turn-1',
    }),
    observers,
  })
  return { port, audit, binding, dispose: () => terminals.disposeAll() }
}

describe('PtcRuntime E2E on the real tool chain', () => {
  let root: string
  let dispose: () => Promise<void> | undefined
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-ptc-e2e-'))
    dispose = undefined
  })
  afterEach(async () => {
    await dispose?.()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('runs a multi-call script through the real bash tool and returns real output', async () => {
    const rigged = rig(root)
    dispose = rigged.dispose
    const { port, audit } = rigged
    const result = await port.exec({
      script: `
        const a = await tool('bash', { command: 'echo first' })
        const b = await tool('bash', { command: 'echo second' })
        return JSON.stringify({ a: a.text.trim(), b: b.text.trim() })
      `,
    })
    expect(result.ok).toBe(true)
    const parsed = JSON.parse(result.result!)
    expect(parsed.a).toBe('first')
    expect(parsed.b).toBe('second')
    expect(result.calls).toEqual([
      { name: 'bash', ok: true },
      { name: 'bash', ok: true },
    ])
    expect(audit.map((e) => e.name)).toEqual(['bash', 'bash'])
  }, 30_000)

  it('bounds what enters the context: result capped at ~12k chars, log aggregate at ~4k', async () => {
    const rigged = rig(root)
    dispose = rigged.dispose
    const { port } = rigged
    const result = await port.exec({
      script: `
        for (let i = 0; i < 100; i++) log('x'.repeat(200))
        return 'y'.repeat(60_000)
      `,
    })
    expect(result.ok).toBe(true)
    // The return is the context-boundary payload: bash-convention sized, not a
    // dump budget (PTC_MAX_RESULT_CHARS). truncateMiddle keeps head + tail.
    expect(result.result!.length).toBeGreaterThan(12_288)
    expect(result.result!.length).toBeLessThan(12_288 + 100)
    expect(result.result!).toContain('…[truncated')
    // log() is model-facing too — its aggregate is bounded with a drop marker.
    const logChars = result.log!.reduce((sum, line) => sum + line.length, 0)
    expect(logChars).toBeLessThan(4_096 + 100)
    expect(result.log!.at(-1)).toContain('log truncated')
  })

  it('reports a non-zero bash exit as a structured result instead of killing the script (O1)', async () => {
    const rigged = rig(root)
    dispose = rigged.dispose
    const { port, audit } = rigged
    const result = await port.exec({
      script: `
        const r = await tool('bash', { command: '(exit 3)' })
        return JSON.stringify({ exitCode: r.exitCode, text: r.text })
      `,
    })
    expect(result.ok).toBe(true)
    const parsed = JSON.parse(result.result!)
    // The persistent bash tool reports the non-zero exit as a structured
    // result: details.exitCode lifted to r.exitCode, `[exit code: 3]` in text.
    expect(parsed.exitCode).toBe(3)
    expect(parsed.text).toBe('[exit code: 3]')
    // The invocation completed with a structured outcome — audit says ok, and
    // the exit code rides in the result the model sees.
    expect(result.calls).toEqual([{ name: 'bash', ok: true }])
    expect(audit).toHaveLength(1)
    expect(audit[0].ok).toBe(true)
  }, 30_000)

  it('reports a timed-out bash command as a structured outcome, script continues', async () => {
    const rigged = rig(root)
    dispose = rigged.dispose
    const { port } = rigged
    const result = await port.exec({
      script: `
        const r = await tool('bash', { command: 'sleep 10', timeout: 2 })
        return JSON.stringify({ timedOut: r.timedOut, exitCode: r.exitCode ?? null })
      `,
    })
    expect(result.ok).toBe(true)
    const parsed = JSON.parse(result.result!)
    expect(parsed.timedOut).toBe(true)
  }, 30_000)

  it('blocks a denied shell.exec at the gate, failing the script loudly', async () => {
    const rigged = rig(root, 'deny')
    dispose = rigged.dispose
    const { port } = rigged
    const result = await port.exec({ script: `await tool('bash', { command: 'echo nope' })` })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('blocked')
    expect(result.error).toContain('Permission denied: shell.exec')
  })

  it('keeps workspace containment through the script: a cwd escape fails the call', async () => {
    const rigged = rig(root)
    dispose = rigged.dispose
    const { port } = rigged
    const result = await port.exec({
      script: `await tool('bash', { command: 'pwd', cwd: '../outside' })`,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('command cwd must stay inside the workspace')
  })
})
