"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BackendError, BackendManager, _findAvailablePort, _bundledPythonPath } = require("./backend_manager.cjs");
const fs = require("node:fs");
const { ensureSettingsFile, ensureRuntimeDirectories, resolveRuntimePaths } = require("./runtime_config.cjs");

// ── runtime_config.cjs tests ────────────────────────────────────────────────

test("Desktop settings cannot relocate Backend storage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-settings-"));
  const settingsFile = path.join(root, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ backend_root: "D:\\TDEase" }));

  assert.notEqual(resolveRuntimePaths({ settingsFile }).backendRoot, path.resolve("D:\\TDEase"));
  assert.equal(resolveRuntimePaths({ settingsFile }).systemRoot, root);
});

test("Backend root is independent of relative Desktop settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-relative-settings-"));
  const settingsFile = path.join(root, "config", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ backend_root: "../backend" }));

  assert.notEqual(resolveRuntimePaths({ settingsFile }).backendRoot, path.join(root, "backend"));
});

test("legacy Backend paths are deleted from Desktop settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-legacy-settings-"));
  const settingsFile = path.join(root, "system", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ data_root: "../data" }));
  ensureSettingsFile(settingsFile);
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(settings.data_root, undefined);
  assert.equal(settings.backend_root, undefined);
  assert.equal(settings.schemaVersion, 3);
});

test("legacy System mcp.json migrates into settings.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-mcp-settings-"));
  const settingsFile = path.join(root, "settings.json");
  const legacyFile = path.join(root, "mcp.json");
  fs.writeFileSync(legacyFile, JSON.stringify({ mcpServers: { local: { command: "x" } } }));
  ensureSettingsFile(settingsFile);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).mcp.mcpServers.local.command, "x");
  assert.equal(fs.existsSync(legacyFile), false);
});

test("provider seed initializes only a missing settings file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-provider-seed-"));
  const settingsFile = path.join(root, "settings.json");
  const seedFile = path.join(root, "settings.seed.json");
  fs.writeFileSync(seedFile, JSON.stringify({
    providers: { deepseek: { base_url: "https://seed.test/v1", api_key: "seed-key" } },
  }));

  ensureSettingsFile(settingsFile, seedFile);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).providers.deepseek.api_key, "seed-key");

  fs.writeFileSync(seedFile, JSON.stringify({
    providers: { deepseek: { base_url: "https://changed.test/v1", api_key: "changed-key" } },
  }));
  ensureSettingsFile(settingsFile, seedFile);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).providers.deepseek.api_key, "seed-key");
});

test("ensureRuntimeDirectories creates only Desktop-owned runtime directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-rt-dirs-"));
  const settingsFile = path.join(root, "system", "settings.json");
  const backendRoot = path.join(root, "custom-backend");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({}));

  const result = ensureRuntimeDirectories({ host: "127.0.0.1", port: 9999, settingsFile, backendRoot });
  assert.equal(result.backendRoot, backendRoot);
  assert.equal(result.systemRoot, path.join(root, "system"));
  assert.equal(result.resultCacheRoot, path.join(root, "system", "cache", "results"));
  assert.equal(result.logsRoot, path.join(root, "system", "logs"));
  assert.equal(result.cacheRoot, path.join(backendRoot, "runtime", "cache"));
  assert.equal(fs.existsSync(backendRoot), false);
  for (const directory of ["templates", "skills", "prompts", "reference", "cache/results", "agent", "logs"]) {
    assert.ok(fs.existsSync(path.join(root, "system", directory)), directory);
  }
  assert.equal(fs.existsSync(path.join(root, "system", "prompts", "internal")), false);
});

// ── BackendManager tests ─────────────────────────────────────────────────────

test("BackendManager constructor accepts options", () => {
  const m = new BackendManager({ isDev: true, host: "127.0.0.1", port: 9000 });
  assert.equal(m.isDev, true);
  assert.equal(m.host, "127.0.0.1");
  assert.equal(m.port, 9000);
});

test("BackendManager local development defaults to an OS-assigned port", () => {
  const m = new BackendManager({ isDev: true });
  assert.equal(m.isDev, true);
  assert.equal(m.host, "127.0.0.1");
  assert.equal(m.port, 0);
});

