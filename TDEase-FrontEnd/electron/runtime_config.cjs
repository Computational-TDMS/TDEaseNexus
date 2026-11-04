"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULTS = {
  schemaVersion: 3,
  backend: {
    host: "127.0.0.1",
    port: 0,
    health_timeout_ms: 180000,
    health_interval_ms: 800,
    log_file: "backend.log",
  },
  backendConnection: {
    mode: "local",
    baseUrl: null,
    // Bearer token for a remote backend. Same trust class as the provider
    // api_key below: main-process credential, persisted once, never logged.
    accessToken: null,
  },
  providers: {
    deepseek: {
      base_url: "https://api.deepseek.com/v1",
      api_key: "",
    },
  },
  runtime: {
    database_role: "verify",
    internal_dispatcher: false,
    uv_path: null,
    auto_install_uv: true,
  },
  data: {
    viewer_max_file_size: 50 * 1024 * 1024,
    viewer_max_rows: 50000,
  },
};

function appUserDataDir() {
  try {
    const { app } = require("electron");
    if (app && app.getPath) return app.getPath("userData");
  } catch {
    // Electron is unavailable in node-only checks/tests.
  }
  return path.join(os.tmpdir(), "tdease-desktop");
}

function _repoDataRoot() {
  let directory = path.resolve(__dirname);
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(directory, "data");
    // The repo data root is located by the writable runtime siblings
    // `backend/` and `workspace/` only. `system/` assets are read-only product
    // inputs resolved independently by `systemAssetsRoot()` (main.ts), so they
    // must NOT gate backend discovery — a split where system/ moved to a
    // toolkit submodule would otherwise break backend root resolution.
    if (fs.existsSync(path.join(candidate, "backend")) &&
        fs.existsSync(path.join(candidate, "workspace"))) {
      return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function _isPackagedRuntime() {
  const resources = process.resourcesPath || "";
  return !!resources && fs.existsSync(path.join(resources, "backend", "pyproject.toml"));
}

/**
 * True when `dir` exists (or can be created) AND is writable by this process.
 * A packaged install may land in a directory a standard user cannot write
 * (e.g. `C:\Program Files\TDEaseNexus` after an elevated install) — probing here
 * is what keeps such a launch from crashing on the first mkdir. The probe
 * makes a REAL child mkdir inside the directory (same syscall the runtime
 * tree creation uses): `fs.accessSync(W_OK)` does not check Windows ACLs, so
 * an access check alone would pass on an existing but ACL-restricted dir and
 * the crash would just move one mkdir later.
 */
function _isWritableDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.tdeasenexus-write-probe-${process.pid}`);
    fs.mkdirSync(probe);
    fs.rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Root for all writable runtime data (system/backend/workspace). In a packaged
 * install this is a `TDEaseNexus-Data` folder next to the installation directory
 * (e.g. `D:\Apps\TDEaseNexus-Data` beside `D:\Apps\TDEaseNexus`), so user data follows
 * the install drive instead of piling into `%APPDATA%` on C:. An AppImage counts
 * the same way: the data root sits beside the `.AppImage` file the user
 * launched. The installer owns the force-reinstall contract: an INTERACTIVE install uninstalls the
 * previous app and wipes any `TDEaseNexus-Data`/`TDEase-Data` beside the install
 * dir (electron/installer.nsh; a SILENT install — the update channel —
 * preserves the data root), so launch never migrates, renames, or reconciles
 * old folders — it only picks
 * where a root lives and creates it when absent. When the install directory is
 * not writable for the current user (Program Files installs, read-only
 * shares), it falls back to the per-user Electron profile — the sibling layout
 * is a convenience, never a launch requirement. Dev runs and node-only checks
 * fall back to the Electron profile.
 *
 * A FRESH root is additionally kept space-free: TopPIC 1.8.x hard-exits when
 * its own directory contains a space, and the Run's node snapshot lives under
 * this root, so a spaced root makes every TopPIC stage unrunnable. An existing
 * root is never relocated for that — moving a multi-GB tree (settings,
 * database, Runs) at launch would be worse than the constraint — so the rule
 * only chooses where a new root goes: install-sibling, else the install
 * drive's root, else the profile.
 */
function _hasSpace(dir) {
  return /\s/.test(dir);
}

/**
 * Directory the app was installed into. An AppImage's `process.execPath` is
 * `<squashfs mount>/tdeasenexus`, so `dirname(dirname(execPath))` is the mount's
 * parent (`/tmp`) — treating that as the install dir would put the data root at
 * `/tmp/TDEaseNexus-Data`: ephemeral, and shared by every installed version. The
 * AppImage runtime exports `APPIMAGE` (the file the user launched), whose
 * directory is the real install location.
 */
function _installRoot() {
  const appImage = process.env.APPIMAGE;
  if (appImage) return path.dirname(path.resolve(appImage));
  return path.dirname(path.dirname(process.execPath));
}

function defaultDataRoot() {
  // Release-E2E seam: the installed (packaged) app must be testable with an
  // isolated data root. Gated on TDEASE_E2E so a user can never trigger it.
  if (process.env.TDEASE_E2E === "1" && process.env.TDEASE_E2E_DATA_ROOT) {
    return process.env.TDEASE_E2E_DATA_ROOT;
  }
  if (_isPackagedRuntime() && process.execPath) {
    const parent = _installRoot();
    const brandRoot = path.join(parent, "TDEaseNexus-Data");
    // Existing data always wins, spaced or not (relocating it at launch is
    // worse than the space constraint); an existing-but-unwritable root is not
    // relocated either — that would orphan its Runs and settings.
    if (fs.existsSync(brandRoot)) {
      if (_isWritableDirectory(brandRoot)) return brandRoot;
      return appUserDataDir();
    }
    // Fresh root: a spaced sibling is skipped for the drive root, because a
    // space anywhere in the path breaks TopPIC (see the note above).
    if (!_hasSpace(brandRoot) && _isWritableDirectory(brandRoot)) return brandRoot;
    if (_hasSpace(brandRoot)) {
      const driveRoot = path.join(path.parse(parent).root, "TDEaseNexus-Data");
      if (_isWritableDirectory(driveRoot)) return driveRoot;
    }
  }
  return appUserDataDir();
}

function defaultSystemRoot() {
  return path.join(defaultDataRoot(), "system");
}

function settingsFilePath(system = defaultSystemRoot()) {
  return path.join(system, "settings.json");
}

function readSettings(filePath = settingsFilePath()) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function _migrateSettingsShape(value) {
  const settings = value && typeof value === "object" ? { ...value } : {};
  delete settings.data_root;
  delete settings.backend_root;
  settings.schemaVersion = DEFAULTS.schemaVersion;
  return settings;
}

/**
 * Ensure a settings.json exists at `target`, seeding it once from
 * `providerSeedFile` when the target is absent (user edits always win after).
 * @param {string} [target] - Absolute settings.json path.
 * @param {string | null} [providerSeedFile] - Optional seed JSON path.
 * @returns {string} The target path written.
 */
function ensureSettingsFile(target = settingsFilePath(), providerSeedFile = null) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const defaultTarget = path.resolve(target) === path.resolve(settingsFilePath());
  const legacyTarget = path.join(appUserDataDir(), "settings.json");
  let source = target;
  let settings = readSettings(target);
  if (!settings && defaultTarget && path.resolve(legacyTarget) !== path.resolve(target)) {
    settings = readSettings(legacyTarget);
    if (settings) source = legacyTarget;
  }

  if (!settings) {
    const seed = providerSeedFile ? readSettings(providerSeedFile) : null;
    settings = {
      schemaVersion: DEFAULTS.schemaVersion,
      backend: seed?.backend ?? DEFAULTS.backend,
      backendConnection: DEFAULTS.backendConnection,
      providers: seed?.providers ?? DEFAULTS.providers,
      runtime: seed?.runtime ?? DEFAULTS.runtime,
      data: seed?.data ?? DEFAULTS.data,
      mcp: { mcpServers: {} },
    };
  } else {
    settings = _migrateSettingsShape(settings);
    if (!settings.mcp || typeof settings.mcp !== "object") settings.mcp = { mcpServers: {} };
  }

  const legacyMcpFile = path.join(path.dirname(target), "mcp.json");
  if (fs.existsSync(legacyMcpFile)) {
    const legacyMcp = readSettings(legacyMcpFile);
    const currentServers = settings.mcp?.mcpServers || settings.mcp?.servers;
    if (legacyMcp && (!currentServers || Object.keys(currentServers).length === 0)) {
      settings.mcp = legacyMcp;
    }
  }

  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  let current = null;
  try { current = fs.readFileSync(target, "utf8"); } catch { /* missing target */ }
  if (current !== serialized) fs.writeFileSync(target, serialized, "utf8");
  if (source === legacyTarget && path.resolve(source) !== path.resolve(target)) {
    fs.rmSync(source, { force: true });
  }
  fs.rmSync(legacyMcpFile, { force: true });
  return target;
}

function resolvedSettings(filePath = settingsFilePath()) {
  const user = readSettings(filePath) || {};
  const merged = JSON.parse(JSON.stringify(DEFAULTS));
  for (const [section, values] of Object.entries(user)) {
    if (values && typeof values === "object" && !Array.isArray(values)) {
      merged[section] = { ...(merged[section] || {}), ...values };
    } else {
      merged[section] = values;
    }
  }
  return merged;
}

function backendSettings(filePath = settingsFilePath()) {
  return resolvedSettings(filePath).backend || DEFAULTS.backend;
}

function dataSettings(filePath = settingsFilePath()) {
  return resolvedSettings(filePath).data || DEFAULTS.data;
}

function runtimeSettings(filePath = settingsFilePath()) {
  return resolvedSettings(filePath).runtime || DEFAULTS.runtime;
}

function resolveRuntimePaths({ settingsFile = settingsFilePath(), backendRoot: fixedBackendRoot = null } = {}) {
  const system = path.dirname(path.resolve(settingsFile));
  const repoData = !_isPackagedRuntime() ? _repoDataRoot() : null;
  const backend = fixedBackendRoot && String(fixedBackendRoot).trim()
    ? path.resolve(String(fixedBackendRoot))
    : repoData
      ? path.join(repoData, "backend")
      : path.join(defaultDataRoot(), "backend");

  return Object.freeze({
    profileRoot: appUserDataDir(),
    settingsFile: path.resolve(settingsFile),
    systemRoot: system,
    backendRoot: backend,
    // Backend owns its compute software. Desktop/System remains separate:
    // <TDEaseNexus-Data>/backend/nodes vs <TDEaseNexus-Data>/system.
    toolsRoot: path.join(backend, "nodes"),
    logsRoot: path.join(system, "logs"),
    databaseFile: path.join(backend, "database", "db.sqlite3"),
    runtimeRoot: path.join(backend, "runtime"),
    cacheRoot: path.join(backend, "runtime", "cache"),
    // System-side uv cache: PEP 723 skill-script environments materialize
    // here, separate from the Backend's cache above — one environment store
    // per side.
    systemCacheRoot: path.join(system, "cache", "uv"),
    resultCacheRoot: path.join(system, "cache", "results"),
    agentRoot: path.join(system, "agent"),
    // The managed tool bin the bash sandbox PATH prefixes (`managedBinDir` in
    // agent-runtime): the `tdeasenexus-toolbox` CLI is provisioned here so its short name
    // resolves inside bash (D16, tdeasenexus-toolbox-native-adapter.md §17).
    agentToolsRoot: path.join(system, "agent", "tools"),
    workspaceRegistryFile: path.join(system, "workspaces.json"),
  });
}

function backendRoot(filePath = settingsFilePath()) {
  return resolveRuntimePaths({ settingsFile: filePath }).backendRoot;
}

function systemRoot(filePath = settingsFilePath()) {
  return resolveRuntimePaths({ settingsFile: filePath }).systemRoot;
}

function toolsRoot(filePath = settingsFilePath()) {
  return resolveRuntimePaths({ settingsFile: filePath }).toolsRoot;
}

function logDir(filePath = settingsFilePath()) {
  return resolveRuntimePaths({ settingsFile: filePath }).logsRoot;
}

/**
 * Materialize the writable Client System + Backend-private directory tree and
 * ensure a settings.json exists (seeded once from `providerSeedFile` if given).
 * @param {Object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {string} [options.settingsFile]
 * @param {string | null} [options.backendRoot] - Fixed backend root, else resolved from settings.
 * @param {string | null} [options.providerSeedFile] - Optional provider seed JSON path.
 */
function ensureRuntimeDirectories({
  host = "127.0.0.1",
  port = 8000,
  settingsFile = settingsFilePath(),
  backendRoot: fixedBackendRoot = null,
  providerSeedFile = null,
} = {}) {
  ensureSettingsFile(settingsFile, providerSeedFile);
  const paths = resolveRuntimePaths({ settingsFile, backendRoot: fixedBackendRoot });
  for (const directory of [
    paths.systemRoot,
    path.join(paths.systemRoot, "templates"),
    path.join(paths.systemRoot, "skills"),
    path.join(paths.systemRoot, "prompts"),
    path.join(paths.systemRoot, "reference"),
    path.join(paths.systemRoot, "wiki"),
    path.join(paths.systemRoot, "cache"),
    paths.systemCacheRoot,
    paths.resultCacheRoot,
    paths.agentRoot,
    paths.agentToolsRoot,
    paths.logsRoot,
    // No Workspace directory here: a Workspace is a folder the user opens
    // themselves (registered in workspaces.json), not something we create.
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return { ...paths, host, port };
}

module.exports = {
  appUserDataDir,
  backendRoot,
  backendSettings,
  dataSettings,
  DEFAULTS,
  defaultDataRoot,
  defaultSystemRoot,
  ensureRuntimeDirectories,
  ensureSettingsFile,
  logDir,
  readSettings,
  resolvedSettings,
  resolveRuntimePaths,
  runtimeSettings,
  settingsFilePath,
  systemRoot,
  toolsRoot,
};
