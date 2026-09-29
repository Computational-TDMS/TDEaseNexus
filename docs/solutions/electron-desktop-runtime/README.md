# Electron Desktop Runtime, Packaging, and Crash Diagnostics Solution

> Status: Long-term troubleshooting and acceptance manual. Last verified: 2026-07-28.
>
> This document does not create new product architecture. Directory layout and ownership
> are solely governed by [`docs/spec/FILE-LAYOUT.md`](../../spec/FILE-LAYOUT.md);
> Desktop/Server transport semantics live in FILE-LAYOUT §6 (that optimization contract is
> self-contained and no longer points to a separate deployment document).
> This document only unifies run shapes, configuration resolution, Electron process
> management, logging, and reproduction routes.

## 1. Conclusions

TDEase has exactly two product deployment semantics:

```text
Desktop: Electron Client -> locally managed Backend
Server:  Client          -> remote Backend
```

Development, testing, packaging, and smoke tests produce seven **run shapes**, but must not
produce seven sets of business logic. All shapes must reuse the same Client/Backend public
protocol, the same Run semantics, and the same root-directory resolver.

The root cause exposed by this incident is not "Electron hot reload is bad", but that the
following boundaries were once conflated:

- The development orchestrator wrongly took over Backend and Worker lifecycle;
- API reload, the stable Worker, Electron, and Vite had no clear parent-child
  relationship;
- Windows `shell:true + args` spawned an extra Shell and triggered Node `DEP0190`;
- Backend port, `/ready`, and the Electron window-open condition were coupled, so when the
  Backend was offline the Client could not open either;
- The Electron main process had no persistent logs, so a silent exit of the release build
  left no evidence;
- Backend log streams closed too early on child-process `exit`, and tail writes triggered
  `ERR_STREAM_WRITE_AFTER_END`;
- Configuration and paths were derived simultaneously from environment variables,
  `settings.json`, repo detection, `userData`, and `resourcesPath`, without a unified
  matrix.

Core principles after the fix:

1. Development mode never auto-starts or waits for the Backend.
2. Released Desktop silently manages the API and the standalone Worker.
3. All Windows child processes use `shell:false`; background child processes use
   `windowsHide:true`.
4. Backend readiness, main-window load, Worker liveness, and Run success are four distinct
   acceptance stages.
5. Release failures must be written to retrievable persistent logs; do not rely on
   invisible stdout/stderr.
6. Closing the app must reclaim the full process tree and prove via process queries that
   there are no survivors.

## 2. The seven run shapes

These names are used for configuration, testing, and support communication. They are not
new business modes.

| # | Run shape | Client | Backend/Worker responsibility | Writable data roots | Ports and logs |
|---|---|---|---|---|---|
| 1 | Backend development | None, or any public Client | Developer explicitly starts the API and Worker | Default repo `data/backend`; tests should set `TDEASE_DATA_ROOT` explicitly | Developer-chosen port; console/Backend logs |
| 2 | Server production | Remote Client | The service deployment system manages the API and one global serial Worker | Ops-configured Backend private root | Fixed service endpoint; service logs |
| 3 | Browser frontend development | Vite browser page | Does not manage the Backend; only connects to an explicit URL | Browser storage; no full Desktop file bridge | Vite default `1420` or test port |
| 4 | Electron development | Vite + Electron main/preload | **Does not manage or wait for the Backend**; only probes and connects to an external Backend | Electron `userData` + user Workspace; the development Backend usually uses repo `data/` | Vite `1420`; Backend default `8000`; development console visible |
| 5 | Electron E2E | Playwright launches the real Electron bundle | The test harness explicitly manages Vite and the Backend; Electron itself still does not manage the Backend | Per-test isolated temporary `user-data-dir` and Backend data root | Fixed isolated ports; traces, screenshots, test logs |
| 6 | Packaged Desktop | `TDEase.exe` | Electron `BackendManager` silently starts a random-port API, then starts the standalone Worker | System defaults to `<userData>/system`; Backend defaults to `<userData>/backend`, overridable via `backend_root` | Random loopback; `backend/logs/` |
| 7 | Packaged black-box acceptance | Playwright drives the real packaged exe | Identical to run shape 6; the test only observes and does not replace managed logic | Isolated temporary `--user-data-dir` | Confirm the random port from logs/public interfaces; check survivors after exit |

### 2.1 Forbidden combinations

