---
type: contract
title: Workflow and Run contract
description: HTTP surface, Run lifecycle, event vocabulary, dry-run shape, Published Results.
status: accepted
---

# Workflow and Run contract

> **Correction (2026-08-31).** An earlier note here (2026-08-28) claimed the
> Snakemake workflow-engine layer was demolished, absent from the venv, and
> kept for rollback only; that was a mis-recording of the same day's
> working-tree over-deletion incident. Snakemake 9.23.1 is the live
> orchestrator (`SnakemakeAdapter` + `engine_runner.py`; pinned in
> `pyproject.toml`, installed in the backend venv). §1 and §3–6 below are
> current architecture, not a rollback contract.

> The HTTP surface, Run lifecycle, event vocabulary, dry-run shape and Published Results
> are implemented and readable in `app/api/`, `src/contracts/`, `run_lifecycle.json`.
> This document records the boundary decisions and non-obvious contracts. Event/projection
> mechanics in `docs/design/CORE-ARCHITECTURE.md`; paths in `docs/spec/FILE-LAYOUT.md`;
> Agent tool surface in `docs/spec/AGENT-CONTRACT.md`.

## 1. Boundary — who owns what

TDEase owns identity, authorization, accepted submission bytes, path containment, resource
limits, execution supervision and observable Run facts. **Snakemake owns workflow
semantics** — DAG construction, incremental execution, output provenance, job scheduling.
There is no Snakemake network service and no public Snakemake CLI contract: Backend embeds
and supervises a pinned engine as a child process; Snakemake never opens a port.

**Execution is deliberately serial:** one Backend deployment has one global execution
slot, starts Runs in submission order, at most one executing. Snakemake alone decides
parallelism inside that Run. This is recorded because "obviously we should run Runs in
parallel" is the obvious regression.

**Compute envelope — three semantics, one owner.** The Backend startup budget
(`resource_budget.py`; surfaced as `GET /api/capabilities` limits) is the only envelope
authority: callers never declare `cores`/`memory_mb` (sending them is rejected by name),
and the Backend injects the budget into every accepted definition. Within that envelope:

- **`threads` is peak appetite, not a reservation.** The engine clamps each job's threads
  to the Run core budget at DAG build time (`min(declared, cores)`); a 28-thread rule on
  an 8-core budget runs with 8 threads — degraded, correct. Nodes may declare whatever
  appetite their tool can consume; no machine assumption ever belongs in a node.
- **`resources` (`mem_mb` and any Backend-capped custom resource) are hard floors.** A
  declared floor above the Run budget fails the dry-run (and, for a definition that
  reaches execution, fails before the first job starts) with the rule name and both
  values — never a mid-run opaque `ENGINE_TASK_FAILED`. The guard compares the raw
  declaration: the engine's native tendency is to scale ANY integer resource down to
  the limits, which for memory would silently under-provision the scheduler while the
  tool OOMs mid-run; the Backend assertion is what makes memory non-negotiable.
  Lambda-declared resources stay under the engine's runtime clamp.
- **The clamp is observable.** Every dry-run projection job carries its resolved
  `threads` and declared `resources`, so "topfd runs 8/28 threads on this machine" is a
  read, not a guess.

Source-of-truth order:

| Question | Authority |
|---|---|
| Which tools are deployed? / How is a Node composed? | Backend Node catalog (`GET /api/nodes`, exact `rules_text`) |
| Is a workflow valid / what will run? | Backend real Snakemake dry-run |
| Current Run state? | `events.jsonl` projected (`CORE-ARCHITECTURE.md` §1) |
| Why did execution fail? | Structured error and job events first, bounded log tail second |

Template text, UI state and human log parsing are never runtime authorities — general
knowledge may *suggest* a Workspace-native implementation but cannot *prove* a
Backend-managed package is present.

