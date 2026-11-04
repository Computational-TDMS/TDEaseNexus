/**
 * Desktop IPC bridge access for slices that have no domain service of their own.
 *
 * The dependency direction is fixed:
 *   `components/ → stores/ → services/ → contracts/ports`
 * and §1 forbids the shell from holding truth or touching Electron IPC
 * directly. `desktopWorkspace.ts` already owns the `workspace` slice under
 * that rule; this file is its sibling for the remaining slices that the
 * Agent runtime, the Runs store, the Subagents store and MCP settings need —
 * `agent`, `subagent`, `runs`, `mcpConfig`, plus the optional `system` /
 * `workspace` text slices the local-skill catalog reads.
 *
 * One file, not one per slice: each slice here is a thin typed accessor, and
 * the only logic worth keeping (the MCP `settings.json` enabled-server parse)
 * is shared by two call sites that used to duplicate it. Splitting these into
 * four single-line wrapper files would be exactly the "extra layer of garbage"
 * AGENTS.md warns against.
 *
 * The optional accessors return `undefined` when the preload is absent (dev
 * browser, or a slice not yet wired); callers that need a hard failure keep
 * using the throwing variants in `agentSessionStorage.ts`.
 */

import type { ViewBridge } from '@/contracts/view-runtime'
import type { AgentBridge } from '@/contracts/agent-runtime'
import type { SubagentBridge } from '@/contracts/subagent-runtime'
import type { JobBridge } from '@/contracts/job-runtime'
import type { SessionRunBridge } from '@/contracts/session-run-runtime'
import type { UsageEntry, UsageEntryListener, UsageListFilter } from '@/services/agent/usageLedger'
import type { UsageStats, UsageStatsRange } from '@/ai/core/usage-stats'
import type { WorkspaceRegistry, WorkspaceRegistryEntry } from '@/services/workspace/workspaceRegistry'

/**
 * The ONE exhaustive shape of `window.tdeaseDesktop` — the Electron preload
 * contract (`electron/preload.cjs`), mirrored slice for slice. Every consumer
 * casts through THIS interface (`(globalThis as { tdeaseDesktop?: TDEaseDesktop })`);
 * per-file inline retypes are gone because two files typing the same slice
 * differently was a real, shipped drift bug class. A new IPC channel is added
 * here and in the preload — nowhere else.
 *
 * `workspace` is the FULL preload slice (text + bytes + tree mutation + shell
 * reveal), not the narrow text shape early consumers typed: narrow consumers
 * assign the slice to their own subset interface, which TypeScript checks
 * structurally.
 */
