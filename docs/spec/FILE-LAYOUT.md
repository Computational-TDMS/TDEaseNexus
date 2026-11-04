---
type: contract
title: Client file and ownership layout
description: Sole authority for every directory, root, ownership and path rule.
status: implemented
---

# Client file and ownership layout

> **Correction (2026-08-31).** An earlier note here (2026-08-28) claimed the
> Snakemake workflow-engine layer was demolished and kept for rollback; that
> was a mis-recording of the same day's working-tree over-deletion
> incident. Snakemake is the live orchestrator, so the Snakefile/Node-package
> execution rules below (§2 "System Snakefiles", §4 Run workflow I/O, §5
> Node packages) are current architecture and remain the sole authority
> together with the ownership model (§1), the asset-identity rules (§2), the
> Session/Workspace/analysis layout (§3–4 remainder) and the safety rules
> (§7).

> Sole authority for every directory, root, ownership and path rule. The actual trees
> are the code/runtime; this document owns the *rules* the trees must obey.

## 1. Ownership model

TDEase has a Client and a Backend service. System and Workspace are always on the
Client side. Backend may run on the same machine (Desktop) or remotely (Server);
deployment never changes file ownership.

| Root | Owner | Purpose |
|---|---|---|
| System | Client installation/user profile | Global settings, Workspace registry, reusable product/user assets |
| Workspace | User/project | Portable analysis units, project assets, every durable user analysis file |
| Backend runtime | Backend service | Uploaded execution inputs, isolated working state, service indexes, caches, retained remote outputs |

Backend runtime storage is **not** user analysis truth. It may be remote, temporary and
subject to a retention policy. A Workspace remains understandable and usable without
direct access to Backend storage.

The System asset source shipped with the product lives in the
`tdease-ai-capability` toolkit submodule at
`tdease-ai-capability/system/` (skills, prompts, genes, templates,
reference, wiki, tools); product-supplied files install read-only and user-level
records/extensions live in the writable System data location. Product upgrades must not
erase user records or extensions.

## 2. Rules that the trees cannot self-prove

- **Identity collision fails closed.** Asset identity is the first name below its
  category (`templates/<id>`, `skills/<name>`). An identity
  present in both the read-only product root and the writable user root is a
  configuration error that fails closed instead of silently overriding either owner.
- **A Workspace asset must not silently overwrite a same-named System asset**, and
  Workspace customization never writes into the installed System copy. Asset origin is
  always visible.
- **The product CLI short name is a runtime capability, not an asset (D20).** The
  provisioned `tdeasenexus-toolbox` in `system/tools/` (the bash PATH prefix) is product-owned
  and lives outside the asset-override hierarchy: a Workspace must never shadow it with a
  same-named binary. The managed PATH short name is the runtime identity. A
  Workspace-supplied custom binary must use a distinct name or an explicit path.
- **System Snakefiles are references only.** Execution never edits or runs the System
  copy; selecting a template instantiates the required files into a Workspace Run, and
  that Run-local copy is then configured, edited and submitted.
- `system/wiki/` is the user-writable, Client-wide knowledge root, never a Workspace
  asset or scientific truth for a project. Pages may cite Workspace Evidence textually,
  but validation never traverses into the open Workspace.
- **Two modification sources (D17).** The official `UNIMOD:n` records live read-only in
  the product `reference/unimod.sqlite`; personal extensions in the writable User System
  `reference/user-mods.sqlite` (`USER:n`, ids offset so the spaces never collide). Search
  returns both sources with `source`/`custom`; a ProFormA tag matching both sources is an
  ambiguity error demanding an explicit `[UNIMOD:n]` / `[USER:n]`, never a silent priority
  pick.

## 3. Workspace

A Workspace is any user-selected directory and the portable analysis unit above Runs.

- **Run directories are flat siblings** under `workspace/runs/`. The Workspace imposes
  no experiment/project hierarchy above them.
- Workspace paths stored in portable files are relative to the Workspace root. Client
  configuration uses JSON. Scientific Evidence remains Workspace-owned and must cite the
  Run files it uses.

### Agent Sessions

Each Session is one self-contained directory under
`workspace/.tdease/sessions/<session_id>/`. `session.json` is the sole durable metadata;
`events.jsonl` is the append-only operational truth. **Session discovery scans this
directory only** — not a user-profile SDK directory, Backend storage or localStorage.
localStorage may remember only the selected Session id per Workspace; it never stores
Session metadata, messages, events or model transcript paths. Session ids
deterministically name their directories; no manifest or path alias maps an id elsewhere.

The on-disk session layout (AGENT-EVENTS.md owns the log invariants):

