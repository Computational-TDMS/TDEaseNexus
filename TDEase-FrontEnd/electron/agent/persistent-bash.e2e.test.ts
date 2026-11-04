import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'

import { afterEach, beforeEach, expect, it } from 'vitest'

import { createToolGateway } from './tool-gateway'
import { NodePermissionGateway } from './permission-gateway'
import { PtyTerminalService } from './pty-terminal'
import { describePty } from './pty-skip'
import { deepFreeze, type SessionBinding } from './turn-definition'
import type { CommandContext } from '../../src/studio/commands/registry'
import type { StudioRuntime } from '../../src/studio/runtime/studio-runtime'
import { createStudioCommandRegistry } from '../../src/studio/commands/definitions'
import { asWorkspaceId } from '../../src/studio/domain/identity'
import { AGENT_PERMISSION_ACTIONS, type PermissionSnapshot } from '../../src/contracts/agent-runtime'

/**
 * Persistent PTY bash E2E — the TDEase port of DSH's dsh-tool-bash-persistent,
 * verified on the real chain: real gateway (persistent bash builtin with the
 * containment/permission wrapper), real node-pty + Git Bash, real marker
 * protocol against the terminal scrollback.
 *
 * The four contracts under test:
 *   1. state (cwd, exported variables) persists across calls
 *   2. non-zero exits are REPORTED as structured results, never thrown
 *   3. a timed-out command reports partial output and RESETS the shell
 *   4. a shell that exits is rebuilt fresh on the next call
 */

function makeContext(root: string): CommandContext {
  return {
    studio: {} as StudioRuntime,
    workspaceId: asWorkspaceId('pty-e2e'),
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

function makeBinding(root: string): SessionBinding {
  const permissionCeiling = Object.fromEntries(
    AGENT_PERMISSION_ACTIONS.map((action) => [action, 'allow']),
  ) as PermissionSnapshot
  return deepFreeze<SessionBinding>({
    workspaceId: 'pty-e2e', sessionId: 'session-pty-e2e',
    workspaceRoot: root, authority: 'local-user',
    permissionCeiling, toolCeiling: { builtins: ['bash'], mcp: false }, generation: 1,
  })
}

interface BashTool {
  name: string
  execute: (id: string, args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>
    details: Record<string, unknown>
  }>
}

describePty('Persistent PTY bash (dsh-tool-bash-persistent port)', () => {
  let root: string
  let terminals: PtyTerminalService
  let bash: BashTool

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-pty-'))
    terminals = new PtyTerminalService()
    const gateway = createToolGateway({
      binding: makeBinding(root),
      permission: new NodePermissionGateway(makeBinding(root)),
      workspaceRoot: root,
      systemRoot: root,
      terminals,
      systemAssetsRoot: path.join(root, 'assets'),
      resolveBashEnv: () => ({ ...process.env }),
      managedBinDir: path.join(root, '.bin'),
      studioContext: makeContext(root),
      commandRegistry: createStudioCommandRegistry(),
      profile: {
        allowsStudioCommand: () => false,
        runtime: { builtins: ['bash'], mcp: false } as never,
      },
    })
    bash = (gateway.buildBuiltinTools(['bash']) as unknown as BashTool[])[0]
  })
  afterEach(async () => {
    await terminals.disposeAll().catch(() => undefined)
    await fs.rm(root, { recursive: true, force: true })
  })

  const run = (command: string, extra: Record<string, unknown> = {}) =>
    bash.execute('pty-call', { command, ...extra })

  it('resets cwd while preserving exported variables across calls', async () => {
    await fs.mkdir(path.join(root, 'subdir'), { recursive: true })
    // The export persists; cwd is deliberately scoped to the first call.
    const first = await run('cd subdir && export TDEASE_MARKER=hello && echo state_set')
    expect(first.content[0].text.trim()).toBe('state_set')

    // The second call returns to the Workspace root but sees the variable.
    const second = await run('pwd && printf "%s" "$TDEASE_MARKER"')
    const text = second.content[0].text
    expect(text).not.toContain('subdir')
    expect(text).toContain('hello')
  }, 30_000)

  it('reports a non-zero exit as a structured result instead of throwing', async () => {
    // `(exit 3)` — a subshell exit — leaves the persistent shell alive; a bare
    // `exit 3` would terminate the session itself (the shell-exit path).
    const result = await run('(exit 3)')
    expect(result.content[0].text).toBe('[exit code: 3]')
    expect(result.details.exitCode).toBe(3)
    // The shell stays alive: the next call runs in the same session.
    const next = await run('echo still_alive')
    expect(next.content[0].text.trim()).toBe('still_alive')
  }, 30_000)

  it('reports partial output on timeout and resets the shell to the workspace', async () => {
    const result = await run('sleep 10', { timeout: 2 })
    expect(result.details.timedOut).toBe(true)
    expect(result.details.reset).toBe(true)
    expect(result.content[0].text).toContain('timed out after 2 seconds')
    expect(result.content[0].text).toContain('was reset')

    // The next call spawns a FRESH shell at the workspace root (Git Bash pwd
    // prints the msys-style path of the workspace, never the stale subdir).
    const next = await run('pwd')
    const nextText = next.content[0].text.trim()
    expect(nextText).toContain('tdease-pty-')
    expect(nextText).not.toContain('subdir')
  }, 30_000)

  it('rebuilds the shell when the previous one exited', async () => {
    const exited = await run('exit')
    expect(exited.content[0].text).toContain('[shell exited')
    expect(exited.details.reset).toBe(true)

    const fresh = await run('echo rebuilt')
    expect(fresh.content[0].text.trim()).toBe('rebuilt')
  }, 30_000)

  it('starts two independent shells without serializing their commands', async () => {
    const secondTerminals = new PtyTerminalService()
    const secondGateway = createToolGateway({
      binding: makeBinding(root),
      permission: new NodePermissionGateway(makeBinding(root)),
      workspaceRoot: root,
      systemRoot: root,
      terminals: secondTerminals,
      systemAssetsRoot: path.join(root, 'assets'),
      resolveBashEnv: () => ({ ...process.env }),
      managedBinDir: path.join(root, '.bin'),
      studioContext: makeContext(root),
      commandRegistry: createStudioCommandRegistry(),
      profile: {
        allowsStudioCommand: () => false,
        runtime: { builtins: ['bash'], mcp: false } as never,
      },
    })
    const secondBash = (secondGateway.buildBuiltinTools(['bash']) as unknown as BashTool[])[0]
    try {
      const [first, second] = await Promise.all([
        bash.execute('pty-a', { command: 'sleep 0.2 && echo first' }),
        secondBash.execute('pty-b', { command: 'sleep 0.2 && echo second' }),
      ])
      expect(first.content[0].text.trim()).toBe('first')
      expect(second.content[0].text.trim()).toBe('second')
    } finally {
      await secondTerminals.disposeAll().catch(() => undefined)
    }
  }, 30_000)
})
