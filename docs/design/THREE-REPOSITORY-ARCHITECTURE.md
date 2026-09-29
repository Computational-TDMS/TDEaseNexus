---
type: design
title: Three repository architecture
status: accepted
---

# Three repository architecture

> **Correction (2026-08-31).** An earlier note here (2026-08-28) claimed the
> Backend's Snakemake engine layer (Node packages, engine execution) was
> demolished and kept for rollback; that was a mis-recording of the same
> day's working-tree over-deletion incident. Snakemake is the live product
> path; §4's Backend tree listing and Snakemake ownership describe current
> architecture. The three-repository boundary itself — dependency direction,
> data separation — is unchanged.

## 1. Final boundary

TDEase consists of three independently usable and independently released products.

```text
Desktop host  ───────> Python Backend ───────> Scientific System
     └───────────────────────────────────────> Scientific System
```

Dependencies point right only. Each repository owns its implementation, packaging,
configuration and end-to-end tests. No repository reaches into another repository's
internal directory layout.

## 2. Desktop repository

Owns the installed product experience:

- Electron and frontend UI/UX.
- Built-in AI runtime, providers, Sessions, permissions and approvals.
- Workspace selection, projections, visualization and result inspection.
- Installation, startup and update of Backend and Scientific System distributions.
- Backend protocol client and standard Skill/MCP adapters.

It owns no scientific algorithm and no Snakemake execution implementation.

## 3. Scientific System repository

`tdease-ai-capability` is installed directly as the product's read-only `system/` tree:

```text
system/
├─ skills/                # incl. _shared/ (kernel invocation + manifest module) and chart-forge
├─ prompts/internal/      # the 15 frozen prompt artifacts
├─ templates/
├─ reference/             # unimod.sqlite, psimod.sqlite, knowledge.db, ...
├─ wiki/                  # the System-scope seed corpus
└─ tools/                 # the provisioned managed CLI (tdeasenexus-toolbox); rg/fd live in
                          # the product's own managed tools dir, not this tree
```

The Rust source checkout lives at the submodule root (`tdease-ai-capability/rust/`),
beside `system/` — it is a development checkout, not part of the installed System
distribution.

It owns:

- Community-contributable Agent Skills.
- Scientific prompts, templates and reference assets.
- Rust mass-spec source and `tdeasenexus-toolbox` release.
- Official UniMod SQLite bundled into the Rust release.
- Direct scientific CLI and Skill end-to-end tests.

It depends on neither Desktop nor Backend. A clone/install is directly usable from
Claude, Codex or a terminal. Normal use requires no `TDEASE_*` environment variables.

The repository root is the System root; there is no redundant nested product `system/`
directory after migration. Skills use their own relative resources or public commands,
never a root environment variable.

## 4. Backend repository

`tdease-backend` owns server-side workflow management:

```text
tdease-backend/
├─ app/
├─ src/
├─ nodes/                 # packaged Snakemake execution assets
├─ migrations/
├─ bin/
├─ skills/                # Backend operation Skill
├─ pyproject.toml
└─ tests/e2e/
```

It owns:

- Snakemake service, Run lifecycle and execution supervision.
- Versioned Node templates/binaries/resources used by Snakemake execution.
- Uploads, storage, events, revisions, synchronization, auth and resource limits.
- Server deployment and Backend data-directory migrations.
- A Backend CLI and a standard Skill that operate the public service protocol.

The Backend Skill plus CLI makes this valid without Desktop:

```text
Claude/Codex -> Backend Skill -> Backend CLI -> remote/local Backend
                                      |
                                      +-> Scientific System commands when required
```

The Skill teaches service operation; the CLI carries structured commands. Neither
duplicates Backend business logic. Backend may invoke the installed Scientific System
through its public CLI/protocol, but never imports its repository paths.

### 4.1 Transport / domain boundary inside the Backend

Inside the Backend repository the dependency direction is one-way:

```text
app/  (transport)  ──────>  src/  (domain)
```

- `app/` owns the FastAPI HTTP surface only: `main.py` (app, middleware, lifespan),
  `api/` (routers), `schemas/` (Pydantic wire models), and a thin `errors.py` that
  translates domain errors to HTTP responses.
- `src/` owns the domain: `contracts/` (types and the single closed failure contract
  `ErrorCode` / `TDEaseError`), `execution_runtime/` (engine, storage, containment),
  and `services/` (worker, index, catalog). `src/` never imports `app/` and never
  imports FastAPI.
