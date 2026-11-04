/**
 * utilityProcess entry for the TDEase agent runtime.
 *
 * WHY A SEPARATE PROCESS: the agent runtime drives node-pty (a native module),
 * arbitrary tool output and the Pi model loop in what used to be the Electron
 * main process. A native crash in node-pty, a runaway loop or an OOM from a
 * huge tool output therefore killed the WHOLE app. This entry runs the exact
 * same createAgentRuntime() factory (unchanged, process-agnostic — the same
 * code agent-harness-cli.ts runs as a plain Node CLI) inside a utilityProcess:
 * a crash terminates this child only, and main's client (utility-client.ts)
 * logs it, respawns, and rebinds sessions from the on-disk store.
 *
 * Bundled by build-main.mjs to electron/dist/agent-utility.cjs. The wire
 * protocol lives in utility-protocol.ts; the dispatch logic lives in the
 * unit-testable utility-host-core.ts — this file only adapts the process
 * boundary (parentPort) and applies main's global policies.
 */
import { createSystemAssetCatalog } from '../system_asset_catalog.cjs'
import { createCrashLogger } from '../crash_logger.cjs'
import { pinSearchToolLookup, resolveVendorGitDirs } from '../skill_runtime.cjs'
import { normalizeProxyConfig, applyProxyEnv } from '../proxy-config'
import { configureHttpDispatcher } from '@tdease/pi-http-dispatcher'
import { createAgentRuntime, type AgentRuntime } from './agent-runtime'
import { createAgentHost } from './utility-host-core'
import type { RelayMessage } from './utility-protocol'

/** Init payload main sends before anything else (mirrors utility-client.ts). */
interface AgentHostInit {
  settingsPath: string
  systemRoot: string
  agentDir: string
  managedBinDir: string
  /** Root of the scientific-system install (asset catalog + skills). */
  systemAssetsRoot: string
  systemCacheRoot: string
  isDev: boolean
  logFile: string
  /** Raw settings.json `network.proxy` value; normalized child-side. */
  proxy?: unknown
  /** Whether main wired nodeCatalogInstaller (external backend mode omits it). */
  hasNodeCatalogInstaller?: boolean
}

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

function main(): void {
  const parentPort = (process as { parentPort?: ParentPort }).parentPort
  if (!parentPort) throw new Error('agent utility host must run inside a utilityProcess (parentPort missing)')
  parentPort.on('message', (event) => {
    const message = event.data as RelayMessage
    if (message?.t === 'init') boot(message.config as unknown as AgentHostInit, parentPort)
  })
}

function boot(config: AgentHostInit, parentPort: ParentPort): void {
  const crashLog = createCrashLogger(config.logFile)

  // A crash in this child must surface through the app's log conventions and
  // then terminate the process — main's supervisor respawns it. Swallowing
  // errors here would silently corrupt supervision instead.
  process.on('uncaughtException', (error) => {
    crashLog.error('agent-utility.uncaught-exception', error)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    crashLog.error('agent-utility.unhandled-rejection', reason)
    process.exit(1)
  })

  // Same global policies main applies to its own fetch paths: route vendor
  // LLM traffic through the configured network proxy (the child's bundled Pi
  // copy owns its undici dispatcher, so it must be configured HERE too), and
  // pin rg/fd lookup to the managed tools dir with Pi's runtime download
  // forbidden — deterministic and offline.
  const proxy = normalizeProxyConfig(config.proxy)
  if (proxy.url) applyProxyEnv(proxy, { configureDispatcher: configureHttpDispatcher })
  pinSearchToolLookup({ toolsDir: config.managedBinDir, extraDirs: resolveVendorGitDirs() })

  const port = {
    post: (message: unknown) => parentPort.postMessage(message),
    onMessage: (listener: (message: unknown) => void) => {
      parentPort.on('message', (event: { data: unknown }) => listener(event.data))
    },
  }

  const host = createAgentHost({ port, logger: crashLog })

  const call = async (method: 'resolveWorkspaceRoot' | 'backendConnection' | 'resolveModelMeta' | 'nodeCatalogInstaller' | 'credentialKeys', args: unknown[]) =>
    host.call(method, args)

  const runtime: AgentRuntime = createAgentRuntime({
    settingsPath: config.settingsPath,
    systemRoot: config.systemRoot,
    agentDir: config.agentDir,
    managedBinDir: config.managedBinDir,
    systemAssets: createSystemAssetCatalog({ productRoot: config.systemAssetsRoot }),
    systemAssetsRoot: config.systemAssetsRoot,
    systemCacheRoot: config.systemCacheRoot,
    isDev: config.isDev,
    resolveWorkspaceRoot: async (workspaceId) => (await call('resolveWorkspaceRoot', [workspaceId])) as string,
    backendConnection: host.backendConnection,
    // safeStorage-decrypted provider keys (snapshot-fed; see utility-host-core).
    credentialKey: host.credentialKey,
    usageLedger: host.ledger,
    resolveModelMeta: async (providerId, modelId) =>
      (await call('resolveModelMeta', [providerId, modelId])) as Awaited<ReturnType<NonNullable<Parameters<typeof createAgentRuntime>[0]['resolveModelMeta']>>>,
    ...(config.hasNodeCatalogInstaller
      ? {
          nodeCatalogInstaller: async (sourceDir: string) =>
            // NodeInstallOutcome — the registry type createAgentRuntime declares.
            (await call('nodeCatalogInstaller', [sourceDir])) as import('../../src/studio/commands/registry').NodeInstallOutcome,
        }
      : {}),
    push: host.push,
  })

  host.attach(runtime)
  crashLog.info('agent-utility.host-ready', { pid: process.pid })
  parentPort.postMessage({ t: 'ready' })
}

main()