- `desktop:dev` starting Uvicorn or `src.services.run_worker`.
- Electron development refusing to create a window because `/ready` is unreachable.
- Packaged Desktop using the fixed port `8000`.
- Packaged Desktop using `shell:true`, visible PowerShell/cmd windows, or a user terminal
  to host the Worker.
- E2E reusing the user's real `userData`, Workspace, database, or credentials.
- Server replacing the upload/sync protocol with Backend private paths.
- Using `app.isPackaged` alone to decide the current packaging shape. Under the current
  unpacked/asar combination it cannot express whether Backend resources exist; the code
  uses `resources/backend/pyproject.toml` as the packaging-capability signal.

## 3. The single configuration and path model

### 3.1 Three root-directory classes

```text
resourcesPath/                    read-only installer resources
  backend/                        Backend sources, lock, Nodes
  app/assets/                     product default System assets

<Electron userData>/system/       writable Client System
  settings.json
  workspaces.json
  templates/ skills/              user extensions; product assets are not copied
  cache/results/ agent/

<backendRoot>/                    Backend private runtime state
  nodes/ database/ logs/ store/ runs/ trash/ runtime/

user-selected workspace/          user source of truth
  .tdease/ runs/
```

`resourcesPath` is always read-only. venv, cache, database, logs, execution directories,
and user settings must not be written into the install directory.
The Backend private root can never become a Workspace identity.

### 3.2 Current resolution priority

The effective rules of the current `electron/runtime_config.cjs` are:

```text
systemRoot = TDEASE_SYSTEM_ROOT ?? <Electron userData>/system
settings   = systemRoot/settings.json
backendRoot = TDEASE_DATA_ROOT
  ?? settings.json:backend_root
  ?? <repo>/data/backend (development)
  ?? <Electron userData>/backend (release)
```

`TDEASE_DATA_ROOT` denotes the Backend private root itself, no longer a mixed
Client/Backend master root. A relative `backend_root` must be resolved against the System
`settings.json`. The legacy `<userData>/settings.json:data_root` and `system/mcp.json` are
migrated once at startup, after which the old sources of truth are deleted.

### 3.3 Scattered paths that must converge

`electron/runtime_config.cjs` is the single composition root for writable paths. The main
process resolves it once at startup and injects its immutable result:

```ts
type RuntimePaths = {
  settingsFile: string
  systemRoot: string
  backendRoot: string
  workspaceDefaultRoot: string
  toolsRoot: string
  logsRoot: string
  databaseFile: string
  runtimeRoot: string
  cacheRoot: string
}
```

Constraints already enforced:

- Resolve once at main-process startup, then inject into BackendManager, the Skill
  runtime, and IPC handlers.
- During request handling, mode environment variables must not be re-read and paths must
  not be re-guessed.
- Environment variables are only for deployment/test overrides; persistent user
  configuration only enters `settings.json`.
- Client Workspace paths can only come from user selection and the Workspace registry,
  not from reverse-deriving `workspaceRoot()` defaults.
- Before adding a writable directory, decide whether its owner is System, Workspace, or
  Backend; there is no fourth junk-root class.
- Product System assets are read-only; user System extensions are writable; on directory
  merges, same-name identity fails rather than overwrites.
- The Backend receives no `TDEASE_SYSTEM_ROOT` and provides no template API.
- Workspace MCP configuration belongs to `.tdease/settings.json:mcp`; Session events are
  written only to `.tdease/sessions/<id>/events.jsonl`.

## 4. Process ownership

### 4.1 Electron development

```text
electron-dev.cjs
  -> build:main (one-shot)
  -> Vite
  -> esbuild watch
  -> Electron

external terminal/service
  -> Backend API
  -> Worker (if a standalone Worker is used)
```

`electron-dev.cjs` may probe the Backend non-blockingly to print connection hints, but the
Backend being offline must not block Vite/Electron startup. Stopping `desktop:dev`
reclaims only the Vite, watcher, and Electron processes it created itself.

### 4.2 Packaged Desktop

```text
TDEase.exe
  -> BackendManager
       -> Python API, random loopback port
       -> Python Worker, TDEASE_EMBEDDED_WORKER=0
```

API and Worker share `TDEASE_BACKEND_GENERATION` and the same Backend data root. A
Backend deployment executes at most one Run at a time; different Runs do not run in
parallel. On normal Electron exit or a main-process fatal error, `BackendManager.stop()`
must be called to reclaim the entire child-process tree.

Windows spawn rules:

```js
spawn(executable, args, {
  shell: false,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
})
```