export interface TDEaseDesktop {
  platform: string
  runtime: 'electron'
  openLogs(): Promise<void>
  /** First frame after Vue mount — the main window keeps the splash until this fires. */
  rendererReady?: () => void
  /** Installs the chokidar watcher global lazily (see fileWatcher.ts). */
  __installFsWatch?: () => void
  backend?: {
    connection(): Promise<{ baseUrl: string; accessToken: string | null } | null>
    /** Persist + live-apply the backend connection choice. The remote bearer
     *  token is kept ONLY in the main-process settings block; it never comes
     *  back on this call (the caller either just sent it or reads the live
     *  token through `connection()`). */
    configure(input: { mode: 'local' | 'remote'; baseUrl?: string; accessToken?: string }): Promise<{ mode: string; baseUrl: string | null; accessTokenConfigured: boolean }>
  }
  /** Unified network proxy (settings.json network.proxy) — infrastructure
   *  config, not a credential: it crosses IPC in plain form both ways. */
  network?: {
    readProxy(): Promise<{ url: string; noProxy: string }>
    writeProxy(input: { url?: string; noProxy?: string }): Promise<{ url: string; noProxy: string }>
  }
  /** App update channel (electron/updater.ts). `restart` only acts in the
   *  `downloaded` phase — the restart is always the user's decision. */
  update?: {
    currentState(): Promise<UpdateBridgeState>
    check(): Promise<UpdateBridgeState>
    restart(): Promise<string>
    subscribe(listener: (state: UpdateBridgeState) => void): () => void
  }
  agent?: AgentBridge
  subagent?: SubagentBridge
  job?: JobBridge
  sessionRun?: SessionRunBridge
  agentView?: ViewBridge
  runs?: { subscribe(listener: (event: { workspaceId: string }) => void): () => void }
  agentProviders?: {
    read(): Promise<{ providers: Record<string, { configured: boolean; name?: string; baseUrl?: string; models?: string[] }> }>
    write(providerId: string, config: Record<string, unknown>): Promise<{ ok: true; providerId: string; configured: boolean }>
    remove(providerId: string): Promise<{ ok: true; providerId: string }>
    addModel(providerId: string, modelId: string): Promise<{ ok: true; providerId: string; modelId: string }>
    readModels(providerId: string, options?: { force?: boolean }): Promise<ProviderModelsResult>
    testProvider(providerId: string): Promise<ProviderTestResultBridge>
    /** Per-model price declaration (USD per 1M tokens). `cost: null` clears. */
    readPricing(providerId: string): Promise<{ pricing: Record<string, ModelPricingBridge> }>
    setPricing(providerId: string, modelId: string, cost: ModelPricingBridge | null): Promise<{ ok: true; providerId: string; modelId: string }>
  }
  /** OAuth login bridge (mirrors electron/agent/provider-auth.ts). */
  providerAuth?: {
    login(providerId: string): Promise<{ ok: boolean; error?: string }>
    cancel(): Promise<void>
    resolvePrompt(promptId: string, value: string): Promise<void>
    status(): Promise<ProviderAuthStatusBridge[]>
    onEvent(listener: (payload: ProviderAuthPushBridge) => void): () => void
  }
  mcpConfig?: { readSystem(): Promise<string>; writeSystem(content: string): Promise<void> }
  /** Workspace Web sharing — the host-only configuration surface. */
  share?: {
    readConfig(): Promise<ShareConfigBridgeResult>
    writeConfig(input: ShareConfigWriteInput): Promise<ShareConfigBridgeResult>
    /** Create a named invitation; the full token is returned exactly once. */
    createInvite(input: { name: string; tier: 'view' | 'continue' }): Promise<{ id: string; name: string; tier: ShareTier; token: string; createdAt: string }>
    /** Revoke one invitation (hot: kills that guest's cookie and SSE stream). */
    revokeInvite(inviteId: string): Promise<{ ok: true; inviteId: string }>
    /** Explicit re-copy of one invitation's token. */
    revealInviteToken(inviteId: string): Promise<{ inviteId: string; token: string }>
  }
  usageLedger?: {
    list(filter?: UsageListFilter): Promise<UsageEntry[]>
    stats(range: UsageStatsRange): Promise<UsageStats | null>
    clear(): Promise<void>
    subscribe(onEntry: UsageEntryListener): () => void
  }
  system?: {
    readText(relative: string): Promise<string>
    listFiles(relative: string): Promise<readonly string[]>
  }
  systemData?: {
    listFiles(relative: string): Promise<readonly string[]>
    readText(relative: string): Promise<string>
    writeTextAtomic(relative: string, content: string): Promise<void>
    sha256(relative: string): Promise<string>
  }
  /** Published Result cache — the Client System root, hard delete. */
  resultCache?: {
    exists(relative: string): Promise<boolean>
    sha256(relative: string): Promise<string>
    readBytes(relative: string): Promise<Uint8Array>
    writeBytesAtomic(relative: string, content: number[] | Uint8Array): Promise<void>
    remove(relative: string): Promise<void>
  }
  workspace?: {
    exists(root: string, relative: string): Promise<boolean>
    mkdir(root: string, relative: string): Promise<void>
    listFiles(root: string): Promise<string[]>
    readText(root: string, relative: string): Promise<string>
    readBytes(root: string, relative: string): Promise<Uint8Array>
    readByteRange(root: string, relative: string, start: number, end: number): Promise<Uint8Array | null>
    fileSize(root: string, relative: string): Promise<number>
    writeTextAtomic(root: string, relative: string, content: string): Promise<void>
    appendText(root: string, relative: string, content: string): Promise<void>
    writeBytesAtomic(root: string, relative: string, content: number[] | Uint8Array): Promise<void>
    sha256(root: string, relative: string): Promise<string>
    rename(root: string, oldRel: string, newRel: string): Promise<void>
    trash(root: string, relative: string): Promise<void>
    move(root: string, srcRels: string[], destDirRel: string): Promise<void>
    copyInto(root: string, absSrcPaths: string[], destDirRel: string): Promise<void>
    /** Recursive copy to an exact workspace-relative destination path. */
    copy(root: string, srcRel: string, destRel: string): Promise<void>
    listDir(root: string, rel: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>
    showInFolder(absPath: string): Promise<void>
    openExternal(absPath: string): Promise<string>
    revealPath(root: string, rel: string): Promise<void>
    startNativeDrag(filePaths: string[]): void
    /** Browser File object → absolute path (OS-file drop upload). */
    getPathForFile(file: File): string | null
  }
  workspaceRegistry?: {
    list(): Promise<WorkspaceRegistry>
    upsert(entry: Pick<WorkspaceRegistryEntry, 'workspace_id' | 'name' | 'local_path'>): Promise<WorkspaceRegistry>
    remove(workspaceId: string): Promise<WorkspaceRegistry>
  }
  /** Conversation export — print the standalone export HTML to PDF bytes (hidden window in main). */
  conversation?: {
    printPdf(html: string): Promise<Uint8Array>
  }
}

// ── Provider model-list refresh types (mirrors electron/agent/model-catalog-refresher.ts) ──

/** Which live layer supplied the model list: the vendor itself, the models.dev
 * aggregator, a stale-cache fallback, or none (static catalog only). */
export type ProviderModelsSource = 'provider' | 'models-dev' | 'cache' | 'none'

export interface ProviderModelsResult {
  providerId: string
  /** Refreshed model ids in vendor order, deduped. Empty when nothing refreshed. */
  models: string[]
  source: ProviderModelsSource
  /** Epoch ms of the winning layer's fetch; null when source is 'none'. */
  updatedAt: number | null
  /** Last failed fetch message; null when every attempted layer succeeded (or none was attempted). */
  error: string | null
}

/** Typed connection-test verdict (mirrors electron/agent/model-catalog-refresher.ts). */
export type ProviderTestCodeBridge =
  | 'no_key'
  | 'no_config'
  | 'unsupported'
  | 'unauthorized'
  | 'rate_limited'
  | 'not_found'
  | 'server'
  | 'timeout'
  | 'network'

export interface ProviderTestResultBridge {
  ok: boolean
  code: ProviderTestCodeBridge | null
  latencyMs: number | null
  modelCount: number | null
  detail: string | null
}

/** User-declared per-model price, USD per 1M tokens — the same four rates the
 *  vendor catalogs carry, so the runtime cost chain consumes it unadapted. */
export interface ModelPricingBridge {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type DesktopGlobal = typeof globalThis & { tdeaseDesktop?: TDEaseDesktop }

// ── Provider OAuth login types (mirrors electron/agent/provider-auth.ts) ────

/** Serializable view of one OAuth flow prompt the renderer must answer. */
export type ProviderAuthPromptViewBridge = {
  promptId: string
} & {
  signal?: never
} & (
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: ReadonlyArray<{ id: string; label: string; description?: string }> }
  | { type: 'manual_code'; message: string; placeholder?: string }
)

export type ProviderAuthPushBridge =
  | { kind: 'notify'; event: { type: 'info'; message: string; links?: ReadonlyArray<{ url: string; label?: string }> } | { type: 'auth_url'; url: string; instructions?: string } | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number } | { type: 'progress'; message: string } }
  | { kind: 'prompt'; prompt: ProviderAuthPromptViewBridge }
  | { kind: 'done'; ok: boolean; error?: string }

