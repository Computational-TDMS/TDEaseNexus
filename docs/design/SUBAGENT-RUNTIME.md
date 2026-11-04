---
type: design
title: Subagent runtime — the delegation interface, roles, parallelism/persistence/discovery, and the floating panel
description: tdease.subagent.spawn/status/cancel/spawnGroup/list/peek, role SKILL.md, the §6 result envelope, reload persistence, parallel groups, model discovery, the right-side floating panel, scaffold equivalence.
status: implemented
---

# Subagent runtime

> Status: **implemented.** The primitives (`tdease.subagent.spawn` / `.status` /
> `.cancel` / `.wait` / `.followup` / `.spawnGroup` / `.list` / `.peek`) are exposed
> via the Studio command registry;
> `electron/agent/subagent-registry.ts` drives the **same** `AgentRuntime`. The role
> mechanism is data-driven (§4), but **no role ships today**: `system/subagents/` is
> empty and only `role: 'generic'` resolves — the four roles once defined there
> (orchestrator / discovery-specialist / evidence-specialist / ingestion-executor)
> were removed; the scan roots and frontmatter contract remain the extension path
> (§9a). The renderer read-side contract is `src/contracts/subagent-runtime.ts`. A
> real run on 2026-08-03 spawning two evidence-specialists in parallel is the
> equivalence proof (§12; the role files it used no longer ship). Role
> `system_prompt` injection via `BindSessionInput.systemPromptOverride` (2026-08-10).
> Contract boundaries: `docs/spec/AGENT-CONTRACT.md`.

## 0. Decision summary