Explicitly invoking `cmd.exe /d /s /c` is only allowed when calling a `.cmd` shim; the
argument array is still constructed programmatically and must not concatenate user input.
Do not use `shell:true + args`.

### 4.3 Log-stream closing rules

Child-process `exit` fires before stdout/stderr fully drain. Log streams must end after
the child's `close`, checking `destroyed` and `writableEnded`. Otherwise even a normal
exit can produce `ERR_STREAM_WRITE_AFTER_END`, which in a GUI release manifests as an
unprompted main-process exception.

## 5. Persistent diagnostics

Release log directory:

```text
<backendRoot>/logs/
  electron-main.log
  electron-main.log.1
  electron-main.log.2
  backend.log
  crash-dumps/
```

`electron-main.log` records:

- main start, `app.ready`, `before-quit`, exit code;
- `uncaughtException`, `unhandledRejection`;
- `render-process-gone`, `child-process-gone`;
- Renderer uncaught error/rejection;
- Backend start and stop failures.

Requirements:

- Crash paths append synchronously; do not depend on async loggers that have not flushed;
- 5 MB per file, two rotated copies kept;
- Do not proxy all console output; do not log prompts, file contents, or ordinary
  interactions;
- tokens, API keys, Authorization headers, and secrets must be redacted;
- Chromium's `ResizeObserver loop completed with undelivered notifications` is non-fatal
  noise and must not enter crash logs;
- "Open logs" in the Splash and Settings views uniformly opens this directory.

## 6. Fastest troubleshooting route

Collect evidence by stage; do not jump straight into local edits wherever the error file
points.

### 6.1 Step 1: confirm who owns the process

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -in @('TDEase.exe', 'electron.exe', 'python.exe', 'node.exe')
  } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
```

Judgments:

- a development Backend must be in the developer/test-harness subtree, not Electron's;
- the packaged API/Worker must belong to the released Electron lifecycle;
- two `python.exe` entries may be the venv launcher and the actual interpreter, which does
  not mean two Backends; judge by command-line role and port;
- query again after exit; survivors must be 0.

### 6.2 Step 2: confirm the port instead of guessing it

Development can check fixed URLs. Packaged uses a random port that must be obtained from
managed connection info, a stable port file, or log evidence — never assumed to be `8000`.

```powershell
Invoke-WebRequest http://127.0.0.1:<port>/ready -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:<port>/api/capabilities -UseBasicParsing
```

`ECONNREFUSED` only means the target host/port was not accepting connections at that
moment. It proves neither that Python failed to start nor that the Worker died. Keep
checking actual PIDs, bound ports, and the log timeline.

### 6.3 Step 3: separate the five stages

```text
configuration resolvable
  -> Backend process spawned
  -> /ready 200
  -> Worker process spawned
  -> main window loaded
  -> a real Run produces events, terminal state, and declared outputs
