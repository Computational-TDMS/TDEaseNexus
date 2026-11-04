---
type: design
title: Orchestration runtime — scripts as workflows + journal replay by call-index
description: orchestrate.run/wait/status; agent()/parallel()/pipeline()/phase() inside JS scripts route to the existing subagent registry; scripts execute in a node:vm realm with host bridges only (no process/require reach); completed calls are cached by positional index to support resumeFromRunId.
status: implemented
---

# Orchestration runtime

> Status: **implemented.** The three commands (`orchestrate.run` / `.wait` / `.status`)
> are exposed via the Studio command registry; `electron/agent/workflow-runtime.ts`
> executes model-written JS scripts inside a `node:vm` realm (host bridges only);
> `workflow-journal.ts` caches completed `agent()`
> calls by positional call-index. The `agent()` inside scripts is underneath just the
> existing `subagent.spawn` + `subagent.wait` (SUBAGENT-RUNTIME.md), **introducing no
> second agent engine**. Contract boundaries: `docs/spec/AGENT-CONTRACT.md`.

## 0. Decision summary

| # | Decision | Rationale |
|---|---|---|
| D1 | **Scripts execute inside a `node:vm` realm** with host bridges only (reversed from the original direct-`AsyncFunction` decision, 2026-10-13, task `10-12-orchestrate-isolation`) | The original D1 argued vm is "for determinism, not a security boundary" — true for the *permission* layer, but it ignored the credential-reach layer: an `AsyncFunction` body runs in the main-process scope, so a prompt-injected script reads `process.env` (backend bootstrap secret, provider keys), violating AGENT-CONTRACT §5.1. The realm (same construction as PTC-RUNTIME D7: single `__run` bridge + self-deleting bootstrap, JSON-only boundary) removes global-scope reach at ~30 lines, while permission-gateway + cwd containment keep holding underneath. NO wall-clock timeout is added — orchestrate runs legitimately block minutes+ awaiting sub-agents, so the isolation scope is credential reach, not DoS; `maxAgents` + AbortController remain the levers. Determinism still comes from the journal, not from banning globals |
| D2 | **Graft onto subagent-registry; don't build another engine** | The script's `agent()/parallel()/pipeline()` all route to the existing `subagent.spawn`/`spawnGroup`/`wait`. Violating D1/D13 (SUBAGENT-RUNTIME.md) — "subagent = ordinary bound session" — to write another engine would be piling on a second layer of garbage |
| D3 | Namespace `orchestrate.*`, not reusing `workflow.*` | `workflow.run`/`.validate`/`.submit` are already taken by the Snakemake Run commands (definitions.ts). The two are entirely different axes: a Snakemake workflow = a scientific-compute DAG; orchestrate = agent orchestration scripts. Reusing the prefix would have the model confuse them — exactly the "second source of truth" STATUS.md repeatedly warns about |
| D4 | Minimal scope for v1: 4 globals + journal + 3 commands | AGENTS.md iron law 2: end-to-end is the core; don't pile up unverified abstractions. Quality assistants/phase budget/UI panes/saved workflows all deferred |
| D5 | **bash does not enter scripts** | The script globals are exactly the 8 names agent/parallel/pipeline/phase/log/budget/args/cwd. bash goes indirectly through `agent(prompt)` — the subagent calls bash within its narrowed tool surface, through the existing containment + permission. A vm sandbox need not re-implement the bash boundary |
| D6 | The journal caches only true results with `state==='returned'` | Partial results of blocked/cancelled calls cannot be reproduced from the prompt and must be re-run. Matches pi-dynamic-workflows' "only a call that finishes with a real result is journaled" |
| D7 | **Off by default** (the `orchestrateEnabled` opt-in binding flag) | One flag gates both tool injection (`context.orchestrate`) and prompt-fragment assembly (`orchestrate_policy.md`). Default false → the model sees neither the `orchestrate.*` tool schemas nor the scripting guide. When enabled, both appear together — never "tools without a guide" or "a guide without tools". This is progressive release: the capability lands first, the switch flips later |

