import fs from 'node:fs'
import path from 'node:path'
import { Client, ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  enabled?: boolean
  /** Per-call request timeout override in ms. The SDK's own 60 s default
   *  bounds every call already; this only exists to RAISE it for tools that
   *  legitimately run longer than a minute. */
  timeoutMs?: number
}

interface McpConfig {
  servers?: Record<string, McpServerConfig>
  mcpServers?: Record<string, McpServerConfig>
}

interface ConnectedServer {
  client: Client
  transport: StdioClientTransport
}

export class McpProvider {
  private readonly workspaceDir: string
  private readonly servers: Record<string, McpServerConfig>
  private readonly connections = new Map<string, Promise<ConnectedServer>>()
  /** Optional host hook, fired with the stdio child's pid once the transport
   *  is live — the Electron main process uses it to assign MCP servers to the
   *  kill-on-close job object. */
  private readonly onChildProcess?: (pid: number | null | undefined) => void

  constructor(
    workspaceDir: string,
    systemDir?: string,
    hooks?: { onChildProcess?: (pid: number | null | undefined) => void },
  ) {
    this.workspaceDir = workspaceDir
    this.onChildProcess = hooks?.onChildProcess
    this.servers = {
      ...this.serversFrom(this.readConfig(systemDir ? path.join(systemDir, 'settings.json') : undefined)),
      ...this.serversFrom(this.readConfig(path.join(this.workspaceDir, '.tdease', 'settings.json'))),
    }
  }

  listServers() {
    return Object.entries(this.servers)
      .filter(([, config]) => config.enabled !== false)
      .map(([name]) => name)
      .sort()
  }

  async listTools(server: string) {
    const result = await (await this.connect(server)).client.listTools()
    return (result.tools || []).map((tool: any) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || {},
    }))
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const connection = this.connect(server)
    const { client } = await connection
    try {
      return await client.callTool(
        { name: tool, arguments: args },
        { signal, ...(this.serverTimeoutMs(server) ? { timeout: this.serverTimeoutMs(server) } : {}) },
      )
    } catch (error) {
      // An SDK error (SdkError/ProtocolError) is the server ANSWERING — bad
      // tool name, bad args, its own failure report; the connection is fine.
      // RequestTimeout is the one SdkError that means the server may be HUNG:
      // the 60 s default (or the raised timeoutMs) already fired, so keeping
      // the cached connection would burn the full budget again on every
      // retry. Anything else (EPIPE, spawn death, "Not connected") is
      // plumbing death: drop the cache and let the next call reconnect.
      const serverAnswered = (error instanceof SdkError && error.code !== SdkErrorCode.RequestTimeout)
        || error instanceof ProtocolError
      if (!serverAnswered) {
        this.connections.delete(server)
        // Best-effort cleanup: a hung server is not a dead process — the
        // dropped transport's child would otherwise linger until dispose().
        void connection
          .then((entry) => entry.transport.close().catch(() => undefined))
          .catch(() => undefined)
      }
      throw error
    }
  }

  /** A positive finite `timeoutMs` override, or undefined for the SDK default. */
  private serverTimeoutMs(server: string): number | undefined {
    const raw = this.servers[server]?.timeoutMs
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined
  }

  async dispose() {
    const connections = await Promise.allSettled(this.connections.values())
    this.connections.clear()
    await Promise.all(connections.map(async (entry) => {
      if (entry.status !== 'fulfilled') return
      await entry.value.transport.close().catch(() => undefined)
    }))
  }

  private serversFrom(config: McpConfig): Record<string, McpServerConfig> {
    return config.servers || config.mcpServers || {}
  }

  private readConfig(configPath?: string): McpConfig {
    if (!configPath) return {}
    if (!fs.existsSync(configPath)) return {}
    // A corrupt or wrong-shaped config degrades to "no servers from this
    // layer" — the same defensive-parsing posture as settings.json elsewhere.
    // Throwing here would take the whole provider (and with it the Agent's
    // MCP tools) down over a file the user can fix in a text editor.
    try {
      const settings = JSON.parse(fs.readFileSync(configPath, 'utf8')) as McpConfig & { mcp?: McpConfig }
      const parsed = settings.mcp ?? settings
      if (!parsed || typeof parsed !== 'object') return {}
      if (parsed.servers !== undefined && typeof parsed.servers !== 'object') return {}
      if (parsed.mcpServers !== undefined && typeof parsed.mcpServers !== 'object') return {}
      return parsed
    } catch {
      return {}
    }
  }

  private async connect(server: string): Promise<ConnectedServer> {
    const current = this.connections.get(server)
    if (current) return current
    const config = this.servers[server]
    if (!config || config.enabled === false) throw new Error(`MCP server is not enabled: ${server}`)
    if (!config.command) throw new Error(`MCP server ${server} has no command`)

    const connection = (async () => {
      const cwd = config.cwd ? path.resolve(this.workspaceDir, config.cwd) : this.workspaceDir
      const workspaceReal = fs.realpathSync(this.workspaceDir)
      const cwdReal = fs.realpathSync(cwd)
      if (cwdReal !== workspaceReal && !cwdReal.startsWith(`${workspaceReal}${path.sep}`)) {
        throw new Error(`MCP server ${server} cwd escapes the workspace`)
      }
      // The stdio transport builds its child env from this map, not from
      // process.env — merge the unified proxy vars in so MCP servers that
      // call out to the network honor the configured proxy. Server-defined
      // env always wins the merge.
      const proxyEnv: Record<string, string> = {}
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
        const value = process.env[name]
        if (value) proxyEnv[name] = value
      }
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        cwd: cwdReal,
        env: { ...proxyEnv, ...(config.env ?? {}) },
      })
      const client = new Client({ name: 'tdease', version: '0.1.0' }, { capabilities: {} })
      await client.connect(transport)
      this.onChildProcess?.(transport.pid)
      return { client, transport }
    })()
    this.connections.set(server, connection)
    try {
      return await connection
    } catch (error) {
      this.connections.delete(server)
      throw error
    }
  }
}
