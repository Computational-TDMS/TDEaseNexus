// Electron main process entry.
//
// Bundled to electron/dist/main.bundle.cjs by electron/build-main.mjs.
// The Pi SDK runtime (Phase 2+) will be added here; for now this is the
// main.cjs logic lifted verbatim into TS so the esbuild bundle pipeline can
// be validated independently.
//
// NOTE: llm:stream proxy handlers are retained for now and removed in Phase 4
// once the renderer no longer consumes them.

import { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage, dialog, crashReporter, session, utilityProcess } from "electron";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { BackendManager } from "./backend_manager.cjs";
import { resolveComponents } from "./component_config.cjs";
import { ensureRuntimeDirectories, readSettings, resolvedSettings } from "./runtime_config.cjs";
import { createCredentialStore } from "./credential-store";
import { createCrashLogger } from "./crash_logger.cjs";
import { containedPath } from "./path_containment.cjs";
import { createSystemAssetCatalog } from "./system_asset_catalog.cjs";
import { reseedNodeCatalog } from "./node_catalog_seed.cjs";
import { ensureNativeCli, ensurePythonLaunchers, ensureSearchTools, pinSearchToolLookup, resolveVendorGitDirs } from "./skill_runtime.cjs";
import { newShareToken, type CollabEvent, type ShareConfig, type ShareInvite, type ShareMode, type ShareServer, type ShareTier } from "./share-server";
import { createModelCatalogRefresher } from "./agent/model-catalog-refresher";
import { createProviderAuthService, type ProviderAuthPush } from "./agent/provider-auth";
import { startUpdater } from "./updater";
import { atomicReplace, mergeProviderConfig, updateSettingsFile, writeTextAtomicQueued } from "./atomic-write";
import { applyProxyEnv, normalizeProxyConfig, updaterProxyRules, type NetworkProxyConfig } from "./proxy-config";
// Workspace file operations: algorithms live in workspace/workspaceFs.ts, the
// registry gatekeeper + Backend root approval in workspace/workspaceRegistry.ts,
// and the sharing logic in workspace/share.ts. main.ts keeps only the process
// state (runtimePaths, the ShareServer instance, the agent runtime) and binds
// it through thin forwarders so every handler below reads exactly as before.
// The result-cache path policy stays HERE on purpose: its containment contract
// is pinned to this file's text by
// src/services/storage/resultCacheStorage.electron.test.ts.
import {
  copyIntoWorkspace,
  listWorkspaceFiles,
  moveWorkspaceEntries,
  readWorkspaceByteRange,
  readWorkspaceFileBounded,
  sha256File,
} from "./workspace/workspaceFs";
import * as workspaceRegistry from "./workspace/workspaceRegistry";
import {
  applyShareConfig,
  normalizeShareConfig,
  readShareInvites,
  resolveSharedWorkspaceRoot,
  SHARE_MODES,
  SHARE_TIERS,
  writeShareInvites,
  type ShareWiring,
} from "./workspace/share";
import { configureHttpDispatcher } from "@tdease/pi-http-dispatcher";
import type { FSWatcher } from "chokidar";
// Bundled by electron/build-main.mjs (esbuild), so main may import from src/.
// Relative, not `@/` — the bundle configures no path alias. The watcher's
// ignore policy is derived here rather than restated; see the handler below.
import { workspaceWatchIgnoreGlobs } from "../src/studio/domain/workspace-snapshot-policy";
import {
  assertBindSessionInput,
  assertPromptInput,
  assertResolveApprovalInput,
} from "../src/contracts/agent-runtime";
import { createUsageLedger, type UsageLedger, type UsageListFilter } from "../src/ai/core/usage-ledger";
import { computeUsageStats, type UsageStatsRange } from "../src/ai/core/usage-stats";
// The agent runtime lives OUT of this process now: electron/agent/utility-host.ts
// boots the identical createAgentRuntime factory inside a utilityProcess, and
// the client below speaks the relay protocol (utility-protocol.ts) to it. The
// types are erased at compile time; the client defers spawning until the first
// agent IPC, preserving the lazy-startup property the in-process runtime had.
import {
  createAgentRuntimeClient,
  type AgentRuntimeClient,
} from "./agent/utility-client";

// userData split by mode: dev keeps the legacy profile name so its data root
// (%APPDATA%\TDEase) stays put; packaged builds brand as TDEaseNexus with their
// own profile (the two never share a single-instance lock or session store).
const isDev = !fs.existsSync(path.join(process.resourcesPath, "backend", "pyproject.toml"));
app.setName(isDev ? "TDEase" : "TDEaseNexus");
if (process.platform === "win32") {
  app.setAppUserModelId("com.tdeasenexus.app");
}

