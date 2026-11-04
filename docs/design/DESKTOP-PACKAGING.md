---
type: design
title: Desktop packaging & install lifecycle
description: Installer posture, data-root selection, bundled runtimes (Python/bash), boot reveal, license surface, update channel, node-catalog seed, process ownership, install verification.
status: implemented
---

# Desktop packaging & install lifecycle

> The installed artifact keeps the name `TDEaseNexus` (installer/productName,
> appId `com.tdeasenexus.app`, exe, data directory; the icon is the celadon tile
> the boot splash draws), while every user-visible surface reads
> **TDEaseNexus · TD通** (window title, splash wordmark, welcome page, tray;
> the Chinese name renders in a kai face). The exe/data-directory name stays
> until a rename is decided — it would move the install dir, the exe and the
> data root. Code lives in `electron/` (`main.ts`, `runtime_config.cjs`,
> `backend_manager.cjs`, `updater.ts`, `pty-bash-backend.ts`,
> `node_catalog_seed.cjs`, `windows-job.cjs`, `installer.nsh`) and
> `scripts/release/`.

## Installer posture

The NSIS install is **per-user strictly** (`nsis.allowElevation: false`) — no
"install for all users" option, so an install never lands under Program Files
and the data dir stays beside the install dir, writable by construction.
`nsis.deleteAppDataOnUninstall` also clears the per-user profile on uninstall.

The assisted installer **owns the force-reinstall**: it uninstalls the previous
app before copying, and `electron/installer.nsh` (`customInstall`) wipes any
`TDEaseNexus-Data` (or pre-rebrand `TDEase-Data`) beside the install directory
on an INTERACTIVE install — every manual reinstall starts from first-launch
state (settings re-seeded, venv/caches re-provisioned). A SILENT install (the
update channel replaying the installer with `/S`) skips the wipe: it must
replace the application and PRESERVE the data root (settings.json holds
provider keys, auth.json the tokens). User Workspace folders live outside the
data root and are never touched.

Launch does not migrate, rename or reconcile old data folders — the picker
below only decides where a root lives.

## Data root selection

`runtime_config.defaultDataRoot` picks a FRESH root in this order:

1. the install-sibling `TDEaseNexus-Data` if it exists, or can be created AND
   written (the probe performs a REAL child `mkdir` — `accessSync(W_OK)` does
   not check Windows ACLs, so an access-only probe passes on an existing but
   ACL-restricted directory and merely moves the crash one mkdir later);
2. else `<install drive>:\TDEaseNexus-Data` (space-free);
3. else the per-user profile.

The root must be **space-free** when fresh: TopPIC 1.8.x (`topfd`/`toppic`)
hard-exits when its own directory path contains a space, and the Run's node
snapshot lives under the data root — a spaced root makes every TopPIC stage
unrunnable. An EXISTING root is never relocated, spaced or not: moving a
multi-GB tree (settings, database, Runs) at launch would be worse than the
constraint. Verified by `scripts/release/verify-data-root.cjs` across spaced /
ACL-denied / normal layouts.

## Python environment: ship the interpreter, resolve online

The installer carries the pinned CPython 3.12.13
(`backend/runtime/cpython-*`, stdlib precompiled at build time so runtime
probes never write bytecode into the install) but NOT a wheelhouse: first boot
runs `uv sync --locked --no-dev`, resolving the locked set from the uv cache or
PyPI. Both uv sides (SMK runtime and SKILL/AI sandbox) are online by design.
What is non-negotiable: `UV_PYTHON` holds the ABSOLUTE bundled-interpreter
path, never a bare version request — machine discovery could otherwise adopt a
PEP 514-registered foreign interpreter or the WindowsApps stub and trigger the
Python install manager.

**A relocated install rebuilds its venv.** `_ensureBackendEnvironment` probes
the console script it is about to spawn (`tdease-backend --help`) instead of
trusting file existence plus the lock marker, and additionally requires the
venv's `pyvenv.cfg` home to be the bundled interpreter. uv's Windows
trampolines embed the venv's absolute path, so a copied install keeps every
file and still cannot run; the probe detects that and rebuilds with one
`uv sync --locked` (`backend_manager.test.cjs`). The `.snakemake`
compatibility alias is created with `_winapi.CreateJunction` — no shell, no
argument quoting, so no path character changes the outcome.

## Packaged bash runtime is self-sufficient

The installer ships Git for Windows 2.55.0.5 as `resources/vendor/git`
(MinGit's msys coreutils + mingw64 git, with bash.exe restored from sh.exe for
`usr/bin/bash.exe` and the `bin/sh`+`bin/bash` pair the msys shebang dispatcher
needs). `pty-bash-backend.resolveBashPath` prefers the bundled bash in packaged
mode; the skill/bash env and the main-process PATH pin prefix
`vendor/git/{bin,usr/bin}`, so a clean machine with no Git for Windows gets a
working agent sandbox (bash 5.3 + coreutils + `python`/`python3` launchers →
uv → the bundled CPython). Vendor acquisition lives in
`scripts/release/build-desktop.ps1` Phase 0.5 (idempotent, pinned release).
Pi's own bash fallback (Program Files Git → PATH) is unchanged for dev.
Verified git-less (fake ProgramFiles, PATH = System32 only): cold start,
backend `/ready` + `/api/capabilities` 200, and ConPTY bash running
`tdeasenexus-toolbox`/`python3`/`uv`.

## Boot reveal is splash-to-painted-UI