> **Decision log — D1 reversal (2026-10-13, task `10-12-orchestrate-isolation`)**: the
> original D1 ("No vm sandbox; direct `AsyncFunction` execution") is reversed. What
> stood: safety was held entirely by permission-gateway + cwd containment, and vm
> added only determinism hygiene. What broke it: a recon verified the script body
> executed in the Electron main-process global scope, where `process.env` (backend
> bootstrap secret, provider keys) is readable by a prompt-injected script — a
> credential-denial violation (AGENT-CONTRACT §5.1) that the gate cannot see, because
> reading an env var is not a tool call. The realm model (above) closes exactly that
> reach; journal/settle/maxAgents/abort semantics are unchanged, and no wall-clock
> timeout is introduced (runs legitimately await sub-agents for minutes+).

## 1. First principle

An orchestration script **is not a new agent engine**. It is a **deterministic thin
shell** over the subagent registry: the script expresses "who does what" with
`agent(prompt)`, "who runs in parallel" with `parallel()`, "who depends on whom" with
`pipeline()`, and the runtime routes those calls to the existing `subagent.spawn` +
`subagent.wait`. The script's only value is making the **fan-out topology reviewable,
editable, replayable** — instead of improvising it inside a single agent turn.

This principle rules out every temptation to "write a second spawn engine for
orchestration". `agent()` is an ordered composition of `subagent.spawn` +
`subagent.wait`, with no new execution path; all existing security boundaries
(permission gateway, cwd containment, tool-surface narrowing) apply unchanged.

## 2. Relationship to pi-dynamic-workflows

This design borrows pi-dynamic-workflows' **core abstractions** (script-as-workflow +
journaled replay by call-index) but **does not copy the whole set**:

| pi-dynamic-workflows | TDEase orchestrate | Decision |
|---|---|---|
| VM realm (Date/random/require/fs banned) | `node:vm` realm with host bridges only (D1, reversed 2026-10-13) | vm alone was never the security boundary — the gate holds regardless; the realm now also removes global-scope credential reach |
| agent/parallel/pipeline/phase | the same 4 globals | adopted as-is |
| verify/judgePanel/loopUntilDry/completenessCheck/retry/gate | not implemented | D4: quality assistants are enhancements; run the core first |
| git worktree isolation | not implemented | TDEase is a single-user desktop; no concurrent repo edits |
| saved workflow + nested workflow(name) | not implemented | D4: enhancement |
| keyword trigger | not needed | The Agent is the sole initiation surface (STATUS.md Decided) |
| per-agent tier/model routing | reuse the existing role thinking_level + model inheritance | D4: enhancement |
| journal replay by positional index | **adopted as-is** (D6) | core value |
| background run + live panel | the run/wait/status commands + the existing SubagentPanel | D4: no new UI pane |

## 3. The eight globals (the script's available surface)

The script body executes inside a `node:vm` realm: the sandbox's only host key is a
`__run` bridge, and a self-deleting bootstrap IIFE defines the complete set of eight
globals — `agent`/`parallel`/`pipeline`/`phase`/`log` as realm-local wrappers over
that bridge (the host closures stay host-side; no host object's `.constructor` chain
is ever reachable from script code), `budget` as a live realm façade over synchronous
bridge reads, and `args`/`cwd` as JSON snapshots parsed realm-side. `Date`,
`require`, `fs`, `Math.random` and `process` are absent from the realm: the script
naturally won't depend on them; the runtime does not enforce their absence, the
journal doesn't care, and the cached results replay reliably regardless of whether
the script contains nondeterminism.

```js
// a minimal orchestration script
phase('discover')
const files = await agent('List every spectrum file under runs/exp1/.')

phase('review')
const findings = await parallel(
  files.findings.flatMap((f) => [
    () => agent(`Deeply research ${f}.`, { role: 'massshift-deepresearch', input: { file: f } }),
  ]),
)

phase('synthesize')
return await agent(
  'Cross-check these findings and report the verdict:\n' + JSON.stringify(findings),
  { role: 'massshift-deepresearch' },
)
```

| Global | Signature | Implementation |
|---|---|---|
| `agent(prompt, opts?)` | `→ Promise<SubagentResult>` | `callIndex++` → journal lookup → hit returns the cache / miss spawns via `subagents.spawn` + `subagents.wait` → take the §6 result → write the journal |
| `parallel(thunks)` | `→ Promise<unknown[]>` | `runBounded(thunks, concurrency, t => t())`, order-preserving, concurrency capped by `concurrency` (default 16) |
| `pipeline(items, ...stages)` | `→ Promise<unknown[]>` | each stage runs all items concurrently with `Promise.all`; stages run serially |
| `phase(title)` | `→ void` | `onPhase(title)` callback (for UI/state), **does not enforce budget** |
| `log(message)` | `→ void` | console mirror |
| `budget` | `{total, spent(), remaining()}` | live agent-count accounting via a realm façade over synchronous bridge reads (**does not track tokens**; tokens are an enhancement) |
| `args` / `cwd` | read-only | JSON snapshots of the `run` inputs, parsed realm-side (script mutations stay in the realm); `cwd` = workspaceRoot |

