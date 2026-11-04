/** Shared bundled uv, PEP 723 environment, and native CLI provisioning. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { _findUserUv, _bundledUvPath, _bundledPythonPath } = require("./backend_manager.cjs");

/** Platform binary name for the `tdeasenexus-toolbox` CLI. */
function nativeCliBinaryName() {
  return process.platform === "win32" ? "tdeasenexus-toolbox.exe" : "tdeasenexus-toolbox";
}

/**
 * Full-file SHA-256, sync. Only reached on the "same size, newer source mtime"
 * path below — at most once per launch per file (37MB hashes in ~100ms).
 */
function fileSha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The copy gate shared by ensureNativeCli/ensureSearchTools. A missing or
 * size-differing target always (re)copies. The subtle case is a rebuild that
 * leaves the size unchanged: a pure mtime gate re-copied the 37.6MB CLI on
 * EVERY launch after every rebuild. So when only the mtime is newer, compare
 * content once and copy on a real difference; an older-or-equal source mtime
 * (the steady state after any copy — copyFileSync does not preserve mtime)
 * never copies.
 */
function sourceDiffersFromTarget(source, target, sourceStat, targetStat) {
  if (sourceStat.size !== targetStat.size) return true;
  if (sourceStat.mtimeMs <= targetStat.mtimeMs) return false;
  return fileSha256(source) !== fileSha256(target);
}

/**
 * Resolve the source `tdeasenexus-toolbox` binary (the file we provision the managed
 * tools dir from). Packaged: `resources/native/` (electron-builder extraResources
 * `system/tools -> native`). Dev: the `build:native:cli` output
 * `<repo>/tdease-ai-capability/system/tools/`. Returns an absolute file path, or `null` when no source
 * exists yet (dev may not have built the CLI).
 */
function resolveNativeCliSource({ isDev }) {
  const name = nativeCliBinaryName();
  const candidates = [];
  if (isDev) {
    // Runtime code is bundled to electron/dist, while a direct CJS test runs
    // from electron/. Both resolve the canonical system toolchain artifact.
    candidates.push(path.join(__dirname, "..", "..", "..", "tdease-ai-capability", "system", "tools", name));
    candidates.push(path.join(__dirname, "..", "..", "tdease-ai-capability", "system", "tools", name));
  } else {
    candidates.push(path.join(process.resourcesPath, "native", name));
  }
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    if (fs.statSync(candidate).isDirectory()) return path.join(candidate, name);
    return candidate;
  }
  return null;
}

/**
 * Provision the `tdeasenexus-toolbox` CLI into `toolsDir` — the managed bin dir the bash
 * sandbox PATH prefixes (`managedBinDir`, D16). Idempotent: copies only when the
 * target is missing, differs in size, or (same size, newer mtime — i.e. a
 * rebuild) differs by content hash, so a real rebuild re-provisions on next
 * startup while a rebuilt-but-identical binary is not re-copied at all.
 * Returns the provisioned binary path, or
 * `null` when no source binary exists (the CLI is optional for the rest of the
 * runtime; a dev tree without `build:native:cli` must not block startup).
 *
 * `source` is a test seam: when passed it overrides source resolution, so a test
 * can point at a fake binary or force the no-source path (`null`). Production
 * callers omit it.
 */
function ensureNativeCli({ isDev, toolsDir, source = undefined }) {
  const resolved = source === undefined ? resolveNativeCliSource({ isDev }) : source;
  if (!resolved) return null;
  const name = nativeCliBinaryName();
  fs.mkdirSync(toolsDir, { recursive: true });
  const target = path.join(toolsDir, name);
  let needsCopy = true;
  try {
    const sourceStat = fs.statSync(resolved);
    const targetStat = fs.statSync(target);
    needsCopy = sourceDiffersFromTarget(resolved, target, sourceStat, targetStat);
  } catch {
    // Missing or unreadable target (or a race) → copy.
  }
  if (needsCopy) fs.copyFileSync(resolved, target);
  return target;
}

/**
 * Resolve the bundled rg/fd source directory. Packaged:
 * `resources/vendor/search-tools/` (electron-builder extraResources
 * `.scratch/vendor/search-tools -> vendor/search-tools`). Dev: the
 * `fetch:search-tools` output at the repo-root `.scratch/`. Returns the
 * directory, or `null` when nothing was fetched yet (dev without the script
 * falls back to a PATH rg/fd; PI_OFFLINE keeps that failure loud instead of a
 * hidden GitHub download).
 */
