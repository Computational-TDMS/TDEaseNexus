const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const { managedSpawnOptions, run, terminateChildTree } = require("./electron-dev.cjs");

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true before timeout");
}

test("terminateChildTree waits for a managed parent and its descendant", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-electron-dev-"));
  const marker = path.join(temp, "pids.json");
  const source = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    "fs.writeFileSync(process.argv[1], JSON.stringify({ parent: process.pid, child: child.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const parent = run(process.execPath, ["-e", source, marker], {
    shell: false,
    stdio: "ignore",
  }, { transient: true });

  try {
    await waitUntil(() => fs.existsSync(marker));
    const pids = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(processExists(pids.parent), true);
    assert.equal(processExists(pids.child), true);

    await terminateChildTree(parent);
    await waitUntil(() => !processExists(pids.parent) && !processExists(pids.child));
  } finally {
    if (parent.exitCode === null) await terminateChildTree(parent);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("shutdown does not exit the orchestrator before descendants are gone", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tdease-electron-shutdown-"));
  const marker = path.join(temp, "pids.json");
  const modulePath = path.join(__dirname, "electron-dev.cjs");
  const childSource = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    "fs.writeFileSync(process.argv[1], JSON.stringify({ parent: process.pid, child: child.pid }));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const harnessSource = [
    "const fs = require('node:fs');",
    `const { run, shutdown } = require(${JSON.stringify(modulePath)});`,
    `run(process.execPath, ['-e', ${JSON.stringify(childSource)}, ${JSON.stringify(marker)}], { shell: false, stdio: 'ignore' });`,
    `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(marker)})) { clearInterval(timer); void shutdown(0); } }, 10);`,
  ].join("\n");
  const harness = spawn(process.execPath, ["-e", harnessSource], {
    shell: false,
    stdio: "ignore",
  });

  try {
    assert.equal(await new Promise((resolve) => harness.once("exit", resolve)), 0);
    const pids = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(processExists(pids.parent), false);
    assert.equal(processExists(pids.child), false);
  } finally {
    if (harness.exitCode === null) harness.kill("SIGKILL");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("pnpm commands do not use Node's deprecated shell-args path", async () => {
  const modulePath = path.join(__dirname, "electron-dev.cjs");
  const source = [
    `const { run } = require(${JSON.stringify(modulePath)});`,
    "run('pnpm', ['--version'], {}, { transient: true });",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", source], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
  assert.doesNotMatch(stderr, /DEP0190/);
});

test("managed Windows children stay attached to the orchestrator", () => {
  assert.equal(managedSpawnOptions("win32").detached, false);
  assert.equal(managedSpawnOptions("linux").detached, true);
});

test("Electron main bundle has no top-level cross-spawn runtime dependency", () => {
  const bundle = fs.readFileSync(
    path.join(__dirname, "..", "electron", "dist", "main.bundle.cjs"),
    "utf8",
  );
  assert.doesNotMatch(bundle, /require\(["']cross-spawn["']\)/);
});

test("development orchestrator contains no Backend process ownership", () => {
  const source = fs.readFileSync(path.join(__dirname, "electron-dev.cjs"), "utf8");
  assert.doesNotMatch(source, /uvicorn|run_worker|prepareBackend|TDEASE_MANAGE_BACKEND/);
});