```

An earlier stage must never be reported as the success of a later stage.

### 6.4 Step 4: run the narrow tests first

```powershell
cd TDEase-FrontEnd
node --test electron/crash_logger.test.cjs electron/backend_manager.test.cjs scripts/electron-dev.test.cjs
pnpm run typecheck:electron
node --check electron/preload.cjs
```

Only then run the full release build:

```powershell
pnpm run desktop:build
```

### 6.5 Step 5: real-package black-box acceptance

Use `release/win-unpacked/TDEase.exe` and provide isolated:

```text
--user-data-dir=<temporary isolated root>
TDEASE_E2E=1
```

The acceptance must observe:

1. Splash appears and is eventually replaced by the main window;
2. The main-window URL points at the packaged `dist/index.html`;
3. Random-port `/ready` returns 200;
4. Both API and Worker roles are present in the process table;
5. `electron-main.log` and `backend.log` have been created;
6. After a normal shutdown the logs contain `before-quit` and `exit code=0`;
7. API, Worker, and Electron survivors are 0;
8. The new log segment from this launch has no `ERROR`.

If the change involves real execution, you must additionally submit a tiny Run and observe
real child processes, the event scope, terminal states, and declared outputs. Verifying
only `/ready` is not verifying Run success.

## 7. Verification record for this round

Actually verified on 2026-07-28:

- The development-orchestration tests confirm the Backend is neither started nor waited
  on;
- Windows no longer goes through Node `shell:true + args`; no `DEP0190`;
- BackendManager targeted tests pass;
- Electron TypeScript checks pass;
- `desktop:build` fully succeeds and produces `release/win-unpacked/TDEase.exe`;
- the real release package loads the main window;
- random-port `/ready` returns 200;
- the process table shows the API and the standalone Worker;
- after a normal exit the relevant processes are 0;
- after fixing the log-stream race, the new-launch log segment has no `ERROR`.
- In the isolated release profile, only the three product roots — writable `system/`,
  `backend/`, and the default `workspace/` — appear;
- `system/templates` and `system/skills` remain empty directories, proving product assets
  did not copy over or overwrite user directories;
- the Backend OpenAPI no longer contains any template routes, and the Backend process
  environment no longer receives the Client System root;
- junction/symlink escape and product/user System asset collision all have fail-closed
  tests;
- the release smoke's main window, preload bridge, random-port `/ready`, and capabilities
  all succeed; after exit, API, Worker, and Electron survivors are 0 and
  `electron-main.log` has no `ERROR`.

First launch on a fresh isolated data root takes about 119 seconds; warm start about 3
seconds. The first-launch cost comes from materializing the Python environment at runtime,
not from an Electron window or an API deadlock.

Test evidence after this round's ownership convergence: Node/Electron boundary tests
32/32, related Vitest 45/45, Backend ownership/release tests 83/83, `desktop:build`
success, isolated release smoke success. Full Vitest is currently 1069 passed / 2 failed;
the remaining failures are pre-existing Workspace-selection fixture and AppShell
session-list UI assertions, outside this runtime/ownership chain. The Backend combination
tests have one more old auth case that depends on process-global storage/auth and reads
development data, so it cannot run as an isolated test and was excluded from this round's
targeted acceptance; these two test debts must not be interpreted as release-runtime
verification failures.

## 8. Known drift and later convergence

### 8.1 Runtime-provisioning docs disagree with the release package

The current `electron-builder.json` packages Backend sources, `pyproject.toml`, `uv.lock`,
System assets, and Nodes, but not the complete uv, CPython, and wheelhouse described by
the old deployment design. The current `BackendManager` discovers or installs a
user-level uv, then builds the environment in:

```text
<backendRoot>/runtime/venv
<backendRoot>/runtime/cache
```

Therefore "fully bundled, offline, no modification of the user's machine" from the old
design cannot be marked as implemented. Pick one and add a release gate:

1. Complete the bundled runtime + offline wheelhouse; or
2. Explicitly accept bootstrap downloads and establish a formal contract for network,
   proxy, version, timeout, and install failures.

Until this decision is made, a first-launch timeout must not simply be explained as a
Backend crash.

### 8.2 Code boundaries of the seven shapes

The seven shapes do not enter the Run or the public protocol. They are orchestrated by
three composition owners:

- `electron/runtime_config.cjs`: all writable roots, settings migration, and Backend
  endpoint defaults;
- `scripts/electron-dev.cjs`: the development Client process tree, managing only
  Vite/watch/Electron;
- `electron/backend_manager.cjs`: manages the API and standalone Worker only in released
  Desktop.

Browser/Electron E2E and packaged black-box are test-harness compositions; they must
provide isolated `user-data-dir`/Backend roots and must not add test business branches to
product code. Backend development and Server production are managed by the service
deployment entry point and equally do not change the protocol. Table-driven
runtime-config, development-orchestration, and BackendManager tests lock down paths,
supervision, and exit behavior respectively.

The completion bar is not "all seven modes can start", but: the seven shapes change only
composition — no Run, upload, event, log-sync, or result-pull behavior forks by shape.

## 9. Checklist when modifying the Electron startup chain

- [ ] Did you first draw the full chain Client -> Backend -> Worker -> child process ->
  event/log -> Client?
- [ ] Are you changing development ownership or packaged ownership?
- [ ] Did `desktop:dev` accidentally gain Backend management?
- [ ] Did you use `shell:true` or a visible console?
- [ ] Did you write into `resourcesPath`?
- [ ] Did you bypass `runtime_config.cjs` and concatenate a data root by hand?
- [ ] Did Backend private paths get written into Workspace identity?
- [ ] Do you distinguish `/ready`, Worker liveness, main-window load, and Run success?
- [ ] Are logs persistent, rotated, redacted, and openable from the UI?
- [ ] Do child-process log streams end only after `close`?
- [ ] Do both normal exit and fatal error reclaim the full process tree?
- [ ] Did you run black-box acceptance with the real packaged exe and isolated user data?
- [ ] Is the post-exit survivor count explicitly 0?