| # | Decision | Rationale |
|---|---|---|
| D1 | A subagent = an ordinary bound session, on the same `bindSession`/`prompt`/`dispose` surface | No second agent loop or new abstraction layer; the only differences are an independent sessionId + a narrowed tool surface |
| D2 | Three primitives, no skill wrapper: `spawn`/`status`/`cancel` (since widened with `wait`/`followup`/`spawnGroup`/`list`/`peek` — still primitives, still no skill wrapper) | Delegation is the minimal action set; wrapping a skill around it would only duplicate loop logic |
| D3 | spawn returns `{subagentId}` immediately; the child prompt runs in the background | The parent is not blocked by the child; the parent command is already human-gated, the child gets no per-tool approvals |
| D4 | Roles are defined by the frontmatter of `system/subagents/<role>/SKILL.md` | Roles = data; adding a role adds a file, no runtime changes |
| D5 | The `system_prompt` field is injected via `systemPromptOverride`; a role = base fragment + dedicated fragment | Composability: a new role adds only its dedicated fragment; the base operating contract is reused |
| D6 | Child result = a single §6 JSON envelope | The parent reads one structured conclusion and never parses the child's conversation stream |
| D7 | Cancel keeps partial results; settle as blocked/cancelled rather than an empty success (the once-planned per-role wall-clock timeout is gone — children run to their prompt's settlement) | A half-finished child still has an actionable conclusion |
| D8 | orchestrator is the only role that can nest spawns | Fan-out is the orchestrator's job; the narrowed specialist surface has no `subagent.*` |
| D9 | The scaffold (agent-harness) uses the same `createAgentRuntime` | The delegation primitives are automatically present; no separate eval mechanism needed |
| D10 | Parallel group `spawnGroup({tasks:[]})` = N ordinary spawns sharing a `groupId` | The group is only a UI aggregation label; in-process concurrency = interleaved turns, no threads needed |
| D11 | Reload persistence: each run writes `<sessionDir>/subagents/<id>.json`; on re-bind, `restoreActiveJobs` | In-process children die with the process restart; running records are marked `blocked` + `SUBAGENT_ORPHANED`; history and partial results kept |
| D12 | Model discovery `subagent.list`: scans `system/subagents/*/SKILL.md` frontmatter | Decouples prompts from the role roster; adding a mass-spec role = dropping in one SKILL.md; `list` reflects it automatically |
| D13 | Subagents run **in-process** (same Node bound sessions); detached OS processes are not ported | Detach has low value in the desktop scenario and several times the work; persistence already fills the reload gap |
| D14 | Right-side **floating panel** `SubagentPanel.vue` (not a session tab), four zones: groups/list/envelope/peek | Subagents are an ambient activity stream, not pinnable documents; independent of `agentTabsStore` |

## 1. First principle

A subagent **is just an ordinary bound session**. It uses exactly the same
`bindSession` / `prompt` / `abort` / `dispose` / `fork` surface as the parent session —
no new agent loop, no new abstraction layer. The only differences: (a) an independent
sessionId (`sub_<role>_<uuid>`); (b) a tool surface narrowed from the role's
`allowed_tool_refs`. The single-host `SessionHost` is unchanged: each child **is its own
host**.

This principle rules out every temptation to "write a second engine for subagents". The
delegation interface is merely the **external opening** of the existing runtime — the
same internal TS code, one more caller.

## 2. Data flow

```
Parent session (bindSession → prompt)
  │
  │  tdease.subagent.spawn {role, task, input?}
  ▼
createSubagentRegistry.spawn
  │  readRole(<role>/SKILL.md)  → allowedToolRefs, profile, systemPrompt
  │  buildRoleSystemPrompt      → subagent_base.md + role.system_prompt
  │  narrowAgentTools           → narrows the parent tool surface
  │  runtime.bindSession({ sessionId: sub_<role>_<uuid>, authority: <parent's>,
  │                        delegation: { parent ceiling, parent presenter },
  │                        agentTools: narrowed, systemPromptOverride })
  │  runtime.prompt({ message: task + structured input })   ← background fire-and-forget
  ▼
returns { subagentId }  (immediately; the child is still running)

Child settles: readResult(child events) → parseResult(§6 envelope) → written into the run record
Parent receives the result (either path; one suffices):
  (A) Automatic injection (default): registry.drainSettled() takes out newly settled children → the
      tdease-extension context hook injects the §6 summary as a user message into the next provider request.
      After spawn there is **no need to wait/poll** — this is the main path for background subagents,
      fully isomorphic to tdease.job.start. drainSettled marks notified; each completion is injected once.
  (B) Explicit pull: subagent.wait hands the result directly to the model; it likewise marks
      notified, so a result already consumed by wait is not re-injected by (A).
      (`subagent.status` / `subagent.peek` are registered but agent-invisible — UI-only, §3.)
  When followup re-enters running, notified is cleared and new completions are injected again.
```

## 3. Tool surface (the delegation primitives)

`src/studio/commands/definitions.ts` registers the commands; tool-gateway exposes them
as `tdease.subagent.*`. All of them pass the `enabled` gate `Boolean(context.subagents)` —
available only when the parent session is bound (registry created). `drainSettled` is
not a model tool; it is the registry's internal drain primitive for the context hook
(same as `JobCommandPort.drainSettled`).

| Command | Signature | Notes |
|---|---|---|
| `subagent.spawn` | `{role, task, input?, toolAllowlist?, context?}` | binds a child session, runs in the background, immediately returns `{subagentId}`. Named specialists are always fresh; `role='generic'` skips the SKILL.md, and only generic may use `context:'fork'` to clone the parent session |
| `subagent.spawnGroup` | `{tasks:[{role,task,input?,...}], concurrency?, groupId?}` | parallel fan-out: N ordinary spawns sharing one `groupId`; returns `{groupId, subagentIds}` (§3a) |
| `subagent.status` | `{subagentId}` | returns `{state, elapsedS, groupId?, result?, error?}`. `state ∈ {running, returned, blocked, cancelled}`. `agentVisible:false` (UI-only). Marks notified once settled (suppresses duplicate injection) |
| `subagent.wait` | `{groupId?/subagentIds?, all?}` (exactly one selector, or neither to collect every child) | blocks until the first selected child settles (`all:true` or unscoped waits for every child); the turn's AbortSignal settles it immediately on user stop (AGENT-CONTRACT §2) |
| `subagent.followup` | `{subagentId, message}` | re-binds the same child sessionId and sends one more prompt — the single resume primitive; notified is cleared so new completions re-inject |
| `subagent.list` | `{}` | discovers roles: scans the role SKILL.md roots (§3b) → `[{name, description, defaultContext?, output?}]` (§9a) |
| `subagent.peek` | `{subagentId, lines?}` | tail-reads the child's recent activity: `{recentTools, lastAssistantSnippet, state}` (§3c). `agentVisible:false` (UI-only — transcript peeking is inspection; Agent orchestration uses `wait`) |
| `subagent.cancel` | `{subagentId}` | abort + dispose the child; settles as `cancelled`, keeping partial results |

The family's exposure is `mindsets: 'all'` and it carries no Agent-Tools setting:
delegation is a mindset-agnostic capability; both analysis and workflow can
delegate.

### §3a Parallel groups

`spawnGroup` loops `tasks[]` into `spawn`, each task carrying a `groupId` (default
`grp_<uuid>`). `concurrency` limits simultaneous binds (a bounded queue in-process;
default = the task count); "parallel" = interleaved turns, not OS threads.
`SubagentStatus.groupId` lets the UI aggregate by group ("3 evidence: 2 returned, 1
running"). It is **not** pi-subagents' chain (sequential steps + template variables) —
that is a future enhancement, addable by reusing the same spawn primitive.

### §3b Model discovery

`listAgents`/`subagent.list` scans the two role roots (§9a), extracting
`name`/`description`/`defaultContext`/`output`. The model runs `list` to see the roster
before spawning an unfamiliar role and **never hardcodes role names** —
`delegation_policy.md` is therefore decoupled: adding a mass-spec role takes just one
SKILL.md drop, no prompt changes.

### §3c Conversation-stream peek

`peek` reads the tail of the child's `events.jsonl` via
`SubagentRuntime.readSessionEvents`, compressed into `{recentTools(≤15),
lastAssistantSnippet(≤lines×80 chars), state}`. The floating panel's "activity" zone
and the `subagent.peek` command share the same implementation; the command is
`agentVisible:false` — the model's wait surface is `subagent.wait`, never transcript
peeking. Failure/no events → returns `state` only.

### §3d Reload persistence

Each run mirrors the `SubagentStatus` projection into
`<workspaceRoot>/.tdease/sessions/<parentSessionId>/subagents/<subagentId>.json`
(written on every `emitChange`). At construction, `createSubagentRegistry`'s
`restoreActiveJobs` scans that directory to rebuild the in-memory map: running records
are marked `blocked` + `SUBAGENT_ORPHANED` (the in-process child died with the process,
unrecoverable); history and partial results are kept. History survives workspace
switches/restarts. When `workspaceRoot` is absent, it degrades to pure in-memory (old
behavior).

## 4. Roles

> **Contract moved.** The role frontmatter schema (the four parsed fields, the
> scan roots, the generic fast path) lives in
> `docs/spec/AGENT-CONTRACT.md` §5.2 (distilled there 2026-10-12).

## 5. Tool-surface narrowing

`narrowAgentTools(allowlist, parent.agentTools)` narrows the parent's coarse-grained
buckets by allowlist:

| Bucket | Opens when (allowlist hit) |
|---|---|
| `discovery` | `nodes` / `templates` prefixes |
| `workflow` | `workflow` prefix |
| `runObservation` | `RUN_OBSERVATION_COMMANDS` (incl. `runs.list`) |
| `runControl` | `RUN_CONTROL_COMMANDS` (incl. `runs.resume`) |
| `workspaceWrite` | `write` / `edit`, or a studio command carrying the `workspace.write` permission |
| `shell` | `bash` |
| `mcp` | `mcp` |

The science buckets (reference etc.) are open by default for
analysis/workflow; the allowlist can only narrow, never widen. An explicit
`toolAllowlist` at spawn overrides the SKILL-derived surface. The
`experience` switch rides through like every other Agent-Tools setting, so a
narrowed child sees `gene.read` exactly when the parent does. The shipped
generic role's allowlist is the base set (`read`/`grep`/`find`/`ls`/`bash`/
`skill.read` + `write`/`edit` for the general profile) — no `subagent.*`, so a
generic child cannot nest spawns.

## 6. Result envelope protocol

> **Contract moved.** The envelope schema, the coercion/fallback rules and the
> never-silently-drop guarantee live in
> `docs/spec/AGENT-CONTRACT.md` §5.2 (distilled there 2026-10-12).

## 7. Lifecycle

| State | Entered when |
|---|---|
| `running` | after spawn |
| `returned` | child prompt `outcome:'resolved'` |
| `blocked` | bind failure (`SUBAGENT_BIND_FAILED`), prompt failure, or outcome not resolved |
| `cancelled` | `subagent.cancel` |

There is **no wall-clock timeout**: a child runs until its own `prompt()` settles
(resolved → `returned`; cancelled → `cancelled`; anything else → `blocked`). A process
restart orphans a still-running child as `blocked` + `SUBAGENT_ORPHANED` (§3d). Only
`subagent.cancel` stops a child mid-flight, and it keeps the partial result (a
best-effort read of the child's last message) — nothing ever **silently settles as a
success**. (The spawnGroup args schema still accepts a per-task `timeoutS` — a vestige
of the removed timeout that the runtime does not consume; reintroducing a timeout must
restore the partial-result read with it.)

## 8. Nested spawn

Each bound child session automatically gets **its own** `createSubagentRegistry`
(driven by the same runtime). A child whose `allowed_tool_refs` include
`subagent.spawn` can spawn specialists inside the child session — fan-out. Any
surface without `subagent.*` (the shipped generic allowlist, or a role that
omits the prefix) **cannot** spawn again. "Only delegating roles fan out" is
guaranteed structurally, not by discipline.

`context:'fork'` calls `runtime.fork(parentSessionId, childSessionId)` before
bindSession, cloning the parent's conversation + Pi transcript into the child
directory; the child continues from that point. If the parent has not yet run a prompt,
fork degrades to a bare spawn (no failure).

## 9. Renderer read-side contract and floating panel

`src/contracts/subagent-runtime.ts` is the **read-only** IPC surface (for renderer
observation; does not alter agent turns):

- `list(parentSessionId)` → full snapshot
- `cancel(parentSessionId, subagentId)` → settles the record
- `onChanged(parentSessionId, cb)` → incremental push
- `peek(parentSessionId, subagentId, lines?)` → the child's recent activity (one
  implementation shared by the panel and the agent-invisible `subagent.peek` command)

The snapshot element type corresponds one-to-one with `SubagentStatus`
(`src/studio/commands/registry.ts`) — there is only **one** subagent data model
(`RunRecord` → `SubagentStatus` projection); the renderer renders directly, with no
translation layer.

**Floating panel `SubagentPanel.vue` (not a session tab, D14)** — the third state of
the Agent page's right column (`SubagentPanel` / `AgentTabHost` / `ActivityCapsule`,
choose one), controlled by the local `subagentPanelOpen` ref, **not** registered in
`agentTabsStore` — subagents are an ambient activity stream, not pinnable documents.
Four zones:

1. **Parallel groups / fleet**: `store.groups` (active aggregated by `groupId`);
   clicking a member selects it for details.
2. **Run list**: reuses `SubagentList.vue` (flat records, cancel).
3. **Result envelope**: select a returned/blocked child → `{findings, evidenceLinks,
   confidence, openQuestions}`.
4. **Conversation peek**: select a child → `store.peek` returns `{recentTools,
   lastAssistantSnippet}`.

Entry: `Ctrl+Shift+D` (`AgentPage.openActivityTab` → `toggleSubagentPanel`) + the
`ActivityCapsule` subagent row (`@open-subagents` emit). The `agent-subagents` tab kind
was removed.

The store `src/stores/subagents.ts` gained `groups` (computed), `peeks` (cache), and a
`peek(id)` action.

## 9a. How to add a mass-spec analysis role

Adding a role = dropping a frontmatter'd `SKILL.md` into one of the two scan roots (on
collision, the global name wins): `tdease-ai-capability/system/subagents/<role>/SKILL.md`
(global) or `tdease-ai-capability/system/skills/<skill>/subagents/<role>/SKILL.md`
(skill-local, the paths `discoverAgents` actually scans). The frontmatter schema is §4 —
`parseFrontmatter` consumes exactly `allowed_tool_refs` / `subagent_profile` /
`thinking_level` / `system_prompt`; `name`, `description`, `defaultContext` and
`output` are `subagent.list` metadata. Fields like `max_tool_rounds` / `timeout_s`
from earlier drafts are not consumed — do not rely on them.