```text
workspace/.tdease/sessions/<session_id>/
├─ session.json          # durable metadata
├─ events.jsonl          # append-only canonical event log (digests, small facts)
├─ turns.jsonl           # one TurnCard per settled turn
├─ tool-audit.jsonl      # compact per-tool-call audit
├─ snapshots/<digest>.md # frozen prompt snapshots (content-addressed)
├─ content/<digest>.blob # large bodies (e.g. tool results), digest-addressed
├─ model-session/        # the Pi SDK's own transcript; Pi owns it
├─ subagents/<id>.json   # child records (design SUBAGENT-RUNTIME §3d)
├─ workflows/<runId>.json# orchestrate journals (design ORCHESTRATE-RUNTIME §4)
└─ jobs/                 # background job records
```

Generic Agent filesystem tools cannot read any of it (the permission gateway blocks
`.tdease/sessions/` and `.tdease/events.jsonl` paths outright).

## 4. Workspace Run

Each `workspace/runs/<run>/` directory is a complete, user-owned analysis division.

- Source data is placed directly in the Run directory — no `raw/`, `fasta/` or
  per-sample subdirectories required.
- Scientific data and returned results are ordinary Run files; meaning comes from the
  workflow's own input/output declarations and sample configuration.
- The active Snakefile, configuration and supporting scripts live in the Run they
  execute; they may originate from a template but are independently editable.
- Logs and execution events are synchronized into the Run so the user can inspect
  execution without browsing Backend storage.
- A Run may contain only the outputs the user/workflow asks to return; TDEase need not
  mirror every Backend working file.
- Analysis Skills read named Run files and write only to explicit paths in that Run or
  another user-approved Workspace location.
- A visualization opened for a Run is transient document state unless the user explicitly
  saves an output file — it is not a global `views/` asset.

**`run.json` records Client-visible identity, Backend execution references, upload/sync
facts, and the selected output policy. It must not contain absolute paths from the
Backend machine.**

### Run analysis intermediates (`analysis/`)

Agent/skill analysis on a Run writes its working intermediates under
`runs/<run>/analysis/<slug>/`: one directory per analysis question (kebab-case slug),
keyed by Run + analysis, never by the Agent Session — any turn or session working on the
same Run and analysis reads and writes the same directory. The Agent ensures the directory
exists when it opens a Run-scoped analysis (auto-created, never manual).

These files are the **inter-process channel for one-shot tooling**: the `tdeasenexus-toolbox` CLI is
a single process with no in-memory state, so the filesystem is how its calls communicate.
The convention is fixed in the system prompt rules (analysis_layout.md), never invented:
the Agent uses the Workspace-relative path `runs/<run>/analysis/<slug>/`, and a skill
script's working directory *is* the Workspace root, so that relative path resolves
directly. The bash child carries exactly two `TDEASE_*` pointers —
`TDEASE_SYSTEM_ASSETS` (read-only System assets) and `TDEASE_WORKSPACE` (the bound
Workspace root, so `bash` and background jobs expand the same variables); the
relative-path convention above is unchanged by them. CLI `--out` writes into the same
relative directory.

- **Scratch until cited.** A file here is not a Run input/output and not scientific truth.
  It becomes evidence only when an Evidence claim records its SHA-256, and `evidence.verify`
  re-hashes it. Uncited scratch may be deleted and the Run stays self-consistent.
- **Never declared workflow I/O.** `analysis/` never appears in Snakefile
  input/output declarations, never enters the execution snapshot or submission.
- **Figures and derived data live beside the analysis** in the same `<slug>/` folder, so a
  chart re-derives without re-running and auto-presents in the transcript via the Workspace
  file-delta scanner.
- **Evidence for a Run analysis goes to `runs/<run>/evidence/`**, not the Workspace root —
  the Run is the portable unit (Evidence rules in `AGENT-CONTRACT.md` §2).
- **An ad-hoc question outside any Run** uses the same layout at the Workspace root
  (`analysis/<slug>/`, parallel to the root `evidence/` scope). Both `analysis/`
  subtrees are excluded from submission and execution snapshots.

### Revisions are manifests, not directories

Returned files always map back into the original `workspace/runs/<run>/` directory; a
Backend Run id, attempt id or revision id must never create a sibling Client Run
directory. A revision is an immutable manifest over content-addressed Backend blobs
(paths, sizes, SHA-256 digests) — it is not a Client directory and does not change
Workspace identity. Historical workflow source is a distinct manifest role, never mixed
into automatic result restoration. If an older Backend Run has no trustworthy
`workspace_run_path` mapping, Client leaves it unmapped and requests migration/user
selection; it must not synthesize `runs/<backend-run-id>`.

