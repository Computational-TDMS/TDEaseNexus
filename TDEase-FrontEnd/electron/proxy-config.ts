/**
 * Unified network-proxy configuration — the ONE model behind every outbound
 * path (vendor LLM calls, OAuth, models.dev discovery, uv/pypi installs, the
 * app updater, MCP-spawned servers).
 *
 * Persistence: settings.json `network.proxy = { url, noProxy }` — read at
 * main-process startup before any network runs. `url` empty = proxy off (the
 * pre-existing behavior, byte for byte: no env vars, no dispatcher change).
 *
 * This module is deliberately dependency-free (no Pi, no Electron): the env
 * dance is pure process state, which is what makes it unit-testable, and the
 * two environment-bound levers are injected by main.ts —
 *   - `configureDispatcher` → Pi's bundled undici EnvHttpProxyAgent, the SAME
 *     undici instance Pi's vendor calls fetch through (a second undici
 *     dependency would have its own global-dispatcher registry and proxy
 *     nothing that matters);
 *   - the updater session's `setProxy` → electron-updater rides Electron net
 *     on its own "electron-updater" partition, which Chromium's network stack
 *     routes by session proxy rules, not by env vars.
 */

export interface NetworkProxyConfig {
  /** Full proxy URL, e.g. "http://127.0.0.1:7890". Empty string = off. */
  url: string
  /** Comma-separated host patterns that bypass the proxy. */
  noProxy: string
}

const PROXY_ENV_VARS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
] as const

/** Defensive parse: anything that is not an http(s) URL degrades to "off". */
export function normalizeProxyConfig(raw: unknown): NetworkProxyConfig {
  const block = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const url = typeof block.url === 'string' ? block.url.trim() : ''
  const noProxy = typeof block.noProxy === 'string' ? block.noProxy.trim() : ''
  return { url: /^https?:\/\/.+/i.test(url) ? url : '', noProxy }
}

/**
 * Loopback is ALWAYS bypassed: the embedded backend, the share server and
 * every renderer→backend call live on 127.0.0.1, and proxying them through a
 * corporate relay is never what anyone wants.
 */
export function noProxyWithLoopback(noProxy: string): string {
  const entries = new Set(['localhost', '127.0.0.1', '::1'])
  for (const entry of noProxy.split(',')) {
    const trimmed = entry.trim()
    if (trimmed) entries.add(trimmed)
  }
  return [...entries].join(',')
}

export interface ProxyEnvApplier {
  /** Rebuilds the global undici dispatcher from the current env (main.ts
   *  injects Pi's configureHttpDispatcher). Omitted in unit tests. */
  configureDispatcher?: () => void
}

/**
 * The synchronous half — must run before any child spawn or fetch:
 *   - env vars reach uv/pypi (backend_manager allowlist forwards them), the
 *     python backend, and MCP stdio servers (mcp-provider merges them);
 *   - the dispatcher covers every Node-fetch path in the main process.
 * Safe to call repeatedly (idempotent by construction: set or delete, then
 * rebuild). Clearing the proxy deletes every variant so a stale lowercase
 * copy can't keep uv proxied after the user turns the proxy off.
 */
export function applyProxyEnv(config: NetworkProxyConfig, applier: ProxyEnvApplier = {}): void {
  if (config.url) {
    process.env.HTTP_PROXY = config.url
    process.env.HTTPS_PROXY = config.url
    process.env.http_proxy = config.url
    process.env.https_proxy = config.url
    const noProxy = noProxyWithLoopback(config.noProxy)
    process.env.NO_PROXY = noProxy
    process.env.no_proxy = noProxy
  } else {
    for (const name of PROXY_ENV_VARS) delete process.env[name]
  }
  applier.configureDispatcher?.()
}

/** Chromium session proxy rules for electron-updater's partition (or any
 *  Electron-net consumer). `mode: 'system'` restores the pre-proxy behavior. */
export function updaterProxyRules(config: NetworkProxyConfig): ElectronProxyConfig {
  return config.url
    ? {
      mode: 'fixed_servers' as const,
      proxyRules: config.url,
      proxyBypassRules: noProxyWithLoopback(config.noProxy),
    }
    : { mode: 'system' as const }
}

export interface ElectronProxyConfig {
  mode: 'system' | 'fixed_servers'
  proxyRules?: string
  proxyBypassRules?: string
}