A Node binding names a deployed package by id; the digest a definition records is
**authorship provenance, never an enforcement** — the catalog is deployment state, and an
execution uses whatever bytes it currently holds. Before dry-run or execution, the
Backend resolves each binding and injects the package's absolute catalog path into the
engine config as `config["nodes"][<id>]`. Node rules resolve their binaries and
resources only through that mapping, so a Run directory never contains tool bytes or a
`nodes/` subtree at all.

**A Run never stores its own private copy of a node package or of a Workspace input.**
Local inputs are sealed once into the Backend CAS and hardlinked from there; control
files (`Snakefile`, `*.smk`, `config.yaml`, `scripts/`) are written; tool packages stay
in the Backend catalog. A platform that cannot create a required input link — a
filesystem without hardlinks — **fails the Run with a structured error**, never silently
duplicates bytes per Run. `materialization_strategy` still
names how the definition was satisfied (`local_workspace_hardlink` | `blob_store`), and
submission itself writes nothing into the run directory: the worker materializes the
revision it starts.

**No status locks a definition.** A Run is always editable and always continuable:
submitting again appends a new revision and a queue request from any status — the
Journal declares `run.submitted` and `run.queue_requested` from every status
(`src/contracts/run_lifecycle.json`). If an execution is in flight it keeps its own
journal range and results manifest, and the new definition is queued behind it: the
projected status stays `RUNNING` until that range terminates, then becomes `QUEUED` for
the new definition. Reproducibility is **recorded, not enforced**: a revision id is a
content hash of the frozen definition, every execution range names the revision it ran,
and the results manifest names it too, so the journal says exactly which parameters
produced which result. Submission itself writes nothing into the run directory; the
worker materializes the revision it starts, so the bytes an execution reads are always
the bytes its revision names.

### Queue order, cancellation and submit identity are execution-scoped

The Run index orders QUEUED runs by the journal seq of the latest
`run.queue_requested` (schema v4, rebuildable) — resubmission preserves
`created_at`, so ordering by it let an old resubmitted Run jump every newer
Run. The cancel flag names the `queue_seq` it targets, and the worker clears a
flag aimed at any other execution, so cancelling one Run cannot self-cancel
the executions queued behind it. The client submits only through the
deterministic `stableRunId` path (the random-id legacy `submit()` is deleted):
one Workspace run folder maps to exactly one Backend Run.

### Results belong to the revision that produced them

`GET /runs/{id}/results` projects the declared specs of the definition the
CURRENT results manifest names — not the newest submitted definition — and the
response carries `definition_revision_id`, so a definition submitted while an
older execution's results stand can neither borrow its spec list for old files
nor make them vanish. The manifest sweep never republishes a file an earlier
manifest already claimed (dead rules' outputs keep their provenance;
`definitions/` snapshots are not results), and the worker binds its queue
request by `projection.queued_at_seq` (never "the latest event"), so revision
and rerun-mode can never come from two different submissions. The agent
surface exposes the history read-only (`runs.listDefinitions` over
`GET /runs/{id}/definitions`). Pinned end-to-end by
`tests/test_run_shared_tree_revisions_e2e.py`.

### Supervision and worker visibility

`serve` runs the worker under a supervisor that restarts it (it is a stateless
poller) and stops the Backend with a `worker_unstable` line after three
crashes in a minute; the worker also exits by itself when the `--parent-pid`
process is gone, so a hard-killed client cannot leave an orphan poller holding
claims. Every wrapper stage around the engine (claim / materialize / engine /
verify-inputs / manifest) names itself in `logs/tasks/worker.log`, and
`GET /runs/{id}/log` tails that section FIRST — a Run that died before the
engine has a log the Agent can actually read. An exception outside the staged
block is contained: terminal `run.failed` event + full traceback in the worker
log, never a re-raise (an escape would requeue the claim and crash-loop
invisibly). Error messages carry the failing stage tag and the two digest
gates are actionable by copy. The ready line reports the port uvicorn actually
bound — there is no pre-flight port probe. Pinned by
`tests/test_worker_failure_visibility.py`.

