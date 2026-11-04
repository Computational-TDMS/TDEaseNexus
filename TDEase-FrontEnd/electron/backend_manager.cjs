/**
 * BackendManager — supervise the public Backend process boundary.
 *
 * Desktop provisions the packaged Python environment, then starts exactly one
 * Backend-owned CLI process with one JSON config file.
 */
"use strict";

const { spawn, execSync } = require("node:child_process");
// Kernel-level orphan guarantee: children assigned to the kill-on-close job
// die with THIS process even when nothing gets to run taskkill (crash, kill).
// Every failure mode inside degrades to the taskkill fallback silently.
const { assignChildToJob } = require("./windows-job.cjs");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  backendSettings,
  backendRoot,
  logDir,
  runtimeSettings,
} = require("./runtime_config.cjs");
const { resolveComponents } = require("./component_config.cjs");

class BackendManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.isDev = !!opts.isDev;
    // A supervised local Backend owns an OS-assigned port. Tests may pin one
    // explicitly; Server connections do not construct this Module.
    const cfg = backendSettings();
    this.host = opts.host || cfg.host;
    this.port = opts.port ?? 0;
    this._hostOverride = opts.host;
    this._portOverride = opts.port;
    this._healthTimeoutMs = opts.healthTimeoutMs || cfg.health_timeout_ms;
    this._healthIntervalMs = opts.healthIntervalMs || cfg.health_interval_ms;
    this._logFile = opts.logFile || cfg.log_file;
    this._children = [];
    this._stopped = false;
    this._stopPromise = null;
    this._failure = null;
    this._uvPath = null;
    this._runtimePython = null;
    this._backendCommand = null;
    this._configuredUvPath = opts.uvPath || null;
    this._findUv = opts.findUv || _findUserUv;
    this._bundledUv = opts.bundledUv || null; // test seam; prod uses _bundledUvPath()
    this._installUv = opts.installUv || _installUvForCurrentUser;
    this._autoInstallUv = opts.autoInstallUv;
    this._backendRoot = null;
    this._dataRoot = null;
    this._configFile = null;
    // Per-launch bearer material: the secret is minted fresh for every start,
    // handed to the Backend child through its environment (never a CLI arg —
    // process lists are readable by every local process), and exchanged
    // exactly once for the launch's token pair after the Backend is ready.
    this._bootstrapSecret = null;
    this._tokens = null;
    this._components = opts.components || null;
  }

  async start() {
    try {
      this._resolvePaths();
      this.emit("progress", { step: "init", detail: "Preparing backend configuration…" });
      this._dataRoot = this._runtimeDataRoot();
      fs.mkdirSync(this._dataRoot, { recursive: true });
      this._configFile = path.join(this._dataRoot, "config.json");
      this._ensureBackendConfig();
      if (!this.isDev) {
        this.emit("progress", { step: "uv", detail: "Locating the Python runtime…" });
        await this._ensureUv();
      }
      await this._ensureBackendEnvironment();
      this.emit("progress", { step: "spawn", detail: "Starting the backend service…" });
      this._bootstrapSecret = crypto.randomBytes(32).toString("base64url");
      const child = this._spawnBackend();
      await this._waitForReady(child);
      this.emit("progress", { step: "health", detail: "Waiting for the backend to become ready…" });
      if (this._failure) throw this._failure;
      await this._exchangeBootstrap();
      return this.connectionInfo();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = (async () => {
      for (const child of [...this._children].reverse()) await this._killTree(child);
      this._children = [];
      this._stopped = true;
    })();
    return this._stopPromise;
  }

  connectionInfo() {
    if (!this.port) throw new BackendError("BACKEND_NOT_READY", "The backend has not started yet", { domain: "environment", remedy: "Wait for the backend to finish starting, then retry.", retryable: true });
    return {
      baseUrl: `http://${this.host}:${this.port}`,
      accessToken: this._tokens ? this._tokens.user : null,
      agentToken: this._tokens ? this._tokens.agent : null,
    };
  }

  async _exchangeBootstrap() {
    // The single-use exchange turns the launch secret into the two
    // process-lifetime tokens: the owner token (every scope, for the UI and
    // the main process) and the agent token (no irreversible scopes, for the
    // AI harness). Failure here is fatal for the launch: a tokenless client
    // against a bearer Backend can do nothing. The timeout exists because a
    // half-ready backend that accepts the socket but never answers would
    // otherwise hang the whole launch chain on this await.
    const response = await fetch(`http://${this.host}:${this.port}/api/auth/bootstrap`, {
      method: "POST",
      headers: { "X-TDEase-Bootstrap": this._bootstrapSecret },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new BackendError("BACKEND_AUTH_EXCHANGE_FAILED", `Bootstrap exchange failed: HTTP ${response.status} ${body.slice(0, 200)}`, { domain: "environment", remedy: "Restart the app; if it persists, check the backend logs.", retryable: true });
    }
    const payload = await response.json();
    if (typeof payload.access_token !== "string" || typeof payload.agent_token !== "string") {
      throw new BackendError("BACKEND_AUTH_EXCHANGE_FAILED", "Bootstrap exchange response is missing tokens.", { domain: "environment", remedy: "Restart the app; if it persists, reinstall TDEase.", retryable: false });
    }
    this._tokens = { user: payload.access_token, agent: payload.agent_token };
    this._bootstrapSecret = null;
  }

  _resolvePaths() {
    this._components = this._components || resolveComponents({ isDev: this.isDev });
    this._backendRoot = this._components.backend.root;
    if (!fs.existsSync(path.join(this._backendRoot, "pyproject.toml"))) {
      throw new BackendError("BACKEND_ROOT_NOT_FOUND", `Backend root not found: ${this._backendRoot}`, { domain: "environment", remedy: "The app installation may be damaged; please reinstall TDEase.", retryable: false, details: { backendRoot: this._backendRoot } });
    }
  }

  _runtimeDataRoot() {
    // Development runs against the repository's checked-in Backend runtime so
    // its historical Runs and Backend-owned Nodes remain visible across
    // Electron restarts. Desktop/System is a separate root.
    return this.isDev
      ? path.join(path.dirname(this._backendRoot), "data", "backend")
      : backendRoot();
  }

  _ensureBackendConfig() {
    let current = null;
    try { current = JSON.parse(fs.readFileSync(this._configFile, "utf8")); } catch { /* create below */ }
    // Compute software belongs to Backend data. Move back a catalog created by
    // the mistaken sibling-root migration, without copying its large files.
    const nodeRoot = path.join(this._dataRoot, "nodes");
    const mistakenSiblingRoot = path.join(path.dirname(this._dataRoot), "nodes");
    if (!fs.existsSync(nodeRoot) && fs.existsSync(mistakenSiblingRoot)) {
      try { fs.renameSync(mistakenSiblingRoot, nodeRoot); } catch { /* Backend will report a missing catalog. */ }
    }
    const desiredNodeRoot = path.relative(this._dataRoot, nodeRoot) || ".";
    const hasCorrectNodeRoot = !!current && typeof current === "object"
      && current.nodeRoot === desiredNodeRoot;
    const hasCorrectAuth = !!current && typeof current === "object"
      && current?.auth?.mode === "bearer";
    if (current && hasCorrectNodeRoot && hasCorrectAuth
      && this._hostOverride === undefined && this._portOverride === undefined) return;
    const config = current && typeof current === "object" ? current : {
      schemaVersion: 1,
      environment: this.isDev ? "development" : "production",
      deploymentMode: "local",
      dataRoot: ".",
      server: { host: "127.0.0.1", port: 0 },
      auth: { mode: "bearer" },
      logging: { level: "INFO" },
      resources: {},
    };
    config.schemaVersion = 1;
    config.nodeRoot = desiredNodeRoot;
    // The Desktop-owned Backend always authenticates: the launcher mints a
    // per-launch bootstrap secret and exchanges it for the launch's tokens.
    // Installs configured before this rule carried mode "local" (every
    // request trusted) and are migrated here in place.
    config.auth = { mode: "bearer" };
    config.server = {
      ...(config.server || {}),
      ...(this._hostOverride !== undefined ? { host: this._hostOverride } : {}),
      ...(this._portOverride !== undefined ? { port: this._portOverride } : {}),
    };
    _writeJsonAtomic(this._configFile, config);
  }

  async _ensureUv() {
    const cfg = runtimeSettings();
    const configured = this._configuredUvPath || cfg.uv_path;
    // Resolution order (RUNTIME-PROVISIONING.md §1: the application brings its
    // own environment): explicit config → bundled uv (packaged builds) →
    // user-level uv on PATH → auto-install. The bundled uv is the one shipped
    // at resources/backend/runtime/uv.exe; before this chain it was defined but
    // never consulted, so packaged builds silently ignored ~64MB of shipped
    // runtime and re-downloaded uv from the network.
    const resolve = () => {
      if (configured) {
        const f = _existingFile(configured);
        if (f) return f;
      }
      if (!this.isDev) {
        const bundled = (this._bundledUv || _bundledUvPath)();
        if (bundled) return bundled;
      }
      return this._findUv();
    };
    const found = resolve();
    if (found) { this._uvPath = found; return; }
    const autoInstall = this._autoInstallUv ?? cfg.auto_install_uv;
    if (this.isDev || autoInstall === false) {
      throw new BackendError("UV_MISSING", "uv not found.", { domain: "environment", remedy: "Install uv, or select uv.exe in settings and retry.", retryable: true });
    }
    this.emit("progress", { step: "uv-install", detail: "Installing user-level uv…" });
    await this._installUv();
    this._uvPath = this._findUv();
    if (!this._uvPath) {
      throw new BackendError("UV_INSTALL_FAILED", "The uv executable was still not found after installation.", { domain: "environment", remedy: "Check your network and security software, install uv manually, then retry.", retryable: true });
    }
  }

  async _ensureBackendEnvironment() {
    const env = this._runtimeEnv();
    const environmentRoot = this.isDev
      ? path.join(this._backendRoot, ".venv")
      : env.UV_PROJECT_ENVIRONMENT;
    this._runtimePython = _environmentPython(environmentRoot);
    this._backendCommand = _environmentCommand(environmentRoot, this._components?.backend.command || "tdease-backend");
    if (this.isDev) {
      if (!fs.existsSync(this._runtimePython) || !fs.existsSync(this._backendCommand)) {
        throw new BackendError("BACKEND_CLI_MISSING", `Dev backend CLI does not exist: ${this._backendCommand}`, { domain: "environment", remedy: "Run uv sync in the tdease-backend repository, then retry.", retryable: true });
      }
      return;
    }
    const marker = path.join(environmentRoot, ".tdease-lock.json");
    const fingerprint = _backendFingerprint(this._backendRoot);
    const envHealthy = fs.existsSync(this._runtimePython) && fs.existsSync(this._backendCommand)
        && _markerMatches(marker, fingerprint)
        && _venvUsesBundledPython(environmentRoot, env.UV_PYTHON)
        && await this._environmentRuns();
    if (envHealthy) return;
    // A copied install (another machine, another drive, a renamed folder) leaves
    // a venv whose pyvenv.cfg and console-script trampolines embed the OLD
    // absolute path. The files exist, so an existence check would skip the
    // rebuild and then fail to spawn the command. The probe above runs the very
    // command we are about to spawn; a failure means the environment is derived
    // state that must be rebuilt (one uv sync; artifacts come from the uv cache
    // or the network — the product decision is that first boot may be online).
    if (fs.existsSync(environmentRoot)) {
      this.emit("progress", { step: "uv-sync", detail: "Rebuilding the Python environment for this install location…" });
      fs.rmSync(environmentRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(environmentRoot), { recursive: true });
    const onOutput = (text) => {
      const detail = _lastNonEmptyLine(_stripAnsi(text));
      if (detail) this.emit("progress", { step: "uv-sync", detail: detail.slice(-320) });
    };
    // One uv-native command: uv sync resolves the lock, creates the venv on the
    // UV_PYTHON interpreter (the bundled one — see _runtimeEnv) and installs
    // the project editable. The venv is derived state in the writable data
    // directory; only the interpreter itself ships.
    this.emit("progress", { step: "uv-sync", detail: "uv sync --locked --no-dev" });
    await _runProcess(this._uvPath, ["sync", "--locked", "--no-dev", "--project", this._backendRoot], {
      cwd: this._backendRoot,
      env,
      onOutput,
    });
    if (!fs.existsSync(this._runtimePython) || !fs.existsSync(this._backendCommand)) {
      throw new BackendError("BACKEND_CLI_MISSING", `uv sync did not produce the backend CLI: ${this._backendCommand}`, { domain: "environment", remedy: "Delete the TDEase backend runtime environment and retry.", retryable: true });
    }
    _writeJsonAtomic(marker, fingerprint);
  }

  async _environmentRuns() {
    // The console script is the fragile part: uv's Windows trampolines embed the
    // venv's absolute path, so a relocated install keeps the files but loses the
    // ability to run them. Probing the exact command we spawn is the only check
    // that catches both a missing base interpreter and a stale trampoline.
    try {
      await _runProcess(this._backendCommand, ["--help"], {
        cwd: this._backendRoot,
        env: this._runtimeEnv(),
      });
      return true;
    } catch {
      return false;
    }
  }

  _runtimeEnv() {
    const binDir = this._uvPath ? path.dirname(this._uvPath) : "";
    const inherited = process.env.PATH || "";
    const bkRoot = this._dataRoot || backendRoot();
    const env = { PATH: binDir ? `${binDir}${path.delimiter}${inherited}` : inherited };
    for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    // Unified proxy (settings.json network.proxy → main.ts sets these before
    // any spawn): uv/pypi (reqwest honors env) and the backend's own outbound
    // calls route through the configured proxy. NO_PROXY always carries the
    // loopback entries, so backend↔main IPC traffic never leaves the machine.
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    if (this._bootstrapSecret) {
      env.TDEASE_BOOTSTRAP_SECRET = this._bootstrapSecret;
    }
    // Packaged mode: the uv venv goes into the writable data directory rather
    // than the read-only resources/. The installer ships the interpreter
    // (runtime/cpython-*); the locked dependency set resolves from the uv cache
    // or the network at first boot (product decision — no offline wheelhouse).
    // UV_PYTHON holds the absolute interpreter path, which keeps uv away from
    // machine discovery (PEP 514 registry entries, PATH stubs that trigger the
    // Python install manager) entirely.
    if (!this.isDev) {
      env.UV_PROJECT_ENVIRONMENT = path.join(bkRoot, "runtime", "venv");
      env.UV_CACHE_DIR = path.join(bkRoot, "runtime", "cache");
      const bundledPython = _bundledPythonPath();
      env.UV_PYTHON = bundledPython || "3.12";
      // The packaged backend imports its modules from the read-only install;
      // writing __pycache__ there would mutate what the installer delivered
      // (and fails outright on a read-only mount), so bytecode writing is off.
      env.PYTHONDONTWRITEBYTECODE = "1";
    }
    return env;
  }

  _spawnBackend() {
    const executable = this._backendCommand;
    // --allow-env-overrides is how the Desktop launcher steers the Backend:
    // the per-launch bootstrap secret arrives through the child environment.
    const args = ["serve", "--config", this._configFile, "--allow-env-overrides"];
    const child = spawn(
      executable,
      args,
      {
        cwd: this._backendRoot,
        env: this._runtimeEnv(),
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    _pipeToConsole(child, "backend", this._logFile);
    assignChildToJob(child);
    this._track(child, "backend");
    return child;
  }

  _waitForReady(child) {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        cleanup();
        reject(new BackendError("HEALTH_TIMEOUT", `Backend not ready within ${this._healthTimeoutMs / 1000}s`, { domain: "environment", remedy: "Check the backend logs to find out why startup failed.", retryable: true }));
      }, this._healthTimeoutMs);
      let buffer = "";
      const cleanup = () => {
        clearTimeout(deadline);
        child.stdout?.off("data", onData);
        child.off("error", onError);
      };
      const onError = (cause) => {
        cleanup();
        reject(new BackendError("CHILD_START_FAILED", `Backend failed to start: ${cause.message}`, { domain: "environment" }));
      };
      const onData = (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message?.type !== "ready" || typeof message.baseUrl !== "string") continue;
          const readyUrl = new URL(message.baseUrl);
          this.host = readyUrl.hostname;
          this.port = Number(readyUrl.port);
          cleanup();
          resolve();
          return;
        }
      };
      child.stdout?.on("data", onData);
      child.once("error", onError);
    });
  }

  _track(child, tag) {
    this._children.push(child);
    child.on("exit", (code, signal) => {
      if (!this._stopped && !this._stopPromise) {
        const tail = child._stderrTail ? `\n${child._stderrTail}` : "";
        const error = new BackendError("CHILD_EXITED", `${tag} exited code=${code} signal=${signal}${tail}`, { domain: "environment", remedy: "Check the logs to locate the crash cause, then retry; if it keeps happening, reinstall the app.", retryable: true, details: { code, signal } });
        this._failure = error;
        this.emit("error", error);
        void this.stop();
      }
    });
  }


  _killTree(child) {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null || child.killed) return resolve();
      try {
        if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
        else { process.kill(-child.pid, "SIGTERM"); try { child.kill("SIGKILL"); } catch { /* */ } }
      } catch { /* already dead */ }
      resolve();
    });
  }
}