test("packaged BackendManager selects a random loopback port", () => {
  const m = new BackendManager({ isDev: false });
  assert.equal(m.host, "127.0.0.1");
  assert.equal(m.port, 0);
});

test("packaged mode without user uv throws UV_MISSING when auto-install is disabled", async () => {
  const m = new BackendManager({ isDev: false, findUv: () => null, autoInstallUv: false });
  await assert.rejects(
    m._ensureUv(),
    (error) => error instanceof BackendError && error.code === "UV_MISSING",
  );
});

test("packaged mode uses the discovered user uv", async () => {
  const fakeUv = path.join(os.tmpdir(), process.platform === "win32" ? "uv.exe" : "uv");
  fs.writeFileSync(fakeUv, "test");
  const m = new BackendManager({ isDev: false, findUv: () => fakeUv });
  await m._ensureUv();
  assert.equal(m._uvPath, fakeUv);
});

test("packaged mode prefers the bundled uv over the user uv", async () => {
  // Regression guard: _bundledUvPath was once defined but never consulted, so
  // packaged builds ignored the shipped ~64MB runtime and re-downloaded uv.
  const fakeBundled = path.join(os.tmpdir(), process.platform === "win32" ? "tdease-bundled-uv.exe" : "tdease-bundled-uv");
  const fakeUser = path.join(os.tmpdir(), process.platform === "win32" ? "tdease-user-uv.exe" : "tdease-user-uv");
  fs.writeFileSync(fakeBundled, "test");
  fs.writeFileSync(fakeUser, "test");
  const m = new BackendManager({
    isDev: false,
    bundledUv: () => fakeBundled,
    findUv: () => fakeUser,
  });
  await m._ensureUv();
  assert.equal(m._uvPath, fakeBundled);
});

test("packaged mode falls back to user uv when no bundled uv", async () => {
  const fakeUser = path.join(os.tmpdir(), process.platform === "win32" ? "tdease-user-uv2.exe" : "tdease-user-uv2");
  fs.writeFileSync(fakeUser, "test");
  const m = new BackendManager({ isDev: false, bundledUv: () => null, findUv: () => fakeUser });
  await m._ensureUv();
  assert.equal(m._uvPath, fakeUser);
});

test("_resolvePaths finds backend root in dev mode", () => {
  const m = new BackendManager({ isDev: true });
  m._resolvePaths();
  assert.ok(typeof m._backendRoot === "string");
  assert.ok(fs.existsSync(path.join(m._backendRoot, "pyproject.toml")));
});

test("development fixes Backend data to the repository runtime", () => {
  const manager = new BackendManager({ isDev: true });
  manager._resolvePaths();

  assert.equal(
    manager._runtimeDataRoot(),
    path.join(path.dirname(manager._backendRoot), "data", "backend"),
  );
});

test("_runtimeEnv does not inject product configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-env-"));
  const manager = new BackendManager({ isDev: true });
  manager._resolvePaths();
  manager._dataRoot = root;
  // Fake a uv path so PATH check doesn't fail
  manager._uvPath = process.platform === "win32"
    ? "C:\\Users\\fake\\uv.exe"
    : "/usr/local/bin/uv";

  const previous = process.env.TDEASE_UNKNOWN_SECRET;
  process.env.TDEASE_UNKNOWN_SECRET = "must-not-leak";
  const env = manager._runtimeEnv();
  if (previous === undefined) delete process.env.TDEASE_UNKNOWN_SECRET;
  else process.env.TDEASE_UNKNOWN_SECRET = previous;
  assert.equal(env.TDEASE_DATA_ROOT, undefined);
  assert.equal(env.TDEASE_ENV, undefined);
  assert.equal(env.TDEASE_BACKEND_GENERATION, undefined);
  assert.equal(env.TDEASE_SYSTEM_ROOT, undefined);
  assert.equal(env.TDEASE_UNKNOWN_SECRET, undefined);
});

test("Backend config is the single local process input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-config-"));
  const manager = new BackendManager({ isDev: true, host: "127.0.0.2", port: 54321 });
  manager._dataRoot = root;
  manager._configFile = path.join(root, "config.json");
  manager._ensureBackendConfig();
  const config = JSON.parse(fs.readFileSync(manager._configFile, "utf8"));
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(config.server, { host: "127.0.0.2", port: 54321 });
  assert.equal(config.dataRoot, ".");
  assert.equal(config.nodeRoot, path.join("nodes"));
});