`subagent.list` reflects the new role automatically; `delegation_policy.md` is
untouched. Example: a "mass-spec script writing" role (writing PEP 723 scripts for
ad-hoc analyses) needs only `allowed_tool_refs: [bash, write, read]` + a note saying
"write scripts with PEP 723 headers run via `uv run --script`".

## 10. Prompt assembly model (composability)

The system prompt is assembled from **modular fragments**; a role = the common base + a
dedicated fragment. New roles add only their dedicated fragment; the operating contract
is reused without boilerplate copying.

**Main-agent fragments** (resident, `SystemPromptAssembler.ASSET_SEQUENCE`):

- `prompts/internal/delegation_policy.md` — teaches the delegation primitives
  (`spawn` / `wait` / `followup` / `cancel`) + the **mixed
  flow direction**: a single bounded heavy task goes directly to a specialist;
  multi-stage dataset tasks first spawn an orchestrator to fan out. When to delegate,
  how to use the primitives, faithfully relaying the §6 envelope, the role
  roster. Delegation is possible only when `subagent.*` is in the tool surface.

**Subagent fragments**:

- `prompts/internal/subagent_base.md` — the common operating contract: do **one**
  bounded task, act within the inherited authority ceiling, the final message must be the §6 envelope,
  honesty rules.
