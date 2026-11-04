---
type: design
title: Studio frontend business logic
description: The non-visual Studio core — module layout, domain types, ports, use-case steps, command definitions.
status: implemented
---

# Studio frontend business logic

> The non-visual Studio core (`TDEase-FrontEnd/src/studio/`). The module layout, domain
> types, ports, use-case steps and command definitions are the code. This document records
> the invariants and the one import-direction rule that makes Agent parity structural.

## Invariants

1. Backend facts own Run/Node/Template/Result/execution state.
2. Workspace files own editable workflow/script/config truth.
3. Snakemake owns workflow semantics and incremental execution (the live
   engine layer — see STATUS Backend).
4. Frontend business logic coordinates these truths; it never recreates them.
5. Pinia stores expose reactive projections; they do not implement protocols.
6. Physical Backend/cache paths are adapters, never logical Result identity.
7. Agent tools call the same use cases as UI commands.
8. A changed Workspace snapshot invalidates every prepared plan derived from it.

## Import direction (the rule that matters)

`commands/` is the sole mutating verb surface; the Agent tool table is the same registry
filtered by permission, **derived never authored**. The Agent turn runtime is a sibling
module (`src/agent/`), and the one enforced boundary is:

> **`agent/` may import `studio/commands` and `studio/domain`; `studio/` must never
> import `agent/`.** The Agent is a client of the business core, not a peer.

Enforced as a lint rule, this is what makes Agent-native parity structural rather than a
review convention — there is no Agent path into the domain that is not a command the UI
could also invoke.

## PlanRef lifecycle

The model never authors a raw `CommitPlan`; the review-UI path (the `workflow.prepare`
/`dryRun`/`submit` trio, `agentVisible: false` — the Agent's atomic path is
`workflow.run`) handles plans through an opaque `planRef`
(Client-session-local, not a product entity). State goes `prepared → validating →
valid|invalid → submitting → consumed`; any non-consumed state plus a relevant Workspace
change → `expired`. Rules: `dryRun(ref)` reads the registry value never model arguments;
`submit(ref)` requires `state=valid` and a matching digest; approval is after a valid
dry-run and before side effects; registry eviction is harmless (prepare again).
`managedNodes` is optional — native script-only workflows are valid; there is no Shell Node.

## Two runtimes, one business core

`StudioRuntime` (plan registry, Run subscriptions, caches; one per Workspace session;
writes no truth directly) and the Agent `TurnRuntime` (Pi turn wrapper, session log,
budgets; one per Agent session) meet at exactly one place — the command registry. Both
are disposed by the same Workspace switch, which is a single `dispose()` not a checklist.
A turn in flight during a switch is cancelled, not migrated (its Workspace binding is
fixed at `turn.started`); a Run survives the switch (Backend state, observed not owned).

## Command registration invariants

Validated at module load so a violation is a startup crash: `id` unique; `mutates:true`
requires a permission action from the closed vocabulary; `mutates:false` must **not**
declare one (read-only exempt by construction, not policy lookup); `agentVisible:false`
requires a `hiddenReason` (Agent parity is opt-out with written justification, never
opt-in — rule 4 matters most: a new capability reaches the Agent unless someone argues in
writing otherwise); `args` must be an object schema (tool call and generated form share
one validator).

**What does not become a command:** pure view state (expanding a tree node, switching a
tab, scrolling). The test — if the Agent has no reason to invoke it and it changes no
truth, it is component state. A registry that also holds view toggles becomes a second
event bus. Commands throw the structured envelope from `CORE-ARCHITECTURE.md` §5; the
prompt-names-only-registered-tools rule is a build-time test, not review.

## Command family layout (capability seams)

`commands/registry.ts` is the contract layer — `CommandDefinition`, the
`CommandContext` port aggregation, and the `CommandRegistry` kernel. Each
command family lives in its own module under `commands/families/` — the thirteen
capability seams: discovery (nodes+templates), workflow, runs, reference,
skill, evidence, turns, session, subagent, orchestrate, ptc, job, view — one port
seam per module, with the family's schemas, input builders, and
`require<Port>` guards beside the definitions that use them. Cross-family
vocabulary (arg coercers, schema builders) lives in `commands/args.ts`.
`commands/definitions.ts` is the assembly manifest — the only place families
compose, in registration order. Families importing each other or the manifest
is a lint-grade violation (asserted in `src/architecture.test.ts`): a seam
that reaches into a sibling recreates the single-file coupling the split
removed. Adding a capability = one family module + one manifest line;
`registry.ts` changes only when the port vocabulary itself grows. (The former
`spectra`/`knowledge`/`gene`/`canvas` families are retired — runs absorbed
run-file reads, the wiki pivot removed the knowledge surface, the experience
genes were removed with their family, and Canvas has no agent-facing commands;
git history holds them.) Exposure metadata gates visibility (fail-closed):
`evidence.*` stays registered — the UI's PROV surfaces share it — but
`withoutEvidenceCommands` strips it from every session profile.
`nodes.install` copies a Workspace node-package folder into the LOCAL Backend
catalog (Electron main owns the copy; `rules.smk` required, existing ids
refused, bytecode residue filtered) and is withheld entirely under a remote
`backendConnection` — that host owns its catalog.

## Backend link

The client speaks the per-launch bearer contract end to end
(`spec/WORKFLOW-RUN.md` §2): every authenticated call goes through
`TDEaseClient.authFetch`, which on a 401 re-handshakes through the desktop
bridge ONCE and retries only when the launch token actually changed
(`backend-auth-recovery.test.ts`); the SSE parser natively ignores the
Backend's `: ping` keepalives. `DryRunProjection` nodes carry the engine's
resolved `threads`/`resources` (the observable clamp, WORKFLOW-RUN §1). The
compute envelope is Backend-owned: `CommitPlan`/`AnalysisCommit`/
`PreparedPlanView` declare no `cores`/`memoryMb` (a caller-sent value is
rejected by name); `RunSummary.cores`/`RunInfo.cores` remain and display the
Backend's injected budget. New auth codes (`AUTH_ORIGIN_FORBIDDEN`,
`AUTH_SCOPE_DENIED`) flow through the generic envelope reader.