// Note: do not rely on app.isPackaged — we ship as an unpacked directory
// (resources/app/) rather than app.asar, so electron reports isPackaged=false.
// Instead, treat "backend sources exist under resourcesPath" as the marker of
// the real packaged mode (backend_manager uses the same check).
const devUrl = process.env.TDEASE_ELECTRON_DEV_URL || "http://127.0.0.1:1420";
// Driving the real app from Playwright (tests/desktop/) rather than a browser is
// the only way the Electron main process, the Pi runtime and the Backend are
// covered at all. Three behaviours that are right for a person sitting at the
// app are wrong for a test runner, and each would hang or corrupt a run:
//
//   - closing the window HIDES to a tray, so `electronApp.close()` never resolves
//   - DevTools opens detached and steals focus from every keyboard assertion
//   - the tray icon outlives the process and accumulates one per spec file
//
// This flag turns those behaviours off and also permits an isolated test instance
// beside a developer instance — the window, the IPC surface,
// the Pi runtime and the Backend are exactly what a user gets. It is read once,
// here, so no handler can branch on the environment at call time.
const isE2E = process.env.TDEASE_E2E === "1";
const e2eRecreateWindows = process.env.TDEASE_E2E_RECREATE_WINDOWS === "1";
const e2eDevTools = process.env.TDEASE_E2E_DEVTOOLS === "1";
// No bundled provider key ships with the app (2026-11-03 product decision):
// users configure their own provider keys in Settings. The historical
// seed-file path (resources/backend/settings.seed.json) is intentionally not
// consumed anymore.
const runtimePaths = ensureRuntimeDirectories({
  // Development deliberately shares the repository Backend runtime with the
  // supervised API and Worker. Packaged builds retain their profile-owned root.
  backendRoot: isDev ? path.resolve(__dirname, "..", "..", "data", "backend") : null,
});
const installedComponents = resolveComponents({ isDev, resourcesPath: process.resourcesPath });
// safeStorage-backed credential store (electron/credential-store.ts): the ONE
// place provider API keys and the remote-backend token are encrypted at rest
// (credentials.json beside settings.json). settings.json keeps at most an
// `apiKeyStored: true` marker. Main decrypts for its own consumers (registry
// resolve via the relay snapshot below, model discovery, the remote backend
// connect) — the renderer only ever sees fingerprints, exactly as before.
const credentialStore = createCredentialStore(runtimePaths.settingsFile);
// Reserved credentials.json namespace for the remote-backend bearer token
// (not a provider; only borrows the same encrypted providers map).
const BACKEND_TOKEN_ID = "backendConnection.accessToken";
// Settings-UI model-list refresher: the vendor's own /models listing (with the
// user's key, read here and never crossing IPC) over a models.dev fallback,
// TTL-cached under the Client System root. Read-only toward settings.json.
const modelCatalogRefresher = createModelCatalogRefresher({
  settingsPath: runtimePaths.settingsFile,
  cacheFile: path.join(runtimePaths.systemRoot, "models-cache.json"),
  credentialLookup: (providerId) => credentialStore.getProviderKey(providerId),
});
// OAuth login bridge — the authPath MUST match session-host's ModelRuntime,
// so a login in Settings authenticates every session. Pushes go only to the
// window that initiated the login.
let providerAuthPushTarget: Electron.WebContents | null = null;
const providerAuthService = createProviderAuthService({
  authPath: path.join(runtimePaths.agentRoot, "auth.json"),
  openExternal: (url) => { if (/^https:\/\//i.test(url)) void shell.openExternal(url); },
  push: (payload: ProviderAuthPush) => {
    if (providerAuthPushTarget && !providerAuthPushTarget.isDestroyed()) providerAuthPushTarget.send("provider-auth:event", payload);
  },
});
// The three D16 provisioning passes (python launchers, tdeasenexus-toolbox CLI,
// bundled rg/fd) used to run HERE at module top level — before any window
// existed, synchronously copying the 37.6MB CLI after every CLI rebuild. They
// are deferred into whenReady (provisionManagedTools below): the agent runtime
// resolves every tool lazily, at bash-spawn time (buildBashEnv prefixes
// managedBinDir onto PATH then; AgentRuntimeOptions.nativeCliPath is declared
// but never read), so no file needs to exist before a renderer could possibly
// spawn a session. pinSearchToolLookup stays here: it is a pure env mutation
// (PI_OFFLINE + PATH prefix, no filesystem I/O) and the no-network policy must
// be unconditional.
pinSearchToolLookup({ toolsDir: runtimePaths.agentToolsRoot, extraDirs: resolveVendorGitDirs() });
const startupSettings = resolvedSettings(runtimePaths.settingsFile);
// Unified network proxy (settings.json `network.proxy`), applied BEFORE any
// network can run: the env half reaches uv/pypi, the python backend and MCP
// stdio children at spawn time; the injected dispatcher covers every
// Node-fetch path in main (vendor LLM calls, OAuth, models.dev discovery)
// through Pi's own undici instance. No proxy configured → nothing is touched
// (the pre-proxy behavior, byte for byte).
const startupProxy = normalizeProxyConfig((startupSettings as { network?: { proxy?: unknown } }).network?.proxy);
let networkProxy: NetworkProxyConfig = startupProxy;
if (startupProxy.url) applyProxyEnv(startupProxy, { configureDispatcher: configureHttpDispatcher });
const configuredConnection = startupSettings.backendConnection;
const allowEnvOverrides = isDev && process.argv.includes("--allow-env-overrides");
const externalBackendUrl = allowEnvOverrides
  ? process.env.TDEASE_BACKEND_URL?.trim() || configuredConnection?.baseUrl || null
  : configuredConnection?.mode === "remote" ? configuredConnection.baseUrl : null;
// The remote bearer token lives in settings.json `backendConnection.accessToken`
// — the same block that selects external mode. Dev env overrides win; otherwise
// the persisted token is the single source both main-side callers (workspace
// approve/revoke, agent-session clients) and the renderer handshake trust.
let externalBackendConnection = externalBackendUrl
  ? {
      baseUrl: externalBackendUrl,
      accessToken: allowEnvOverrides
        ? process.env.TDEASE_ACCESS_TOKEN || null
        : typeof configuredConnection?.accessToken === "string" && configuredConnection.accessToken
          ? configuredConnection.accessToken
          : null,
      agentToken: null as string | null,
    }
  : null;
const electronDir = path.resolve(__dirname, "..");
const distDir = path.resolve(electronDir, "..", "dist");
const indexHtml = path.join(distDir, "index.html");
const appIcon = path.join(electronDir, "assets", "icon.png");
const splashHtml = path.join(electronDir, "splash.html");

const electronLogDir = runtimePaths.logsRoot;
const crashLog = createCrashLogger(path.join(electronLogDir, "electron-main.log"));
try {
  fs.mkdirSync(path.join(electronLogDir, "crash-dumps"), { recursive: true });
  app.setPath("crashDumps", path.join(electronLogDir, "crash-dumps"));
  crashReporter.start({ uploadToServer: false, compress: false });
} catch (error) {
  crashLog.warn("crash-reporter.start-failed", error);
}
crashLog.info("main.start", { pid: process.pid, mode: isDev ? "development" : "packaged" });

let splashWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
let backendManager: InstanceType<typeof BackendManager> | null = null;
let tray: Tray | null = null;
let forceQuit = false;
// Replaces the former `(app as any).isQuitting` monkey-patch: module-local,
// written on every quit path, read by the splash close guard.
let appIsQuitting = false;
let fatalExitStarted = false;
// Usage ledger — lazily created on first access and injected into the Pi
// engine runtime. Persists to <systemRoot>/usage-ledger.json (same mutable
// System root as settings.json). Appends are broadcast to the renderer so the
// StatisticsPanel can update live without re-querying.
let usageLedgerEntry: { ledger: UsageLedger } | null = null;
// bootApp() start time. createMainWindow's ready path reads it to decide the
// splash linger: the "ready" cel only deserves its closing-line pause when
// the user actually watched the staged boot progress, which a fast boot
// never showed them.
let bootStartedAt = Date.now();

const hasSingleInstanceLock = isE2E || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const agentSessionOwners = new Map<string, Electron.WebContents>();
const rendererCleanupInstalled = new WeakSet<Electron.WebContents>();

function stopAfterFatalError(error: unknown) {
  crashLog.error("main.uncaught-exception", error);
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  const forcedExit = setTimeout(() => app.exit(1), 5000);
  forcedExit.unref();
  Promise.resolve(backendManager?.stop())
    .catch((stopError) => crashLog.error("backend.stop-after-crash-failed", stopError))
    .finally(() => app.exit(1));
}

process.on("uncaughtException", stopAfterFatalError);
process.on("unhandledRejection", (reason) => crashLog.error("main.unhandled-rejection", reason));
process.on("exit", (code) => crashLog.info("main.exit", { code }));

app.on("render-process-gone", (_event, webContents, details) => {
  crashLog.error("renderer.process-gone", {
    url: webContents.getURL(),
    reason: details.reason,
    exitCode: details.exitCode,
  });
});
app.on("child-process-gone", (_event, details) => {
  crashLog.error("electron.child-process-gone", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName,
    name: details.name,
  });
});
ipcMain.on("desktop:renderer-error", (event, payload: unknown) => {
  crashLog.error("renderer.unhandled-error", {
    url: event.sender.getURL(),
    payload,
  });
});

function systemAssetsRoot(): string {
  return installedComponents.scientific.root;
}

function systemDataRoot(): string {
  return runtimePaths.systemRoot;
}

const systemAssetCatalog = createSystemAssetCatalog({
  productRoot: systemAssetsRoot(),
});

function systemDataPath(relative: string): string {
  if (typeof relative !== "string" || !relative) throw new Error("system data path is required");
  return containedPath(systemDataRoot(), relative, "system data path traversal denied");
}

async function listSystemDataFiles(relative: string): Promise<string[]> {
  const base = systemDataRoot();
  const root = systemDataPath(relative);
  const files: string[] = [];
  try { await fsp.access(root); } catch { return files; }
  async function walk(directory: string): Promise<void> {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(path.relative(base, absolute).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return files.sort();
}

// The main process owns the persisted ledger. It is deliberately created from
// main's own bundle: an auxiliary accounting feature must not add another
// required export to the separately-built Pi runtime or block Session creation
// when the two bundles are rebuilt at different times in development.
function usageLedger(): UsageLedger {
  if (usageLedgerEntry) return usageLedgerEntry.ledger;
  const ledger = createUsageLedger({
    storagePath: path.join(systemDataRoot(), "usage-ledger.json"),
  });
  // Forward every appended entry to the renderer's StatisticsPanel. Broadcast
  // to all webContents so a panel open in any window updates live; the entry is
  // global, the renderer does not need to filter by session.
  ledger.subscribe((entry: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("usage-ledger:event", entry);
    }
  });
  usageLedgerEntry = { ledger };
  return ledger;
}

// ── Agent runtime (utility process, lazy) ─────────────────────────────────────
// The agent runtime (sessions, PTY bash, tool gateway, subagents, jobs) runs
// in a supervised utilityProcess (electron/dist/agent-utility.cjs — entry
// electron/agent/utility-host.ts). Nothing the agent does — a node-pty native
// crash, a runaway loop, an OOM from a giant tool output — can take down this
// process. The spawn is deferred to the first agent IPC (same laziness the
// in-process runtime had: no child process before then), and the client
// respawns the child and rebinds owned sessions from the on-disk store after
// a crash. The ipcMain channel names and payloads are unchanged; the renderer
// does not know where the runtime lives.
let agentRuntimeClient: AgentRuntimeClient | null = null;

function getAgentRuntime(): AgentRuntimeClient {
  if (agentRuntimeClient) return agentRuntimeClient;
  agentRuntimeClient = createAgentRuntimeClient({
    spawn: () => {
      const child = utilityProcess.fork(path.join(__dirname, "agent-utility.cjs"), [], {
        serviceName: "tdease-agent-runtime",
        stdio: "pipe",
      });
      // Child stderr (Pi runtime warnings, native crash spew) rides the app's
      // crash log instead of vanishing with the detached process.
      child.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim()) crashLog.warn("agent-utility.stderr", line.slice(0, 2000));
        }
      });
      return child;
    },
    init: {
      settingsPath: runtimePaths.settingsFile,
      systemRoot: runtimePaths.systemRoot,
      agentDir: runtimePaths.agentRoot,
      managedBinDir: runtimePaths.agentToolsRoot,
      systemAssetsRoot: systemAssetsRoot(),
      systemCacheRoot: runtimePaths.systemCacheRoot,
      isDev,
      logFile: path.join(electronLogDir, "agent-utility.log"),
      proxy: networkProxy,
      // External backend mode withholds the node-catalog install port, exactly
      // as the in-process runtime's options did.
      ...(externalBackendConnection ? {} : { hasNodeCatalogInstaller: true }),
    },
    isQuitting: () => appIsQuitting,
    crashLog,
    // The runtime's one outward event surface (RuntimePush): turn events plus
    // the read-side pushes, all routed through the owner map the same way.
    push: {
      turnEvent: (sessionId, payload, parentSessionId) => {
      // A subagent (or background-job) session is bound internally by the
      // registry, not via the agent:bind-session IPC, so it has no owner entry
      // of its own. Route its turn events (text deltas, tool commits, …) to
      // the renderer that owns its PARENT session — that is where a live
      // SubagentConversation tab is streaming that child. The relay host
      // resolves the parent id child-side, so this stays a map lookup.
      let owner = agentSessionOwners.get(sessionId);
      if (!owner && parentSessionId) owner = agentSessionOwners.get(parentSessionId);
      if (owner && !owner.isDestroyed()) owner.send("agent:event", sessionId, payload);
      // The collab mirror consumes the same stream the host Renderer sees, so
      // a guest's view can never drift from what the host user is watching.
      // No-op when sharing is off (shareServer is null), including across
      // restarts, because apply() rebuilt it idempotently.
      shareServer?.publishTurnEvent(sessionId, payload as unknown as CollabEvent);
    },
      runsInvalidated: (workspaceId) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send("runs:invalidated", { workspaceId });
        }
      },
      subagents: (sessionId, snapshot) => {
      // Same owner-map routing as `agent:event` — a session's subagent records
      // belong to the renderer that bound it, so a stale/destroyed owner is a
      // no-op rather than a cross-window leak.
      const owner = agentSessionOwners.get(sessionId);
      if (owner && !owner.isDestroyed()) owner.send("subagent:changed", sessionId, snapshot);
    },
      jobs: (sessionId, snapshot) => {
      // Same owner-map routing as subagent:changed — a session's job records
      // belong to the renderer that bound it, so a stale/destroyed owner is a
      // no-op rather than a cross-window leak.
      const owner = agentSessionOwners.get(sessionId);
      if (owner && !owner.isDestroyed()) owner.send("job:changed", sessionId, snapshot);
    },
      sessionRuns: (sessionId, snapshot) => {
      // Same owner-map routing — a session's dispatched-run list belongs to
      // the renderer that bound it ("runs this conversation started"), not to
      // the workspace at large.
      const owner = agentSessionOwners.get(sessionId);
      if (owner && !owner.isDestroyed()) owner.send("session-run:changed", sessionId, snapshot);
    },
      view: (sessionId, envelope) => {
      // Same owner-map routing: the Agent points the window that bound its
      // session at a file — never another window's Workbench.
      const owner = agentSessionOwners.get(sessionId);
      if (owner && !owner.isDestroyed()) owner.send("agent-view:command", envelope);
    },
      contextUsage: (sessionId, usage) => {
      // Same owner-map routing as subagent:changed/job:changed. Child
      // (subagent) sessions have no gauge UI, so their context reads are
      // dropped child-side — pointless IPC noise otherwise.
      const owner = agentSessionOwners.get(sessionId);
        if (owner && !owner.isDestroyed()) owner.send("context:changed", sessionId, usage);
      },
    },
    // Main-owned dependencies, exposed to the child over reverse RPC.
    deps: {
      resolveWorkspaceRoot: async (workspaceId) => {
        const registry = await readWorkspaceRegistry();
        const entry = registry.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
        if (!entry || typeof entry.local_path !== "string") throw new Error(`Workspace is not registered: ${workspaceId}`);
        return workspacePath(entry.local_path);
      },
      backendConnection: () => backendConnectionInfo(),
      // Decrypted provider keys for the utility runtime's registry: the child
      // cannot reach safeStorage, so main resolves the effective key per
      // provider (explicit settings value first — pre-migration plaintext or
      // a fail-closed fallback install — then the encrypted store) and the
      // host snapshots the map ahead of every request (utility-host-core).
      credentialKeys: () => decryptedProviderKeys(),
      // Local Node-catalog installation: Electron main owns the copy because
      // the agent's filesystem reach ends at the Workspace. A remote Backend
      // connection owns its catalog on its own host, so the port is withheld
      // entirely — `nodes.install` then reports the boundary instead of
      // copying into a catalog the connected Backend never reads.
      ...(externalBackendConnection ? {} : { nodeCatalogInstaller: installNodePackage }),
      usageLedger: usageLedger(),
      // Model-metadata digest for models Pi's catalog doesn't know: the
      // refresher serves it from its warm aggregator cache (offline),
      // SessionHost's register branch freezes it into settings.json. Nothing
      // crosses renderer IPC.
      resolveModelMeta: (providerId: string, modelId: string) => modelCatalogRefresher.modelMeta(providerId, modelId),
    },
  });
  return agentRuntimeClient;
}

function assertAgentSessionOwner(sender: Electron.WebContents, sessionId: string): void {
  if (agentSessionOwners.get(sessionId) !== sender) throw new Error("Agent session is not owned by this renderer");
}