class BackendError extends Error {
  // domain follows CORE-ARCHITECTURE.md §7.1/7.3: every Backend-startup failure is
  // reported to the renderer as {code, domain, message, remedy, retryable}, never a
  // bare message. "environment" is correct here — a not-yet-started Backend is a
  // missing interpreter/port/disk/permission problem, not a product (workspace/run)
  // error and not a live engine failure.
  constructor(code, msg, opts = {}) {
    super(msg);
    this.code = code;
    this.name = "BackendError";
    this.domain = opts.domain || "environment";
    this.remedy = opts.remedy || "Check the logs for details, then retry; if the problem persists, reinstall the app.";
    this.retryable = opts.retryable !== undefined ? opts.retryable : true;
    if (opts.details) this.details = opts.details;
  }
}

function _existingFile(candidate) {
  if (!candidate || !String(candidate).trim()) return null;
  const resolved = path.resolve(String(candidate));
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : null;
}

function _findUserUv() {
  const fromPath = _which("uv");
  if (fromPath) return fromPath;
  const executable = process.platform === "win32" ? "uv.exe" : "uv";
  const candidates = process.platform === "win32"
    ? [
        path.join(os.homedir(), ".local", "bin", executable),
        path.join(process.env.LOCALAPPDATA || "", "uv", "bin", executable),
      ]
    : [path.join(os.homedir(), ".local", "bin", executable)];
  for (const candidate of candidates) {
    const found = _existingFile(candidate);
    if (found) return found;
  }
  return null;
}