### Process identity, not bare pids

The execution slot claim and the engine process record carry
`<pid>:<create_time>`, and liveness compares both. Windows recycles pids; a
stale claim or engine record whose pid now belongs to an unrelated process can
no longer wedge the queue or aim a kill at a stranger.

### Text is compared verbatim (CRLF submits)

The plan freezes the Client's raw read; the Backend compares it against the
file verbatim (`_read_text_verbatim` at both comparison sites).
`Path.read_text()`'s universal-newline mode turns CRLF into LF and made every
CRLF-authored Snakefile fail prepare/dry-run with `RUN_PLAN_STALE` on identical
content. The stale error is not a black box: it reports both lengths and the
first diverging char, or says outright that the texts differ only in line
endings. Pinned by `tests/test_run_snakefile_text.py` at the API level.

### Node packages: `rules.smk` is the contract

Capabilities are parsed FROM the rules text (inputs/outputs/params/message +
the `shell` invocation line); README.md is prose fallback, never the contract.
Inline `# comments` on params survive parsing and surface verbatim in the node
digest (`# name: comment` lines) — authors document knobs where they are
defined (`nodes/_template/` demonstrates). The frozen definition of ANY
revision is readable in full (`GET /runs/{id}/definitions/{def-id}` → exact
Snakefile text, config, node digests, input manifest; client
`runs.readDefinition`) — the self-correction primitive: diff a planned edit
against what an earlier revision actually executed.

One binary-location override serves every node: `<config-block>.bin_dir` in
the Run's `config.yaml` (an absolute directory; the node owns the executable
names) relocates any node's executables; unset means the node's own package
directory. `nodes/_template/` is the copyable package for a tool that must not
be bundled; directory names starting with `_` are templates/drafts — they ship
with the seed and are skipped by the catalog scanner, never nodes. A bundled
node binds its own binary inside the Run snapshot (the msconvert rule: its old
wrapper probed only the host and failed exit 127 without a matching host
install); a host install is opt-in via `bin_dir` and recorded in the Run's
provenance. No Run depends on host PATH or registry edits.

The Run commit locks executables through `nodes` only: the removed
`packages: PackageLock[]` field is rejected by name
(`_reject_removed_commit_fields`), not silently ignored. Catalog digests are
memoized by a per-file (path, size, mtime) tree signature, invalidated on
content change, so repeated catalog reads stop re-hashing hundreds of MB.

## 2. Capability discovery (`GET /api/capabilities`)

The Client feature-detects on this one startup-frozen document to decide how to talk to a
Backend. Two rules govern it:

1. **Feature-detect on presence, never on version.** A Client checks whether a field
   exists and what it contains; it never branches on `protocol_version` to infer a
   feature. The version only refuses an incompatible major (Client supports exactly `3`).
2. **Capabilities select a transport adapter, never file ownership.** Client always
   submits a Workspace Run manifest; Backend advertises how missing bytes are satisfied.
   The caller never declares a product edition — no `mode` field.

The field inventory is the code (`src/backend_settings.py`). `materialization.strategies`
is resolved once from Backend JSON at startup; `POST /runs` reads no configuration at
request time.

**Exposure rule (who may talk to a Backend).** A Desktop-owned Backend binds loopback
and authenticates every request: the Desktop launcher mints a per-launch bootstrap
secret, hands it to the Backend child through its environment (never a CLI arg), and
exchanges it once for the launch's token pair — the owner token (every scope, for the
UI and the Desktop main process) and the agent token (working scopes, but NOT the
irreversible `run:purge`, for the AI harness; `DELETE /trash/{id}` fails with
`AUTH_SCOPE_DENIED` under it). `auth.mode: local` (every request trusted) is a
development/test configuration, never a shipped one. A Backend is never exposed to a
network directly: web sharing goes through the Desktop's share server, which holds its
own link-tier authentication — the raw Backend has no non-loopback deployment posture.