- `cli.py` is the composition root: the one module allowed to import both `app/` and
  `src/`. It lives at the repository root and owns process assembly (`serve` /
  `worker`).

There is no catch-all `app/core/` directory: routers, wire schemas and domain logic
each live in the layer that owns them.

## 5. Runtime data

Installed code and mutable data never share ownership:

```text
installation/
├─ desktop/               # read-only
├─ backend/               # read-only Python distribution
└─ system/                # read-only Scientific System distribution

data/
├─ system/                # Desktop settings, registry and user extensions
├─ backend/               # Backend database, runs, store, logs and cache
└─ workspace/             # user-owned projects
```

The two meanings of System are named explicitly in code:

- `productSystemRoot`: installed, read-only Scientific System.
- `userSystemRoot`: mutable Desktop/user state.

Do not introduce a generic `systemRoot`.

## 6. Configuration and process startup

- Persistent policy and paths use exactly three owner-specific JSON files:

| File | Owner | Contains | Must not contain |
|---|---|---|---|
| `installation/components.json` | Desktop installer | Released component versions and relative public entrypoints (`backend.command`, `scientific.root`) | Python modules, Rust build paths, Skill paths |
| `data/system/settings.json` | Desktop | UI, providers, MCP servers, local/remote Backend selection | Backend storage layout, scientific resource paths |
| `data/backend/config.json` | Backend | Bind address, data root, resource limits, auth and logging policy | Desktop paths, Skill paths, Python module names |

- `components.json` is immutable installation metadata, not user configuration. Development
  uses the same shape with development artifact locations; production does not discover
  sibling repositories by walking parent directories.
- Backend starts through its own public command:
  `tdease-backend serve --config <data/backend/config.json>`. Desktop does not invoke
  `uvicorn`, import Python modules, create Backend-private directories or manage a Worker
  separately.
- Scientific System has no root configuration file. Its installation root is supplied by
  `components.json`; Skills resolve their own relative resources and public commands resolve
  their bundled resources. Adding `system.json` merely to repeat internal paths is forbidden.
- Official scientific resources are installation content, not configuration.
- Invocation facts use CLI arguments.
- Secrets use OS credential storage, stdin or inherited handles.
- Child readiness uses one JSON line on stdout, for example
  `{"type":"ready","baseUrl":"http://127.0.0.1:49152"}`. This is process output,
  never an environment-variable handshake.
- Desktop and Backend production processes receive no configuration through `TDEASE_*`.
  The controlled bash child receives exactly two sandbox pointers —
  `TDEASE_SYSTEM_ASSETS` (the read-only Skill tree) and `TDEASE_WORKSPACE` (the bound
  Workspace root, keeping `bash` and background jobs on one variable surface); these are
  sandbox context, not product configuration.
- Development/test environment overrides require an explicit opt-in flag and are parsed
  once at the owning process entry point.

Resolution order is fixed and short:

1. Explicit CLI argument.
2. The owning JSON file.
3. A built-in default owned by that executable.
4. Environment only when the process was started with `--allow-env-overrides`.

There is no compatibility fallback after migration and no process reads another product's
configuration file.

No configuration file lists internal paths such as `skills/`, `unimod.sqlite`, Rust build
outputs or Python modules. Each distribution resolves its own internals.

## 7. Deletions

Migration deletes rather than relocates:

- `TDEASE_SYSTEM_ROOT`, `TDEASENEXUS_TOOLBOX_BIN`, `TDEASE_UNIMOD_XML` and
  `TDEASE_TOOLS_ROOT` scientific fallbacks. `TDEASE_SYSTEM_ASSETS` remains only inside
  the controlled bash child.
- Official UniMod `--db` arguments and `resolve_db_path`.
- Skill commands containing installation-root paths.
- Frontend scientific implementations.
- Backend implementation in the Desktop repository.
- Duplicate HTTP, MCP and CLI business logic.
- Capability manifests or registries duplicating Skills/MCP discovery.

## 8. Independent release gates

Scientific System:

- Clean install plus a direct real-data scientific CLI/Skill E2E.
- No Desktop/Backend imports or environment setup.

Backend:

- Clean server start from JSON and a complete Run E2E through its CLI Skill.
- The same E2E works with local and remote transport.

Desktop:

- Installs/starts released Backend and Scientific System artifacts.
- Completes the same Run through the product UI.
- Contains no copied scientific or Backend implementation.

Fresh-install rule: `data/` is never a source tree. Desktop development reads the two
submodules directly; packaged builds receive Backend `nodes/` and Scientific System
assets through `electron-builder` resources. Backend execution data is created only
under the user data root.