ipcMain.handle("agent:bind-session", async (event, input: unknown) => {
  assertBindSessionInput(input);
  ensureRendererCleanup(event.sender);
  const result = await getAgentRuntime().bindSession(input);
  if (result.ok) {
    agentSessionOwners.set(input.sessionId, event.sender);
    // The host user opened this conversation — it is now the live session a
    // guest's collab view mirrors. Nothing is mirrored while sharing is off.
    shareServer?.notifySessionBound(input.sessionId, { workspaceId: input.workspaceId });
  }
  return result;
});
ipcMain.handle("mcp-config:read-system", async () => {
  const settings = readSettings(runtimePaths.settingsFile) || {};
  return `${JSON.stringify(settings.mcp || { mcpServers: {} }, null, 2)}\n`;
});
ipcMain.handle("system:read-text", async (_event, relative: string) => systemAssetCatalog.readText(relative));
ipcMain.handle("system:list-files", async (_event, relative: string) => systemAssetCatalog.listFiles(relative));
ipcMain.handle("system-data:list-files", async (_event, relative: string) => listSystemDataFiles(relative));
ipcMain.handle("system-data:read-text", async (_event, relative: string) => fsp.readFile(systemDataPath(relative), "utf8"));
ipcMain.handle("system-data:write-text-atomic", async (_event, relative: string, content: string) => {
  if (typeof content !== "string") throw new Error("system data content must be text");
  const target = systemDataPath(relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tdease-${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(temp, content, "utf8"); await atomicReplace(temp, target); }
  finally { await fsp.rm(temp, { force: true }).catch(() => undefined); }
});
ipcMain.handle("system-data:sha256", (_event, relative: string) => new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(systemDataPath(relative));
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(hash.digest("hex")));
}));
ipcMain.handle("mcp-config:write-system", async (_event, content: string) => {
  const mcp = JSON.parse(content);
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) throw new Error("MCP configuration must be an object");
  await updateSettingsFile(runtimePaths.settingsFile, (doc) => ({ ...(doc ?? {}), mcp }));
});
// ── Agent provider config (settings.json, the single credential truth) ───────
//
// NodeProviderRegistry reads the top-level `providers` object. The Renderer
// writes credentials here and receives only redacted summaries; provider/model
// selection is supplied explicitly by bindSession and is not duplicated here.
ipcMain.handle("settings:read-agent-providers", async () => {
  const settings = readSettings(runtimePaths.settingsFile) || {};
  const providers = (settings.providers ?? {}) as Record<string, Record<string, unknown>>;
  const summary: Record<string, { configured: boolean; name?: string; baseUrl?: string; models?: string[]; credentialFingerprint?: string }> = {};
  // A provider counts as configured only through the user's own settings
  // entry; no build-baked credential exists anymore. The fingerprint covers
  // the effective key so swapping it re-binds the turn session.
  const ids = new Set([...Object.keys(providers)]);
  for (const id of ids) {
    const config = providers[id] ?? {};
    // Effective key: explicit settings value (pre-migration plaintext, or a
    // fail-closed fallback install) wins; otherwise the decrypted blob. The
    // fingerprint covers the EFFECTIVE key, so a config that migrates from
    // plaintext to the store keeps its fingerprint — turn bindings survive.
    const userKey = config.apiKey ?? config.api_key;
    const apiKey = (typeof userKey === "string" && userKey.length > 0)
      ? userKey
      : credentialStore.getProviderKey(id) ?? undefined;
    const baseUrl = config.baseUrl ?? config.base_url;
    summary[id] = {
      configured: typeof apiKey === "string" && apiKey.length > 0,
      // Display name of user-defined providers ("custom-*"); catalog providers
      // name themselves in the static catalog.
      ...(typeof config.name === "string" && config.name.trim() ? { name: config.name.trim() } : {}),
      // Non-secret hash prefix of the credential. The renderer puts it in the
      // turn binding key, so swapping the key re-binds the session — without
      // it a saved key stayed inert until a restart. The key itself never
      // crosses IPC.
      ...(typeof apiKey === "string" && apiKey.length > 0
        ? { credentialFingerprint: crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 8) }
        : {}),
      ...(typeof baseUrl === "string" ? { baseUrl } : {}),
      ...(config.models && typeof config.models === "object" ? { models: Object.keys(config.models as Record<string, unknown>) } : {}),
    };
  }
  return { providers: summary };
});
ipcMain.handle("settings:write-agent-provider", async (_event, providerId: string, config: Record<string, unknown>) => {
  if (typeof providerId !== "string" || !providerId.trim()) throw new Error("providerId is required");
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("provider config must be an object");
  const hasValue = ["apiKey", "baseUrl", "headers"].some((k) => config[k] !== undefined && config[k] !== "");
  const plainKey = typeof config.apiKey === "string" && config.apiKey.length > 0 ? config.apiKey : null;
  // Credential-store write path: when safeStorage is available the key lands
  // encrypted in credentials.json FIRST (credential-store's blob-before-scrub
  // ordering), and settings.json receives the `apiKeyStored` marker instead of
  // the secret. When safeStorage is unavailable (Linux without libsecret…),
  // credential-store is fail-closed by contract — it refuses the write. The
  // app must keep working, so this caller (not the store) falls back to the
  // historical plaintext write and says so in the log. Wrapping beats editing
  // the store's core: its "no plaintext write-back" invariant stays intact.
  let keyStoredEncrypted = false;
  if (plainKey && credentialStore.isAvailable()) {
    try {
      await credentialStore.storeProviderKey(providerId, plainKey);
      keyStoredEncrypted = true;
    } catch (error) {
      // Blob write failed: fall through to the plaintext write below — losing
      // the key the user just typed would be far worse than a plaintext one.
      crashLog.warn("credential-store.provider-key-store-failed", { providerId, error });
    }
  } else if (plainKey) {
    crashLog.warn("credential-store.unavailable-plaintext-fallback", { providerId });
  } else if (credentialStore.isAvailable()) {
    // No key in this write (clear or keyless edit): drop any stored blob so a
    // cleared credential cannot keep resolving from the encrypted store.
    // Guarded by isAvailable(): when unavailable the blob is unreadable too
    // (fail-closed reads), so skipping the delete is safe and quiet.
    await credentialStore.deleteProviderKey(providerId).catch((error: unknown) =>
      crashLog.warn("credential-store.provider-key-delete-failed", { providerId, error }));
  }
  const { apiKey: _stripped, ...keylessConfig } = config;
  const settingsConfig = plainKey && keyStoredEncrypted
    ? { ...keylessConfig, apiKeyStored: true }
    : config;
  // mergeProviderConfig keeps a cleared provider's `models` map alive — the
  // frozen capability digests are model truth, not credential state.
  const written = await updateSettingsFile(runtimePaths.settingsFile, (doc) => {
    const providers = { ...((doc?.providers ?? {}) as Record<string, Record<string, unknown>>) };
    const merged = mergeProviderConfig(providers[providerId], settingsConfig);
    if (merged) providers[providerId] = merged;
    else delete providers[providerId];
    return { ...(doc ?? {}), providers };
  });
  if (!written) throw new Error("settings.json could not be updated");
  return { ok: true as const, providerId, configured: hasValue && typeof config.apiKey === "string" && config.apiKey.length > 0 };
});
// True removal — write {} deliberately spares the frozen `models` capability
// digests, which is right for "clear credentials" but would leave a ghost
// entry behind "delete this custom provider". That deletes the whole key.
ipcMain.handle("settings:delete-agent-provider", async (_event, providerId: string) => {
  if (typeof providerId !== "string" || !providerId.trim()) throw new Error("providerId is required");
  let existed = false;
  const written = await updateSettingsFile(runtimePaths.settingsFile, (doc) => {
    const providers = { ...((doc?.providers ?? {}) as Record<string, Record<string, unknown>>) };
    if (!(providerId in providers)) return null; // absent: abort, no write — a delete of nothing is a no-op
    existed = true;
    delete providers[providerId];
    return { ...(doc ?? {}), providers };
  });
  if (!written && existed) throw new Error("settings.json could not be updated");
  // The settings entry is gone; drop the encrypted blob with it so a deleted
  // provider cannot keep resolving (guarded: an unavailable store is already
  // unreadable, fail-closed, so there is nothing to clean up).
  if (existed && credentialStore.isAvailable()) {
    await credentialStore.deleteProviderKey(providerId).catch((error: unknown) =>
      crashLog.warn("credential-store.provider-key-delete-failed", { providerId, error }));
  }
  return { ok: true as const, providerId };
});
// One model id into providers.<id>.models — sibling-safe (existing metas are
// never rewritten, unlike a renderer-side {models: ...} merge which would wipe
// frozen capability digests it cannot see). Empty meta = the capability seam's
// defaults apply until the next bind freezes a digest.
ipcMain.handle("settings:add-provider-model", async (_event, providerId: string, modelId: string) => {
  if (typeof providerId !== "string" || !providerId.trim()) throw new Error("providerId is required");
  if (typeof modelId !== "string" || !modelId.trim()) throw new Error("modelId is required");
  const written = await updateSettingsFile(runtimePaths.settingsFile, (doc) => {
    const providers = { ...((doc?.providers ?? {}) as Record<string, Record<string, unknown>>) };
    const config = { ...((providers[providerId] ?? {}) as Record<string, unknown>) };
    const models = { ...((config.models ?? {}) as Record<string, unknown>) };
    const id = modelId.trim();
    if (models[id] !== undefined) return null; // already known — no write
    models[id] = {};
    config.models = models;
    providers[providerId] = config;
    return { ...(doc ?? {}), providers };
  });
  if (!written) throw new Error("settings.json could not be updated");
  return { ok: true as const, providerId, modelId };
});
// Live model list for the Settings provider detail — discovery + aggregator
// with their own TTL cache (`<systemRoot>/models-cache.json`). Advisory only:
// the result feeds the picker; settings.json stays the binding truth.
ipcMain.handle("settings:read-provider-models", (_event, providerId: string, options?: { force?: boolean }) =>
  modelCatalogRefresher.refresh(providerId, options ?? {}));
// Per-model price declaration (USD per 1M tokens) — providers.<id>.models.
// <modelId>.cost, the exact shape the discovery digest freezes, so the runtime
// cost chain (modelMeta → costRates → ledger costTotal) picks it up with no
// adapter. Custom endpoints have no vendor pricing source; this is the one
// way their usage statistics get a real dollar figure. Field-level merge:
// sibling models and other meta fields are untouched; null removes the cost
// block ("unpriced" again).
ipcMain.handle("settings:set-provider-model-pricing", async (_event, providerId: string, modelId: string, cost: Record<string, unknown> | null) => {
  if (typeof providerId !== "string" || !providerId.trim()) throw new Error("providerId is required");
  if (typeof modelId !== "string" || !modelId.trim()) throw new Error("modelId is required");
  let normalized: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
  if (cost != null) {
    if (typeof cost !== "object" || Array.isArray(cost)) throw new Error("pricing must be an object or null");
    const rate = (value: unknown): number => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    normalized = {
      input: rate(cost.input),
      output: rate(cost.output),
      cacheRead: rate(cost.cacheRead),
      cacheWrite: rate(cost.cacheWrite),
    };
  }
  const written = await updateSettingsFile(runtimePaths.settingsFile, (doc) => {
    const providers = { ...((doc?.providers ?? {}) as Record<string, Record<string, unknown>>) };
    const existingConfig = providers[providerId];
    if (!existingConfig || typeof existingConfig !== "object" || Array.isArray(existingConfig)) {
      throw new Error(`Provider not configured: ${providerId}`);
    }
    const config = { ...existingConfig };
    const models = { ...((config.models ?? {}) as Record<string, Record<string, unknown>>) };
    // Pricing attaches to a model the user already registered — creating a
    // meta-only ghost entry would leak it into the picker's model list.
    if (!(modelId in models)) throw new Error(`Model not registered: ${providerId}/${modelId}`);
    const meta = { ...(models[modelId] ?? {}) };
    if (normalized) meta.cost = normalized;
    else delete meta.cost;
    models[modelId] = meta;
    config.models = models;
    providers[providerId] = config;
    return { ...(doc ?? {}), providers };
  });
  if (!written) throw new Error("settings.json could not be updated");
  return { ok: true as const, providerId, modelId };
});
// Read back one provider's declared per-model pricing. Pricing is not secret
// (unlike the apiKey it was entered by the user to make statistics truthful).
ipcMain.handle("settings:read-provider-model-pricing", (_event, providerId: string) => {
  const settings = readSettings(runtimePaths.settingsFile) || {};
  const config = ((settings.providers ?? {}) as Record<string, { models?: Record<string, unknown> }>)[providerId];
  const pricing: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {};
  for (const [modelId, meta] of Object.entries(config?.models ?? {})) {
    const cost = (meta && typeof meta === "object" ? (meta as { cost?: unknown }).cost : null) as
      | Record<string, unknown>
      | null;
    if (!cost || typeof cost !== "object" || Array.isArray(cost)) continue;
    const input = Number(cost.input);
    const output = Number(cost.output);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    pricing[modelId] = {
      input,
      output,
      cacheRead: Number.isFinite(Number(cost.cacheRead)) ? Number(cost.cacheRead) : 0,
      cacheWrite: Number.isFinite(Number(cost.cacheWrite)) ? Number(cost.cacheWrite) : 0,
    };
  }
  return { pricing };
});
// Explicit connection test (ProviderDetail's "Test connection"): one live
// probe of the provider's own listing endpoint with its stored credential,
// typed verdict — never the models.dev fallback, never a cache write.
ipcMain.handle("settings:test-provider", (_event, providerId: string) =>
  modelCatalogRefresher.test(providerId));
// OAuth login (provider-auth.ts): the invoking window receives the flow's
// prompts and events on `provider-auth:event`, answers prompts through
// `provider-auth:resolve-prompt`, and may cancel mid-flow.
ipcMain.handle("provider-auth:login", async (event, providerId: string) => {
  providerAuthPushTarget = event.sender;
  return providerAuthService.login(providerId);
});
ipcMain.handle("provider-auth:cancel", () => providerAuthService.cancel());
ipcMain.handle("provider-auth:resolve-prompt", (_event, promptId: string, value: string) =>
  providerAuthService.resolvePrompt(promptId, value));