`agent()`'s `opts`: `{role?, input?}`. `role` defaults to `'generic'` (an
ordinary child session); naming a role (e.g., `massshift-deepresearch`) uses its fixed
explore/general profile and the role's declared specialist commands. The return is the
§6 envelope (`findings/evidenceLinks/confidence/openQuestions`); scripts mostly read
`.findings`. **The role roster is data, and it is empty today** (no role ships under
`system/subagents/` — SUBAGENT-RUNTIME §4): until a role SKILL.md is dropped in,
non-generic roles fail at spawn, so scripts should use `generic` or `list` the roster
first.

## 4. Journal — replay by positional call-index

`workflow-journal.ts` is a persistent KV of `(index, promptHash) → result`. **It does no
policy, only storage**; the replay policy lives in the runtime.

**Replay algorithm (mirrors the pi-dynamic-workflows positional contract)**:

```
runtime keeps replayBroken: boolean (reset on every runWorkflow)
agent(prompt, opts):
  idx = callIndex++
  hash = hashAgentCall(prompt, opts)   // first 16 chars of sha256(prompt + normalized opts)
  if not replayBroken:
    cached = journal.lookup(idx, hash)
    if cached:                          // both (index, hash) match
      onAgentStart(idx, prompt, cached=true)
      return cached.result              // no spawn, no tokens spent
    replayBroken = true                 // the first miss breaks the chain
  onAgentStart(idx, prompt, cached=false)
  spawn + wait → result
  if state === 'returned':
    journal.append({idx, hash, result, 'returned'})
  return result
```

**Why everything after the first miss is invalidated**: the orchestrator cannot know
whether later `agent()` prompts depended on earlier calls' return values. If call N
re-runs and returns something different, call N+1's prompt may have changed (its hash
naturally won't match); but it may also be unchanged (an independent call) — the
conservative policy re-runs everything, preferring to overspend over misusing a stale
cache. pi-dynamic-workflows uses the same contract.

**Persistence**:
`<workspaceRoot>/.tdease/sessions/<sessionId>/workflows/<runId>.json`, the whole file
rewritten per append (a small file; N calls = N entries). Failure does `console.warn`
without aborting the turn (consistent with the persist pattern in subagent-registry.ts).

## 5. The three commands (same pattern as subagent.*)

| Command | Signature | Notes |
|---|---|---|
| `orchestrate.run` | `{script, args?, resumeFromRunId?, maxAgents?, concurrency?}` | starts the script in the background, immediately returns `{runId}`. Fire-and-forget |
| `orchestrate.wait` | `{runId}` | blocks until the script settles; returns `{runId, state, result}` |
| `orchestrate.status` | `{runId}` | snapshot: `{runId, state, phase?, agentCount}`. `agentVisible:false` (for UI) |

- `permission: 'subagent.spawn'` (orchestrate.run) — reuse; underneath it is literally
  spawning subagents, no new permission created
- `stakes: 'inline'` (orchestrate.run) — same as subagent.spawn; a session grant
  suffices
- `enabled: context.orchestrate && context.subagents` — available only when both ports
  are present

## 5a. Off by default and prompt assembly (D7)

Orchestration is an **opt-in** capability. One boolean `orchestrateEnabled` runs from
the binding layer through to prompt assembly, gating **both** sides simultaneously,
never splitting them:

```
BindSessionInput.orchestrateEnabled (default undefined → false)
  │
  ├─→ bindSession: only when true, context.orchestrate = createOrchestrateRegistry(...)
  │     └─→ tool-gateway buildStudioTools: the enabled gate Boolean(context.orchestrate)
  │         └─→ orchestrate.run/wait/status stay out of the tool table (the model sees no schema)
  │
  └─→ SessionBinding.orchestrateEnabled → assembleForRun
        └─→ SystemPromptInput.orchestrateEnabled
            └─→ SystemPromptAssembler.assemble: only when true does it read
                prompts/internal/orchestrate_policy.md (a conditional fragment)
                └─→ absent from the assembled result (the model sees no scripting guide)
```