async function _installUvForCurrentUser() {
  if (process.platform !== "win32") {
    throw new BackendError("UV_INSTALL_UNSUPPORTED", "The current installer only supports automatic uv installation on Windows.", { remedy: "Follow the official uv instructions to complete a user-level install, then retry." });
  }
  const powershell = _which("pwsh") || _which("powershell");
  if (!powershell) {
    throw new BackendError("POWERSHELL_MISSING", "Cannot auto-install uv: PowerShell not found.", { remedy: "Install uv manually, then retry." });
  }
  await _runProcess(powershell, [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", "Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression",
  ], { cwd: os.tmpdir(), env: process.env });
}

function _environmentPython(environmentRoot) {
  return process.platform === "win32"
    ? path.join(environmentRoot, "Scripts", "python.exe")
    : path.join(environmentRoot, "bin", "python");
}

function _environmentCommand(environmentRoot, command) {
  return process.platform === "win32"
    ? path.join(environmentRoot, "Scripts", `${command}.exe`)
    : path.join(environmentRoot, "bin", command);
}

function _waitForSpawn(child, tag) {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (cause) => reject(new BackendError("CHILD_START_FAILED", `${tag} failed to start: ${cause.message}`, { domain: "environment", remedy: "Check the backend runtime environment and logs, then retry.", retryable: true })));
  });
}