ipcMain.handle("provider-auth:status", () => providerAuthService.status());
// Usage ledger read. The ledger is created lazily on first Pi session, so a
// panel opened before any conversation still resolves (empty list). Filter is
// passed through verbatim to the ledger's list().
ipcMain.handle("usage-ledger:list", async (_event, filter?: UsageListFilter) =>
  usageLedger().list(filter ?? {}));
// Full-ledger aggregation (usage-stats.ts) — every consumption surface goes
// through here so no renderer can reintroduce the capped-page under-count.
ipcMain.handle("usage-ledger:stats", (_event, range: UsageStatsRange) => {
  const valid: UsageStatsRange[] = ["5h", "today", "7d", "30d", "all"];
  return computeUsageStats(usageLedger().list({}), {
    range: valid.includes(range) ? range : "all",
  });
});
ipcMain.handle("usage-ledger:clear", () => {
  usageLedger().clear();
});
ipcMain.handle("agent:prompt", async (event, input: unknown) => {
  assertPromptInput(input);
  assertAgentSessionOwner(event.sender, input.sessionId);
  return getAgentRuntime().prompt(input);
});
ipcMain.handle("agent:abort", async (event, sessionId: string) => {
  if (agentSessionOwners.get(sessionId) !== event.sender) return { ok: true };
  return getAgentRuntime().abort(sessionId);
});
ipcMain.handle("agent:compact", async (event, sessionId: string) => {
  assertAgentSessionOwner(event.sender, sessionId);
  return getAgentRuntime().compact(sessionId);
});
ipcMain.handle("agent:fork", async (event, sessionId: string, targetSessionId: string) => {
  assertAgentSessionOwner(event.sender, sessionId);
  return getAgentRuntime().fork(sessionId, targetSessionId);
});
ipcMain.handle("agent:dispose", async (event, sessionId: string) => {
  if (agentSessionOwners.get(sessionId) !== event.sender) return { ok: true };
  agentSessionOwners.delete(sessionId);
  shareServer?.notifySessionDisposed(sessionId);
  return getAgentRuntime().dispose(sessionId);
});
ipcMain.handle("agent:resolve-approval", async (event, input: unknown) => {
  assertResolveApprovalInput(input);
  assertAgentSessionOwner(event.sender, input.sessionId);
  return getAgentRuntime().resolveApproval(input);
});

// ── Conversation export: print a standalone HTML document to PDF bytes.
// The renderer owns the document (conversation-export.ts) and the destination
// (workspace `exports/` through the bytes-atomic channel); this handler owns
// only the printing, in one hidden chrome-less window with NO preload — the
// document is untrusted-ish renderer output and needs no app APIs. A temp
// file (not a data: URL) keeps large conversations off navigation limits. ──
ipcMain.handle("conversation:print-pdf", async (_event, html: string) => {
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("conversation:print-pdf requires non-empty html");
  }
  const dir = await fsp.mkdtemp(path.join(app.getPath("temp"), "tdease-export-"));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    const file = path.join(dir, "conversation.html");
    await fsp.writeFile(file, html, "utf8");
    // The export HTML is fully self-contained (math pre-rendered, fonts
    // inlined — no CDN link since B3), so loadFile settles offline. The race
    // stays as a safety net: a pathological page (huge embedded fonts on a
    // slow disk) must never hang the export — print whatever rendered after
    // 15 s.
    await Promise.race([
      win.loadFile(file),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
    return new Uint8Array(pdf);
  } finally {
    win.destroy();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ── Subagent read-side IPC (Phase B of the palot inspector migration).
// The agent-facing surface is still the three command primitives
// (spawn/status/cancel) the registry already exposes; these handlers are the
// UI read-side — the inspector's Subagents tab and the SessionBar running
// badge. `subagent:changed` is pushed through the same `agent:event` owner
// map (set on bind-session), so an unowned sender gets nothing. ──────────
ipcMain.handle("subagent:list", async (event, sessionId: unknown) => {
  if (typeof sessionId !== "string") throw new Error("subagent:list sessionId must be a string");
  // Session selection is persisted, while the live Agent binding is not. On
  // startup/reload the renderer can therefore request this read projection
  // before bindSession has re-established ownership. An unbound session has
  // no live subagent registry, so its truthful snapshot is empty. Commands
  // such as cancel remain owner-checked below.
  if (agentSessionOwners.get(sessionId) !== event.sender) return [];
  return getAgentRuntime().listSubagents(sessionId);
});
ipcMain.handle("subagent:cancel", async (event, parentSessionId: unknown, subagentId: unknown) => {
  if (typeof parentSessionId !== "string" || typeof subagentId !== "string") {
    throw new Error("subagent:cancel requires (parentSessionId, subagentId) strings");
  }
  assertAgentSessionOwner(event.sender, parentSessionId);
  return getAgentRuntime().cancelSubagent(parentSessionId, subagentId);
});

ipcMain.handle("subagent:peek", async (event, parentSessionId: unknown, subagentId: unknown, lines: unknown) => {
  if (typeof parentSessionId !== "string" || typeof subagentId !== "string") {
    throw new Error("subagent:peek requires (parentSessionId, subagentId) strings");
  }
  assertAgentSessionOwner(event.sender, parentSessionId);
  return getAgentRuntime().peekSubagent(parentSessionId, subagentId, typeof lines === "number" ? lines : undefined);
});

// Background-job UI read-side — mirrors the subagent handlers above. The
// renderer's jobs store subscribes to `job:changed` and calls these for
// list/cancel/peek; `job:changed` rides the same owner map as `subagent:changed`.
ipcMain.handle("job:list", async (event, sessionId: unknown) => {
  if (typeof sessionId !== "string") throw new Error("job:list sessionId must be a string");
  if (agentSessionOwners.get(sessionId) !== event.sender) return [];
  return getAgentRuntime().listJobs(sessionId);
});
ipcMain.handle("session-run:list", async (event, sessionId: unknown) => {
  if (typeof sessionId !== "string") throw new Error("session-run:list sessionId must be a string");
  if (agentSessionOwners.get(sessionId) !== event.sender) return [];
  return getAgentRuntime().listSessionRuns(sessionId);
});
ipcMain.handle("job:cancel", async (event, parentSessionId: unknown, jobId: unknown) => {
  if (typeof parentSessionId !== "string" || typeof jobId !== "string") {
    throw new Error("job:cancel requires (parentSessionId, jobId) strings");
  }
  assertAgentSessionOwner(event.sender, parentSessionId);
  return getAgentRuntime().cancelJob(parentSessionId, jobId);
});
ipcMain.handle("job:peek", async (event, parentSessionId: unknown, jobId: unknown, lines: unknown) => {
  if (typeof parentSessionId !== "string" || typeof jobId !== "string") {
    throw new Error("job:peek requires (parentSessionId, jobId) strings");
  }
  assertAgentSessionOwner(event.sender, parentSessionId);
  return getAgentRuntime().peekJob(parentSessionId, jobId, typeof lines === "number" ? lines : undefined);
});

// ---------------------------------------------------------------- splash

async function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 720,
    height: 560,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    center: true,
    backgroundColor: "#F7F5F2",
    icon: appIcon,
    webPreferences: {
      // Plain sandboxed window: no Node in the renderer. The splash's few IPC
      // channels (progress/error events, retry/quit/open-logs) are exposed via
      // a minimal contextBridge preload — electron/splash-preload.cjs — instead
      // of nodeIntegration, so a compromised splash page gets nothing else.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "splash-preload.cjs"),
    },
  });
  await splashWindow.loadFile(splashHtml);
  splashWindow.on("close", (e) => {
    if (!appIsQuitting) e.preventDefault();
  });
}