## 3. The `planRef` boundary

The model never receives or authors a raw `CommitPlan`. The Client owns scanning/hashing/
commit-planning and exposes them through an opaque `planRef`:

```text
prepare({...}) -> { planRef, ... }   dryRun({planRef}) -> {...}   submit({planRef}) -> RunSummary
```

`planRef` is Client-session-local, opaque to the model, scoped to one Workspace, expires
when a relevant file changes; `submit` rejects a missing/changed/expired/not-dry-run plan.
`managedNodes` (the node bindings, `[{id, rules}]`) is optional — **`prepare` must not
reject valid Snakemake** (rules, `script:`,
`notebook:`, `run:`, modules, wrappers, checkpoints) because TDEase cannot parse it. This
is a mechanical integrity boundary, not a restricted workflow language. The Agent stops
rather than guesses when a Node is missing, detail is unreadable, an input is unknown, the
snapshot cannot freeze, or dry-run fails.

**There is no generic Shell Node** in the catalog, frontend or workflow tools, and
the Agent must never turn shell calls into workflow structure. A managed Node may use
`shell:` internally; that is Snakemake source semantics, not a TDEase abstraction.

## 4. Product errors are not execution outcomes

A workflow that fails is **not** an API error: `POST /api/v2/runs` returns 201 and the Run
subsequently reaches `FAILED` with an `engine`-domain code. HTTP error status is reserved
for requests that were themselves wrong (invalid identity, unauthorized path, unknown
Node, malformed/stale plan). See `CORE-ARCHITECTURE.md` §5.

## 5. Client projection contract

The frontend is a projection and command surface, not another workflow engine. The
load-bearing rules: no component may synthesize Backend events, edit engine persistence,
or invoke Snakemake outside the Backend service; DAG/summary views render Backend-provided
native data only and never parse Snakefiles/logs to construct an authoritative DAG; Backend
cache presence is not user file truth. Submit/cancel/overwrite/trash are explicit commands
with permission gates; read/discovery/dry-run/observation run uninterrupted.

## 6. Non-goals

- No visual editor or form model as the canonical workflow source.
- No Node-only capability whitelist for Workspace computation.
- No generic Shell Node or arbitrary-command workflow block.
- No Task/Attempt/Invocation/job-status database entities.
- No separate Desktop and Server workflow APIs; no Agent-only Backend protocol.
- No success inference from logs or output-file absence.
- No framework-side reimplementation of Snakemake scheduling semantics.

## 7. Alternatives considered

> Sub-section contracts added after the original writing carry their
> defeated alternatives here.

- **Bare-pid liveness** for the slot claim and engine record — lost: Windows
  recycles pids, so a stale claim could wedge the queue or aim a kill at an
  unrelated process; `<pid>:<create_time>` is the identity.
- **Ordering QUEUED runs by `created_at`** — lost: resubmission preserves
  `created_at`, so an old resubmitted Run jumped every newer Run; the journal
  seq of the latest `run.queue_requested` is the honest arrival order.
- **Projecting results against the newest submitted definition** — lost: an
  in-flight resubmission borrowed its spec list for files it never produced,
  or made standing results vanish.
- **Re-raising worker exceptions outside the staged block** — lost: the escape
  requeues the claim and crash-loops invisibly (three crashes a minute would
  stop the whole Backend); containment + supervisor is the contract.
- **Normalizing newlines before the Snakefile comparison** — lost: the freeze
  is the Client's raw read, and normalizing one side manufactured
  `RUN_PLAN_STALE` out of identical content (CRLF templates could never
  submit); verbatim comparison at both sites is the fix.
- **A host-probing wrapper for bundled tools** (the msconvert.cmd era) —
  lost: it never looked in its own package directory, so any machine without
  a matching host install failed exit 127 while dev machines masked the
  defect; nodes bind their own binaries through the `config["nodes"]`
  snapshot path.