test("mistaken sibling node catalog migrates back under Backend data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-node-migrate-"));
  const backend = path.join(root, "backend");
  const legacy = path.join(root, "nodes", "toppic");
  fs.mkdirSync(backend, { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "rules.smk"), "rule all:\n", "utf8");
  const manager = new BackendManager({ isDev: true });
  manager._dataRoot = backend;
  manager._configFile = path.join(backend, "config.json");

  manager._ensureBackendConfig();

  assert.ok(fs.existsSync(path.join(backend, "nodes", "toppic", "rules.smk")));
  assert.equal(fs.existsSync(path.join(root, "nodes")), false);
  const config = JSON.parse(fs.readFileSync(manager._configFile, "utf8"));
  assert.equal(config.nodeRoot, path.join("nodes"));
});

test("BackendManager reaches ready through the public CLI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-manager-e2e-"));
  const manager = new BackendManager({ isDev: true, healthTimeoutMs: 30_000 });
  manager._runtimeDataRoot = () => root;
  try {
    const connection = await manager.start();
    const response = await fetch(`${connection.baseUrl}/ready`);
    assert.equal(response.status, 200);
    // The launch mints the bearer pair: a protected route rejects anonymous
    // callers and accepts the owner token — the whole auth wiring, end to end.
    assert.equal(typeof connection.accessToken, "string");
    assert.ok(connection.accessToken.length > 20);
    assert.equal(typeof connection.agentToken, "string");
    const anonymous = await fetch(`${connection.baseUrl}/api/v2/runs`);
    assert.equal(anonymous.status, 401);
    const authorized = await fetch(`${connection.baseUrl}/api/v2/runs`, {
      headers: { Authorization: `Bearer ${connection.accessToken}` },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await manager.stop();
  }
});

test("development uses the repository virtual environment", async () => {
  const manager = new BackendManager({ isDev: true });
  manager._resolvePaths();
  await manager._ensureBackendEnvironment();
  assert.equal(
    manager._runtimePython,
    path.join(manager._backendRoot, ".venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python"),
  );
  assert.ok(fs.existsSync(manager._runtimePython));
});

test("_runtimeEnv in packaged mode sets UV_PROJECT_ENVIRONMENT and UV_CACHE_DIR", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-pkg-env-"));
  const manager = new BackendManager({ isDev: false });
  // _resolvePaths uses process.resourcesPath — in test env it may be undefined.
  // Stub _backendRoot directly to skip the resolve step.
  manager._backendRoot = path.join(os.tmpdir(), "tdease-fake-backend");
  manager._dataRoot = root;
  manager._uvPath = process.platform === "win32"
    ? "C:\\Program Files\\TDEase\\resources\\backend\\runtime\\uv.exe"
    : "/opt/TDEase/resources/backend/runtime/uv";

  const env = manager._runtimeEnv();
  assert.ok(env.UV_PROJECT_ENVIRONMENT);
  assert.ok(env.UV_PROJECT_ENVIRONMENT.includes("runtime"));
  assert.ok(env.UV_CACHE_DIR);
  assert.ok(env.UV_CACHE_DIR.includes("runtime"));
  assert.equal(env.TDEASE_ENV, undefined);
  assert.equal(env.TDEASE_DATA_ROOT, undefined);
  assert.equal(env.TDEASE_BOOTSTRAP_SECRET, undefined);
});

test("_runtimeEnv in packaged mode points at the bundled cpython when present", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-pkg-bundled-"));
  const manager = new BackendManager({ isDev: false });
  manager._backendRoot = path.join(os.tmpdir(), "tdease-fake-backend");
  manager._dataRoot = root;
  manager._uvPath = process.platform === "win32"
    ? "C:\\Program Files\\TDEase\\resources\\backend\\runtime\\uv.exe"
    : "/opt/TDEase/resources/backend/runtime/uv";
  // In the test host process.resourcesPath is unset, so the bundled resolvers
  // return null and the env vars stay absent — assert that contract directly.
  assert.equal(_bundledPythonPath(), null);
  const env = manager._runtimeEnv();
  // No bundled interpreter in the test host: UV_PYTHON falls back to the pinned
  // 3.12 (the C-extension wheel compatibility pin), never to whatever
  // interpreter the machine happens to have.
  assert.equal(env.UV_PYTHON, "3.12");
  assert.equal(env.UV_FIND_LINKS, undefined);
});