export interface ProviderAuthStatusBridge {
  id: string
  configured: boolean
  source?: string
  label?: string
  models?: string[]
}

/** The OAuth-capable provider accessors, or `undefined` outside Electron. */
export function desktopProviderAuthBridge(): TDEaseDesktop['providerAuth'] | undefined {
  return desktop()?.providerAuth
}

// ── Workspace Web sharing types (mirrors electron/share-server.ts) ───────────

export type ShareTier = 'view' | 'continue' | 'control'
export type ShareMode = 'loopback' | 'lan'

export interface ShareConfigBridge {
  enabled: boolean
  mode: ShareMode
  port: number
  workspaceId: string
}

/** An invitation as the Renderer may see it: never the full token. */
export interface ShareInvitePublic {
  id: string
  name: string
  tier: ShareTier
  createdAt: string
  revokedAt?: string
  /** Fingerprint (first4…last4). The full secret exists only at creation and
   *  through the explicit reveal action — the API-key philosophy. */
  tokenPreview: string
}

export interface ShareConfigBridgeResult {
  config: ShareConfigBridge & { invites: ShareInvitePublic[] }
  status: { running: boolean; port?: number; url?: string }
  inviteStatuses: Array<{ inviteId: string; lastSeenAt: string | null }>
  audit: Array<{ at: string; name: string; action: string; detail: string }>
}