- The role's `system_prompt` (SKILL.md frontmatter) — dedicated instructions.

**Injection path**: `createSubagentRegistry.spawn` calls
`buildRoleSystemPrompt(systemAssets, profile)` = `subagent_base.md` + the role's
`system_prompt`, passed in via `BindSessionInput.systemPromptOverride`. `assembleForRun`
reads `binding.systemPromptOverride` → `SystemPromptInput.subagentRole` → the assembler
appends the `subagent_role` fragment after safety. The parent session sets no override;
the assembled bytes are unchanged.

If reading the base fragment fails, it degrades to the role prompt only (never fails
the spawn).

## 11. Runtime wiring

`electron/agent/agent-runtime.ts` `bindSession`: creates `createSubagentRegistry({runtime:
this, parent, systemAssets})` (§11.1), **before** tool-gateway creation, so the
`enabled` gates of `subagent.*` see it (§11.2). The registry pushes record snapshots to
the renderer via the `emitSubagents` callback (independent of the turn-event stream)
(§11.3).

- §11.1 — the registry drives **this** AgentRuntime through a narrow surface
  (`bindSession`/`prompt`/`abort`/`dispose`/`fork`/`readSessionEvents`), cloning the
  parent's model/mindset/workspace.
- §11.2 — `context.subagents` is ready before tool-gateway `enabled` checks.
- §11.3 — `emitSubagents` is separate from turn `emit`: the `RuntimeEvent` union stays
  pure; subagent records are a read-side data stream.
- §11.4 — the child inherits the parent's frozen permission ceiling verbatim
  (`delegation.permissionCeiling`) and carries the parent's authority label; it
  never re-resolves the workspace policy, so a child can never out-permit its
  parent. An `ask` decision inside the child surfaces an approval card on the
  PARENT conversation's stream (`approvalPresenterSessionId`) and resolves back
  to the child's coordinator by `approvalId` (2026-09-05 correction: the earlier
  `authority:'auto'` re-resolution let an ask-parent's child run bash unasked).
- §11.5 — role SKILL.md and skill SKILL.md both belong to the **SPECIFICATION** corpus;
  the prompt-contract gate (`prompt-contract.test.ts`) applies the same registry
  validation to their `allowed_tool_refs` / `tdease.*` names — roles too can reference
  only really registered commands.

## 12. Deferred items

Chain mode (sequential steps + template variables), per-role
defaultContext/output/thinking runtime consumption, and an in-process
child→parent intercom are deferred — the spawn primitive, parallel groups and
fire-and-forget envelopes cover current needs. The 2026-08-03 scaffold-proof
trajectory and the full implementation-status table live in
`archive/docs-prune-2026-10-12/` (git history holds them).