## 5. Backend execution storage

Backend storage layout is private implementation detail (a typical layout exists in
`server-data/` during development). Backend paths, database rows and caches never become
Workspace identity. Deleting a Backend cache must not invalidate files already
synchronized into a Workspace; deleting mutable execution state must not invalidate a
retained revision manifest or its referenced blobs.

Backend owns scientific Node packages under its data root's `nodes/` directory
(`data/backend/nodes/` in the repository; `<TDEaseNexus-Data>/backend/nodes/` in an
install). Desktop/System data remains separate under `<TDEaseNexus-Data>/system/`.
The installer ships the packages as one compressed seed
(`resources/backend/nodes.zip`); first launch extracts it into the data root's
catalog when that catalog holds no packages yet, then removes the seed —
out-of-the-box compute without a second tree in the install. Afterwards the
catalog is user-managed: an app update never overwrites it.
The catalog is user-manageable and shared by Runs; an edited package is not
copied privately into each Run. Backend derives this root from `dataRoot` and rejects a
configured `nodeRoot` that resolves outside Backend data. A directory name starting with `_` is not a node package: it
holds templates and drafts (`_template/` is the copyable starting point for a host-installed
tool) and the catalog scanner skips it. A Run never carries tool bytes: at dry-run and
execution the Backend injects each bound package's absolute catalog path into the engine
config (`config["nodes"][<id>]`), and node rules resolve themselves through that mapping.
The digest a definition records documents which catalog content the Run was authored
against — the catalog is deployment state, and executions follow its current bytes.

## 6. Desktop and Server transport

Desktop starts Backend as a supervised local child process; Server mode connects the
same Client to a remote Backend. Both use the same submission/synchronization contract.
Desktop transport may optimize verified bytes with hardlinks, reflinks or contained
direct reads. Backend seals each verified input once into its CAS and links Runs to that
blob; a filesystem that cannot provide the required link fails clearly instead of making
an untracked per-Run copy.

## 7. Initialization and safety

Opening a Workspace creates only missing management directories and files. Existing Run
files, Snakefiles, configuration and assets are never overwritten. Every caller-supplied
Client path is resolved and contained under its approved System or Workspace root;
symlink and junction escape fail closed. Backend paths are never accepted as Client file
identities. **Uninstall never deletes user-selected Workspaces.**

## 8. Configuration ownership and process startup

> Distilled from `design/THREE-REPOSITORY-ARCHITECTURE.md` §6 (2026-10-12
> prune); that document keeps the repository-boundary rationale.

Persistent policy and paths use exactly three owner-specific JSON files:

| File | Owner | Contains | Must not contain |
|---|---|---|---|
| `installation/components.json` | Desktop installer | Released component versions and relative public entrypoints (`backend.command`, `scientific.root`) | Python modules, Rust build paths, Skill paths |
| `data/system/settings.json` | Desktop | UI, providers, MCP servers, local/remote Backend selection | Backend storage layout, scientific resource paths |
| `data/backend/config.json` | Backend | Bind address, data root, resource limits, auth and logging policy | Desktop paths, Skill paths, Python module names |

- `components.json` is immutable installation metadata, not user configuration.
  Production does not discover sibling repositories by walking parent directories.
- Backend starts through its own public command:
  `tdease-backend serve --config <data/backend/config.json>`. Desktop does not invoke
  `uvicorn`, import Python modules, create Backend-private directories or manage a Worker
  separately.
- Scientific System has no root configuration file; adding `system.json` merely to
  repeat internal paths is forbidden. Official scientific resources are installation
  content, not configuration.
- Invocation facts use CLI arguments. Secrets use OS credential storage, stdin or
  inherited handles. Child readiness uses one JSON line on stdout — process output,
  never an environment-variable handshake.
- Desktop and Backend production processes receive no configuration through
  `TDEASE_*`. The controlled bash child receives exactly two sandbox pointers
  (`TDEASE_SYSTEM_ASSETS`, `TDEASE_WORKSPACE` — AGENT-CONTRACT §5.1); these are
  sandbox context, not product configuration. Development/test environment overrides
  require an explicit opt-in flag parsed once at the owning process entry point.

Resolution order is fixed and short:

1. Explicit CLI argument.
2. The owning JSON file.
3. A built-in default owned by that executable.
4. Environment only when the process was started with `--allow-env-overrides`.

There is no compatibility fallback after migration and no process reads another
product's configuration file. No configuration file lists internal paths such as
`skills/`, `unimod.sqlite`, Rust build outputs or Python modules — each distribution
resolves its own internals.