export interface ShareConfigWriteInput {
  enabled?: boolean
  mode?: ShareMode
  port?: number
  workspaceId?: string
}

/** The sharing configuration IPC bridge, or `undefined` outside Electron. */
export function desktopShareBridge(): TDEaseDesktop['share'] | undefined {
  return desktop()?.share
}

/** The local workspace registry IPC bridge, or `undefined` outside Electron. */
export function desktopWorkspaceRegistryBridge(): TDEaseDesktop['workspaceRegistry'] | undefined {
  return desktop()?.workspaceRegistry
}

/** The FULL workspace slice (bytes, tree mutation, shell reveal), or `undefined` outside Electron. */
export function desktopWorkspaceBridge(): TDEaseDesktop['workspace'] | undefined {
  return desktop()?.workspace
}

/** The conversation-export print bridge, or `undefined` outside Electron. */
export function desktopConversationBridge(): TDEaseDesktop['conversation'] | undefined {
  return desktop()?.conversation
}

function desktop(): DesktopGlobal['tdeaseDesktop'] {
  return (globalThis as DesktopGlobal).tdeaseDesktop
}

/** The local-Backend connection IPC bridge, or `undefined` outside Electron. */
export function desktopBackendBridge(): BackendBridge | undefined {
  return desktop()?.backend
}

/** The unified network-proxy IPC bridge, or `undefined` outside Electron. */
export function desktopNetworkBridge(): NonNullable<TDEaseDesktop['network']> | undefined {
  return desktop()?.network
}

/** Open the app's logs folder in the OS file manager. Returns false outside
 *  Electron (browser dev has no logs) — callers treat that as a no-op. */
export async function openDesktopLogs(): Promise<boolean> {
  const bridge = desktop()
  if (!bridge?.openLogs) return false
  await bridge.openLogs()
  return true
}

/** Mirrors `UpdateState` from electron/updater.ts — re-declared here because
 *  the preload contract is hand-typed on both sides (mirrors preload.cjs). */
export interface UpdateBridgeState {
  phase: 'unavailable' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  version: string | null
  progress: number | null
  message: string | null
}

/** The app-update IPC bridge, or `undefined` outside Electron. */
export function desktopUpdateBridge(): NonNullable<TDEaseDesktop['update']> | undefined {
  return desktop()?.update
}

/** The Agent runtime IPC bridge, or `undefined` outside Electron. */
export function desktopAgentBridge(): AgentBridge | undefined {
  return desktop()?.agent
}

/** The agent-provider config IPC bridge, or `undefined` outside Electron. */
export function desktopAgentProvidersBridge(): AgentProvidersBridge | undefined {
  return desktop()?.agentProviders
}

/** The read-side Subagent bridge, or `undefined` outside Electron. */
export function desktopSubagentBridge(): SubagentBridge | undefined {
  return desktop()?.subagent
}

/** The read-side background-Job bridge, or `undefined` outside Electron. */
export function desktopJobBridge(): JobBridge | undefined {
  return desktop()?.job
}

/** The read-side session-run bridge, or `undefined` outside Electron. */
export function desktopSessionRunBridge(): SessionRunBridge | undefined {
  return desktop()?.sessionRun
}

