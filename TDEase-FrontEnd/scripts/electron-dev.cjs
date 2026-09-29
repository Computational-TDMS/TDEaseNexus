// electron-dev.cjs — dev orchestrator: Vite + atomic Electron generations.
//
// Usage: pnpm run desktop:dev
// 1. Builds electron/dist/main.bundle.cjs once (so Electron can boot immediately)
// 2. Starts `vite` (fixed port 1420, see vite.config.ts), waits for it
// 3. Watches Electron/Pi sources
// 4. On a change: stops Electron, builds the complete main/Pi/preload set, then
//    starts a new Electron process. A running main process never observes a Pi
//    bundle from another build generation.

const { spawn } = require("node:child_process");
const path = require("node:path");

// Host must match vite.config.ts (devBindHost). Read the same env so the two
// never drift — that mismatch is what made waitForServer hang on Windows.
const DEV_HOST = process.env.TDEASE_FRONTEND_HOST || "127.0.0.1";
const DEV_URL = process.env.TDEASE_ELECTRON_DEV_URL || `http://${DEV_HOST}:1420`;
const root = path.resolve(__dirname, "..");

function log(msg) {
  process.stdout.write(`[electron-dev] ${msg}\n`);
}

const managedChildren = new Set();
const intentionallyStopping = new WeakSet();

function waitForExit(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function taskkillTree(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    killer.once("error", () => resolve(false));
    killer.once("exit", (code) => resolve(code === 0 || code === 128));
  });
}

function managedSpawnOptions(platform = process.platform) {
  return {
    // Unix cleanup addresses the child process group with a negative PID.
    // Windows cleanup uses taskkill /T, so detaching only makes children more
    // likely to outlive an abruptly terminated orchestrator.
    detached: platform !== "win32",
    windowsHide: true,
  };
}

async function terminateChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await taskkillTree(child.pid);
    if (!(await waitForExit(child))) {
      throw new Error(`process tree ${child.pid} did not stop after taskkill`);
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch { /* already dead */ }
  if (await waitForExit(child, 5_000)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch { /* already dead */ }
  if (!(await waitForExit(child, 5_000))) {
    throw new Error(`process group ${child.pid} did not stop after SIGKILL`);
  }
}

function run(cmd, args, opts = {}, { transient = false } = {}) {
  const useCmdShim = process.platform === "win32" && cmd === "pnpm";
  const executable = useCmdShim ? (process.env.ComSpec || "cmd.exe") : cmd;
  const spawnArgs = useCmdShim ? ["/d", "/s", "/c", cmd, ...args] : args;
  const child = spawn(executable, spawnArgs, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...managedSpawnOptions(),
    ...opts,
  });
  managedChildren.add(child);
  child.on("error", (err) => {
    managedChildren.delete(child);
    log(`${cmd} failed to start: ${err.message}`);
    if (!transient && !shuttingDown) void shutdown(1);
  });
  child.on("exit", (code) => {
    managedChildren.delete(child);
    log(`${cmd} ${args.join(" ")} exited code=${code ?? 0}`);
    if (intentionallyStopping.has(child)) {
      intentionallyStopping.delete(child);
      return;
    }
    // Only long-lived children (vite / electron / watcher) own the orchestrator's
    // lifecycle — if they die, we shut down. One-shot children (buildMainOnce)
    // are awaited by their caller and must NOT tear down the whole process.
    if (!transient && !shuttingDown) void shutdown(code ?? 0);
  });
  return child;
}

let shuttingDown = false;
let vite = null;
let electron = null;
let sourceWatcher = null;
let shutdownPromise = null;
let restartTimer = null;
let restartPromise = null;
let restartRequested = false;

function shutdown(code = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    if (sourceWatcher) await sourceWatcher.close().catch(() => undefined);
    sourceWatcher = null;
    const children = [...managedChildren].reverse();
    if (children.length > 0) log(`stopping ${children.length} managed process tree(s)…`);
    const results = await Promise.allSettled(children.map(terminateChildTree));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      for (const failure of failures) log(`process cleanup failed: ${failure.reason}`);
      code = 1;
    } else {
      log("managed processes stopped");
    }
    process.exit(code);
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("SIGHUP", () => void shutdown(0));

async function waitForServer(url, timeoutMs = 60_000, method = "HEAD") {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(url, { method });
      if (res.ok || res.status === 404) {
        log(`vite ready at ${url} (after ${attempt} probe(s))`);
        return;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.code || err?.message || String(err);
    }
    // Surface progress every ~5s so the wait is no longer silent.
    if (attempt % 10 === 0) {
      log(`waiting for vite at ${url} (${attempt} probes; last=${lastErr})`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Timed out waiting for vite dev server at ${url} (last error: ${lastErr}). ` +
    `Hint: set TDEASE_FRONTEND_HOST or check 'netstat -ano | findstr :1420'.`
  );
}

async function isServerReady(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function buildMainOnce() {
  // One complete generation: main, Pi runtime, and preload all finish before
  // Electron is allowed to start.
  await new Promise((resolve, reject) => {
    const child = run("pnpm", ["run", "build:main"], {}, { transient: true });
    child.once("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("build:main failed"))));
  });
}

function spawnElectron() {
  const electronBin = require("electron");
  log("spawning electron…");
  electron = run(electronBin, ["."], {
    env: {
      ...process.env,
      TDEASE_ELECTRON_DEV_URL: DEV_URL,
    },
    shell: false,
  });
}

async function restartElectronGeneration(reason) {
  restartRequested = true;
  if (restartPromise) return restartPromise;
  restartPromise = (async () => {
    while (restartRequested && !shuttingDown) {
      restartRequested = false;
      log(`starting new Electron generation (${reason})…`);
      if (electron && electron.exitCode === null && electron.signalCode === null) {
        intentionallyStopping.add(electron);
        await terminateChildTree(electron);
      }
      electron = null;
      await buildMainOnce();
      if (!shuttingDown) spawnElectron();
    }
  })().finally(() => { restartPromise = null; });
  return restartPromise;
}

function scheduleElectronRestart(changedPath) {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartElectronGeneration(changedPath).catch((error) => {
      console.error("[electron-dev] generation rebuild failed:", error);
      void shutdown(1);
    });
  }, 150);
}

async function watchElectronSources() {
  const { watch } = await import("chokidar");
  sourceWatcher = watch([
    "electron/**/*.{ts,cjs,mjs,mts}",
    "src/ai/**/*.{ts,mts}",
    "src/contracts/agent-runtime.ts",
    "src/studio/domain/workspace-snapshot-policy.ts",
  ], {
    cwd: root,
    ignoreInitial: true,
    ignored: ["electron/dist/**"],
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
  });
  sourceWatcher.on("all", (_event, changedPath) => scheduleElectronRestart(changedPath));
  sourceWatcher.on("error", (error) => {
    console.error("[electron-dev] source watcher failed:", error);
    void shutdown(1);
  });
  log("watching Electron/Pi sources; rebuilds restart Electron atomically");
}

async function main() {
  log(`steps: build:main → vite → watch → electron (DEV_URL=${DEV_URL})`);
  await buildMainOnce();

  if (await isServerReady(DEV_URL)) {
    log(`reusing existing vite at ${DEV_URL}`);
  } else {
    log("starting vite (pnpm run dev)…");
    vite = run("pnpm", ["run", "dev"]);
  }
  await waitForServer(DEV_URL);

  await watchElectronSources();
  spawnElectron();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[electron-dev]", err);
    void shutdown(1);
  });
}

module.exports = {
  managedSpawnOptions, run, shutdown, terminateChildTree,
  restartElectronGeneration, scheduleElectronRestart,
};
