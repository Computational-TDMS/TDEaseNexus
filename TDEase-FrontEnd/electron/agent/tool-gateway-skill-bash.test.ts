import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { createToolGateway } from './tool-gateway'
import { createProducedPathLedger } from './tool-call-gate'
import { NodePermissionGateway } from './permission-gateway'
import { PtyTerminalService } from './pty-terminal'
import { deepFreeze, type SessionBinding } from './turn-definition'
import type { CommandContext } from '../../src/studio/commands/registry'
import type { StudioRuntime } from '../../src/studio/runtime/studio-runtime'
import { createStudioCommandRegistry } from '../../src/studio/commands/definitions'
import { asWorkspaceId } from '../../src/studio/domain/identity'
import {
  AGENT_PERMISSION_ACTIONS,
  type PermissionSnapshot,
} from '../../src/contracts/agent-runtime'

/**
 * Skill scripts run through controlled `bash`, with the runtime env located
 * via the `TDEASE_SYSTEM_ASSETS` / `UV_*` markers the bash spawnHook injects.
 * Scripts are ordinary bash: the only product seam is the env var.
 */

function makeContext(root: string): CommandContext {
  return {
    studio: {} as StudioRuntime,
    workspaceId: asWorkspaceId('skill-bash'),
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
    workspaceId: 'skill-bash', sessionId: 'session-skill',
    workspaceRoot: root, authority: 'local-user',
    permissionCeiling, toolCeiling: { builtins: ['bash'], mcp: false }, generation: 1,
  })
}

/** A binding whose shell.exec is denied, for exercising the deny path. */
function makeShellDenyBinding(root: string): SessionBinding {
  const ceiling = Object.fromEntries(
    AGENT_PERMISSION_ACTIONS.map((action) => [action, action === 'shell.exec' ? 'deny' : 'allow']),
  ) as PermissionSnapshot
  return deepFreeze<SessionBinding>({
    workspaceId: 'skill-bash', sessionId: 'session-skill',
    workspaceRoot: root, authority: 'local-user',
    permissionCeiling: ceiling, toolCeiling: { builtins: ['bash'], mcp: false }, generation: 1,
  })
}

async function runBash(tools: unknown[], command: string, cwd: string): Promise<unknown> {
  const bashTool = (tools as Array<{ name: string; execute: (id: string, args: Record<string, unknown>) => Promise<unknown> }>)
    .find((t) => t.name === 'bash')!
  return bashTool.execute('call-skill', { command, cwd })
}

describe('ToolGateway Skill-via-bash', () => {
  let root: string
  let terminals: PtyTerminalService
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-skill-bash-'))
    terminals = new PtyTerminalService()
  })
  afterEach(async () => {
    await terminals.disposeAll().catch(() => undefined)
    await fs.rm(root, { recursive: true, force: true })
  })

  it('runs System and Workspace Skill scripts with uv isolated from the host PATH', async () => {
    const uv = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['uv'], { encoding: 'utf8' })
      .split(/\r?\n/)[0]
      .trim()
    const assets = path.join(root, 'system-assets')
    const systemScript = path.join(assets, 'skills', 'probe', 'scripts', 'run.py')
    const workspaceScript = path.join(root, '.tdease', 'skills', 'probe', 'scripts', 'run.py')
    const script = [
      '# /// script',
      '# requires-python = ">=3.11"',
      '# ///',
      'from pathlib import Path',
      'import sys',
      'Path(sys.argv[1]).write_text("ok", encoding="utf-8")',
      '',
    ].join('\n')
    await fs.mkdir(path.dirname(systemScript), { recursive: true })
    await fs.mkdir(path.dirname(workspaceScript), { recursive: true })
    await fs.writeFile(systemScript, script, 'utf8')
    await fs.writeFile(workspaceScript, script, 'utf8')

    const permission = new NodePermissionGateway(makeBinding(root))
    const gateway = createToolGateway({
      binding: makeBinding(root),
      permission,
      workspaceRoot: root,
      systemRoot: root,
      terminals,
      systemAssetsRoot: assets,
      resolveBashEnv: () => ({
        ...process.env,
        PATH: path.dirname(uv),
        TDEASE_SYSTEM_ASSETS: assets,
        TDEASE_SYSTEM_ROOT: root,
      }),
      managedBinDir: path.join(root, '.bin'),
      studioContext: makeContext(root),
      commandRegistry: createStudioCommandRegistry(),
      profile: {
        allowsStudioCommand: () => false,
        runtime: { builtins: ['bash'], mcp: false } as never,
      },
    })
    const tools = gateway.buildBuiltinTools(['bash'])

    await runBash(tools, 'uv run --script "$TDEASE_SYSTEM_ASSETS/skills/probe/scripts/run.py" system.txt', root)
    await runBash(tools, 'uv run --script ".tdease/skills/probe/scripts/run.py" workspace.txt', root)

    await expect(fs.readFile(path.join(root, 'system.txt'), 'utf8')).resolves.toBe('ok')
    await expect(fs.readFile(path.join(root, 'workspace.txt'), 'utf8')).resolves.toBe('ok')
  }, 60_000)
})