/** Agent → Workbench viewer commands (`view.*`). Absent outside Electron. */
export function desktopAgentViewBridge(): ViewBridge | undefined {
  return desktop()?.agentView
}

/**
 * Subscribe to desktop-driven Run invalidation. Returns the unsubscribe fn when
 * the bridge is present, `undefined` otherwise (browser dev has no desktop
 * invalidation source, which is fine — the store falls back to its own load).
 */
export function subscribeDesktopRunsInvalidation(
  onInvalidate: (workspaceId: string) => void,
): (() => void) | undefined {
  return desktop()?.runs?.subscribe(({ workspaceId }) => onInvalidate(workspaceId))
}

// ── Local MCP server config ──────────────────────────────────────────────────

/**
 * Parse the enabled MCP server names from a raw `settings.json` body. The file
 * may carry servers under `mcp.servers`, `mcp.mcpServers`, `servers` or
 * `mcpServers` (bare or nested-under-`mcp` layouts); an entry counts as
 * enabled unless `enabled: false`. Absorbed from AgentPage so two call sites
 * (the `/mcp` autocomplete + the settings editor) share one parser.
 */
export function parseEnabledServerNames(raw: string): string[] {
  try {
    const settings = JSON.parse(raw) as {
      mcp?: { servers?: Record<string, { enabled?: boolean }>; mcpServers?: Record<string, { enabled?: boolean }> }
      servers?: Record<string, { enabled?: boolean }>
      mcpServers?: Record<string, { enabled?: boolean }>
    }
    const parsed = settings.mcp ?? settings
    const servers = parsed.servers ?? parsed.mcpServers ?? {}
    return Object.entries(servers)
      .filter(([, config]) => config?.enabled !== false)
      .map(([name]) => name)
  } catch {
    return []
  }
}

/** Read the system-scope MCP config body, or `undefined` when unavailable. */
export async function readSystemMcpConfig(): Promise<string | undefined> {
  return desktop()?.mcpConfig?.readSystem()
}

/** Write the system-scope MCP config body. Throws if the bridge is absent. */
export async function writeSystemMcpConfig(content: string): Promise<void> {
  const bridge = desktop()?.mcpConfig
  if (!bridge) throw new Error('System MCP config is only editable in the desktop build.')
  await bridge.writeSystem(content)
}

/**
 * The union of enabled MCP servers across system config and the Workspace's
 * `.tdease/settings.json` (if any). The Workspace file system slice is read
 * through the same `desktop()` accessor; `workspacePath` may be empty in which
 * case only the system scope is consulted.
 */
export async function listEnabledLocalMcpServers(workspacePath: string): Promise<string[]> {
  const names = new Set<string>()
  const d = desktop()
  try {
    if (d?.mcpConfig) parseEnabledServerNames(await d.mcpConfig.readSystem()).forEach((n) => names.add(n))
  } catch { /* optional local System config */ }
  try {
    if (d?.workspace && workspacePath) {
      const configPath = '.tdease/settings.json'
      if (await d.workspace.exists(workspacePath, configPath)) {
        parseEnabledServerNames(await d.workspace.readText(workspacePath, configPath)).forEach((n) => names.add(n))
      }
    }
  } catch { /* a Workspace does not need an MCP config */ }
  return [...names].sort()
}

// ── Optional system / workspace text slices (for the local-skill catalog) ─────
// `agentSessionStorage.ts` exports throwing variants for session I/O; the
// local-skill catalog degrades gracefully when a slice is absent, so it takes
// these optional accessors instead.

type SystemTextBridge = NonNullable<DesktopGlobal['tdeaseDesktop']>['system']
type WorkspaceTextBridge = NonNullable<DesktopGlobal['tdeaseDesktop']>['workspace']
type BackendBridge = NonNullable<DesktopGlobal['tdeaseDesktop']>['backend']
type AgentProvidersBridge = NonNullable<DesktopGlobal['tdeaseDesktop']>['agentProviders']

export function desktopSystemBridgeOptionally(): SystemTextBridge | undefined {
  return desktop()?.system
}

export function desktopWorkspaceBridgeOptionally(): WorkspaceTextBridge | undefined {
  return desktop()?.workspace
}
