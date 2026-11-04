---
type: design
title: Backend Run Service — trusted execution loop and team-service roadmap
description: Phase 1 designs (lifecycle state machine, command module, crash-safe submit, global queue ticket, execution lease, read-only CAS, staging protection, engine integration convergence) + Phase 2/3 scope and gates.
status: accepted
---

# Backend Run Service

Two layers live in this document. **Phase 1 is an implementable design** for the
trusted execution loop: every defect named below has a code anchor, a fix
contract, and an acceptance path. **Phases 2–3 are scoped roadmaps with gates**,
not designs — their details are decided when their gates are reached.
§2.10 records the landed engine-integration convergence: one integration
file, one DAG build per engine process, one execution-artifact record, one
relay discipline.

Source: backend architecture audit 2026-10-13 (10 candidates, 6 confirmed with
fault-injection or real-storage evidence). This document is the design
authority for the remediation; when a slice lands, the owning `spec/` passages
are amended in the same change (see §2.9).

## 0. Confirmed defects (evidence anchors)

| # | Defect | Anchor | Failure |
|---|---|---|---|
| D1 | Journal and SQLite each interpret lifecycle | `src/services/run_index.py:270-283` applies `STATUS_BY_EVENT` per event with no open-range/pending-queue semantics, while `src/execution_runtime/run_projector.py:166-235` keeps RUNNING while a range is open and flips to QUEUED on terminal | Run A running, revision B submitted → journal projects QUEUED after A terminates, index says SUCCEEDED; worker misses B |
| D2 | CAS inputs shared as writable hardlinks | `src/execution_runtime/storage.py:1085-1098` `_link_blob` links the blob inode into the run tree read-write | An in-place input modification rewrites the CAS blob and every sibling Run's input; `verify_local_inputs` (storage.py:1100) detects it after the damage |
| D3 | Commit is not crash-atomic | `app/api/runs_v2.py:813-842`: definition snapshot → run.json → index → events. Crash after run.json, before events → same-key retry takes the idempotent branch (runs_v2.py:702) → `_run_status_response` folds an empty journal → `RUN_NOT_FOUND` 404, forever |
| D4 | Recovery judges engine liveness, not worker ownership | `storage.py:1538-1580` `reconcile_orphaned_runs`: RUNNING + open range + engine dead → `run.failed "orphaned"`, even when the live worker is publishing the manifest (engine exit precedes finalization). Runs on every API start (`app/main.py:70`). Also releases the worker's run claim unconditionally (storage.py:1524), and a rescue terminal can double with the worker's own terminal (`ALLOWED_FROM` then raises on every later projection) |
| D5 | Cross-Run queue order compares per-Run journal seqs | `run_index.py:492-501` orders by `queued_seq` — each Run's local counter; `run_worker.py:157` same; filesystem fallback orders by `created_at`/mtime (run_worker.py:158-164) — a second ordering | A newly submitted Run (local seq 2) jumps a resubmitted older Run (local seq 200); order differs by index health |
| D6 | Upload staging protected only by a 5-minute GC grace | `storage.py:1385` `gc_unreferenced_blobs(min_age_seconds=300)`; called at worker start (`run_worker.py:112`) and on purge | A multi-file upload older than 5 minutes and not yet committed is collected by a worker restart; submission then fails `WORKSPACE_BLOB_NOT_FOUND` |

## 1. Target shape — one authority per fact

The refactor introduces **one writer and one interpreter per fact**:

| Fact | Authority after Phase 1 |
|---|---|
| Lifecycle state | `events.jsonl` journal, folded by ONE state machine (`run_projector`); SQLite `runs.status` is a cache written only by the command module |
| Queue arrival order | A global monotonic ticket minted once per queue request, carried in the journal event and cached in the index |
| Execution ownership | A per-execution lease naming the worker process identity, covering claim → start → engine → verify → manifest publish |
| Commit atomicity | The command module's submit sequence: journal first, `run.json` pointer last, idempotent by (run_id, definition_revision_id) against the journal |
| Blob immutability | Read-only CAS blobs; the run tree is the only writable surface |

What deliberately stays: SQLite as a rebuildable cache (never authority), the
single global execution slot, hardlink-based zero-copy inputs, the per-run
event write lock, the supervisor-restarted stateless worker, Snakemake as the
only workflow-semantics authority.

## 2. Phase 1 — trusted execution loop (designs)

