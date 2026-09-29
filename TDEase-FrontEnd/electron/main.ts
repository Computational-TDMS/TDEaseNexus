// Electron main process entry.
//
// Bundled to electron/dist/main.bundle.cjs by electron/build-main.mjs.
// The Pi SDK runtime (Phase 2+) will be added here; for now this is the
// main.cjs logic lifted verbatim into TS so the esbuild bundle pipeline can
// be validated independently.
//
// NOTE: llm:stream proxy handlers are retained for now and removed in Phase 4
// once the renderer no longer consumes them.

import { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage, dialog, crashReporter, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { BackendManager } from "./backend_manager.cjs";
import { resolveComponents } from "./component_config.cjs";
import { ensureRuntimeDirectories, readSettings, resolvedSettings } from "./runtime_config.cjs";
import { createCrashLogger } from "./crash_logger.cjs";
import { containedPath } from "./path_containment.cjs";
import { createSystemAssetCatalog } from "./system_asset_catalog.cjs";
import { reseedNodeCatalog } from "./node_catalog_seed.cjs";
import { ensureNativeCli, ensurePythonLaunchers, ensureSearchTools, pinSearchToolLookup, resolveVendorGitDirs } from "./skill_runtime.cjs";
import { ShareServer, newShareToken, type CollabEvent, type ShareConfig, type ShareInvite, type ShareMode, type ShareTier } from "./share-server";
import { builtinApiKeyFor, builtinProviderIds } from "./agent/builtin-provider-keys";
import { createModelCatalogRefresher } from "./agent/model-catalog-refresher";
import { createProviderAuthService, type ProviderAuthPush } from "./agent/provider-auth";
import { startUpdater } from "./updater";
import { atomicReplace, mergeProviderConfig, updateSettingsFile, writeTextAtomicQueued } from "./atomic-write";
import { applyProxyEnv, normalizeProxyConfig, updaterProxyRules, type NetworkProxyConfig } from "./proxy-config";
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
// The agent runtime module graph (agent-runtime → tool-gateway →
// persistent-bash-tool → the bundled Pi SDK) is ~15MB of parse+eval. It must
// NOT be evaluated at bundle load: this top level runs before app.whenReady,
// so a static import here delayed even the splash window. The types below are
// erased at compile time and cost nothing; the runtime value is require()d on
// first actual use — see getAgentRuntime() below.
type AgentRuntimeModule = typeof import("./agent/agent-runtime");
type AgentRuntimeInstance = ReturnType<AgentRuntimeModule["createAgentRuntime"]>;

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
// Packaged builds ship a provider seed (resources/backend/settings.seed.json)
// that pre-fills the DeepSeek key into a fresh settings.json exactly once —
// only when no settings file exists yet, so user edits always win afterward
// (see runtime_config.cjs::ensureSettingsFile). Dev runs never seed: the
// developer's own settings.json must not be silently overwritten.
const packagedSeedFile = !isDev && process.resourcesPath
  ? path.join(process.resourcesPath, "backend", "settings.seed.json")
  : null;
const providerSeedFile = packagedSeedFile && fs.existsSync(packagedSeedFile) ? packagedSeedFile : null;
const runtimePaths = ensureRuntimeDirectories({
  // Development deliberately shares the repository Backend runtime with the
  // supervised API and Worker. Packaged builds retain their profile-owned root.
  backendRoot: isDev ? path.resolve(__dirname, "..", "..", "data", "backend") : null,
  providerSeedFile,
});
const installedComponents = resolveComponents({ isDev, resourcesPath: process.resourcesPath });
// Settings-UI model-list refresher: the vendor's own /models listing (with the
// user's key, read here and never crossing IPC) over a models.dev fallback,
// TTL-cached under the Client System root. Read-only toward settings.json.
const modelCatalogRefresher = createModelCatalogRefresher({
  settingsPath: runtimePaths.settingsFile,
  cacheFile: path.join(runtimePaths.systemRoot, "models-cache.json"),
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

// ── Agent runtime (lazy) ──────────────────────────────────────────────────────
// Two costs are deliberately separated here:
//   1. IMPORT cost — evaluating the agent-runtime module graph, which esbuild
//      bundles together with the Pi SDK (~15MB of parse+eval). This is what
//      delayed startup; it now happens once, on first actual use (the first
//      agent IPC from the renderer — typically agent:bind-session).
//   2. CONSTRUCTION cost — createAgentRuntime's own body (provider registry,
//      system assets, observers). Per audit this is light; it merely lives
//      behind the same import boundary.
// Nothing else at main's top level depends on this graph evaluating eagerly:
// crash reporter, settings, the backend manager, the workspace registry, the
// watchers and the usage ledger (which has its own lazy creation path shared
// with the `usage-ledger:list` handler) are all independent of it.
let agentRuntimeInstance: AgentRuntimeInstance | null = null;

function getAgentRuntime(): AgentRuntimeInstance {
  if (agentRuntimeInstance) return agentRuntimeInstance;
  // A plain require, NOT `await import()`: this bundle is built by
  // build-main.mjs with format "cjs" and NO code splitting, so esbuild would
  // not keep a dynamic import of a bundled module at an async boundary. A
  // CommonJS require of a bundled module compiles to a lazily-initialized
  // wrapper call — true deferral. Same house pattern as loadPty() in
  // agent/pty-bash-backend.ts. The require cache makes this idempotent, and
  // because the load is synchronous there is no concurrent-first-call window:
  // every caller blocks on the same evaluation, then observes the memo.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred agent-graph load; see above
  const { createAgentRuntime } = require("./agent/agent-runtime") as AgentRuntimeModule;
  agentRuntimeInstance = createAgentRuntime({
    settingsPath: runtimePaths.settingsFile,
    systemRoot: runtimePaths.systemRoot,
    agentDir: runtimePaths.agentRoot,
    managedBinDir: runtimePaths.agentToolsRoot,
    systemAssets: systemAssetCatalog,
    usageLedger: usageLedger(),
    resolveWorkspaceRoot: async (workspaceId) => {
      const registry = await readWorkspaceRegistry();
      const entry = registry.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
      if (!entry || typeof entry.local_path !== "string") throw new Error(`Workspace is not registered: ${workspaceId}`);
      return workspacePath(entry.local_path);
    },
    backendConnection: () => backendConnectionInfo(),
    // Local Node-catalog installation: Electron main owns the copy because the
    // agent's filesystem reach ends at the Workspace. A remote Backend
    // connection owns its catalog on its own host, so the port is withheld
    // entirely — `nodes.install` then reports the boundary instead of copying
    // into a catalog the connected Backend never reads.
    ...(externalBackendConnection ? {} : { nodeCatalogInstaller: installNodePackage }),
    // No `nativeCliPath`: the option is declared by AgentRuntimeOptions but never
    // read — the runtime reaches the CLI by short name through the bash sandbox
    // PATH prefix (managedBinDir), which the deferred provisioning below fills.
    systemAssetsRoot: systemAssetsRoot(),
    systemCacheRoot: runtimePaths.systemCacheRoot,
    isDev,
    // Model-metadata digest for models Pi's catalog doesn't know: the refresher
    // serves it from its warm aggregator cache (offline), SessionHost's register
    // branch freezes it into settings.json. Nothing crosses IPC.
    resolveModelMeta: (providerId: string, modelId: string) => modelCatalogRefresher.modelMeta(providerId, modelId),
    // The runtime's one outward event surface (RuntimePush): turn events plus
    // the read-side pushes, all routed through the owner map the same way.
    push: {
      turnEvent: (sessionId, payload) => {
      let owner = agentSessionOwners.get(sessionId);
      // A subagent (or background-job) session is bound internally by the
      // registry, not via the agent:bind-session IPC, so it has no owner entry of
      // its own. Route its turn events (text deltas, tool commits, …) to the
      // renderer that owns its PARENT session — that is where a live
      // SubagentConversation tab is streaming that child. Without this, a child's
      // events were silently dropped and its conversation tab could only show a
      // frozen disk snapshot.
      //
      // Reads the memoized instance rather than getAgentRuntime(): during the
      // very first construction this callback's closure runs while
      // agentRuntimeInstance is still null (createAgentRuntime has not
      // returned). The light constructor emits no turn events, so the null
      // path is unreachable in practice — but reading the memo keeps this
      // reentrancy-proof instead of infinitely recursive.
      if (!owner) {
        const parentSessionId = agentRuntimeInstance?.parentSessionOf(sessionId);
        if (parentSessionId) owner = agentSessionOwners.get(parentSessionId);
      }
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
      // Same owner-map routing — a session's dispatched-run list belongs to the
      // renderer that bound it ("runs this conversation started"), not to the
      // workspace at large.
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
      // Same owner-map routing as subagent:changed/job:changed. Deliberately NOT
      // routed through parentSessionOf: child (subagent) sessions have no gauge
      // UI, so their context reads are dropped — pointless IPC noise otherwise.
      const owner = agentSessionOwners.get(sessionId);
        if (owner && !owner.isDestroyed()) owner.send("context:changed", sessionId, usage);
      },
    },
  });
  return agentRuntimeInstance;
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
  // A build-baked key (builtin-provider-keys.ts) counts as configured: a fresh
  // install can run the default provider before any user setup. The user's own
  // settings entry always wins; the fingerprint covers whichever key is
  // effective so swapping either re-binds the turn session.
  const ids = new Set([...Object.keys(providers), ...builtinProviderIds()]);
  for (const id of ids) {
    const config = providers[id] ?? {};
    const userKey = config.apiKey ?? config.api_key;
    const apiKey = (typeof userKey === "string" && userKey.length > 0) ? userKey : builtinApiKeyFor(id);
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
  // mergeProviderConfig keeps a cleared provider's `models` map alive — the
  // frozen capability digests are model truth, not credential state.
  const written = await updateSettingsFile(runtimePaths.settingsFile, (doc) => {
    const providers = { ...((doc?.providers ?? {}) as Record<string, Record<string, unknown>>) };
    const merged = mergeProviderConfig(providers[providerId], config);
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
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
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

function backendConnectionInfo() {
  if (backendManager) return backendManager.connectionInfo();
  if (externalBackendConnection) return externalBackendConnection;
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
async function startEmbeddedBackend() {
  backendManager = new BackendManager({ isDev });
  backendManager.on("progress", (info: { step?: string; detail?: string }) => sendSplash("splash:progress", info));
  backendManager.on("error", (err: unknown) => sendSplash("splash:error", splashErrorEnvelope(err)));
  sendSplash("splash:progress", { step: "assets", detail: "Checking Backend node catalog…" });
  await provisionNodeCatalogSeed(runtimePaths.backendRoot, runtimePaths.toolsRoot);
  if (!fs.existsSync(runtimePaths.toolsRoot)) {
    crashLog.warn("nodes.catalog-missing", { nodeRoot: runtimePaths.toolsRoot });
  }
  const started = backendManager.start();
  backendStartPromise = started.then(() => undefined);
  started.catch(() => undefined);
  return started;
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
      accessToken = typeof persisted?.accessToken === "string" && persisted.accessToken ? persisted.accessToken : null;
    }
  }
  await updateSettingsFile(runtimePaths.settingsFile, (doc) => ({
    ...(doc ?? {}),
    backendConnection: { mode, baseUrl, accessToken },
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
// shared workspace). The ShareServer enforces it; this wiring only
// normalizes input, persists atomically and applies idempotently. Default is
// OFF + loopback, so nothing listens until the local user opts in.
const SHARE_TIERS: ReadonlyArray<ShareTier> = ["view", "continue", "control"];
const SHARE_MODES: ReadonlyArray<ShareMode> = ["loopback", "lan"];

function normalizeShareInvite(value: unknown): ShareInvite | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const tier = SHARE_TIERS.includes(raw.tier as ShareTier) ? raw.tier as ShareTier : "view";
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  const token = typeof raw.token === "string" ? raw.token : "";
  if (!id || !name || !token) return null;
  return {
    id,
    name,
    token,
    tier,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    ...(typeof raw.revokedAt === "string" ? { revokedAt: raw.revokedAt } : {}),
  };
}

function normalizeShareConfig(value: unknown): ShareConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const mode = SHARE_MODES.includes(raw.mode as ShareMode) ? raw.mode as ShareMode : "loopback";
  const portNumber = Number(raw.port);
  const invites = Array.isArray(raw.invites)
    ? raw.invites.map(normalizeShareInvite).filter((invite): invite is ShareInvite => invite !== null)
    : [];
  // Legacy migration (single shared token → one named invitation): the old
  // model's every-holder-is-one-crowd becomes an explicit "Link" guest, so an
  // upgrading host loses nothing and can revoke precisely what the old rotate
  // button used to nuke wholesale.
  if (invites.length === 0 && typeof raw.token === "string" && raw.token) {
    const legacyTier = SHARE_TIERS.includes(raw.tier as ShareTier) ? raw.tier as ShareTier : "view";
    invites.push({
      id: `legacy-${raw.token.slice(0, 6)}`,
      name: "Link",
      token: raw.token,
      tier: legacyTier,
      createdAt: new Date().toISOString(),
    });
  }
  return {
    enabled: raw.enabled === true,
    mode,
    port: Number.isInteger(portNumber) && portNumber >= 0 && portNumber <= 65535 ? portNumber : 0,
    invites,
    workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : "",
  };
}

let shareServer: ShareServer | null = null;

async function applyShareConfig(): Promise<void> {
  const config = normalizeShareConfig(readSettings(runtimePaths.settingsFile)?.sharing);
  if (!config.enabled) {
    await shareServer?.stop();
    return;
  }
  // An enabled share whose workspace vanished from the registry stays DOWN —
  // fail closed with a log line instead of serving an empty root.
  try {
    await resolveSharedWorkspaceRoot(config.workspaceId);
  } catch (error) {
    crashLog.warn("share.start-workspace-unresolved", error);
    await shareServer?.stop();
    return;
  }
  const effective = config;
  if (!shareServer) {
    shareServer = new ShareServer(effective, {
      resolveWorkspaceRoot: resolveSharedWorkspaceRoot,
      promptAgent: async (sessionId, message, guestName) => {
        // The guest speaks in the host's transcript under their invitation
        // name — provenance is part of the conversation, not a side log only.
        const result = await getAgentRuntime().prompt({ sessionId, message: `[guest: ${guestName}] ${message}` });
        if (result && !result.ok) {
          return { ok: false, error: result.message ?? "Agent prompt failed" };
        }
        return { ok: true };
      },
      log: (level, message, details) => crashLog[level](`share.${message}`, details),
    });
  }
  await shareServer.apply(effective).catch((error) => {
    crashLog.warn("share.apply-failed", error);
  });
}

async function resolveSharedWorkspaceRoot(workspaceId: string): Promise<string> {
  if (!workspaceId) throw new Error("No workspace selected for sharing");
  const registry = await readWorkspaceRegistry();
  const entry = registry.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
  if (!entry || typeof entry.local_path !== "string") {
    throw new Error(`Workspace is not registered: ${workspaceId}`);
  }
  return workspacePath(entry.local_path);
}

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

async function readShareInvites(): Promise<ShareInvite[]> {
  return [...normalizeShareConfig(readSettings(runtimePaths.settingsFile)?.sharing).invites];
}

/** Serialized write of the invites array (create/revoke share this seam). */
async function writeShareInvites(transform: (invites: ShareInvite[]) => ShareInvite[]): Promise<ShareInvite[]> {
  const current = normalizeShareConfig(readSettings(runtimePaths.settingsFile)?.sharing);
  const nextInvites = transform([...current.invites]);
  const next: ShareConfig = { ...current, invites: nextInvites };
  const written = await updateSettingsFile(runtimePaths.settingsFile, (doc) => ({ ...(doc ?? {}), sharing: next }));
  if (!written) throw new Error("settings.json could not be updated");
  await applyShareConfig();
  return nextInvites;
}

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
  if (enabled) await resolveSharedWorkspaceRoot(workspaceId);
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
  await applyShareConfig();
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
  await writeShareInvites((invites) => [...invites, invite]);
  return invite;
});

// Revoke keeps the entry (audit trail) and stops matching immediately.
ipcMain.handle("share:revoke-invite", async (_event, inviteId: unknown) => {
  if (typeof inviteId !== "string" || !inviteId.trim()) throw new Error("inviteId is required");
  let revoked = false;
  await writeShareInvites((invites) => invites.map((invite) => {
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
  const invite = (await readShareInvites()).find((candidate) => candidate.id === inviteId);
  if (!invite || invite.revokedAt) throw new Error(`No live invitation: ${String(inviteId)}`);
  return { inviteId, token: invite.token };
});

function failShareWrite(message: string): never {
  throw new Error(`Invalid sharing configuration: ${message}`);
}

function workspaceRegistryPath() {
  return runtimePaths.workspaceRegistryFile;
}

/** One local Workspaces registry entry. The file on disk is external data —
 *  field accesses still guard at runtime; this interface states the shape
 *  this process itself writes. */
interface WorkspaceRegistryEntry {
  workspace_id: string
  name?: string
  local_path: string
  backend_root_id?: string
  last_opened_at?: string
}
type WorkspaceRegistryFile = { schema_version: 1; workspaces: WorkspaceRegistryEntry[] };

async function readWorkspaceRegistry(): Promise<WorkspaceRegistryFile> {
  try {
    const value = JSON.parse(await fsp.readFile(workspaceRegistryPath(), "utf8")) as WorkspaceRegistryFile;
    return value?.schema_version === 1 && Array.isArray(value.workspaces)
      ? value
      : { schema_version: 1, workspaces: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { schema_version: 1, workspaces: [] };
    throw error;
  }
}

async function writeWorkspaceRegistry(value: WorkspaceRegistryFile) {
  const target = workspaceRegistryPath();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await atomicReplace(temp, target);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

// ── Backend Workspace-root approval ────────────────────────────────────
//
// An absolute path crosses the protocol only at attach time. Backend persists a
// per-principal grant and returns an opaque root_id; Run commits use that id plus
// a relative Run path. Removing a Workspace revokes the same grant.
async function approveWorkspaceRootWithBackend(absolutePath: string): Promise<{ root_id: string; path: string }> {
  const connection = backendConnectionInfo();
  const { baseUrl, accessToken } = connection;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/workspace-roots`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ path: absolutePath }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Backend at ${baseUrl} is unavailable while approving the Workspace root (${reason}). Start or repair the development Backend, then retry.`, { cause });
  }
  if (!response.ok) {
    // Surface the Backend's own envelope rather than inventing a message: it
    // already carries the code and the remedy the user needs.
    let detail = `HTTP ${response.status}`;
    try {
      type BackendErrorEnvelope = { code?: string; message?: string; remedy?: string };
      const body = await response.json() as { error?: BackendErrorEnvelope; detail?: { error?: BackendErrorEnvelope } } | null;
      const error = body?.error ?? body?.detail?.error;
      if (error?.message) detail = `${error.code}: ${error.message}${error.remedy ? ` — ${error.remedy}` : ""}`;
    } catch { /* keep the status-only detail */ }
    throw new Error(`Backend refused the Workspace root ${absolutePath} (${detail})`);
  }
  return response.json() as Promise<{ root_id: string; path: string }>;
}

async function revokeWorkspaceRootWithBackend(rootId: string): Promise<void> {
  let connection;
  try { connection = backendConnectionInfo(); } catch { return; }
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl}/api/workspace-roots/${encodeURIComponent(rootId)}`, {
      method: "DELETE",
      headers: connection.accessToken ? { Authorization: `Bearer ${connection.accessToken}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Backend at ${connection.baseUrl} is unavailable while revoking the Workspace root (${reason})`, { cause });
  }
  if (!response.ok && response.status !== 404) {
    throw new Error(`Backend refused to revoke Workspace root ${rootId} (HTTP ${response.status})`);
  }
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

function workspacePath(root: string, relative = ".") {
  if (!path.isAbsolute(root)) throw new Error("workspace root must be absolute");
  const resolvedRoot = path.resolve(root);
  let workspaces: unknown[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(workspaceRegistryPath(), "utf8")) as { workspaces?: unknown[] } | null;
    if (Array.isArray(parsed?.workspaces)) workspaces = parsed.workspaces;
  } catch {
    // An unreadable registry means nothing is registered; the membership
    // check below fails closed on the empty list.
  }
  const registered = workspaces.some((entry) => {
    const localPath = (entry as WorkspaceRegistryEntry | undefined)?.local_path;
    return typeof localPath === "string" && path.resolve(localPath) === resolvedRoot;
  });
  if (!registered) throw new Error("workspace root is not registered");
  return containedPath(resolvedRoot, relative, "workspace path traversal denied");
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
ipcMain.handle("workspace:read-text", (_event, root: string, relative: string) => fsp.readFile(workspacePath(root, relative), "utf8"));
// The Buffer crosses the structured-clone boundary as a Uint8Array — the
// renderer gets bytes, not a JS number per byte. Array.from(Buffer) on a
// multi-GB mzML exceeded V8's max array length and killed the handler.
ipcMain.handle("workspace:read-bytes", (_event, root: string, relative: string) => fsp.readFile(workspacePath(root, relative)));
ipcMain.handle("workspace:file-size", async (_event, root: string, relative: string) => (await fsp.stat(workspacePath(root, relative))).size);
// Random-access byte range [start, end) — lets the mzML preview stream and
// slice a large file without ever holding it whole in the renderer.
ipcMain.handle("workspace:read-byte-range", async (_event, root: string, relative: string, start: unknown, end: unknown) => {
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new Error("read-byte-range requires finite numeric start/end");
  }
  const target = workspacePath(root, relative);
  const length = Math.max(0, Math.min(Math.floor(to), (await fsp.stat(target)).size) - Math.max(0, Math.floor(from)));
  const handle = await fsp.open(target, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, Math.floor(from)));
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
});
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
ipcMain.handle("workspace:list-files", async (_event, root: string) => {
  const base = workspacePath(root);
  const files: string[] = [];
  async function walk(directory: string) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", ".tdease", ".snakemake"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(path.relative(base, absolute).split(path.sep).join("/"));
    }
  }
  await walk(base);
  return files.sort();
});
ipcMain.handle("workspace:sha256", (_event, root: string, relative: string) => new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(workspacePath(root, relative));
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(hash.digest("hex")));
}));

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
ipcMain.handle("result-cache:sha256", (_event, relative: string) => new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(resultCachePath(relative));
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(hash.digest("hex")));
}));
ipcMain.handle("result-cache:read-bytes", (_event, relative: string) => fsp.readFile(resultCachePath(relative)));
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
ipcMain.handle("workspace:move", async (_event, root: string, srcRels: string[], destDirRel: string) => {
  if (!Array.isArray(srcRels) || srcRels.length === 0) return;
  const destDir = workspacePath(root, destDirRel);
  await fsp.mkdir(destDir, { recursive: true });
  for (const srcRel of srcRels) {
    const src = workspacePath(root, srcRel);
    const dest = path.join(destDir, path.basename(src));
    await fsp.rename(src, dest);
  }
});
ipcMain.handle("workspace:copy-into", async (_event, root: string, absSrcPaths: string[], destDirRel: string) => {
  if (!Array.isArray(absSrcPaths) || absSrcPaths.length === 0) return;
  const destDir = workspacePath(root, destDirRel);
  await fsp.mkdir(destDir, { recursive: true });
  for (const absSrc of absSrcPaths) {
    if (!path.isAbsolute(absSrc)) throw new Error("copy-into requires absolute source path");
    const dest = path.join(destDir, path.basename(absSrc));
    await fsp.cp(absSrc, dest, { recursive: true, force: true });
  }
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
  if (!path.isAbsolute(absPath)) throw new Error("show-in-folder requires absolute path");
  shell.showItemInFolder(absPath);
});
ipcMain.handle("workspace:open-external", async (_event, absPath: string) => {
  if (!path.isAbsolute(absPath)) throw new Error("open-external requires absolute path");
  return shell.openPath(absPath);
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
  if (!path.isAbsolute(root)) return { ok: false, error: "root must be absolute" };
  let entry = watchers.get(root);
  if (!entry) {
    const resolvedRoot = path.resolve(root);
    // Union, deduped. Note the watcher for a root is created once and then
    // shared by refcount, so later subscribers do not re-negotiate `ignored`;
    // that is safe precisely because the derived contract floor is unconditional.
    const ignored = [...new Set([...WORKSPACE_WATCH_IGNORED, ...(opts?.ignored ?? [])])];
    const watcher = chokidar.watch(resolvedRoot, {
      ignored,
      ignoreInitial: true,
      persistent: true,
    });
    watcher.on("all", (eventName: string, filePath: string) => {
      const rel = path.relative(resolvedRoot, filePath).split(path.sep).join("/");
      const subs = entry!.subscribers;
      for (const wc of subs) {
        if (!wc.isDestroyed()) wc.send("workspace:fs-event", { event: eventName, path: rel });
      }
    });
    entry = { watcher, refCount: 0, subscribers: new Set() };
    watchers.set(root, entry);
    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
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
  const entry = watchers.get(root);
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
    void applyShareConfig().catch((error) => crashLog.warn("share.boot-apply-failed", error));
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
  const needsSweep = !!backendManager || !!agentRuntimeInstance;
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
    try { await agentRuntimeInstance?.disposeAll(); } catch (error) {
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