ipcMain.handle("desktop:open-logs", async () => {
  const dir = runtimePaths.logsRoot;
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
ipcMain.handle("desktop:open-uv-docs", () => shell.openExternal("https://docs.astral.sh/uv/getting-started/installation/"));

// ── Unified network proxy (B1) ───────────────────────────────────────────────
//
// The Renderer edits; settings.json persists; applyProxyEnv + the updater
// session apply it live. Not a secret — the proxy host is infrastructure, not
// a credential — so the plain config crosses IPC in both directions.
ipcMain.handle("network:read-proxy", () => ({ ...networkProxy }));
ipcMain.handle("network:write-proxy", async (_event, input: { url?: unknown; noProxy?: unknown }) => {
  const next = normalizeProxyConfig(input);
  await updateSettingsFile(runtimePaths.settingsFile, (doc) => {
    const record = (doc ?? {}) as Record<string, unknown>
    const network = { ...(record.network as Record<string, unknown> | undefined), proxy: next }
    return { ...record, network }
  });
  networkProxy = next;
  applyProxyEnv(next, { configureDispatcher: configureHttpDispatcher });
  const updaterSession = session.fromPartition("electron-updater", { cache: false });
  await updaterSession.setProxy(updaterProxyRules(next))
    .catch((error) => crashLog.warn("proxy.updater-session-failed", error));
  return { ...next };
});
// Resolved when the current BackendManager's start() settles (null before
// the first start / in external-backend mode, where nothing needs waiting).
let backendStartPromise: Promise<void> | null = null;

ipcMain.handle("backend:connection", async () => {
  // The renderer boots concurrently with the backend chain (window creation
  // no longer waits for backendManager.start()), so the first connection()
  // can arrive before start() resolved. Waiting for the chain here is the
  // one correct parking spot: the renderer's boot path mounts on this
  // handshake and never re-issues it on its own (its supervisor retries
  // probes, not the base-URL handshake). A failed start still falls through
  // to backendConnectionInfo()'s throw, which the renderer renders as its
  // offline state with a manual retry.
  await backendStartPromise?.catch(() => undefined);
  return backendConnectionInfo();
});

/** providerId → effective (decrypted) key, for the utility runtime's resolve. */
function decryptedProviderKeys(): Record<string, string> {
  const providers = ((readSettings(runtimePaths.settingsFile) ?? {}).providers ?? {}) as Record<string, Record<string, unknown>>;
  const keys: Record<string, string> = {};
  for (const [id, config] of Object.entries(providers)) {
    const plain = config?.apiKey ?? config?.api_key;
    if (typeof plain === "string" && plain) keys[id] = plain;
    else {
      const stored = credentialStore.getProviderKey(id);
      if (stored) keys[id] = stored;
    }
  }
  return keys;
}

function backendConnectionInfo() {
  if (backendManager) return backendManager.connectionInfo();
  if (externalBackendConnection) {
    // The persisted remote token may live encrypted (startup read happens
    // before app.whenReady(), where safeStorage is not usable yet); resolve it
    // lazily here — this is the one seam every main-side remote consumer
    // (workspace approve/revoke, agent-session clients, the renderer
    // handshake) goes through. Dev env overrides keep winning via ??.
    return externalBackendConnection.accessToken
      ? externalBackendConnection
      : { ...externalBackendConnection, accessToken: credentialStore.getProviderKey(BACKEND_TOKEN_ID) };
  }
  throw new Error("Backend connection is not ready");
}

/**
 * Start (or restart) the embedded backend chain. Extracted from bootApp so the
 * `backend:configure` IPC can bring an embedded backend back after the session
 * switched to remote and stopped it — the persisted settings block only
 * decides the NEXT launch; the running process must match it or the renderer's
 * `backend:connection` handshake would keep serving a backend the user just
 * switched away from.
 */
function startEmbeddedBackend(): Promise<void> {
  backendManager = new BackendManager({ isDev });
  backendManager.on("progress", (info: { step?: string; detail?: string }) => sendSplash("splash:progress", info));
  backendManager.on("error", (err: unknown) => sendSplash("splash:error", splashErrorEnvelope(err)));
  sendSplash("splash:progress", { step: "assets", detail: "Checking Backend node catalog…" });
  const chain = (async () => {
    await provisionNodeCatalogSeed(runtimePaths.backendRoot, runtimePaths.toolsRoot);
    if (!fs.existsSync(runtimePaths.toolsRoot)) {
      crashLog.warn("nodes.catalog-missing", { nodeRoot: runtimePaths.toolsRoot });
    }
    await backendManager.start();
  })();
  // Assigned BEFORE the chain's first await runs, so the renderer's boot
  // handshake parks on the whole chain — seed included — instead of failing
  // with BACKEND_NOT_READY. That window is not first-boot-only: a packaged
  // AppImage re-hashes its read-only 250 MB nodes.zip on every launch, and a
  // failed handshake leaves the shell "Disconnected" until the user clicks
  // Reconnect (the renderer never re-issues it on its own).
  backendStartPromise = chain.catch(() => undefined);
  return chain;
}

// The renderer owns the interactive backend choice, but settings.json is where
// the token is kept and where the next launch reads the mode from. `undefined`
// accessToken preserves the persisted token (the form only sends a value when
// the user typed one); an explicit empty string clears it.
ipcMain.handle("backend:configure", async (
  _event,
  input: { mode?: unknown; baseUrl?: unknown; accessToken?: unknown },
) => {
  const mode = input?.mode === "remote" ? "remote" : "local";
  let baseUrl: string | null = null;
  let accessToken: string | null = null;
  if (mode === "remote") {
    const candidate = typeof input?.baseUrl === "string" ? input.baseUrl.trim().replace(/\/+$/, "") : "";
    if (!/^https?:\/\/.+/i.test(candidate)) {
      throw new Error("A remote backend address (http://…) is required");
    }
    baseUrl = candidate;
    if (typeof input?.accessToken === "string" && input.accessToken.trim()) {
      accessToken = input.accessToken.trim();
    } else if (input?.accessToken === undefined) {
      const persisted = resolvedSettings(runtimePaths.settingsFile)
        .backendConnection as { accessToken?: unknown } | undefined;
      // Preservation also consults the encrypted store: post-migration
      // settings.json carries null while the live token lives in credentials.json.
      accessToken = typeof persisted?.accessToken === "string" && persisted.accessToken
        ? persisted.accessToken
        : credentialStore.getProviderKey(BACKEND_TOKEN_ID);
    } else {
      // Explicit empty string clears the token — including the encrypted blob.
      if (credentialStore.isAvailable()) {
        await credentialStore.deleteProviderKey(BACKEND_TOKEN_ID).catch((error: unknown) =>
          crashLog.warn("credential-store.backend-token-delete-failed", error));
      }
    }
  }
  // Same encrypt-first policy as provider keys: the token lands in
  // credentials.json and settings.json records only "configured" (null) when
  // safeStorage is available; otherwise the historical plaintext write with a
  // log line (the app must keep working — see write-agent-provider above).
  let persistedAccessToken: string | null = accessToken;
  if (accessToken && credentialStore.isAvailable()) {
    try {
      await credentialStore.storeProviderKey(BACKEND_TOKEN_ID, accessToken);
      persistedAccessToken = null;
    } catch (error) {
      crashLog.warn("credential-store.backend-token-store-failed", error);
    }
  } else if (accessToken) {
    crashLog.warn("credential-store.unavailable-plaintext-fallback", { token: BACKEND_TOKEN_ID });
  }
  await updateSettingsFile(runtimePaths.settingsFile, (doc) => ({
    ...(doc ?? {}),
    backendConnection: { mode, baseUrl, accessToken: persistedAccessToken },
  }));
  if (mode === "remote") {
    externalBackendConnection = { baseUrl, accessToken, agentToken: null };
    if (backendManager) {
      // Switching away from the embedded backend stops it: agent-session
      // clients are constructed per use, so new work goes to the remote
      // backend immediately. In-flight runs on the embedded one die with it —
      // the same trade a restart would make.
      const stopping = backendManager;
      backendManager = null;
      backendStartPromise = null;
      await stopping.stop().catch((error: unknown) => crashLog.warn("backend.embedded-stop-on-remote-failed", error));
    }
  } else {
    externalBackendConnection = null;
    if (!backendManager) await startEmbeddedBackend();
  }
  return { mode, baseUrl, accessTokenConfigured: accessToken !== null };
});

// ── Workspace Web sharing (workstream 5, first slice) ────────────────────────
//
// The host's only user-visible sharing surface: settings.json `sharing` holds
// the whole configuration (enable, loopback/LAN, port, tier, token, the ONE
// shared workspace). The ShareServer enforces it. Normalization, persistence
// and idempotent application live in workspace/share.ts; what stays here is
// the process state the ShareServer needs — the instance itself and the agent
// runtime — handed to the module once as `shareWiring`.
let shareServer: ShareServer | null = null;

const shareWiring: ShareWiring = {
  settingsFile: runtimePaths.settingsFile,
  registryFile: runtimePaths.workspaceRegistryFile,
  crashLog,
  getShareServer: () => shareServer,
  setShareServer: (server) => { shareServer = server; },
  promptAgent: async (sessionId, message, guestName) => {
    // The guest speaks in the host's transcript under their invitation
    // name — provenance is part of the conversation, not a side log only.
    const result = await getAgentRuntime().prompt({ sessionId, message: `[guest: ${guestName}] ${message}` });
    if (result && !result.ok) {
      return { ok: false, error: result.message ?? "Agent prompt failed" };
    }
    return { ok: true };
  },
};

ipcMain.handle("share:read-config", async () => {
  const config = normalizeShareConfig(readSettings(runtimePaths.settingsFile)?.sharing);
  // The full token never crosses back to the Renderer after creation — only a
  // fingerprint. Re-copying is an explicit reveal action, mirroring the API
  // key philosophy (created once in the clear, stored redacted since).
  const invites = config.invites.map((invite) => ({
    id: invite.id,
    name: invite.name,
    tier: invite.tier,
    createdAt: invite.createdAt,
    ...(invite.revokedAt ? { revokedAt: invite.revokedAt } : {}),
    tokenPreview: invite.token.length > 8
      ? `${invite.token.slice(0, 4)}…${invite.token.slice(-4)}`
      : "…",
  }));
  return {
    config: { ...config, invites },
    status: shareServer?.getStatus() ?? { running: false },
    inviteStatuses: shareServer?.getInviteStatuses() ?? [],
    audit: shareServer?.getAudit() ?? [],
  };
});

ipcMain.handle("share:write-config", async (_event, input: unknown) => {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const current = normalizeShareConfig(readSettings(runtimePaths.settingsFile)?.sharing);
  const mode = raw.mode === undefined ? current.mode
    : SHARE_MODES.includes(raw.mode as ShareMode) ? raw.mode as ShareMode
      : failShareWrite("mode must be loopback or lan");
  const portNumber = raw.port === undefined ? current.port : Number(raw.port);
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
    failShareWrite("port must be an integer between 0 and 65535");
  }
  const enabled = raw.enabled === undefined ? current.enabled : raw.enabled === true;
  const workspaceId = raw.workspaceId === undefined ? current.workspaceId
    : typeof raw.workspaceId === "string" ? raw.workspaceId
      : failShareWrite("workspaceId must be a string");
  if (enabled) await resolveSharedWorkspaceRoot(shareWiring, workspaceId);
  // Enabling with no invitations yet seeds one view-tier "Link" guest, so the
  // first-time flow still ends with something concrete to hand out — the same
  // shape the legacy auto-generated token used to provide, minus the
  // all-holders-are-one-crowd semantics.
  const invites = enabled && current.invites.filter((invite) => !invite.revokedAt).length === 0
    ? [{ id: `inv-${crypto.randomUUID()}`, name: "Link", token: newShareToken(), tier: "view" as ShareTier, createdAt: new Date().toISOString() }]
    : current.invites;
  const next: ShareConfig = { enabled, mode, port: portNumber, invites, workspaceId };
  const written = await updateSettingsFile(runtimePaths.settingsFile, (doc) => ({ ...(doc ?? {}), sharing: next }));
  if (!written) throw new Error("settings.json could not be updated");
  await applyShareConfig(shareWiring);
  return { config: next, status: shareServer?.getStatus() ?? { running: false } };
});

// Create a named invitation. The full token is returned exactly ONCE — the
// renderer shows it for copy at creation time; every later read is redacted
// and re-copying goes through share:reveal-invite-token.
ipcMain.handle("share:create-invite", async (_event, input: unknown) => {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
  const tier = SHARE_TIERS.includes(raw.tier as ShareTier) ? raw.tier as ShareTier : "view";
  if (!name) throw new Error("Invitation name is required");
  if (tier === "control") throw new Error("The control tier is not available for invitations");
  const invite: ShareInvite = {
    id: `inv-${crypto.randomUUID()}`,
    name,
    token: newShareToken(),
    tier,
    createdAt: new Date().toISOString(),
  };
  await writeShareInvites(shareWiring, (invites) => [...invites, invite]);
  return invite;
});

// Revoke keeps the entry (audit trail) and stops matching immediately.
ipcMain.handle("share:revoke-invite", async (_event, inviteId: unknown) => {
  if (typeof inviteId !== "string" || !inviteId.trim()) throw new Error("inviteId is required");
  let revoked = false;
  await writeShareInvites(shareWiring, (invites) => invites.map((invite) => {
    if (invite.id !== inviteId || invite.revokedAt) return invite;
    revoked = true;
    return { ...invite, revokedAt: new Date().toISOString() };
  }));
  if (!revoked) throw new Error(`No live invitation: ${String(inviteId)}`);
  return { ok: true as const, inviteId };
});

// Explicit re-reveal of one invitation's token (the "copy again" action).
ipcMain.handle("share:reveal-invite-token", async (_event, inviteId: unknown) => {
  if (typeof inviteId !== "string" || !inviteId.trim()) throw new Error("inviteId is required");
  const invite = (await readShareInvites(shareWiring)).find((candidate) => candidate.id === inviteId);
  if (!invite || invite.revokedAt) throw new Error(`No live invitation: ${String(inviteId)}`);
  return { inviteId, token: invite.token };
});

function failShareWrite(message: string): never {
  throw new Error(`Invalid sharing configuration: ${message}`);
}

// Registry persistence (schema, atomic write) and the Backend root-approval
// calls live in workspace/workspaceRegistry.ts. These forwarders bind the
// process-owned registry path and the Backend connection (evaluated at the
// exact point the inline code used to call backendConnectionInfo(), so the
// "not ready" and swallow-on-revoke semantics are untouched).
function readWorkspaceRegistry() {
  return workspaceRegistry.readWorkspaceRegistry(runtimePaths.workspaceRegistryFile);
}
function writeWorkspaceRegistry(value: workspaceRegistry.WorkspaceRegistryFile) {
  return workspaceRegistry.writeWorkspaceRegistry(runtimePaths.workspaceRegistryFile, value);
}
// An absolute path crosses the protocol only at attach time. Backend persists a
// per-principal grant and returns an opaque root_id; Run commits use that id plus
// a relative Run path. Removing a Workspace revokes the same grant.
function approveWorkspaceRootWithBackend(absolutePath: string) {
  return workspaceRegistry.approveWorkspaceRootWithBackend(backendConnectionInfo, absolutePath);
}
function revokeWorkspaceRootWithBackend(rootId: string) {
  return workspaceRegistry.revokeWorkspaceRootWithBackend(backendConnectionInfo, rootId);
}

ipcMain.handle("workspace-registry:list", () => readWorkspaceRegistry());
ipcMain.handle("workspace-registry:upsert", async (_event, entry: { workspace_id?: unknown; local_path?: unknown; name?: unknown }) => {
  if (!entry || typeof entry.workspace_id !== "string" || !entry.workspace_id ||
      typeof entry.local_path !== "string" || !path.isAbsolute(entry.local_path)) {
    throw new Error("invalid workspace registry entry");
  }
  const registry = await readWorkspaceRegistry();
  const canonical = path.resolve(entry.local_path);
  // Local filesystem access is a Client-only capability. `workspacePath()` —
  // the gatekeeper for every `workspace:*` IPC — checks ONLY registry
  // membership of the canonical path, never the Backend. So writing the local
  // registry MUST succeed first and MUST NOT be blocked by Backend
  // availability. Backend root approval (used solely by the hardlink submit
  // path) is best-effort here: a failure is logged but leaves the entry
  // registered. The renderer's submit gateway approves lazily anyway
  // (`studioBackendGateway.ts`), so a missing `backend_root_id` self-heals on
  // the next Run commit, and `workspace-registry:remove` already tolerates an
  // undefined `backend_root_id`.
  let backendRootId: string | undefined;
  try {
    const grant = await approveWorkspaceRootWithBackend(canonical);
    backendRootId = grant.root_id;
  } catch (cause) {
    console.error(
      "[main] best-effort Backend root approval failed for", canonical, "-", cause instanceof Error ? cause.message : cause,
      "; the Workspace stays registered locally and will approve on next submit",
    );
  }
  // `openPath()` derives the id from the folder name while callers restoring a
  // registry entry retain its stable id. The directory is the identity the
  // filesystem bridge authorizes, so dedupe on its canonical path as well as
  // the supplied id; otherwise reopening one folder makes it appear twice.
  registry.workspaces = registry.workspaces.filter((item) =>
    item.workspace_id !== entry.workspace_id
      && (typeof item.local_path !== "string" || path.resolve(item.local_path) !== canonical)
  );
  registry.workspaces.push({
    workspace_id: entry.workspace_id,
    name: typeof entry.name === "string" && entry.name ? entry.name : path.basename(canonical),
    local_path: canonical,
    backend_root_id: backendRootId,
    last_opened_at: new Date().toISOString(),
  });
  registry.workspaces.sort((a, b) => (b.last_opened_at ?? "").localeCompare(a.last_opened_at ?? ""));
  await writeWorkspaceRegistry(registry);
  return registry;
});
ipcMain.handle("workspace-registry:remove", async (_event, workspaceId: string) => {
  const registry = await readWorkspaceRegistry();
  const removed = registry.workspaces.find((item) => item.workspace_id === workspaceId);
  if (typeof removed?.backend_root_id === "string") {
    await revokeWorkspaceRootWithBackend(removed.backend_root_id);
  }
  registry.workspaces = registry.workspaces.filter((item) => item.workspace_id !== workspaceId);
  await writeWorkspaceRegistry(registry);
  return registry;
});

// ── Folder picker dialog ───────────────────────────────────────────────
ipcMain.handle("workspace:pick-directory", async () => {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow();
  if (!win) return "";
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  return result.canceled || result.filePaths.length === 0 ? "" : result.filePaths[0];
});

// The gatekeeper every `workspace:*` handler resolves through: absolute root,
// registered membership (canonical path in the registry file), contained
// relative part. Algorithm in workspace/workspaceRegistry.ts; only the
// process-owned registry path is bound here.
function workspacePath(root: string, relative = "."): string {
  return workspaceRegistry.workspacePath(runtimePaths.workspaceRegistryFile, root, relative);
}
// Raw-absolute-path variant for the few handlers that take a bare path
// (show-in-folder, open-external, copy-into sources): the canonical path must
// sit inside SOME registered Workspace root — the same registry membership
// every other `workspace:*` handler is gated on.
function registeredWorkspacePath(absPath: string): string {
  return workspaceRegistry.registeredWorkspacePath(runtimePaths.workspaceRegistryFile, absPath);
}

ipcMain.handle("workspace:mkdir", (_event, root: string, relative: string) => fsp.mkdir(workspacePath(root, relative), { recursive: true }));
ipcMain.handle("workspace:exists", async (_event, root: string, relative: string) => {
  const target = workspacePath(root, relative);
  try {
    await fsp.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
});
// Whole reads are stat-guarded (readWorkspaceFileBounded): a file over the
// whole-read limit refuses with a typed error instead of cloning a giant
// buffer across IPC — the renderer's large-file paths stream byte ranges.
ipcMain.handle("workspace:read-text", (_event, root: string, relative: string) =>
  readWorkspaceFileBounded(workspacePath(root, relative)).then((buffer) => buffer.toString("utf8")));
// The Buffer crosses the structured-clone boundary as a Uint8Array — the
// renderer gets bytes, not a JS number per byte. Array.from(Buffer) on a
// multi-GB mzML exceeded V8's max array length and killed the handler.
ipcMain.handle("workspace:read-bytes", (_event, root: string, relative: string) =>
  readWorkspaceFileBounded(workspacePath(root, relative)));
ipcMain.handle("workspace:file-size", async (_event, root: string, relative: string) => (await fsp.stat(workspacePath(root, relative))).size);
// Random-access byte range [start, end) — lets the mzML preview stream and
// slice a large file without ever holding it whole in the renderer.
ipcMain.handle("workspace:read-byte-range", (_event, root: string, relative: string, start: unknown, end: unknown) =>
  readWorkspaceByteRange(root, relative, start, end, workspacePath));
ipcMain.handle("workspace:write-text-atomic", async (_event, root: string, relative: string, content: string) => {
  if (typeof content !== "string") throw new Error("workspace content must be text");
  const target = workspacePath(root, relative);
  await writeTextAtomicQueued(target, content);
});
ipcMain.handle("workspace:append-text", async (_event, root: string, relative: string, content: string) => {
  if (typeof content !== "string") throw new Error("workspace append content must be text");
  const target = workspacePath(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.appendFile(target, content, "utf8");
});
ipcMain.handle("workspace:write-bytes-atomic", async (_event, root: string, relative: string, content: number[]) => {
  const target = workspacePath(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tdease-${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(temp, Buffer.from(content)); await atomicReplace(temp, target); }
  finally { await fsp.rm(temp, { force: true }).catch(() => undefined); }
});
ipcMain.handle("workspace:list-files", (_event, root: string) => listWorkspaceFiles(root, workspacePath));
ipcMain.handle("workspace:sha256", (_event, root: string, relative: string) => sha256File(workspacePath(root, relative)));

// ── Published Result cache (TDEaseNexus's own file store, not the Workspace) ────
//
// `src/services/storage/studioResultCache.ts`'s `PublishedResultCache` needs a place
// to keep a Backend-fetched Published Result across app restarts so a repeat
// `open()` is instant. That place must not be a registered Workspace root --
// a cached Backend artifact is derived state, not something a Recompute, git,
// or the user's own file management in `workspace:*` above should ever see --
// so it gets its own root under the Client System root instead (see
// `runtimePaths.resultCacheRoot`).
//
// The five primitives below deliberately mirror `workspace:*` above: same
// names (exists / sha256 / read-bytes / write-bytes-atomic / remove), same
// `containedPath` containment call, same temp-then-rename atomicity. Nothing
// here computes a combined "digest" IPC call -- `exists` + `sha256` is
// composed into `ResultCacheStorage.digest` on the renderer side, in
// `src/services/storage/resultCacheStorage.ts`, so both storages backing
// `PublishedResultCache` (this one, and the Workspace one reusing
// `workspace:*`) share one definition of "digest of a missing path".
function resultCacheRoot(): string {
  return runtimePaths.resultCacheRoot;
}
function resultCachePath(relative: string): string {
  if (typeof relative !== "string" || !relative) throw new Error("result cache path is required");
  return containedPath(resultCacheRoot(), relative, "result cache path traversal denied");
}
ipcMain.handle("result-cache:exists", async (_event, relative: string) => {
  try { await fsp.access(resultCachePath(relative)); return true; } catch { return false; }
});
ipcMain.handle("result-cache:sha256", (_event, relative: string) => sha256File(resultCachePath(relative)));
// Cached Results are Backend artifacts (bounded by the Backend's own output
// sizes), but the same whole-read guard applies: a corrupt/oversized cache
// entry must degrade to a re-fetch, not clone a giant buffer into the renderer.
ipcMain.handle("result-cache:read-bytes", (_event, relative: string) =>
  readWorkspaceFileBounded(resultCachePath(relative)));
ipcMain.handle("result-cache:write-bytes-atomic", async (_event, relative: string, content: number[]) => {
  const target = resultCachePath(relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // Write to a temp name in the same directory, then rename. A crash or
  // rejection between `writeFile` and `rename` leaves `target` untouched --
  // never a half-written cached Result that later passes a digest check.
  // `atomicReplace` performs the rename with Windows lock retries while
  // preserving the all-or-nothing contract; see its comment above.
  const temp = `${target}.tdease-${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(temp, Buffer.from(content)); await atomicReplace(temp, target); }
  finally { await fsp.rm(temp, { force: true }).catch(() => undefined); }
});
ipcMain.handle("result-cache:remove", async (_event, relative: string) => {
  // A hard delete, not `shell.trashItem` like `workspace:trash` below -- this
  // is TDEaseNexus's own derived cache, not user data the OS trash should protect,
  // and `ResultCache.evict()` expects the entry gone, not recoverable.
  await fsp.rm(resultCachePath(relative), { force: true });
});

ipcMain.handle("workspace:rename", async (_event, root: string, oldRel: string, newRel: string) => {
  await fsp.rename(workspacePath(root, oldRel), workspacePath(root, newRel));
});
ipcMain.handle("workspace:trash", async (_event, root: string, rel: string) => {
  const target = workspacePath(root, rel);
  await shell.trashItem(target);
});
ipcMain.handle("workspace:move", (_event, root: string, srcRels: string[], destDirRel: string) =>
  moveWorkspaceEntries(root, srcRels, destDirRel, workspacePath));
ipcMain.handle("workspace:copy-into", (_event, root: string, absSrcPaths: string[], destDirRel: string) => {
  // Sources are deliberately NOT registry-gated: OS drag-drop import of host
  // files into a Workspace and outside-workspace attachment import are product
  // features. A compromised renderer can exfiltrate arbitrary host files
  // through this channel — the durable fix is expressing user drag intent via
  // webUtils.getPathForFile in the renderer, not an allowlist here.
  return copyIntoWorkspace(root, absSrcPaths, destDirRel, workspacePath);
});
// Recursive copy to an EXACT destination path (unlike copy-into, which
// preserves the source basename). The renderer computes a collision-free
// name before calling, so `force` never silently overwrites a user entry.
ipcMain.handle("workspace:copy", async (_event, root: string, srcRel: string, destRel: string) => {
  const src = workspacePath(root, srcRel);
  const dest = workspacePath(root, destRel);
  if (src === dest || dest.startsWith(src + path.sep)) {
    throw new Error("cannot copy a path into itself");
  }
  await fsp.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
});
ipcMain.handle("workspace:list-dir", async (_event, root: string, rel: string) => {
  const dir = workspacePath(root, rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const result: { name: string; isDir: boolean; size: number; mtime: number }[] = [];
  for (const entry of entries) {
    if ([".git", "node_modules", ".tdease", ".snakemake"].includes(entry.name)) continue;
    let size = 0, mtime = 0;
    try {
      const stat = await fsp.stat(path.join(dir, entry.name));
      size = stat.size;
      mtime = stat.mtimeMs;
    } catch { /* unreadable entry — skip metadata */ }
    result.push({ name: entry.name, isDir: entry.isDirectory(), size, mtime });
  }
  result.sort((a, b) => (Number(b.isDir) - Number(a.isDir)) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return result;
});
ipcMain.handle("workspace:show-in-folder", (_event, absPath: string) => {
  // Registry containment, not just "is absolute": an arbitrary host path
  // must not be revealable from a compromised renderer.
  const contained = registeredWorkspacePath(absPath);
  shell.showItemInFolder(contained);
});
ipcMain.handle("workspace:open-external", async (_event, absPath: string) => {
  const contained = registeredWorkspacePath(absPath);
  return shell.openPath(contained);
});
ipcMain.handle("workspace:reveal-path", (_event, root: string, rel: string) => {
  shell.showItemInFolder(workspacePath(root, rel));
});
ipcMain.on("workspace:start-native-drag", (_event, filePaths: string[]) => {
  try {
    const win = BrowserWindow.getFocusedWindow();
    if (!win || !Array.isArray(filePaths) || filePaths.length === 0) return;
    win.webContents.startDrag({
      // `file` is a single path by contract; a multi-selection goes in `files`
      // and `file` names the one the drag is anchored to. Passing the array
      // here was a type error the main process never had a check to catch.
      file: filePaths[0],
      files: filePaths,
      icon: appIcon,
    });
  } catch (err) {
    console.warn("[workspace:start-native-drag] failed:", (err as Error)?.message || err);
  }
});

// ── Native file watcher (chokidar) ──────────────────────────────────────────
let chokidar: typeof import("chokidar") | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- guarded load: the watcher degrades, never crashes, when the dependency fails
  chokidar = require("chokidar");
} catch (err) {
  console.warn("[main] chokidar unavailable — file watcher disabled:", (err as Error)?.message || err);
}
const watchers = new Map<string, { watcher: FSWatcher; refCount: number; subscribers: Set<Electron.WebContents> }>();

function ensureRendererCleanup(sender: Electron.WebContents): void {
  if (rendererCleanupInstalled.has(sender)) return;
  rendererCleanupInstalled.add(sender);
  sender.once("destroyed", () => {
    for (const [root, entry] of watchers) {
      if (!entry.subscribers.delete(sender)) continue;
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount === 0) {
        entry.watcher.close().catch(() => undefined);
        watchers.delete(root);
      }
    }
    for (const [sessionId, owner] of agentSessionOwners) {
      if (owner !== sender) continue;
      agentSessionOwners.delete(sessionId);
      void getAgentRuntime().dispose(sessionId).catch(() => undefined);
    }
  });
}

// The watch policy is derived, once, from the submission exclusion contract --
// see workspaceWatchIgnoreGlobs() in src/studio/domain/workspace-snapshot-policy.ts.
// Computed at module load so every watcher in this process shares one list.
const WORKSPACE_WATCH_IGNORED = workspaceWatchIgnoreGlobs();

/**
 * Renderer-supplied watch options. `ignored` is *added to* the derived list,
 * never substituted for it: the contract is a floor the renderer may raise but
 * cannot lower, so an over-narrow list in a caller can no longer make the live
 * view and the snapshot disagree about what a Workspace contains. Everything
 * else about the watcher (ignoreInitial, persistent) stays main-owned.
 */
type WatchStartOptions = { ignored?: string[] };

ipcMain.handle("workspace:watch-start", async (event, root: string, opts?: WatchStartOptions) => {
  if (!chokidar) return { ok: false, error: "chokidar unavailable" };
  // Same registry gatekeeper as every other `workspace:*` handler: the
  // canonical root must be a registered Workspace. A bare isAbsolute check
  // let a compromised renderer point a file watcher at any host directory.
  let resolvedRoot: string;
  try {
    resolvedRoot = workspacePath(root);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  let entry = watchers.get(resolvedRoot);
  if (!entry) {
    // Union, deduped. Note the watcher for a root is created once and then
    // shared by refcount, so later subscribers do not re-negotiate `ignored`;
    // that is safe precisely because the derived contract floor is unconditional.
    const ignored = [...new Set([...WORKSPACE_WATCH_IGNORED, ...(opts?.ignored ?? [])])];
    const watcher = chokidar.watch(resolvedRoot, {
      ignored,
      ignoreInitial: true,
      persistent: true,
      // Bulk operations (git checkout, a Run writing hundreds of result
      // files) would otherwise fire one event per write; a short stability
      // window merges the add/change churn per file before it crosses IPC.
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    // Forwarding coalescing: buffer the latest event per path and flush at
    // most every FORWARD_INTERVAL_MS. The renderer re-syncs whole directories
    // per event, so intermediate event types for the same path carry no
    // information — only the latest matters. This bounds the IPC + refresh
    // fan-out during bulk writes regardless of how many directories are hit.
    const pending = new Map<string, { event: string; path: string }>();
    let flushTimer: NodeJS.Timeout | null = null;
    const FORWARD_INTERVAL_MS = 250;
    const flush = () => {
      flushTimer = null;
      if (pending.size === 0) return;
      const events = [...pending.values()];
      pending.clear();
      const subs = entry!.subscribers;
      for (const wc of subs) {
        if (wc.isDestroyed()) continue;
        for (const e of events) {
          wc.send("workspace:fs-event", e);
        }
      }
    };
    watcher.on("all", (eventName: string, filePath: string) => {
      const rel = path.relative(resolvedRoot, filePath).split(path.sep).join("/");
      pending.set(`${eventName}:${rel}`, { event: eventName, path: rel });
      // Keyed with the event name so an `add` immediately followed by an
      // `unlink` for the same path still reaches the renderer as two facts.
      if (pending.size > 1000) flush();
      else if (flushTimer === null) flushTimer = setTimeout(flush, FORWARD_INTERVAL_MS);
    });
    const baseEntry = { watcher, refCount: 0, subscribers: new Set<Electron.WebContents>() as Set<Electron.WebContents> };
    entry = baseEntry;
    watchers.set(resolvedRoot, entry);
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => {
        // Cancel nothing: a final flush after ready keeps pre-ready events.
        resolve();
      });
      setTimeout(resolve, 2000);
    });
  }
  // Renderer lifecycles can race and ask to start the same root twice. The Set
  // already models one subscription per WebContents; keep the refcount and the
  // destruction listener equally idempotent. Otherwise every refresh adds a
  // listener that survives until the window is destroyed.
  if (!entry.subscribers.has(event.sender)) {
    entry.refCount += 1;
    entry.subscribers.add(event.sender);
    ensureRendererCleanup(event.sender);
  }
  return { ok: true };
});
ipcMain.handle("workspace:watch-stop", async (event, root: string) => {
  const entry = watchers.get(path.resolve(root));
  if (!entry) return { ok: true };
  if (entry.subscribers.delete(event.sender)) {
    entry.refCount = Math.max(0, entry.refCount - 1);
  }
  if (entry.refCount === 0) {
    await entry.watcher.close().catch(() => undefined);
    watchers.delete(root);
  }
  return { ok: true };
});

ipcMain.on("splash:quit", () => {
  appIsQuitting = true;
  app.quit();
});

ipcMain.on("splash:retry", () => {
  void bootApp({ retry: true });
});

function sendSplash(channel: string, payload: unknown) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------- main window

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#F7F5F2",
    autoHideMenuBar: true,
    icon: appIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only remote-document schemes reach the OS browser. Anything else —
    // file:, custom schemes, malformed relative junk — is denied outright:
    // shell.openExternal hands the string to the OS, which executes whatever
    // it resolves to.
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
        shell.openExternal(parsed.href);
      }
    } catch {
      /* not an absolute URL — deny */
    }
    return { action: "deny" };
  });

  // Navigation guard: the main window may never navigate away from the app's
  // own origin (dev server or file:). Without this, an injected link/form or a
  // renderer compromise could sail the whole window — preload included — to an
  // attacker-controlled page.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let allowed = false;
    try {
      const target = new URL(url);
      const current = mainWindow!.webContents.getURL();
      const origin = current ? new URL(current).origin : target.origin;
      allowed = target.origin === origin;
    } catch {
      allowed = false;
    }
    if (!allowed) event.preventDefault();
  });

  mainWindow.on("close", (e) => {
    if (!forceQuit && !isE2E && !isDev) {
      e.preventDefault();
      mainWindow!.hide();
      setupTray();
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });

  mainWindow.once("ready-to-show", () => {
    // Splash hand-off: `ready-to-show` fires as soon as the HTML skeleton
    // loads, but Vue mounts only after the backend:connection handshake (up
    // to minutes of first-run uv sync). RULES:
    //   1. While the splash is up the main window stays HIDDEN — revealing
    //      it at ready-to-show put a blank skeleton on top of the splash
    //      (the user saw a white page with no animation for the whole
    //      handshake). The splash covers the wait, and the window is
    //      revealed only when the renderer signals its first real frame
    //      (`app:renderer-ready`), so the switch is splash → painted UI,
    //      never splash → blank.
    //   2. If that signal never comes (renderer error, or a renderer that
    //      dies without reporting), reveal after the settle window or the
    //      150s guard — never leave the user on the splash forever.
    //   3. E2E keeps the old immediate reveal — the fixture's firstWindow()
    //      and window-count assertions were written against it.
    const splashUp = splashWindow && !splashWindow.isDestroyed();
    const closeSplash = (): void => {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.destroy();
        splashWindow = null;
      }
    };
    const revealMainWindow = (): void => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    };
    if (splashUp) {
      const bootWasLong = Date.now() - bootStartedAt >= 2000;
      const settleMs = bootWasLong ? 900 : 150;
      if (isE2E) {
        sendSplash("splash:progress", { step: "ready" });
        revealMainWindow();
        setTimeout(closeSplash, settleMs);
      } else {
        let revealed = false;
        let closingGuard: ReturnType<typeof setTimeout> | undefined;
        const revealAfterSettle = (): void => {
          if (revealed) return;
          revealed = true;
          ipcMain.removeListener("app:renderer-ready", onRendererReady);
          ipcMain.removeListener("desktop:renderer-error", onRendererError);
          // The UI is ready NOW (this fires on app:renderer-ready). Hand the
          // splash its final stage only here: marking it complete at
          // ready-to-show was a lie — that only means the HTML loaded, while
          // the renderer still waits out the backend handshake (minutes on a
          // cold first run).
          sendSplash("splash:progress", { step: "ready" });
          // The splash owns its closing beat and reports when the last frame
          // has landed (`splash:closing-done`); only then is it destroyed and
          // the already painted window shown — the user watches the splash
          // finish, then the UI. The guard covers a splash that cannot report
          // (renderer crash, throttled timer), and fires after the beat.
          ipcMain.once("splash:closing-done", () => {
            clearTimeout(closingGuard);
            closeSplash();
            revealMainWindow();
          });
          closingGuard = setTimeout(() => {
            closeSplash();
            revealMainWindow();
          }, settleMs + 1500);
        };
        const onRendererReady = (): void => { revealAfterSettle(); };
        const onRendererError = (): void => { revealAfterSettle(); };
        ipcMain.on("app:renderer-ready", onRendererReady);
        ipcMain.on("desktop:renderer-error", onRendererError);
        // Cold first-run provisioning (uv sync downloads the interpreter and
        // the dependency set) can legally exceed the backend's 180s health
        // deadline — the guard exists only so a renderer that never reports
        // cannot pin the user to the splash forever.
        setTimeout(() => {
          ipcMain.removeListener("app:renderer-ready", onRendererReady);
          ipcMain.removeListener("desktop:renderer-error", onRendererError);
          if (!revealed) revealAfterSettle();
        }, 300000);
      }
    } else {
      // No splash covers the window (post-error resurrect): reveal at the
      // first paint instead of waiting for a signal nobody will send.
      revealMainWindow();
    }
  });

  if (isDev) {
    mainWindow.loadURL(devUrl);
    if (!isE2E || e2eDevTools) mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  if (!fs.existsSync(indexHtml)) {
    throw new Error(`Electron frontend bundle not found: ${indexHtml}`);
  }
  mainWindow.loadFile(indexHtml);
}

// The update channel (electron/updater.ts): background check + background
// download, user-decided restart, state pushed to the renderer. Called ONCE
// from the app-level whenReady; `mainWindow` is read lazily because windows
// are rebuilt while the updater lives for the whole process.
function startUpdateCheck() {
  startUpdater(() => mainWindow, isDev);
}

// Every Backend-startup failure crosses into the splash renderer as a full
// CORE-ARCHITECTURE.md §7.1 envelope (code, domain, message, remedy, retryable),
// never a bare message — the splash screen must show a real remedy, not a blank
// window. "environment" is the correct domain for "the Backend did not start"
// (§7.3): a missing interpreter, an occupied port, or a crash before readiness.
function splashErrorEnvelope(err: unknown) {
  const value = (err ?? {}) as Partial<Record<"code" | "domain" | "message" | "remedy", string>> & { retryable?: boolean };
  return {
    code: value.code || "BACKEND_ERROR",
    domain: value.domain || "environment",
    message: value.message || String(err),
    remedy: value.remedy || "Check the logs or retry; if it keeps failing, reinstall the app.",
    retryable: value.retryable !== undefined ? value.retryable : true,
  };
}

// ── D16 managed-tools provisioning (deferred off the module-load path) ──────
// Runs the three provisioning passes into the managed tools dir: stable python
// command names, the tdeasenexus-toolbox CLI, and bundled rg/fd — the copies the
// bash sandbox PATH prefix resolves by short name. Best-effort, as before: the
// CLI is optional and a dev tree without a built binary must not block startup
// (ensureNativeCli returns null), and every pass is wrapped because an
// uncaught throw inside the whenReady handler hits the uncaughtException
// handler and exits the app — a provisioning failure must degrade to a
// tool-time error instead.
//
// Ordering guarantee: invoked from whenReady AFTER `void bootApp()`. bootApp's
// synchronous preamble creates the splash window before its first await, so
// this synchronous work (a 37MB copy only after a CLI rebuild; a couple of
// stats otherwise) lands behind a visible splash instead of delaying first
// paint — and it completes before the whenReady handler returns, i.e. before
// the splash even finishes loading. No renderer exists yet, so no
// agent:bind-session/agent:prompt IPC can race it, and the runtime resolves
// its tools only at bash-spawn time (see the provisioning note at the top of
// this file).
function provisionManagedTools() {
  try { ensurePythonLaunchers({ toolsDir: runtimePaths.agentToolsRoot }); }
  catch (error) { console.warn("python launcher provisioning skipped:", error); }
  try { ensureNativeCli({ isDev, toolsDir: runtimePaths.agentToolsRoot }); }
  catch (error) { console.warn("tdeasenexus-toolbox provisioning skipped:", error); }
  try { ensureSearchTools({ isDev, toolsDir: runtimePaths.agentToolsRoot }); }
  catch (error) { console.warn("search tools provisioning skipped:", error); }
}

/**
 * Agent-facing Node-package installation (tdease.nodes.install): copy one
 * Workspace folder into the local Backend catalog. The same filters the
 * installer packaging uses keep development residue out; a user-managed
 * catalog is never clobbered — an existing package id is refused with the
 * removal instruction, mirroring provisionNodeCatalogSeed's ownership rule.
 */
async function installNodePackage(sourceDir: string): Promise<{ nodeId: string; targetDir: string; files: number }> {
  const stat = await fsp.stat(sourceDir).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Source is not a directory: ${sourceDir}`);
  }
  if (!fs.existsSync(path.join(sourceDir, "rules.smk"))) {
    throw new Error(`Source folder has no rules.smk, so it is not a Node package: ${sourceDir}`);
  }
  const nodeId = path.basename(path.resolve(sourceDir));
  if (nodeId.startsWith("_") || nodeId.startsWith(".")) {
    throw new Error(`Reserved package name (underscore/dot prefix): ${nodeId}`);
  }
  const targetDir = path.join(runtimePaths.toolsRoot, nodeId);
  if (fs.existsSync(targetDir)) {
    throw new Error(`Node package ${nodeId} is already installed at ${targetDir}. Remove that folder first to replace it.`);
  }
  let files = 0;
  // Bytecode/venv residue must not enter the catalog — same exclusion set the
  // electron-builder extraResources filters enforce for the shipped tree.
  const excluded = (name: string) =>
    name === "__pycache__" || name === ".venv" || name === ".pytest_cache" ||
    name.endsWith(".egg-info") || name.endsWith(".pyc") || name === ".DS_Store";
  await fsp.cp(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => !excluded(path.basename(src)),
  });
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (excluded(entry.name)) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else files += 1;
    }
  };
  walk(targetDir);
  crashLog.info("nodes.agent-installed", { nodeId, sourceDir, targetDir, files });
  return { nodeId, targetDir, files };
}

/**
 * Node-catalog seed with refresh-on-update contract: the installer ships the
 * packages as ONE zip (`resources/backend/nodes.zip`) and every update's first
 * boot compares the zip's SHA-256 against the catalog's seed manifest — a
 * changed fingerprint REPLACES the seed-owned package directories (user-
 * installed/renamed ones are never touched, retired shipped ones removed), a
 * matching one just discards the zip. The decision logic and its ownership
 * rules live in `node_catalog_seed.cjs` (tested there); this wrapper only
 * adds the dev guard and the splash/crash-log surfaces.
 */
async function provisionNodeCatalogSeed(backendRoot: string, toolsRoot: string): Promise<void> {
  if (isDev) return; // dev runs against the repository catalog directly
  const seedZip = path.join(process.resourcesPath ?? "", "backend", "nodes.zip");
  const started = Date.now();
  const result = await reseedNodeCatalog({
    seedZip,
    backendRoot,
    toolsRoot,
    requiredEntries: [path.join("toppic", "rules.smk")],
    onBeforeExtract: () => sendSplash("splash:progress", { step: "nodes", detail: "Installing compute nodes…" }),
    log: (level, message, data) => {
      if (level === "warn") crashLog.warn(message, data ?? {});
      else crashLog.info(message, data ?? {});
    },
  });
  if (result.action === "seeded") {
    crashLog.info("nodes.seeded-from-zip", { ms: Date.now() - started, catalog: toolsRoot, packages: result.packages });
  } else if (result.action === "unchanged") {
    crashLog.info("nodes.seed-current", { catalog: toolsRoot });
  } else if (result.action === "failed") {
    // Degraded but honest: the catalog keeps its previous packages and the
    // doctor/nodes API report the gap. The zip is kept so the next launch retries.
    crashLog.warn("nodes.seed-reseed-failed", { error: String(result.error) });
  } else {
    crashLog.warn("nodes.seed-missing", { seedZip });
  }
}

async function bootApp(options: { retry?: boolean } = {}) {
  bootStartedAt = Date.now();
  if (options.retry && backendManager) {
    await backendManager.stop();
    backendManager = null;
  }
  if (!splashWindow || splashWindow.isDestroyed()) {
    await createSplashWindow();
  } else {
    sendSplash("splash:reset", {});
  }
  try {
    if (externalBackendConnection) {
      sendSplash("splash:progress", { step: "backend", detail: "Connecting to the remote backend…" });
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    } else {
      // The renderer mounts without the backend and renders its own
      // connecting/offline state (its connection supervisor retries until
      // the backend answers), so the window loads concurrently with the
      // backend chain instead of behind it — first paint no longer waits
      // out uv sync (unbounded on first run) and the health deadline. The
      // splash keeps displaying the backend stages above until
      // ready-to-show replaces it. startEmbeddedBackend also publishes
      // backendStartPromise for the `backend:connection` handshake (the
      // concurrently booted renderer can ask before start() settles).
      const backendStarted = startEmbeddedBackend();
      // A retry after an early backend failure can race a window the first
      // boot already created — its ready-to-show fires independently of the
      // backend.
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      await backendStarted;
    }
  } catch (err) {
    crashLog.error("backend.start-failed", err);
    // The splash error surface is only for while the splash is still the
    // visible surface. Once the main window is up, the renderer's offline
    // state applies — resurrecting the splash here would cover a window the
    // user is already looking at, and no failure path may leave a splash
    // lingering over the app.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.destroy();
        splashWindow = null;
      }
      return;
    }
    sendSplash("splash:error", splashErrorEnvelope(err));
  }
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    crashLog.info("app.ready");
    // One-time startup migration of legacy plaintext credentials into the
    // encrypted store (chosen over piggyback-on-next-write: this actually
    // removes plaintext from disk promptly, using credential-store's
    // already-tested blob-before-scrub pass; piggyback would leave plaintext
    // on disk for as long as the user never re-saves a key). When safeStorage
    // is unavailable the pass refuses — plaintext stays as the working
    // fallback and the warning below is the audit trail; next launch retries.
    void credentialStore.migrateLegacyProviderKeys().catch((error: unknown) =>
      crashLog.warn("credential-store.migration-skipped", error));
    void (async () => {
      const persisted = resolvedSettings(runtimePaths.settingsFile)
        .backendConnection as { accessToken?: unknown } | undefined;
      const token = typeof persisted?.accessToken === "string" && persisted.accessToken ? persisted.accessToken : null;
      if (!token || !credentialStore.isAvailable()) return;
      try {
        await credentialStore.storeProviderKey(BACKEND_TOKEN_ID, token);
        await updateSettingsFile(runtimePaths.settingsFile, (doc) => doc
          ? { ...doc, backendConnection: { ...(doc.backendConnection as Record<string, unknown> | null ?? {}), accessToken: null } }
          : null);
      } catch (error) {
        crashLog.warn("credential-store.backend-token-migration-failed", error);
      }
    })();
    void bootApp().catch((error) => {
      crashLog.error("app.boot-failed", error);
      sendSplash("splash:error", splashErrorEnvelope(error));
    });
    // AFTER bootApp() is invoked: its synchronous preamble has created the
    // splash window by this point, and this synchronous provisioning still
    // completes before the handler returns — before any window content or IPC.
    // See provisionManagedTools() for the full ordering guarantee.
    provisionManagedTools();
    // App-scope, once per process (windows are rebuilt; IPC handlers are not
    // re-registrable). The updater reads the current window lazily.
    // electron-updater fetches through Electron net on its OWN partition —
    // Chromium routes that by SESSION proxy rules, never by env vars, so the
    // unified proxy must reach it here, before the first update check.
    const updaterSession = session.fromPartition("electron-updater", { cache: false });
    await updaterSession.setProxy(updaterProxyRules(networkProxy))
      .catch((error) => crashLog.warn("proxy.updater-session-failed", error));
    startUpdateCheck();
    // Restore an enabled share from the persisted settings (default off —
    // nothing listens until the user opted in and the config was written).
    void applyShareConfig(shareWiring).catch((error) => crashLog.warn("share.boot-apply-failed", error));
    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
      else { mainWindow.show(); mainWindow.focus(); }
    });
  });
}