function resolveSearchToolsSource({ isDev }) {
  if (!isDev) {
    const packaged = path.join(process.resourcesPath, "vendor", "search-tools");
    return fs.existsSync(packaged) ? packaged : null;
  }
  // Same two layouts as resolveNativeCliSource: bundled electron/dist and a
  // direct CJS test from electron/, both walking to the repo root.
  for (const candidate of [
    path.join(__dirname, "..", "..", "..", ".scratch", "vendor", "search-tools"),
    path.join(__dirname, "..", "..", ".scratch", "vendor", "search-tools"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Provision the bundled rg/fd into `toolsDir` (managedBinDir, D16). The bash
 * sandbox PATH prefix exposes the short names `rg`/`fd`, and the main-process
 * PATH prefix (main.ts / agent-harness-cli.ts) points Pi's grep/find
 * `ensureTool` at the same copies so neither ever downloads from GitHub at
 * runtime. Idempotent content-aware copy — the same gate as ensureNativeCli
 * (see sourceDiffersFromTarget); a missing source or binary skips that tool
 * without blocking startup.
 * `source` is a test seam. Returns the provisioned paths (possibly empty).
 */
function ensureSearchTools({ isDev, toolsDir, source = undefined }) {
  const resolved = source === undefined ? resolveSearchToolsSource({ isDev }) : source;
  if (!resolved) return [];
  const provisioned = [];
  for (const name of ["rg", "fd"]) {
    const fileName = process.platform === "win32" ? `${name}.exe` : name;
    const from = path.join(resolved, fileName);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(toolsDir, { recursive: true });
    const target = path.join(toolsDir, fileName);
    let needsCopy = true;
    try {
      const sourceStat = fs.statSync(from);
      const targetStat = fs.statSync(target);
      needsCopy = sourceDiffersFromTarget(from, target, sourceStat, targetStat);
    } catch {
      // Missing or unreadable target (or a race) → copy.
    }
    if (needsCopy) fs.copyFileSync(from, target);
    provisioned.push(target);
  }
  return provisioned;
}

/**
 * The bundled Git-for-Windows dirs the bash sandbox PATH prefixes (packaged).
 * A clean target machine has no Git: bash itself (pty-bash-backend resolves
 * it from here), its coreutils (ls/grep/sed/awk/...) and the msys runtime all
 * live under `resources/vendor/git`; nothing outside the install may be
 * needed to run a sandbox command. Returns `[]` when there is no bundled
 * vendor tree (dev mode, or a damaged package) so callers degrade to the
 * machine's own Git exactly as before.
 */
function resolveVendorGitDirs() {
  if (process.platform !== "win32" || !process.resourcesPath) return [];
  const root = path.join(process.resourcesPath, "vendor", "git");
  if (!fs.existsSync(path.join(root, "usr", "bin", "bash.exe"))) return [];
  const dirs = [];
  for (const rel of ["bin", "usr/bin"]) {
    const dir = path.join(root, rel);
    if (fs.existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Pin how the runtime resolves rg/fd: prefix the managed tools dir onto the
 * main-process PATH — the only lookup seam Pi's grep/find `ensureTool` reads
 * besides `~/.pi/agent/bin` (user-global state we never write) — and forbid
 * the SDK's runtime GitHub-download fallback via PI_OFFLINE, so a missing
 * binary fails fast with a clear error instead of a hidden network hang.
 * Unconditional policy: call once at startup even when nothing was
 * provisioned (dev then falls back to a PATH rg/fd).
 * `extraDirs` (packaged: the bundled vendor-git bin dirs) lets the same pin
 * also satisfy Pi's own `bash.exe` PATH fallback on a Git-less machine.
 * @param {{ toolsDir: string, extraDirs?: string[] }} options
 */
function pinSearchToolLookup({ toolsDir, extraDirs = [] }) {
  process.env.PI_OFFLINE = "1";
  process.env.PATH = [toolsDir, ...extraDirs, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
}

/**
 * Provision stable Python command names for Agent bash. Python is owned by uv;
 * these launchers only normalize the common `python` / `python3` spellings to
 * the same runtime instead of depending on the host PATH.
 */
function ensurePythonLaunchers({ toolsDir }) {
  fs.mkdirSync(toolsDir, { recursive: true });
  const script = '#!/bin/sh\nexec uv run --no-project python "$@"\n';
  for (const name of ['python', 'python3']) {
    const target = path.join(toolsDir, name);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== script) {
      fs.writeFileSync(target, script, 'utf8');
    }
    try { fs.chmodSync(target, 0o755); } catch { /* Git Bash reads the shebang on Windows. */ }
  }
}

/**
 * Resolve the `uv` binary used to run skill scripts.
 *
 * Packaged builds prefer the bundled uv (resources/backend/runtime/uv.exe) so
 * skill scripts invoke the *same* executable the Backend venv was built with —
 * one source of truth, no second network install. Falls back to the user-level
 * uv on PATH (dev mode, or a damaged bundle) before failing.
 */
function resolveUv(isDev) {
  if (!isDev) {
    const bundled = _bundledUvPath();
    if (bundled) return bundled;
  }
  const uvPath = _findUserUv();
  if (uvPath) return uvPath;
  const error = new Error(
    isDev
      ? "No uv runtime found for skill scripts. Install uv and retry."
      : "The bundled uv runtime is missing and no user-level uv was found. Reinstall TDEase, then retry.",
  );
  error.code = "UV_MISSING";
  throw error;
}

/**
 * The environment `uv run --script` sees. Distinct from
 * `BackendManager._runtimeEnv()`: a skill script is a one-shot PEP 723
 * invocation (`uv run --script`), not the backend's persistent project venv,
 * so `UV_PROJECT_ENVIRONMENT` is not part of this, and its `UV_CACHE_DIR` is
 * the System-side cache (`runtimePaths.systemCacheRoot`), not the Backend's.
 * Both sides share the same uv executable, bundled python and wheelhouse, but
 * each keeps its own environment store — one per side.
 *
 * `systemAssetsRoot` is the read-only product assets root (skills/, prompts/).
 * The plain `bash` builtin reuses this same env so a Skill script is reached
 * as `"$TDEASE_SYSTEM_ASSETS/skills/<skill>/scripts/..."` and the bundled uv
 * resolves regardless of the host PATH.
 *
 * No Workspace root is injected: a skill script's cwd *is* the Workspace root
 * (main.ts sets it), so a Workspace-relative path like
 * `runs/<run>/analysis/<slug>/` resolves directly. Exposing an absolute root in
 * the env would invite the model to touch absolute paths, which the tool policy
 * forbids (analysis_layout.md).
 */
function skillRuntimeEnv({ isDev, uvPath, systemAssetsRoot, cacheRoot }) {
  const binDir = uvPath ? path.dirname(uvPath) : "";
  const systemPath = process.platform === "win32"
    ? [
        process.env.SystemRoot && path.join(process.env.SystemRoot, "System32"),
        process.env.SystemRoot,
      ].filter(Boolean).join(path.delimiter)
    : "/usr/local/bin:/usr/bin:/bin";
  const env = {
    PATH: [binDir, ...resolveVendorGitDirs(), systemPath].filter(Boolean).join(path.delimiter),
    // A skill script imports its sibling modules from the read-only product
    // assets root; __pycache__ must never land there (and cannot, on a
    // read-only mount). The cache buys little next to uv resolution, so the
    // sandbox runs Python with bytecode writing off — the same rule the
    // packaged backend applies in BackendManager._runtimeEnv().
    PYTHONDONTWRITEBYTECODE: "1",
  };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  if (systemAssetsRoot) env.TDEASE_SYSTEM_ASSETS = systemAssetsRoot;
  if (!isDev) {
    if (!cacheRoot) throw new Error("cacheRoot is required in packaged mode");
    env.UV_CACHE_DIR = cacheRoot;
    // The AI side is a normal uv: skill dependencies resolve from the network
    // straight away (the product decision — only the SMK side is sealed
    // offline). Missing deps land in the data-side cache and never touch the
    // machine.
    // UV_PYTHON still pins the bundled interpreter: a discovery hit could be
    // the WindowsApps stub that triggers the Python install manager.
    env.UV_PYTHON = _bundledPythonPath() || "3.12";
  }
  return env;
}

module.exports = { ensureNativeCli, ensurePythonLaunchers, ensureSearchTools, nativeCliBinaryName, pinSearchToolLookup, resolveNativeCliSource, resolveUv, resolveVendorGitDirs, skillRuntimeEnv };
