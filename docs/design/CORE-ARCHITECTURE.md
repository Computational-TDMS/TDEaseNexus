---
type: design
title: Core architecture — the cross-cutting decisions
description: The cross-cutting decisions (event vocabulary, event projection, error envelope, enumeration).
status: implemented
---

# Core architecture — the cross-cutting decisions

> The cross-cutting decisions that are not obvious from reading the code. Implemented
> mechanics (the event vocabulary, Backend projection rules, error envelope, enumeration,
> the four truth stores) live in the code: `src/contracts/`,
> `src/contracts/errors.py`, `run_lifecycle.json`. This document records the
> *reasoning* a reader cannot recover
> from the code alone.

## 1. The event-and-projection model, and its three invariants

Everything that changes over time — Run status, Agent turn, Result readiness — is an
append-only event log (`events.jsonl`) plus a pure projection. Backend transition legality
lives in `run_projector.py` and `run_lifecycle.json`. Clients consume the public event
vocabulary and may derive display state, but never import or revalidate Backend internals.
Three invariants are not encoded by that mechanism:

1. **One writer.** Sequence numbers come from the append operation, never a caller.
2. **The projection is never a second truth.** Anything computed from events may be
   cached but must be reproducible by replay and discarded — never "repaired" — when it
   disagrees.
3. **The log records decisions and outcomes, never keystrokes.** Streaming deltas travel
   on the live channel and are not appended.

The last two are the ones code cannot enforce: a future contributor will be tempted to
"fix" a projection in place or log every token delta, and both corrupt the model.

### Execution ranges replace the Invocation entity

There is no Attempt/Invocation table. An **execution range** is the half-open interval
from a `run.started` to its terminal event; "which process produced this job event" is
"which range contains its sequence number"; job identity is
`(execution_start_seq, upstream_job_id)`, meaningful only inside its range. **At most one
range may be open per Run** — that single sentence is the entire concurrency control for
execution. This is recorded because the obvious design is a state machine, and the
state machine is wrong here.

## 2. `ResultRef` has two readings — and that is the whole design

Continue/Recompute preserve `result_id` but change the digest. The reference type's
optional `digest` field resolves the ambiguity deliberately:

| Form | Reads as | Used by |
|---|---|---|
| digest omitted | *the current value of this result* | Result documents, navigation, Agent analysis |
| digest present | *exactly this value* | Evidence, provenance, published claims |

Evidence pins (digest present) so a scientific claim stays attached to the bytes it was
made about; a pinned reference whose value no longer exists is `unavailable`, reason
`superseded` — not an error to paper over.

## 3. Scientific dimensions are declared, never inferred

Dimensions live in `result_specs` at authoring time, written by whoever knows the wildcard
semantics. **TDEase never parses a path to guess that `sample-a_features.tsv` concerns
`sample-a`.** Path-shape inference is the fragile pattern the architecture rejects
everywhere, and breaks on the first workflow that nests differently. Dimensions never
participate in computation (Snakemake wildcards do that); two Results in one Run may not
share both `kind` and the full dimension tuple (`prepare` rejects the collision rather
than silently picking).

## 4. Concurrency and lifetime — the non-obvious rules

Most lifetimes are obvious from the code; two are not:

- **A second user message while a turn is active is rejected with `TURN_ACTIVE`, not
  queued.** Queueing hides the authority model — the user would be approving actions for
  a turn whose context they can no longer see.
- **Workspace switch is one `dispose()`, not a checklist.** `StudioRuntime` owns the plan
  registry, subscriptions and caches precisely so switching Workspace can tear the whole
  thing down at once; the isolation test is "switch, then assert the previous runtime's
  subscriptions are closed and its registry empty". A Run survives the switch — it is
  Backend state observed through a subscription, not Client state owned by a session.

## 5. Product errors are not execution outcomes

> A Snakemake job failing is **not** an API error. It is a successful observation of a
> Run that failed.

`POST /runs` returns 201; a workflow failure surfaces later as a `run.failed` event with
an `engine`-domain code. Turning that into a 5xx tells the Client the request was wrong
and invites a retry that repeats the failure. This is the one rule that is both
non-obvious and easy to regress — every layer wants to make a failed Run look like an
HTTP error.

The error domain split is in `errors.py`; the one non-obvious separation is
**`environment` vs `backend`**: `environment` is the one class the user can usually fix
themselves (install a dependency, free disk, grant a permission), and collapsing it into
"internal error" is what makes desktop scientific software feel broken when it is merely
unconfigured.

## 6. The entity criterion: what earns durable identity

Every entity costs seven obligations (identity, storage, lifecycle, migration,
authorization, GC, UI+Agent vocabulary). An entity exists **only if both** hold:

1. **Cross-creator reference** — something outside must name it *after* its creator is gone.
2. **Not derivable** — delete it, and it cannot be recomputed from remaining truth.

Satisfying only the first makes it a reference; only the second makes it a file.

This is the highest-leverage decision tool in the architecture because it **predicts**,
not just restates: an Evidence claim is cited across sessions and not recomputable →
entity (needs a stable ID and append-only ledger — why Evidence rejects `claims.jsonl`).
A PTM candidate exists only inside one line of reasoning → session event, never stored.
A cross-Run grouping ("the question") is recomputable from session logs and cited by
nothing after its creator is gone → projection — which is why sessions and Runs stay
many-to-many and neither owns the other. An entity that stops satisfying both must be
demoted, not kept for compatibility (`results.json`, the Invocation entity, the Task
table were each removed by this rule).

## 7. Client architecture — the structural decisions

- **The command registry is the spine.** The Agent tool surface and the UI use-case
  surface are projections of one registry; the Agent tool list is *computed* (registry
  filtered by permission), never authored. This makes three defect classes structurally
  impossible: a prompt/tool naming a non-existent command; a capability the UI has but
  the Agent lacks (or reverse); a permission enforced in one surface and forgotten in the
  other.
- **Feature intake asks one question: which of the four truth stores does it write to?**
  (Workspace files, Backend events, System assets, Session events.) "A new one" is almost
  always a design error. Deleting every derived layer (SQLite, caches, projections) must
  leave a working system — that rebuild runs in CI as the only mechanical proof the
  layering holds.
- **Run-first, not file-first.** VSCode's mental model is *a folder of files you edit*;
  TDEase's is *an analysis you run and interpret*. Copying the workbench shell wholesale
  imports file-first navigation that demotes the Run to a side panel and diffuses into
  every component. Two-layer disclosure follows: a scientific surface on the default path
  and a technical/verification surface reachable on demand (it must be completely
  reachable or computational users leave for a terminal; it must not be on the default
  path or the primary user is forced to become a workflow engineer).
- **The Agent is a page, and its outputs are Workbench documents.** The Agent lives on
  its own full page (the 2026-09-01 simplification removed the old right
  Agent/inspector column); surfaces it produces open as real documents — an
  `agent-run` tab reuses the Workbench's `RunDocument`, agent file tabs reuse
  `FileDocument` — so there is one document registry, one viewer per concern, and
  nothing about a Run is duplicated for the Agent.