test("BackendError carries code and message", () => {
  const err = new BackendError("TEST_CODE", "test message");
  assert.equal(err.code, "TEST_CODE");
  assert.equal(err.message, "test message");
  assert.equal(err.name, "BackendError");
  assert.ok(err instanceof Error);
});

test("BackendManager.stop is idempotent", async () => {
  const m = new BackendManager({ isDev: true });
  await m.stop();
  await m.stop(); // should not throw
  assert.equal(m._stopped, true);
});

// ── Failure envelope (CORE-ARCHITECTURE.md §7.1/7.3) ─────────────────────────────────────────────────────

test("BackendError defaults to the environment domain with a real remedy", () => {
  const err = new BackendError("SOMETHING_BROKE", "boom");
  assert.equal(err.domain, "environment");
  assert.equal(typeof err.remedy, "string");
  assert.ok(err.remedy.length > 0);
  assert.equal(err.retryable, true);
});

test("BackendError accepts an explicit envelope (domain, remedy, retryable, details)", () => {
  const err = new BackendError("PORT_IN_USE", "port busy", {
    domain: "environment",
    remedy: "Close the other process and retry.",
    retryable: true,
    details: { port: 5001 },
  });
  assert.equal(err.domain, "environment");
  assert.equal(err.remedy, "Close the other process and retry.");
  assert.equal(err.retryable, true);
  assert.deepEqual(err.details, { port: 5001 });
});

test("UV_MISSING failure carries an environment-domain envelope with a remedy", async () => {
  const m = new BackendManager({ isDev: false, findUv: () => null, autoInstallUv: false });
  try {
    await m._ensureUv();
    assert.fail("expected UV_MISSING");
  } catch (err) {
    assert.ok(err instanceof BackendError);
    assert.equal(err.code, "UV_MISSING");
    assert.equal(err.domain, "environment");
    assert.ok(err.remedy && err.remedy.length > 0);
  }
});

// ── M2 gate: two instances starting concurrently must not collide on a port ──

test("concurrent OS-assigned port lookups never collide (M2 gate)", async () => {
  // Simulates N Electron instances launched at the same instant, each asking
  // the OS for a free loopback port before spawning its own Backend child.
  const ports = await Promise.all(
    Array.from({ length: 8 }, () => _findAvailablePort("127.0.0.1")),
  );
  assert.equal(ports.length, 8);
  for (const port of ports) {
    assert.ok(Number.isInteger(port) && port > 0, `expected a real port, got ${port}`);
  }
  assert.equal(new Set(ports).size, ports.length, `expected all ports distinct, got ${JSON.stringify(ports)}`);
});

test("a relocated Python environment that cannot run is detected, not trusted", async () => {
  // Regression guard for a copied install (another machine, another drive): the
  // venv files still exist and the lock marker still matches, but uv's Windows
  // console-script trampolines embed the OLD absolute path. Existence checks
  // would skip the rebuild and then fail to spawn the Backend; the probe runs
  // the exact command, so a broken environment is rebuilt instead.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-env-broken-"));
  const scripts = path.join(root, "Scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "python.exe"), "not an interpreter");
  fs.writeFileSync(path.join(scripts, "tdease-backend.exe"), "not a trampoline");

  const manager = new BackendManager({ isDev: false });
  manager._backendRoot = root;
  manager._runtimeEnv = () => ({});
  manager._backendCommand = path.join(scripts, "tdease-backend.exe");

  assert.equal(await manager._environmentRuns(), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a runnable Python environment passes the probe", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-env-ok-"));
  const manager = new BackendManager({ isDev: false });
  manager._backendRoot = root;
  manager._runtimeEnv = () => ({});
  manager._backendCommand = process.execPath; // `node --help` exits 0

  assert.equal(await manager._environmentRuns(), true);
  fs.rmSync(root, { recursive: true, force: true });
});