The main window stays HIDDEN through `ready-to-show` while the splash is up;
it is shown only when the renderer signals its first painted frame
(`app:renderer-ready`). Revealing at the HTML skeleton put a blank white page
on top of the splash for the whole backend:connection handshake (cold first-run
uv sync can take minutes). A renderer error or a 150 s guard reveals the window
anyway — never stuck on the splash. E2E keeps an immediate reveal.

## License surface spans installer, app and install dir

One text — `electron/license-agreement.txt` (Chinese AI-service/data terms +
generated-content labeling per the 2025-09-01 《人工智能生成合成内容标识办法》
+ GPL-3.0 English full text) — feeds three places: the NSIS license page
(`nsis.license`), the Settings About group (`AboutSettings.vue`, imported
`?raw` into the SettingsDocument lazy chunk; version from package.json; the
three-part summary + full text satisfies GPL-3.0 §0 "Appropriate Legal
Notices"), and a verbatim copy in the install directory via `extraResources`.
The AI-terms part is benchmarked against peer BYOK agent clients (Cherry
Studio / Chatbox / Cursor / Claude Code): seven clauses covering service
non-agency/billing boundary, output no-warranty (incl. IP), third-party data
processing outside the app's control, lawful use, and terms-update
continued-use acceptance.

## Update channel

`electron/updater.ts` owns the whole surface: background check on start + every
4 h, background download (blockmap differential), `autoInstallOnAppQuit`
acting only on a user-started quit, and NEVER a self-initiated restart. State
(`unavailable/checking/available/downloading/downloaded/error`) pushes to the
renderer over `update:state` (preload `tdeaseDesktop.update` port, mirrored in
`services/desktop/desktopBridge.ts`); the only UI is the App-update row of
General settings — quiet status line + Check button + a Restart-to-update
button that appears solely in the downloaded phase. Check failures surface only
there and in the logs; a user without the update host sees a quiet "up to
date". `electron-updater` is a runtime dependency external to the main bundle;
a missing package or dev run degrades to a disabled updater, never an error.
Publish target: the GitHub repository `Tisen-Ray/TDEaseNexus-Releases`
(`electron-builder.json` `publish`).

## Node catalog seed ships with the installer

Compute packages are delivered as one compressed seed
(`resources/backend/nodes.zip`, regenerated from `data/backend/nodes/` every
build). Every packaged boot compares the zip's SHA-256 against
`nodes/.seed-manifest.json`; the manifest records the fingerprint and the exact
top-level names the last seed installed, so **ownership is by NAME**: a changed
fingerprint REPLACES the seed-owned directories (and removes shipped-but-
retired ones), while a name the manifest never owned — a `tdease.nodes.install`
package or a user-created dir — is never touched (`node_catalog_seed.cjs`;
contract tests in `node_catalog_seed.test.cjs`). A matching fingerprint
discards the zip without extracting, but a matching fingerprint with a MISSING
recorded package reseeds — deleting a shipped node is repaired on the same
install. Extraction goes to a `<backend>/.nodes-seed-tmp` dir wiped before
every attempt; the zip is deleted only after the manifest is written (crash
mid-reseed retries idempotently). Run snapshots under `nodes/.snapshots` are
digest-addressed and never part of the manifest. The Backend's node root
derives from `dataRoot` (`backend/nodes`); a configured `nodeRoot` must resolve
under `dataRoot`.

## Process ownership (Windows)

`electron/windows-job.cjs` (koffi/kernel32, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
assigns the backend, uv, the uv installer, MCP stdio servers and PTY shells to
one Job Object: parent exit → kernel-terminated children, verified on-machine.
Every failure mode degrades to the existing taskkill sweep. Still missing: a
forced-kill desktop E2E asserting the whole tree (open item in STATUS).

## Install verification

`scripts/release/verify-install.ps1` checks the packaged layout, then audits
every Node package's `rules.smk` — present, no hardcoded absolute host path (a
wildcard host-discovery glob is not a leak), and every executable/script it
names ships in the package — and, once the app has launched, the external
catalog, environment, provisioned tools and index. `-EngineSmoke` also runs the
shipped `tdeasenexus-docs` doctor against the installed data root, resolves the
`toppic` binding through the installed Backend's own `resolve_bindings`, and
executes the catalog `topindex` node in a temp Run root with the installed
venv's Snakemake. The final section re-audits the packaged trees for
`__pycache__`/`.pyc`/virtualenv/cache residue AFTER those checks have run the
installed Python: every `extraResources` entry copying a source tree carries a
filter, and the packaged Backend plus the agent bash sandbox run with
`PYTHONDONTWRITEBYTECODE=1`, so a used install is never written back to. The
engine command line legitimately carries the absolute catalog tool path; the
install directory itself must never appear.

## Alternatives considered

- **Offline wheelhouse in the installer** — built, then cut: it made the
  installer large to serve a scenario (fully offline first boot) the product
  does not promise; `uv sync --locked` from cache/PyPI is the contract.
- **`accessSync(W_OK)` as the writability probe** — lost: it does not check
  Windows ACLs on an existing directory and deferred the EPERM crash to first
  write; a real child mkdir is the probe.
- **Legacy data-folder rename/migration at launch** — removed: the picker only
  chooses where a root lives; reconciling old layouts re-created every crash
  class it tried to fix, and the installer now owns reset semantics.
- **`cmd /c mklink /J` for the `.snakemake` alias** — lost to
  `_winapi.CreateJunction`: no shell, no argument quoting, no path-character
  sensitivity.
- **Elevated/all-users install** — lost: it is what puts the install (and thus
  the data root) under Program Files, creating the ACL failure the per-user
  posture eliminates by construction.