Work is sliced so each lands with the root suite green. Slices S1–S6 in §2.8.

### 2.1 Single lifecycle state machine

`run_projector.py` gains an explicit incremental state object:

```python
@dataclass
class LifecycleState:      # the fold state of project_run, made first-class
    status, projected_at_seq, current_revision_id, queued_mode,
    queued_at_seq, pending_queue, ranges, open_range_index
    def apply(self, event) -> None          # table-driven, raises on illegal transition
    def snapshot(self) -> RunProjection

def project_run(events) -> RunProjection    # = reduce(apply) over a normalized prefix
```

`project_run` becomes a fold over `LifecycleState.apply`; the legacy-event
normalization stays at the replay boundary. **`RunIndex.project_events` stops
writing `status` entirely** (delete the `STATUS_BY_EVENT` update and the
`queued_seq` write); it keeps only derived tables (jobs, tasks, graph,
progress counts). The status cache is written by the command module (§2.2) as
the fold result of the transition it just appended — under the same run event
lock — and by `reconcile()` after a full fold.

### 2.2 Run Command Module

New module `src/services/run_commands.py` (singleton `get_run_commands()`),
sitting at the same layer as `run_index`/`run_worker` (imports
`execution_runtime` primitives; both API and worker call it). It is the **only**
component that constructs lifecycle `run.*` events (the EventEmitter stays the
low-level append primitive; the adapter's `run_started` emit moves here, §2.5).

```python
class RunCommands:
    def submit(commit, *, snake_text, actor) -> SubmitOutcome
    def queue(run_id, revision_id, mode, rerun_mode, actor) -> int      # returns ticket
    def begin_execution(run_id) -> Lease        # appends run.started + acquires lease
    def heartbeat_stage(lease, stage) -> None   # lease observability, no liveness role
    def finish(run_id, outcome, *, run_time_seconds, ...) -> None       # the only terminalizer
    def cancel(run_id, queue_ticket) -> None
    def reconcile() -> list[str]                # the only recovery pass
```

Every method takes the per-run event lock for the whole decide-and-append
critical section (today the lock wraps only the append, so the worker's
check-then-act races reconcile's check-then-act — the D4 double-terminal
window). `finish()` re-folds inside the lock and appends a terminal only if
the range is still open; the manifest-rescue decision (a manifest whose
`journal_seq` covers the open range → `run.succeeded`) moves into `finish()`.

### 2.3 Crash-safe submit, journal-keyed idempotency (fixes D3)

Validation (binding resolution, containment, sealing, Snakefile agreement)
stays read-only-plus-CAS-sealing in the API layer and precedes all of this —
unchanged. The durable sequence in `submit()`:

1. `freeze_definition` (pure) → `write_definition_snapshot` (idempotent,
   content-addressed `definitions/def-<hash>.json`).
2. Under the run event lock, fold the journal:
   - no `run.submitted` for this `definition_revision_id` → append it;
   - no pending/active queue request naming this revision → mint a ticket
     (§2.4) and append `run.queue_requested` carrying `queue_ticket`.
3. Write the `run.json` pointer **last** (atomic). It is derivable from the
   snapshot; it is never the commit record.
4. Index row upsert + status cache write.

Convergence: any crash window retries to the same state — events exist →
skipped; pointer missing → rewritten; `run.json` without events (legacy
zombie from D3) is completed by `reconcile()` (§2.5): journal has
`run.submitted` but `run.json` is missing/stale → rewrite the pointer from
the definition snapshot. A crashed submit that is never retried leaves a
journal-backed Run that reconcile makes visible and queueable — no ghost, no
404. The idempotent-response branch in `_create_run` consults the journal
fold (not `run.json`) and can no longer observe "run.json exists, journal
empty".

### 2.4 Global queue ticket (fixes D5)

Queue arrival order becomes a deployment-global monotonic integer.

- **Minting**: append one line `{ticket, run_id, revision_id, ts}` to
  `data/.runtime/queue.tickets.jsonl` under a global lock (same lock pattern
  as the event lock). Ticket = line count. Wasted tickets after a crash are
  fine — monotonic, not dense.
- **Recording**: the `run.queue_requested` event data carries `queue_ticket`;
  the SQLite column becomes `queued_ticket` (schema v5; `queued_seq` stays
  only as the per-run execution-attempt identity — the cancel flag and the
  log-attempt marker keep using it).
- **Ordering**: `queued_run_ids` orders by `queued_ticket`; the dequeue
  filesystem fallback reads the same mint log instead of `created_at`/mtime.
  One ordering everywhere. Rebuild: the journal alone suffices (each event
  carries its ticket); the mint log exists only to mint.
- HTTP surfaces expose `queue_ticket` additively (status/list responses);
  protocol feature-detect-on-presence makes this a compatible extension.

### 2.5 Execution lease and reconciler rewrite (fixes D4)

The bare `claimed` flag is replaced by a lease record:
`.runtime/lease.json` = `{schema_version, worker_identity: "<pid>:<create_time>",
queue_seq, revision_id, stage, acquired_at, updated_at}`. The worker acquires
it at dequeue (O_EXCL) — before `run.started` — refreshes `stage` at the
existing stage boundaries (startup / queue-request / materialize / engine /
verify-inputs / manifest), and releases it after `finish()`. The global
`execution.claim` slot is unchanged (already identity-based).

`run.started` moves out of `SnakemakeAdapter` into
`RunCommands.begin_execution()`, which appends the event and the lease as one
step; the adapter keeps job/task/graph events only.

`reconcile()` (now the single recovery pass, run by API lifespan and worker
startup; it takes a global reconcile lock):

1. `repair_events_file` (unchanged).
2. Commit completion: journal `run.submitted` present, `run.json`
   missing/stale → rewrite pointer from the definition snapshot (§2.3).
3. Per-run, under the run event lock:
   - **open range + live lease owner → leave everything alone** (worker owns
     the outcome through finalization; the engine being dead is expected
     during manifest publication). No claim release, no terminal.
   - open range + dead-or-absent lease → kill the engine tree via
     `process.json` (unchanged mechanics), then `finish()` with the
     manifest-rescue rule (manifest covers the range → `run.succeeded`;
     else `run.failed "orphaned"`).
   - QUEUED + stale lease → release lease, `orphan_reclaimed` audit event
     (today's semantics, minus the unconditional release of live claims).
4. Legacy `claimed` files without a lease are treated as dead-owner leases
   (one migration pass); after migration the file is gone.

The unconditional claim release at storage.py:1524 is deleted — its
"no live worker exists" premise is false whenever only the API restarts.

### 2.6 Read-only CAS sealing (fixes D2)

`blob_put` and `blob_put_stream` set the read-only flag (`os.chmod(tmp,
stat.S_IREAD)` on Windows → FILE_ATTRIBUTE_READONLY; `0o444` on POSIX) after
fsync, before the rename into `store/<shard>/<digest>`. Every hardlink
(`_link_blob`) then exposes a read-only inode in the run tree: an in-place
input modification fails at write time (access denied) instead of corrupting
the CAS and sibling Runs — a loud, early engine failure, not a post-hoc
digest mismatch. `verify_local_inputs` stays as the detector for
already-corrupted trees.

Consequences that are deliberate: the CAS copy of a sealed result is
read-only (results are digest-addressed, immutable by contract); run-tree
control files and outputs are unaffected (fresh files); the dry-run inline
path is unaffected (atomic_write, not CAS). A workflow that legitimately
rewrites an input was already contractually broken (WORKFLOW-RUN §1 —
inputs are sealed and shared); it now fails at first write with a remedy
pointing at "copy the input into an output path".

Migration: the reconcile pass sets the read-only flag on existing blobs that
lack it (lstat + chmod, idempotent, amortized over the store walk). The
legacy source-backed materialization path in `_materialize_run` (pre-sealing
definitions) is left as-is and documented as read-only-unsealed legacy.

### 2.7 Upload staging protection (fixes D6)

Upload completion touches a per-digest marker `store/.staging/<digest>` (the
upload endpoint and `seal_local_run_files` both count as "in flight"). GC
protects any digest whose marker is younger than `staging_ttl` (default 24h,
`backend_settings`). `submit()` removes markers for digests its definition
referenced once the queue event is durable. GC drops orphan markers (no blob,
or older than TTL and unreachable). The time heuristic remains only as the
outer bound for abandoned uploads; the five-minute window no longer decides
liveness. The client contract is unchanged. (Full resumable upload sessions
are Phase 2 §3.4.)

### 2.8 Slices, order, and verification

Each slice = implementation + spec amendment where it owns a contract + green
suites. Verification commands: `uv run --project tdease-backend pytest tests/`
(root suite, imports backend `src/`) and `cd tdease-backend && uv run pytest`.

| Slice | Content | New acceptance (e2e, fault-injected) |
|---|---|---|
| S1 | `LifecycleState` extraction; SQLite projector loses status writes; command module writes status cache + fold-shared transition table | Existing suites green unchanged; a revision queued mid-run projects RUNNING-then-QUEUED identically from journal and index after reconcile |
| S2 | Command module `submit`/`queue` (crash-safe order, ticket mint, journal-keyed idempotency); dequeue single ordering | Kill the API between every pair of durable writes (injected storage failure); same-key retry converges, never 404; FIFO: resubmitted old Run with a long journal precedes a newer Run's first submission |
| S3 | Lease + `begin_execution`/`finish`; `run.started` moves out of the adapter; reconciler rewrite; legacy `claimed` migration | API restart while a live worker finalizes an engine-dead Run → no false `run.failed`, no double terminal; dead-owner orphan → killed tree + single rescue/failed terminal; cancel-in-claim-window behavior preserved |
| S4 | Read-only CAS sealing + store-walk migration | A rule writing an input in place fails loudly; CAS digest and a sibling Run's linked input are byte-identical before/after; sealed results still download |
| S5 | Staging markers + TTL GC protection + submit marker cleanup | Blobs uploaded, aged past 300 s, unreferenced, marker fresh → survive a worker-restart GC; stale markers → collected; referenced digests → markers removed |
| S6 | Docs sync: WORKFLOW-RUN.md (ticket ordering replaces `queued_seq` ordering language; lease/ownership wording; read-only CAS; commit-order statement), STATUS.md rewrite, BACKEND-HARDENING cross-links | Docs state exactly what the tests pin |

### 2.9 Spec impact (amended in-slice, not after)

`spec/WORKFLOW-RUN.md` owns: queue ordering (§ "Queue order…"), supervision
wording (claim/lease), the hardlink-or-fail input contract (gains
read-only), and submission semantics. Each slice amends the owning passages
in the same commit — the spec never drifts behind landed code, and no
conflict is left for STATUS.md to record.

### 2.10 Engine integration convergence

Landed with Phase 1 (audit follow-up): every internal touchpoint the
embedded Snakemake integration relies on now lives in one file
(`src/execution_runtime/engine_runner.py`) and obeys three disciplines.

1. **Execution artifact record.** At the end of a successful execute-mode
   run the engine process writes `.tdease/execution-outputs.json` from its
   own DAG — the run-relative outputs of the jobs it put in the needrun set
   for this attempt and saw finish. Up-to-date jobs (resume) are excluded —
   their outputs stay attributed to the execution that produced them, and
   the manifest keeps them through the retained-claims merge; a dry-run
   writes no record. The record is the only attribution authority for what
   an execution produced: the results manifest joins it with the ran
   definition's explicit `result_specs` and previously claimed entries —
   never Snakefile text parsing (the rule-all parser `declared_outputs.py`
   is deleted) and never a sweep of the shared run tree
   (WORKFLOW-RUN §"Results belong to the revision that produced them").
2. **Event-relay complete-line discipline.** The adapter forwards engine
   job-event frames through a byte cursor that moves only past complete
   lines (`read_complete_lines_from`, shared with journal replay): the
   engine appends frames byte-wise, so acknowledging a half-written line
   would lose that event forever. A final pass after engine exit drains the
   tail; only parsing/validation is guarded — a malformed frame is reported
   loudly (runtime error record + warning event) without blocking the
   frames behind it, and emission is not. Engine output is relayed verbatim
   (the branding rewriter is deleted); every lifecycle `run.*` event
   belongs to the command module (§2.2), and the adapter refuses an engine
   attempt whose open journal range does not name its revision and mode.
3. **Single graph composition.** The engine process builds the DAG exactly
   once: the private `_prepare_dag`/`_build_dag` run with the arguments
   `Workflow.execute()` itself would pass (mirrored off the one
   `ExecutionSettings` instance the executor uses), and both are then
   pinned to no-ops on the workflow instance so the public
   `execute_workflow()` entry keeps working while the projection, the
   resource feasibility assertion, and the executor all consume this one
   graph.

**Upgrade goal**: one integration location and one locked dependency set
per upgrade. `tests/test_engine_integration_contract.py` locks every
internal touchpoint — the API entry chain (`SnakemakeApi.workflow` →
`WorkflowApi.dag` → `DAGApi`), the `FilePersistence` seam, the private
one-build surface, the job-level DAG members the projection and the record
read (`jobs`/`needrun`/`finished`/`jobid`/`dependencies`), the LogEvent
names the job-event handler maps, the settings fields the single build
mirrors — so a dependency upgrade that moves any of them turns red pointing
at `engine_runner.py` and nowhere else.

## 3. Phase 2 — single-server team service (scope and gates)

Entered when Phase 1 suites are green. Design decided at gate entry; the
scope boundaries are fixed now:

1. **Principals and project permissions.** Accounts beyond `local-owner`;
   the `_is_owner`/`_owned_run` enforcement points (runs_v2.py:339-367)
   already exist and deepen to project membership. Token tiers keep the
   owner/agent scope split (including `run:purge` denial); add revocation
   and Agent delegation scopes. Blob and workspace-root capability checks
   gain per-principal scoping (today: `workspace_roots.resolve` keyed by
   `user_id`).
2. **Contained execution.** Engine + tool children under a Windows Job
   Object with memory limits (the desktop already ships job-object process
   ownership — reuse the pattern); read-only tool/catalog and input surfaces
   (Phase 1 §2.6 delivers the CAS half); per-run writable scratch; env
   allowlist (`backend_child_env` today is the seam).
3. **Independent server lifecycle.** `serve` under a service manager;
   graceful drain (finish in-flight, stop dequeue) as a first-class verb;
   readiness reflecting slot/queue/disk/worker-liveness, not import success.
4. **Admission and upload.** Queue caps; per-principal fairness at dequeue
   (round-robin over tickets); a bounded dry-run path that does not queue
   behind the single execution slot; resumable upload sessions replacing the
   marker heuristic.
5. **Operations.** Metrics (worker lease age, queue depth/wait, disk, index
   projection lag); documented backup/restore (data root = database +
   runs/ + store/); drain-upgrade and failure-convergence procedures.
6. **Capability provenance.** Each definition records engine version, node
   catalog digests, toolbox version actually used; release pinning is
   decided from reproduction needs, not pre-committed.

## 4. Phase 3 — multi-host (gate: load evidence)

Not designed. Gate: sustained queue-wait or utilization evidence that a
single serial slot cannot serve. The known non-portable pieces this phase
would replace: local PID liveness and file locks (→ TTL leases with
heartbeat), single-writer journal appends (→ fencing epoch on append),
hardlink CAS (→ shared store or blob service), local slot (→ admission
scheduler). None of these may leak into Phase 2 interfaces.

## 5. Non-goals (Phase 1)

- No HTTP breaking change; new fields (`queue_ticket`) are additive.
- No client/desktop change is required (feature-detect-on-presence).
- No parallel execution, no scheduling policy, no new queue entities.
- No Task/Attempt database entities (WORKFLOW-RUN §6 stands).
- SQLite never becomes an authority.

## 6. Alternatives considered

- **SQLite run-queue table as the queue authority** — lost: the journal is
  already the lifecycle truth; a second authority re-creates D1, the exact
  defect being removed. The ticket is carried by the journal event; SQLite
  only caches it.
- **Per-Run input copies instead of read-only hardlinks** — lost: violates
  the WORKFLOW-RUN §1 zero-copy contract (hardlink-or-fail is deliberate);
  the defect is mutability, not sharing.
- **Wall-clock timestamps for global queue order** — lost: clock steps
  reorder arrivals; an explicit minted counter is monotonic and rebuildable
  from the journals alone.
- **Heartbeat-based worker liveness** — lost: process identity
  (`<pid>:<create_time>`) is the shipped pattern, needs no writer, and has
  no "alive but stalled" failure mode of its own making.
- **Fixing the SQLite projector to mirror range semantics in SQL** — lost:
  two interpreters remain two interpreters; instead the status cache is
  written by the single component that appends events, folding with the one
  state machine.
- **Extending the bare `claimed` flag with an owner field instead of a
  lease record** — lost on observability, not correctness: the lease also
  records stage and target execution, which is what makes recovery and
  operations auditable; the flag is its degenerate form.
- **A dedicated recovery service/process** — lost: recovery is a fold over
  the journal plus liveness reads; a process adds a lifecycle to manage
  without adding a decision. The command module's `reconcile()` at API and
  worker startup is sufficient because lease ownership makes concurrent
  passes harmless (global lock serializes them anyway).