function _backendFingerprint(backendProjectRoot) {
  const files = ["uv.lock", "pyproject.toml"];
  const hashes = {};
  for (const name of files) {
    const file = path.join(backendProjectRoot, name);
    hashes[name] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return { schemaVersion: 1, ...hashes };
}

function _markerMatches(markerPath, expected) {
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(markerPath, "utf8"))) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function _writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

function _runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assignChildToJob(child);
    let output = "";
    const collect = (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-8000);
      options.onOutput?.(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new BackendError("RUNTIME_SETUP_FAILED", `Runtime setup failed (exit=${code})\n${output.trim()}`, { domain: "environment", remedy: "Check your network, proxy, and disk space, then retry.", retryable: true, details: { code } }));
    });
  });
}

function _stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function _lastNonEmptyLine(value) {
  const lines = String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function _bundledUvPath() {
  const exe = process.platform === "win32" ? "uv.exe" : "uv";
  const resourcesDir = process.resourcesPath || "";
  if (!resourcesDir) return null;
  const p = path.join(resourcesDir, "backend", "runtime", exe);
  return fs.existsSync(p) ? p : null;
}

function _bundledPythonPath() {
  const resourcesDir = process.resourcesPath || "";
  if (!resourcesDir) return null;
  const name = process.platform === "win32" ? "python.exe" : "python3";
  const runtimeDir = path.join(resourcesDir, "backend", "runtime");
  // The shipped cpython lands at runtime/cpython-<tag>/python.exe (a
  // managed-python distribution), matching the directory the release pipeline
  // provisions under .scratch/runtime/. The earlier runtime/python/... probe
  // never matched the real layout, so this resolver silently returned null.
  if (fs.existsSync(runtimeDir)) {
    for (const entry of fs.readdirSync(runtimeDir)) {
      if (!entry.startsWith("cpython-")) continue;
      for (const rel of [name, path.join("bin", name)]) {
        const candidate = path.join(runtimeDir, entry, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

// A venv built by any other interpreter than the bundled one (a dev machine's
// discovery hit, a previous install) carries that interpreter's absolute path
// in pyvenv.cfg. Comparing against the current bundled interpreter is what
// forces a rebuild after the product moves or the shipped runtime changes.
function _venvUsesBundledPython(environmentRoot, bundledPython) {
  if (!bundledPython || !path.isAbsolute(bundledPython)) return true;
  try {
    const cfg = fs.readFileSync(path.join(environmentRoot, "pyvenv.cfg"), "utf8");
    const home = /^home\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim();
    if (!home) return false;
    const normalize = (p) => path.resolve(p).toLowerCase();
    return normalize(home) === normalize(path.dirname(bundledPython));
  } catch {
    return false;
  }
}

function _which(name) {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = path.join(dir, name + e);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  }
  return null;
}

function _isPortAvailable(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => { s.close(() => resolve(true)); });
    s.listen(port, host);
  });
}

function _pipeToConsole(child, tag, logFile) {
  const prefix = `[${tag}] `;
  child._stderrTail = "";
  // Log files go to <backendRoot>/logs/ (packaged GUI has no console)
  let logStream = null;
  const targetLogDir = logDir();
  try { fs.mkdirSync(targetLogDir, { recursive: true }); } catch { /* */ }
  try {
    logStream = fs.createWriteStream(path.join(targetLogDir, logFile || "backend.log"), { flags: "a" });
    logStream.on("error", () => { /* logging must not crash the desktop host */ });
  } catch { /* */ }
  const teeToFile = (text) => {
    if (logStream && !logStream.destroyed && !logStream.writableEnded) {
      try { logStream.write(text, "utf8"); } catch { /* */ }
    }
  };
  child.stdout?.on("data", (d) => {
    const text = prefix + d;
    _safeWrite(process.stdout, text);
    teeToFile(text);
  });
  child.stderr?.on("data", (d) => {
    const text = d.toString();
    child._stderrTail = (child._stderrTail + text).slice(-4000);
    const prefixed = prefix + text;
    _safeWrite(process.stderr, prefixed);
    teeToFile(prefixed);
  });
  // `exit` can fire before stdout/stderr have drained. Closing the file there
  // races the final data event and produced ERR_STREAM_WRITE_AFTER_END during
  // an otherwise clean packaged shutdown. `close` is emitted after stdio ends.
  child.on("close", () => {
    if (logStream && !logStream.destroyed && !logStream.writableEnded) {
      try { logStream.end(); } catch { /* */ }
    }
  });
}

function _findAvailablePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function _safeWrite(stream, val) {
  if (!stream || stream.destroyed || !stream.writable) return;
  try { stream.write(val, (err) => { if (err && err.code !== "EPIPE") throw err; }); }
  catch (err) { if (!err || err.code !== "EPIPE") throw err; }
}

// `_bundledUvPath`/`_bundledPythonPath`/`_which` are exported (additively --
// nothing above changes) so `skill_runtime.cjs` can resolve the same bundled
// uv and interpreter for `uv run --script` skill invocations without a second
// copy of this resolution logic. BackendManager and skill script execution are
// two different processes started under the same rule
// (RUNTIME-PROVISIONING.md §1: "the application never mutates the user's
// machine; it brings its own environment and points at it by absolute path"),
// so they share one source of truth for finding that environment.
module.exports = {
  BackendManager, BackendError, _findAvailablePort, _isPortAvailable,
  _bundledUvPath, _bundledPythonPath, _findUserUv, _which,
};
