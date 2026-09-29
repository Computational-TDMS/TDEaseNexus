import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProtocolError, SdkErrorCode } from '@modelcontextprotocol/client'
import { McpProvider } from './mcp-provider.ts'

const roots: string[] = []
function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdease-mcp-'))
  roots.push(root)
  const system = path.join(root, 'system')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(system, { recursive: true })
  fs.mkdirSync(path.join(workspace, '.tdease'), { recursive: true })
  return { system, workspace }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('McpProvider configuration layers', () => {
  it('merges system servers with workspace overrides and workspace disables', () => {
    const { system, workspace } = createRoot()
    fs.writeFileSync(path.join(system, 'settings.json'), JSON.stringify({ mcp: { mcpServers: {
      shared: { command: 'system-command' },
      systemOnly: { command: 'system-only' },
      disabled: { command: 'system-disabled' },
    } } }))
    fs.writeFileSync(path.join(workspace, '.tdease', 'settings.json'), JSON.stringify({ mcp: { servers: {
      shared: { command: 'workspace-command' },
      workspaceOnly: { command: 'workspace-only' },
      disabled: { enabled: false },
    } } }))
    expect(new McpProvider(workspace, system).listServers()).toEqual(['shared', 'systemOnly', 'workspaceOnly'])
  })
})

describe('McpProvider callTool timeout', () => {
  // vitest runs with the package root as cwd — stable for a spawn argument.
  const fixtureServer = path.resolve('tests/fixtures/mcp-echo-server.mjs')

  it('drops a hung connection after timeoutMs and reconnects with a fresh process', async () => {
    const { system, workspace } = createRoot()
    const counter = path.join(workspace, 'spawn-count.txt')
    fs.writeFileSync(path.join(system, 'settings.json'), JSON.stringify({ mcp: { mcpServers: {
      hang: { command: process.execPath, args: [fixtureServer, counter], timeoutMs: 400 },
    } } }))
    const provider = new McpProvider(workspace, system)
    try {
      // Baseline: the fixture answers a normal call.
      await expect(provider.callTool('hang', 'echo', { text: 'alive' })).resolves.toMatchObject({
        content: [{ type: 'text', text: 'alive' }],
      })
      expect(fs.readFileSync(counter, 'utf8')).toBe('1')

      // A hung tool call must reject with the SDK's RequestTimeout — bounded
      // by timeoutMs, not the default 60 s and never unbounded.
      await expect(provider.callTool('hang', 'echo', { hang: true })).rejects.toMatchObject({
        code: SdkErrorCode.RequestTimeout,
      })

      // The timed-out connection is dead weight: the next call must have
      // reconnected — a SECOND process spawn — and answer normally.
      await expect(provider.callTool('hang', 'echo', { text: 'revived' })).resolves.toMatchObject({
        content: [{ type: 'text', text: 'revived' }],
      })
      expect(fs.readFileSync(counter, 'utf8')).toBe('2')
    } finally {
      await provider.dispose()
    }
  }, 15_000)

  it('keeps the cached connection when the server answers with a tool error', async () => {
    const { system, workspace } = createRoot()
    const counter = path.join(workspace, 'spawn-count.txt')
    fs.writeFileSync(path.join(system, 'settings.json'), JSON.stringify({ mcp: { mcpServers: {
      answer: { command: process.execPath, args: [fixtureServer, counter] },
    } } }))
    const provider = new McpProvider(workspace, system)
    try {
      // A JSON-RPC error response is a server that ANSWERS (ProtocolError,
      // not plumbing): the connection must survive and serve the next call
      // without a respawn.
      await expect(provider.callTool('answer', 'no-such-tool', {})).rejects.toBeInstanceOf(ProtocolError)
      await expect(provider.callTool('answer', 'echo', { text: 'same-process' })).resolves.toMatchObject({
        content: [{ type: 'text', text: 'same-process' }],
      })
      expect(fs.readFileSync(counter, 'utf8')).toBe('1')
    } finally {
      await provider.dispose()
    }
  }, 15_000)
})
