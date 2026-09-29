const { contextBridge, ipcRenderer, webUtils } = require("electron");

function reportRendererError(kind, value) {
  const error = value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : { message: typeof value === "string" ? value : String(value) };
  ipcRenderer.send("desktop:renderer-error", { kind, error });
}

window.addEventListener("error", (event) => {
  // Chromium reports this as a window error even though it is a recoverable
  // ResizeObserver scheduling warning, not a Renderer failure.
  if (event.message === "ResizeObserver loop completed with undelivered notifications.") return;
  reportRendererError("error", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  reportRendererError("unhandledrejection", event.reason);
});

contextBridge.exposeInMainWorld("tdeaseDesktop", {
  platform: process.platform,
  runtime: "electron",
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  /** First frame after Vue mount — the splash stays up until this arrives. */
  rendererReady: () => ipcRenderer.send("app:renderer-ready"),
  backend: {
    connection: () => ipcRenderer.invoke("backend:connection"),
    configure: (input) => ipcRenderer.invoke("backend:configure", input),
  },
  network: {
    readProxy: () => ipcRenderer.invoke("network:read-proxy"),
    writeProxy: (input) => ipcRenderer.invoke("network:write-proxy", input),
  },
  // App update channel (electron/updater.ts): state pushes + the two actions.
  // `restart` is only honored in the `downloaded` phase — the app never
  // restarts on its own initiative.
  update: {
    currentState: () => ipcRenderer.invoke("update:state:get"),
    check: () => ipcRenderer.invoke("update:check"),
    restart: () => ipcRenderer.invoke("update:restart"),
    subscribe: (onState) => {
      const handler = (_event, payload) => { onState(payload); };
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
  runs: {
    subscribe: (onInvalidated) => {
      const handler = (_event, payload) => { onInvalidated(payload); };
      ipcRenderer.on("runs:invalidated", handler);
      return () => ipcRenderer.removeListener("runs:invalidated", handler);
    },
  },
  agent: {
    bindSession: (input) => ipcRenderer.invoke("agent:bind-session", input),
    prompt: (input) => ipcRenderer.invoke("agent:prompt", input),
    abort: (sessionId) => ipcRenderer.invoke("agent:abort", sessionId),
    compact: (sessionId) => ipcRenderer.invoke("agent:compact", sessionId),
    fork: (sessionId, targetSessionId) => ipcRenderer.invoke("agent:fork", sessionId, targetSessionId),
    dispose: (sessionId) => ipcRenderer.invoke("agent:dispose", sessionId),
    resolveApproval: (input) => ipcRenderer.invoke("agent:resolve-approval", input),
    subscribe: (sessionId, onEvent) => {
      const handler = (_event, id, payload) => { if (id === sessionId) onEvent(payload); };
      ipcRenderer.on("agent:event", handler);
      return () => {
        ipcRenderer.removeListener("agent:event", handler);
      };
    },
    // Live context occupancy read-side push on `context:changed`, owner-routed
    // by main the same way `subagent:changed` is. Session-scoped like
    // `subscribe`; the renderer's useAgentTurn keeps one per bound session.
    onContextChanged: (sessionId, onUsage) => {
      const handler = (_event, id, payload) => { if (id === sessionId) onUsage(payload); };
      ipcRenderer.on("context:changed", handler);
      return () => {
        ipcRenderer.removeListener("context:changed", handler);
      };
    },
  },
  // Subagent read-side (palot inspector Phase B). `list`/`cancel` are invoke;
  // `onChanged` is a push on the `subagent:changed` channel, owner-routed by
  // main the same way `agent:event` is. The renderer's subagent store
  // subscribes once per bound parent session.
  subagent: {
    list: (sessionId) => ipcRenderer.invoke("subagent:list", sessionId),
    cancel: (parentSessionId, subagentId) => ipcRenderer.invoke("subagent:cancel", parentSessionId, subagentId),
    peek: (parentSessionId, subagentId, lines) => ipcRenderer.invoke("subagent:peek", parentSessionId, subagentId, lines),
    onChanged: (sessionId, onSnapshot) => {
      const handler = (_event, id, payload) => { if (id === sessionId) onSnapshot(payload); };
      ipcRenderer.on("subagent:changed", handler);
      return () => { ipcRenderer.removeListener("subagent:changed", handler); };
    },
  },
  // Background job read-side — mirrors `subagent`. `list`/`cancel`/`peek` are
  // invoke; `onChanged` is a push on `job:changed`, owner-routed by main the
  // same way `subagent:changed` is. The renderer's jobs store subscribes once
  // per bound parent session.
  job: {
    list: (sessionId) => ipcRenderer.invoke("job:list", sessionId),
    cancel: (parentSessionId, jobId) => ipcRenderer.invoke("job:cancel", parentSessionId, jobId),
    peek: (parentSessionId, jobId, lines) => ipcRenderer.invoke("job:peek", parentSessionId, jobId, lines),
    onChanged: (sessionId, onSnapshot) => {
      const handler = (_event, id, payload) => { if (id === sessionId) onSnapshot(payload); };
      ipcRenderer.on("job:changed", handler);
      return () => { ipcRenderer.removeListener("job:changed", handler); };
    },
  },
  // Agent → Workbench viewer commands (view.open/focus/select), owner-routed
  // by main. Push-only: the renderer decides focus (Follow agent).
  agentView: {
    onCommand: (callback) => {
      const handler = (_event, envelope) => callback(envelope);
      ipcRenderer.on("agent-view:command", handler);
      return () => { ipcRenderer.removeListener("agent-view:command", handler); };
    },
  },
  // Session-run read-side — mirrors `job`. `list` is an invoke;
  // `onChanged` pushes on `session-run:changed`, owner-routed by main. The
  // renderer's sessionRuns store mirrors this one snapshot per parent session:
  // the runs THIS conversation dispatched, never the workspace's history.
  sessionRun: {
    list: (sessionId) => ipcRenderer.invoke("session-run:list", sessionId),
    onChanged: (sessionId, onSnapshot) => {
      const handler = (_event, id, payload) => { if (id === sessionId) onSnapshot(payload); };
      ipcRenderer.on("session-run:changed", handler);
      return () => { ipcRenderer.removeListener("session-run:changed", handler); };
    },
  },
  mcpConfig: {
    readSystem: () => ipcRenderer.invoke("mcp-config:read-system"),
    writeSystem: (content) => ipcRenderer.invoke("mcp-config:write-system", content),
  },
  // Workspace Web sharing — host-only configuration surface (default off).
  // readConfig returns the config INCLUDING the token: it is the host's own
  // settings page reading it, the same trust as every other settings IPC.
  share: {
    readConfig: () => ipcRenderer.invoke("share:read-config"),
    writeConfig: (input) => ipcRenderer.invoke("share:write-config", input),
    createInvite: (input) => ipcRenderer.invoke("share:create-invite", input),
    revokeInvite: (inviteId) => ipcRenderer.invoke("share:revoke-invite", inviteId),
    revealInviteToken: (inviteId) => ipcRenderer.invoke("share:reveal-invite-token", inviteId),
  },
  // Agent provider config — settings.json v3 is the single credential truth.
  // The Renderer never holds the apiKey except transiently in the edit field;
  // it writes through here and reads back only a redacted `configured` flag.
  // `readModels` returns the live model list discovered by main (vendor
  // /models + models.dev fallback, TTL-cached) — advisory picker data only.
  agentProviders: {
    read: () => ipcRenderer.invoke("settings:read-agent-providers"),
    write: (providerId, config) => ipcRenderer.invoke("settings:write-agent-provider", providerId, config),
    // Whole-key removal (custom providers) — write({}) intentionally spares
    // the frozen models map, so it cannot express "delete this provider".
    remove: (providerId) => ipcRenderer.invoke("settings:delete-agent-provider", providerId),
    addModel: (providerId, modelId) => ipcRenderer.invoke("settings:add-provider-model", providerId, modelId),
    readModels: (providerId, options) => ipcRenderer.invoke("settings:read-provider-models", providerId, options),
    testProvider: (providerId) => ipcRenderer.invoke("settings:test-provider", providerId),
    // Per-model price declaration (custom endpoints; USD per 1M tokens).
    readPricing: (providerId) => ipcRenderer.invoke("settings:read-provider-model-pricing", providerId),
    setPricing: (providerId, modelId, cost) =>
      ipcRenderer.invoke("settings:set-provider-model-pricing", providerId, modelId, cost),
  },
  // OAuth login bridge — push events (flow prompts/notify/done) arrive on
  // `provider-auth:event` for the window that started the login.
  providerAuth: {
    login: (providerId) => ipcRenderer.invoke("provider-auth:login", providerId),
    cancel: () => ipcRenderer.invoke("provider-auth:cancel"),
    resolvePrompt: (promptId, value) => ipcRenderer.invoke("provider-auth:resolve-prompt", promptId, value),
    status: () => ipcRenderer.invoke("provider-auth:status"),
    onEvent: (onPayload) => {
      const handler = (_event, payload) => onPayload(payload);
      ipcRenderer.on("provider-auth:event", handler);
      return () => ipcRenderer.removeListener("provider-auth:event", handler);
    },
  },
  usageLedger: {
    list: (filter) => ipcRenderer.invoke("usage-ledger:list", filter),
    // Full-ledger aggregation over in main (usage-stats.ts) — the only
    // consumption-stats path, so totals can never be capped-page under-counts.
    stats: (range) => ipcRenderer.invoke("usage-ledger:stats", range),
    clear: () => ipcRenderer.invoke("usage-ledger:clear"),
    // Live append stream. The main process broadcasts every new entry to all
    // windows; the renderer's onEntry callback receives it. Returns an
    // unsubscribe that removes only this listener (mirror of pi.subscribe).
    subscribe: (onEntry) => {
      const handler = (_event, entry) => { try { onEntry(entry); } catch (err) { console.error("[usage-ledger] listener threw:", err); } };
      ipcRenderer.on("usage-ledger:event", handler);
      return () => ipcRenderer.removeListener("usage-ledger:event", handler);
    },
  },
  system: {
    readText: (relative) => ipcRenderer.invoke("system:read-text", relative),
    listFiles: (relative) => ipcRenderer.invoke("system:list-files", relative),
  },
  systemData: {
    listFiles: (relative) => ipcRenderer.invoke("system-data:list-files", relative),
    readText: (relative) => ipcRenderer.invoke("system-data:read-text", relative),
    writeTextAtomic: (relative, content) => ipcRenderer.invoke("system-data:write-text-atomic", relative, content),
    sha256: (relative) => ipcRenderer.invoke("system-data:sha256", relative),
  },
  // Published Result cache -- TDEase's own file store under the Client System
  // root, not the user's Workspace. Same five-primitive shape
  // as `workspace` below (exists / sha256 / readBytes / writeBytesAtomic /
  // remove); see electron/main.ts's "Published Result cache" section for why
  // it is a separate root and why `remove` here is a hard delete rather than
  // `workspace.trash`'s OS-trash move.
  resultCache: {
    exists: (relative) => ipcRenderer.invoke("result-cache:exists", relative),
    sha256: (relative) => ipcRenderer.invoke("result-cache:sha256", relative),
    readBytes: (relative) => ipcRenderer.invoke("result-cache:read-bytes", relative),
    writeBytesAtomic: (relative, content) => ipcRenderer.invoke("result-cache:write-bytes-atomic", relative, content),
    remove: (relative) => ipcRenderer.invoke("result-cache:remove", relative),
  },
  workspace: {
    exists: (root, relative) => ipcRenderer.invoke("workspace:exists", root, relative),
    mkdir: (root, relative) => ipcRenderer.invoke("workspace:mkdir", root, relative),
    listFiles: (root) => ipcRenderer.invoke("workspace:list-files", root),
    readText: (root, relative) => ipcRenderer.invoke("workspace:read-text", root, relative),
    readBytes: (root, relative) => ipcRenderer.invoke("workspace:read-bytes", root, relative),
    readByteRange: (root, relative, start, end) => ipcRenderer.invoke("workspace:read-byte-range", root, relative, start, end),
    fileSize: (root, relative) => ipcRenderer.invoke("workspace:file-size", root, relative),
    writeTextAtomic: (root, relative, content) => ipcRenderer.invoke("workspace:write-text-atomic", root, relative, content),
    appendText: (root, relative, content) => ipcRenderer.invoke("workspace:append-text", root, relative, content),
    writeBytesAtomic: (root, relative, content) => ipcRenderer.invoke("workspace:write-bytes-atomic", root, relative, content),
    sha256: (root, relative) => ipcRenderer.invoke("workspace:sha256", root, relative),
    // ── File-tree mutation ops (DeskTree parity) ──
    rename: (root, oldRel, newRel) => ipcRenderer.invoke("workspace:rename", root, oldRel, newRel),
    trash: (root, rel) => ipcRenderer.invoke("workspace:trash", root, rel),
    move: (root, srcRels, destDirRel) => ipcRenderer.invoke("workspace:move", root, srcRels, destDirRel),
    copyInto: (root, absSrcPaths, destDirRel) => ipcRenderer.invoke("workspace:copy-into", root, absSrcPaths, destDirRel),
    copy: (root, srcRel, destRel) => ipcRenderer.invoke("workspace:copy", root, srcRel, destRel),
    listDir: (root, rel) => ipcRenderer.invoke("workspace:list-dir", root, rel),
    showInFolder: (absPath) => ipcRenderer.invoke("workspace:show-in-folder", absPath),
    openExternal: (absPath) => ipcRenderer.invoke("workspace:open-external", absPath),
    revealPath: (root, rel) => ipcRenderer.invoke("workspace:reveal-path", root, rel),
    startNativeDrag: (filePaths) => ipcRenderer.send("workspace:start-native-drag", filePaths),
    // Browser File object → absolute path (for OS-file drop upload).
    getPathForFile: (file) => {
      try { return webUtils.getPathForFile(file); }
      catch { return null; }
    },
  },
  // ── File watcher bridge (chokidar via main process) ──
  // Kept for callers that ask the bridge to install the watcher; the watcher
  // itself is exposed unconditionally below, so this is now a no-op that only
  // exists so `fileWatcher.ts`'s feature detection keeps reading true.
  __installFsWatch: () => {},
  workspaceRegistry: {
    list: () => ipcRenderer.invoke("workspace-registry:list"),
    upsert: (entry) => ipcRenderer.invoke("workspace-registry:upsert", entry),
    remove: (workspaceId) => ipcRenderer.invoke("workspace-registry:remove", workspaceId),
  },
  // Conversation export: the standalone export HTML printed to PDF bytes by a
  // hidden window in main (see conversation:print-pdf). Bytes only — the
  // renderer writes them into the workspace through `workspace` above.
  conversation: {
    printPdf: (html) => ipcRenderer.invoke("conversation:print-pdf", html),
  },
});

// ── Two globals the renderer reads by name ──
//
// These were assigned with `globalThis.x = ...`, which under `contextIsolation:
// true` writes to the PRELOAD's isolated world, not to the page. The renderer
// reads `window.__tdease_fs` / `globalThis.__tdease_fs_watch` and found neither,
// so the folder picker silently reported "no picker available" (and
// `pickAndOpen` fell back to opening a Workspace literally named "demo"), and
// `fileWatcher.ts` fell back to polling. Crossing the bridge explicitly is the
// only assignment that reaches the page.
//
// `exposeInMainWorld` must run while the preload is executing, so the watcher
// factory is installed eagerly here rather than lazily from `__installFsWatch`.

contextBridge.exposeInMainWorld("__tdease_fs", {
  pickDirectory: () => ipcRenderer.invoke("workspace:pick-directory"),
});

// `opts` is forwarded, not dropped. It used to be accepted as `_opts` and
// discarded, so the signature promised a policy no caller could ever deliver.
// Main still owns the floor -- it derives its ignore list from
// SUBMISSION_EXCLUDED_PATHS and *adds* whatever arrives here rather than
// replacing it -- so forwarding widens the ignore set and can never narrow it
// below the submission exclusion contract.
/** @param {string} root @param {{ ignored?: string[] } | undefined} [opts] */
const __tdease_fs_watch = (root, opts) => {
  const listeners = new Set();
  const handler = (_e, payload) => {
    for (const fn of listeners) {
      try { fn(payload.event, payload.path); }
      catch (err) { console.error("[fs-watch] listener threw:", err); }
    }
  };
  ipcRenderer.on("workspace:fs-event", handler);
  // Kick off the watcher in main. We don't await here — events flow when they
  // flow; the renderer's start() resolves immediately.
  ipcRenderer.invoke("workspace:watch-start", root, opts).catch((err) => {
    console.warn("[fs-watch] watch-start failed:", err?.message || err);
  });
  return {
    on(name, fn) {
      if (name === "all") listeners.add(fn);
      return this;
    },
    once(name, fn) {
      // chokidar 'ready' — we don't surface it; no-op (main awaits ready).
      if (name === "ready") setTimeout(fn, 0);
      return this;
    },
    async close() {
      listeners.clear();
      ipcRenderer.removeListener("workspace:fs-event", handler);
      try { await ipcRenderer.invoke("workspace:watch-stop", root); }
      catch { /* already torn down */ }
    },
  };
};

contextBridge.exposeInMainWorld("__tdease_fs_watch", __tdease_fs_watch);
