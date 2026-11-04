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

> **Contract moved.** The three-owner JSON table, the startup rules and the
> fixed resolution order live in `docs/spec/FILE-LAYOUT.md` §8 (distilled
> there 2026-10-12). Summary of the shape: exactly three owner-specific JSON
> files (`components.json` / `settings.json` / `config.json`), CLI arguments
> for invocation facts, secrets via OS credential storage/stdin/inherited
> handles, one stdout JSON readiness line, no `TDEASE_*` product configuration
> in production processes (the two bash sandbox pointers excepted), and the
> 4-step resolution order with `--allow-env-overrides` as the only environment
> escape.

The Desktop's provider API keys follow the secrets rule literally: they live
in OS-backed credential storage (Electron `safeStorage` — DPAPI on Windows),
persisted as `credentials.json` beside `settings.json`. `settings.json` keeps
only an `apiKeyStored` marker, never the key; the tradeoff is the
OS-credential-storage bar itself (OS-keyed: any same-user process can
decrypt), not a per-user vault.

## 7. Deletions

The 2026-08 repository migration's deletion list (removed env fallbacks, `--db`
arguments, frontend scientific implementations, the backend-in-desktop copy,
duplicate HTTP/MCP/CLI business logic) lives in
`archive/docs-prune-2026-10-12/` — the migration is done and git history holds
the record.

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
