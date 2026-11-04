"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ensureNativeCli, ensurePythonLaunchers, ensureSearchTools, nativeCliBinaryName, pinSearchToolLookup, resolveNativeCliSource, skillRuntimeEnv } = require("./skill_runtime.cjs");

// ── ensureNativeCli: provision the tdeasenexus-toolbox CLI into the managed tools dir ──

test('ensurePythonLaunchers provisions python and python3 through uv', () => {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdease-python-launchers-'));
  try {
    ensurePythonLaunchers({ toolsDir });
    for (const name of ['python', 'python3']) {
      assert.equal(fs.readFileSync(path.join(toolsDir, name), 'utf8'), '#!/bin/sh\nexec uv run --no-project python "$@"\n');
    }
  } finally {
    fs.rmSync(toolsDir, { recursive: true, force: true });
  }
});

test("provisions the CLI binary into toolsDir and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-cli-"));
  const toolsDir = path.join(dir, "tools");
  const source = path.join(dir, "tdeasenexus-toolbox-source");
  fs.writeFileSync(source, "fake-cli-bytes");

  const first = ensureNativeCli({ isDev: true, toolsDir, source });
  const target = path.join(toolsDir, nativeCliBinaryName());
  assert.equal(first, target);
  assert.equal(fs.readFileSync(target, "utf8"), "fake-cli-bytes");

  // Idempotent: a second call returns the same target and leaves the copy intact.
  const second = ensureNativeCli({ isDev: true, toolsDir, source });
  assert.equal(second, target);
  assert.equal(fs.readFileSync(target, "utf8"), "fake-cli-bytes");
});

test("re-provisions when the source is newer (a rebuild)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-cli-rebuild-"));
  const toolsDir = path.join(dir, "tools");
  const source = path.join(dir, "tdeasenexus-toolbox-source");
  fs.writeFileSync(source, "v1");

  ensureNativeCli({ isDev: true, toolsDir, source });
  const target = path.join(toolsDir, nativeCliBinaryName());
  assert.equal(fs.readFileSync(target, "utf8"), "v1");

  fs.writeFileSync(source, "v2-rebuilt");
  ensureNativeCli({ isDev: true, toolsDir, source });
  assert.equal(fs.readFileSync(target, "utf8"), "v2-rebuilt");
});

test("returns null and creates nothing when no source binary exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-cli-missing-"));
  const toolsDir = path.join(dir, "tools");
  assert.equal(ensureNativeCli({ isDev: true, toolsDir, source: null }), null);
  assert.equal(fs.existsSync(toolsDir), false);
});

test("development source resolves to the CLI build output", () => {
  const source = resolveNativeCliSource({ isDev: true });
  assert.equal(source, path.join(__dirname, "..", "..", "tdease-ai-capability", "system", "tools", nativeCliBinaryName()));
});

// ── ensureSearchTools: provision the bundled rg/fd into the managed tools dir ──

test("ensureSearchTools copies rg/fd idempotently and skips missing binaries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-searchtools-"));
  const toolsDir = path.join(dir, "tools");
  const source = path.join(dir, "vendor");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "rg.exe"), "rg-payload");
  // fd absent in the source: skipped without blocking the rg provision.
  const provisioned = ensureSearchTools({ isDev: true, toolsDir, source });
  assert.deepEqual(provisioned, [path.join(toolsDir, "rg.exe")]);
  assert.equal(fs.readFileSync(path.join(toolsDir, "rg.exe"), "utf8"), "rg-payload");
  const before = fs.statSync(path.join(toolsDir, "rg.exe")).mtimeMs;
  ensureSearchTools({ isDev: true, toolsDir, source });
  assert.equal(fs.statSync(path.join(toolsDir, "rg.exe")).mtimeMs, before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pinSearchToolLookup prefixes the managed bin and forbids the network fallback", () => {
  const previousOffline = process.env.PI_OFFLINE;
  const previousPath = process.env.PATH;
  try {
    const toolsDir = path.join(os.tmpdir(), "tdease-pin-bin");
    pinSearchToolLookup({ toolsDir });
    assert.equal(process.env.PI_OFFLINE, "1");
    assert.ok(process.env.PATH.startsWith(`${toolsDir}${path.delimiter}`));
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    process.env.PATH = previousPath;
  }
});

// ── skillRuntimeEnv: minimal sandbox environment ──

test("sandbox env exposes only the read-only System capability", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-env-"));
  const toolsDir = path.join(dir, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(path.join(toolsDir, nativeCliBinaryName()), "x");

  const env = skillRuntimeEnv({
    isDev: true,
    uvPath: null,
    systemAssetsRoot: path.join(dir, "assets"),
    cacheRoot: null,
  });
  assert.equal(env.TDEASE_SYSTEM_ASSETS, path.join(dir, "assets"));
  assert.equal(env.TDEASE_SYSTEM_ROOT, undefined);
  assert.equal(env.TDEASENEXUS_TOOLBOX_BIN, undefined);
  assert.equal(env.TDEASE_ENV, undefined);
  assert.equal(env.USERPROFILE, undefined);
  assert.equal(env.HOME, undefined);
});

test("sandbox env never inherits arbitrary host secrets", () => {
  const previous = process.env.TDEASE_TEST_SECRET;
  try {
    process.env.TDEASE_TEST_SECRET = "must-not-leak";
    const env = skillRuntimeEnv({
      isDev: true,
      uvPath: null,
      systemAssetsRoot: null,
      cacheRoot: null,
    });
    assert.equal(env.TDEASE_TEST_SECRET, undefined);
  } finally {
    if (previous === undefined) delete process.env.TDEASE_TEST_SECRET;
    else process.env.TDEASE_TEST_SECRET = previous;
  }
});