/**
 * The bash spawnHook must install the FULL TDEase skill runtime env (bundled
 * uv on PATH, UV_CACHE_DIR, UV_FIND_LINKS, UV_PYTHON and TDEASE_SYSTEM_ASSETS.
 * Writable System state and host process variables stay absent. Otherwise a packaged
 * build on a clean machine (no uv on PATH) cannot run `uv run --script`. The
 * existing IsoForma case above passes only because the dev machine has uv on
 * PATH; this case proves the env is authoritative without depending on PATH.
 *
 * Strategy: seed bashEnv with marker values nothing in the inherited env
 * carries, then echo them from the shell. Presence proves the spawnHook
 * replaced the spawn env with bashEnv rather than merging one var. No uv
 * execution is needed to assert the env contract.
 */
describe('ToolGateway bash spawnHook injects the full skill runtime env', () => {
  it('replaces spawn env with bashEnv carrying the bundled runtime markers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-bashenv-'))
    const terminals = new PtyTerminalService()
    try {
      // The env main.ts assembles via resolveUv()+skillRuntimeEnv(). PATH is
      // prefixed with the bundled-uv dir so `uv` resolves with an empty
      // inherited PATH. The UV_*/TDEASE_* markers must survive into spawn.
      const bashEnv = {
        PATH: `${path.join(root, 'bundled', 'uv')}${path.delimiter}${process.env.PATH ?? ''}`,
        UV_CACHE_DIR: 'MARKER_UV_CACHE_DIR',
        UV_FIND_LINKS: 'MARKER_UV_FIND_LINKS',
        UV_PYTHON: 'MARKER_UV_PYTHON',
        TDEASE_SYSTEM_ASSETS: 'MARKER_TDEASE_SYSTEM_ASSETS',
      }

      const permission = new NodePermissionGateway(makeBinding(root))
      const gateway = createToolGateway({
        binding: makeBinding(root),
        permission,
        workspaceRoot: root,
        systemRoot: root,
        terminals,
        systemAssetsRoot: path.join(root, 'assets'),
        managedBinDir: path.join(root, '.bin'),
        resolveBashEnv: () => bashEnv,
        studioContext: makeContext(root),
        commandRegistry: createStudioCommandRegistry(),
        profile: {
          allowsStudioCommand: () => false,
          runtime: { builtins: ['bash'], mcp: false } as never,
        },
      })

      // Echo each marker. If the spawnHook ignored bashEnv (the old bug), these
      // marker values — which exist nowhere in the inherited env — would be
      // empty, failing the assertion. Runtime markers present prove the
      // spawnHook replaced spawn env with bashEnv wholesale, not merged one var.
      const tools = gateway.buildBuiltinTools(['bash'])
      const result = await runBash(
        tools,
        'printf %s,%s,%s,%s,%s "$UV_CACHE_DIR" "$UV_FIND_LINKS" "$UV_PYTHON" "$TDEASE_SYSTEM_ASSETS" "$TDEASE_SYSTEM_ROOT"',
        root,
      )
      const out = (result as { content: Array<{ text: string }> }).content[0].text

      expect(out).toBe(`MARKER_UV_CACHE_DIR,MARKER_UV_FIND_LINKS,MARKER_UV_PYTHON,${path.join(root, 'assets')},`)
    } finally {
      await terminals.disposeAll().catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

/**
 * D16 (tdeasenexus-toolbox-native-adapter.md §17): the `tdeasenexus-toolbox` CLI is provisioned into
 * the managed bin dir, which is the bash PATH prefix — so the short name
 * `tdeasenexus-toolbox` resolves inside the sandbox with no absolute path and no
 * `TDEASENEXUS_TOOLBOX_BIN`-style env pointer.
 */
describe('ToolGateway bash resolves the tdeasenexus-toolbox short name from the managed bin dir', () => {
  it('runs `tdeasenexus-toolbox` from managedBinDir with no absolute path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-shortname-'))
    const terminals = new PtyTerminalService()
    try {
      const managedBinDir = path.join(root, '.bin')
      await fs.mkdir(managedBinDir, { recursive: true })
      await fs.writeFile(path.join(managedBinDir, 'tdeasenexus-toolbox'), '#!/bin/sh\necho SHORTNAME_OK\n')

      const gateway = createToolGateway({
        binding: makeBinding(root),
        permission: new NodePermissionGateway(makeBinding(root)),
        workspaceRoot: root,
        systemRoot: root,
        terminals,
        systemAssetsRoot: path.join(root, 'assets'),
        resolveBashEnv: () => ({ ...process.env, TDEASE_SYSTEM_ASSETS: path.join(root, 'assets') }),
        managedBinDir,
        studioContext: makeContext(root),
        commandRegistry: createStudioCommandRegistry(),
        profile: {
          allowsStudioCommand: () => false,
          runtime: { builtins: ['bash'], mcp: false } as never,
        },
      })
      const tools = gateway.buildBuiltinTools(['bash'])

      // Git Bash only resolves +x files by short name; set the bit through the
      // same bash tool so the exec attribute matches what bash itself uses.
      await runBash(tools, 'chmod +x .bin/tdeasenexus-toolbox', root)
      const result = await runBash(tools, 'tdeasenexus-toolbox', root)
      const out = (result as { content: Array<{ text: string }> }).content[0].text
      expect(out).toContain('SHORTNAME_OK')
    } finally {
      await terminals.disposeAll().catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('refuses bash execution when the shell.exec permission is denied', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-deny-'))
    const terminals = new PtyTerminalService()
    try {
      const denied = makeShellDenyBinding(root)
      const gateway = createToolGateway({
        binding: denied,
        permission: new NodePermissionGateway(denied),
        workspaceRoot: root,
        systemRoot: root,
        terminals,
        systemAssetsRoot: path.join(root, 'assets'),
        resolveBashEnv: () => ({ ...process.env, TDEASE_SYSTEM_ASSETS: path.join(root, 'assets') }),
        managedBinDir: path.join(root, '.bin'),
        studioContext: makeContext(root),
        commandRegistry: createStudioCommandRegistry(),
        profile: {
          allowsStudioCommand: () => false,
          runtime: { builtins: ['bash'], mcp: false } as never,
        },
      })
      const tools = gateway.buildBuiltinTools(['bash'])
      // The deny decision must throw before any shell side effect runs.
      await expect(runBash(tools, 'echo should-not-run', root)).rejects.toThrow(/Permission denied.*shell\.exec/)
    } finally {
      await terminals.disposeAll().catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('ToolGateway analysis access', () => {
  it('permits Workspace-contained analysis reads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-history-'))
    const terminals = new PtyTerminalService()
    try {
      await fs.mkdir(path.join(root, 'runs', 'current', 'analysis', 'task'), { recursive: true })
      await fs.writeFile(path.join(root, 'runs', 'current', 'analysis', 'task', 'result.json'), '{}', 'utf8')
      const producedPaths = createProducedPathLedger()
      producedPaths.note('runs/current/analysis/task/result.json')
      const binding = makeBinding(root)
      const gateway = createToolGateway({
        binding,
        permission: new NodePermissionGateway(binding),
        workspaceRoot: root,
        systemRoot: root,
        terminals,
        systemAssetsRoot: path.join(root, 'assets'),
        resolveBashEnv: () => ({ ...process.env, TDEASE_SYSTEM_ASSETS: path.join(root, 'assets') }),
        managedBinDir: path.join(root, '.bin'),
        studioContext: makeContext(root),
        commandRegistry: createStudioCommandRegistry(),
        producedPaths,
        profile: {
          allowsStudioCommand: () => false,
          runtime: { builtins: ['bash', 'ls', 'read'], mcp: false } as never,
        },
      })
      const tools = gateway.buildBuiltinTools(['bash', 'ls', 'read']) as Array<{
        name: string
        execute: (id: string, args: Record<string, unknown>) => Promise<unknown>
      }>
      const ls = tools.find((tool) => tool.name === 'ls')!
      const read = tools.find((tool) => tool.name === 'read')!
      const bash = tools.find((tool) => tool.name === 'bash')!

      await expect(ls.execute('current-ls', { path: 'runs/current/analysis/task' })).resolves.toBeTruthy()
      await expect(read.execute('current-read', { path: 'runs/current/analysis/task/result.json' })).resolves.toBeTruthy()
    } finally {
      await terminals.disposeAll().catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * `runs.*` tools are Backend-registered-Run tools. Aiming them at a local
 * workspace Run source root produced a bare RUN_NOT_FOUND the model then
 * worked around with extra exploratory calls (session s_9fed927b: the
 * unresolved dead end cost a full directory sweep). The gateway answers with
 * guidance instead — before the doomed backend call leaves the process.
 */
describe('ToolGateway runs.* local-run guidance', () => {
  async function makeRunsGateway(root: string) {
    const terminals = new PtyTerminalService()
    const gateway = createToolGateway({
      binding: makeBinding(root),
      permission: new NodePermissionGateway(makeBinding(root)),
      workspaceRoot: root,
      systemRoot: root,
      terminals,
      systemAssetsRoot: path.join(root, 'assets'),
      resolveBashEnv: () => process.env,
      managedBinDir: path.join(root, '.bin'),
      studioContext: makeContext(root),
      commandRegistry: createStudioCommandRegistry(),
      profile: {
        allowsStudioCommand: (id: string) => id.startsWith('runs.'),
        runtime: { builtins: [], mcp: false } as never,
      },
    })
    return { terminals, tools: gateway.buildStudioTools() as Array<{
      name: string
      execute: (id: string, args: Record<string, unknown>) => Promise<unknown>
    }> }
  }

  function resultText(result: unknown): string {
    return (result as { content: Array<{ text: string }> }).content[0].text
  }

  it('answers a local workspace Run with guidance instead of a doomed backend call', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-localrun-'))
    const { terminals, tools } = await makeRunsGateway(root)
    try {
      await fs.mkdir(path.join(root, 'runs', 'soybean-all'), { recursive: true })
      const status = tools.find((tool) => tool.name === 'tdease.runs.status')!

      const text = resultText(await status.execute('c1', { runId: 'soybean-all' }))
      expect(text).toContain('local workspace Run directory (runs/soybean-all)')
      expect(text).toContain('RUN_NOT_FOUND')
      expect(text).toContain('Work directly on the files')
    } finally {
      await terminals.disposeAll().catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('lets non-local runIds reach the backend unchanged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-localrun-'))
    const { terminals, tools } = await makeRunsGateway(root)
    try {
      await fs.mkdir(path.join(root, 'runs', 'soybean-all'), { recursive: true })
      const status = tools.find((tool) => tool.name === 'tdease.runs.status')!
      // No local directory for this id — the invoke proceeds and fails inside
      // the (empty) studio runtime, proving the guidance never swallowed a
      // legitimate backend path.
      await expect(status.execute('c2', { runId: 'registered-run' })).rejects.toThrow()
    } finally {
      await terminals.disposeAll().catch(() => undefined)
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