**Position**: `orchestrate_policy.md` is assembled after `delegation_policy` and before
`mode` — first teach the subagent primitives, then teach how orchestration scripts
reuse them.

**prompt-contract blind spot (fixed)**: `orchestrate_policy.md` is the first prompt in
the INSTRUCTION corpus describing a **script API** (rather than `tdease.*` tools). The
8 realm-injected names
(`agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`args`/`cwd`) must appear in the
prompt in call form `agent(prompt, opts)`, triggering prompt-contract rule 2 (`name(`)
and rule 4 (`` `name` ``). They are a **fixed closed set** (exactly the realm
bootstrap's 8 injected names), added to `NON_TOOL_WORDS` with the source noted — not a
"rule misreading
the corpus" signal, but the corpus gaining a new category (script-API description),
these identifiers being definitional non-tool globals.

## 6. Data flow

```
The model calls tdease.orchestrate.run { script } within a turn
  │
  ▼
createOrchestrateRegistry.run
  │  createWorkflowJournal({runId, persistPath, resume})   ← with resume=true, loads the old journal
  │  record.settle = (async () => runWorkflow(input, deps))()   ← fire-and-forget
  │  runs.set(runId, record)
  ▼
returns { runId }                              ← the model gets runId immediately

The model calls tdease.orchestrate.wait { runId }
  │
  ▼
record.settle                               ← blocks until the script returns/throws
  │
runWorkflow:
  vm.createContext({ __run, __argsJson, __cwd, __budgetTotal })
  runInContext(self-deleting bootstrap IIFE)   ← defines the 8 realm globals, deletes the sandbox keys
  await runInContext('(async () => { <script> })()')
    │  agent(prompt) → __run bridge → spawn+wait via the subagents port → journal
    │  parallel(...) → __run bridge → runBounded fills the realm's out-array in place
    ▼
  returns the script's return value (errors re-read defensively at the host boundary)
```

## 7. Relationship to SUBAGENT-RUNTIME.md

orchestrate is subagent's **ordered, journaled replay layer**, not a replacement:

- **subagent** (SUBAGENT-RUNTIME.md): the execution primitives.
  spawn/spawnGroup/wait/cancel, the role system, tool-surface narrowing, the §6
  envelope. **All reused, unchanged**.
- **orchestrate** (this file): the orchestration primitives. Turns "when to fan out,
  how much, how results are synthesized" from an improvised in-turn decision into a
  reviewable, replayable, editable script.

`agent()` internally is `subagent.spawn` + `subagent.wait`; there is no second spawn
path. `orchestrate.run`'s `permission: 'subagent.spawn'` makes the relationship
explicit — its entire side effect is spawning subagents; the permission model is
unchanged.

## 8. Implementation status and tests

Core chain implemented: journal (KV + persistence + resume), runtime
(node:vm realm + 8 globals + host bridges + runBounded), the three commands,
conditional binding + prompt gating (off by default), journal replay by
positional call-index, `resumeFromRunId` re-running only the changed tail,
persistence to `<sessionDir>/workflows/<runId>.json`. Realm isolation landed
2026-10-13 (task `10-12-orchestrate-isolation`): scripts execute with host
bridges only — `process`/`require` unreachable, constructor escapes contained,
errors crossing defensively; no wall-clock timeout by design. Deferred: quality
assistants
(verify/judgePanel/loopUntilDry/completenessCheck/retry/gate), SubagentPanel
orchestrate section, phase budget enforcement/token tracking, saved-workflow
commands + nested workflows, per-agent tier/model routing. Tests:
`workflow-journal.test.ts`, `workflow-runtime.test.ts` (incl. the resume
replay re-runs-only-the-changed-tail assertion and the realm-isolation cases:
`process`/`require` absence, constructor-escape containment, all eight names,
cross-realm error readability, `log` console mirroring), `definitions.test.ts`;
they
walk the full `runWorkflow → vm realm → journal → replay` chain with a
mock subagent port. A real-model multi-specialist fan-out is a separate
pending acceptance (the STATUS Open items "real-LLM trajectory audit" tracks
the family). The detailed stage table and test list are archived at
`archive/docs-prune-2026-10-12/`.