// One synchronous quit gate. Electron does NOT await before-quit handlers —
// a preventDefault issued after the first await arrives too late (will-quit
// and process teardown already ran while disposal was still in flight,
// reproduced 2026-09-05), so the default quit is blocked SYNCHRONOUSLY here
// whenever anything needs sweeping, and the bounded async sweep below is the
// only thing that calls app.exit.
let quitSweepStarted = false;
app.on("before-quit", (e) => {
  crashLog.info("app.before-quit");
  // The ledger flushes on a debounce; quit is the last train, so land any
  // pending usage rows synchronously before teardown. A ledger never created
  // (no Pi session this run) has nothing to flush.
  if (usageLedgerEntry) usageLedgerEntry.ledger.flush();
  if (tray) { tray.destroy(); tray = null; }
  const needsSweep = !!backendManager || !!agentRuntimeClient;
  if (!needsSweep || quitSweepStarted) return;
  e.preventDefault();
  quitSweepStarted = true;
  appIsQuitting = true;
  forceQuit = true;
  // Bounded sweep: agent sessions (PTY shells, background-job trees,
  // subagent children) first — they are the cheaper, app-owned processes —
  // then the Backend, then exit. Every step has its own deadline, and the
  // overall sweep is raced against a hard cap so a hung close can never
  // wedge the exit (the process-tree equivalent of stopAfterFatalError's
  // forced exit timer).
  const SWEEP_DEADLINE_MS = 15_000;
  const deadline = setTimeout(() => app.exit(0), SWEEP_DEADLINE_MS);
  deadline.unref();
  void (async () => {
    try { await agentRuntimeClient?.disposeAll(); } catch (error) {
      crashLog.warn("agent.disposeAll-on-quit-failed", error);
    }
    try { await shareServer?.stop(); } catch { /* best-effort */ }
    try { await backendManager?.stop(); } catch { /* best-effort */ }
    clearTimeout(deadline);
    app.exit(0);
  })();
});

function setupTray() {
  if (tray || isE2E) return;
  const icon = nativeImage.createFromPath(appIcon);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("TDEaseNexus");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Open TDEaseNexus",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
        else createMainWindow();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => { forceQuit = true; app.quit(); },
    },
  ]));
  tray.on("double-click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    else createMainWindow();
  });
}

app.on("window-all-closed", () => {
  if (isE2E && !e2eRecreateWindows) { app.quit(); return; }
  if (isE2E) return;
  if (!isDev && !forceQuit && (!splashWindow || splashWindow.isDestroyed())) {
    setupTray();
    return;
  }
  if (process.platform !== "darwin" && (!splashWindow || splashWindow.isDestroyed())) {
    app.quit();
  }
});
