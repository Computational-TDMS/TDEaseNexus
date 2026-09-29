---
type: design
title: Orchestration runtime — scripts as workflows + journal replay by call-index
description: orchestrate.run/wait/status; agent()/parallel()/pipeline()/phase() inside JS scripts route to the existing subagent registry; AsyncFunction executes directly (no vm sandbox); completed calls are cached by positional index to support resumeFromRunId.
status: implemented
---

# Orchestration runtime

> Status: **implemented.** The three commands (`orchestrate.run` / `.wait` / `.status`)
> are exposed via the Studio command registry; `electron/agent/workflow-runtime.ts`
> executes model-written JS scripts; `workflow-journal.ts` caches completed `agent()`
> calls by positional call-index. The `agent()` inside scripts is underneath just the
> existing `subagent.spawn` + `subagent.wait` (SUBAGENT-RUNTIME.md), **introducing no
> second agent engine**. Contract boundaries: `docs/spec/AGENT-CONTRACT.md`.

## 0. Decision summary

| # | Decision | Rationale |
|---|---|---|
| D1 | **No vm sandbox**; scripts execute directly via `new AsyncFunction` | pi-dynamic-workflows itself states vm is "for determinism, not a security boundary"; TDEase's safety is held by permission-gateway + cwd containment (verified) and needs no second security layer. Determinism comes from the journal, not from banning globals. Zero vm dependency, zero sandbox overhead, zero new abstraction layers (AGENTS.md iron law 3) |
| D2 | **Graft onto subagent-registry; don't build another engine** | The script's `agent()/parallel()/pipeline()` all route to the existing `subagent.spawn`/`spawnGroup`/`wait`. Violating D1/D13 (SUBAGENT-RUNTIME.md) — "subagent = ordinary bound session" — to write another engine would be piling on a second layer of garbage |
| D3 | Namespace `orchestrate.*`, not reusing `workflow.*` | `workflow.run`/`.validate`/`.submit` are already taken by the Snakemake Run commands (definitions.ts). The two are entirely different axes: a Snakemake workflow = a scientific-compute DAG; orchestrate = agent orchestration scripts. Reusing the prefix would have the model confuse them — exactly the "second source of truth" STATUS.md repeatedly warns about |
| D4 | Minimal scope for v1: 4 globals + journal + 3 commands | AGENTS.md iron law 2: end-to-end is the core; don't pile up unverified abstractions. Quality assistants/phase budget/UI panes/saved workflows all deferred |
| D5 | **bash does not enter scripts** | The script globals are exactly the 8 names agent/parallel/pipeline/phase/log/budget/args/cwd. bash goes indirectly through `agent(prompt)` — the subagent calls bash within its narrowed tool surface, through the existing containment + permission. A vm sandbox need not re-implement the bash boundary |
| D6 | The journal caches only true results with `state==='returned'` | Partial results of blocked/cancelled calls cannot be reproduced from the prompt and must be re-run. Matches pi-dynamic-workflows' "only a call that finishes with a real result is journaled" |
| D7 | **Off by default** (the `orchestrateEnabled` opt-in binding flag) | One flag gates both tool injection (`context.orchestrate`) and prompt-fragment assembly (`orchestrate_policy.md`). Default false → the model sees neither the `orchestrate.*` tool schemas nor the scripting guide. When enabled, both appear together — never "tools without a guide" or "a guide without tools". This is progressive release: the capability lands first, the switch flips later |

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
| VM realm (Date/random/require/fs banned) | direct `AsyncFunction` execution | D1: vm is not a security boundary; determinism via the journal |
| agent/parallel/pipeline/phase | the same 4 globals | adopted as-is |
| verify/judgePanel/loopUntilDry/completenessCheck/retry/gate | not implemented | D4: quality assistants are enhancements; run the core first |
| git worktree isolation | not implemented | TDEase is a single-user desktop; no concurrent repo edits |
| saved workflow + nested workflow(name) | not implemented | D4: enhancement |
| keyword trigger | not needed | The Agent is the sole initiation surface (STATUS.md Decided) |
| per-agent tier/model routing | reuse the existing role thinking_level + model inheritance | D4: enhancement |
| journal replay by positional index | **adopted as-is** (D6) | core value |
| background run + live panel | the run/wait/status commands + the existing SubagentPanel | D4: no new UI pane |

## 3. The four globals (the script's available surface)

The script is the function body of `new AsyncFunction('agent','parallel','pipeline','phase','log','budget','args','cwd',
script)`. The injected parameter names are the complete set of globals the script can
use — `Date/require/fs/Math.random` are not in the parameter list, so the script
naturally won't depend on them; the runtime does not enforce their absence, the journal
doesn't care, and the cached results replay reliably regardless of whether the script
contains nondeterminism.

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
| `budget` | `{total, spent(), remaining()}` | agent-count accounting (**does not track tokens**; tokens are an enhancement) |
| `args` / `cwd` | read-only | passed through from the `run` inputs; `cwd` = workspaceRoot |

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
8 AsyncFunction parameter names
(`agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`args`/`cwd`) must appear in the
prompt in call form `agent(prompt, opts)`, triggering prompt-contract rule 2 (`name(`)
and rule 4 (`` `name` ``). They are a **fixed closed set** (exactly the AsyncFunction's
8 parameters), added to `NON_TOOL_WORDS` with the source noted — not a "rule misreading
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
  new AsyncFunction(8 globals, script)
  await fn(agent, parallel, ...)
    │  agent(prompt) → spawn+wait via the subagents port → journal
    │  parallel(...) → runBounded → multiple agent() concurrently
    ▼
  returns the script's return value
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

## 8. Implementation status

| Item | Status |
|---|---|
| `workflow-journal.ts` (KV + persistence + resume load) | implemented |
| `workflow-runtime.ts` (AsyncFunction + 4 globals + runBounded) | implemented |
| `createOrchestrateRegistry` (Map<runId> state shell + run/wait/status) | implemented |
| `orchestrate.run/wait/status` three-command registration | implemented |
| `agent-runtime.ts` bindSession conditional port injection (only with `orchestrateEnabled`) | implemented |
| Off by default: `orchestrateEnabled` opt-in (tool schema + prompt gated together) | implemented |
| `orchestrate_policy.md` conditional prompt fragment (D7, after delegation, before mode) | implemented |
| prompt-contract: the 8 script-API globals added to `NON_TOOL_WORDS` (a fixed closed set) | implemented |
| Journal replay by positional index (the first miss breaks the chain) | implemented |
| resumeFromRunId re-runs only the changed tail when the script is edited | implemented (unit-verified: a 2-call script with the second prompt changed → spawn count 2→1) |
| Persistence to `<sessionDir>/workflows/<runId>.json` | implemented |
| Quality assistants verify/judgePanel/loopUntilDry/completenessCheck/retry/gate | deferred (D4) |
| SubagentPanel orchestrate section (phase/budget/cache-vs-fresh) | deferred (D4, reuses the existing panel) |
| Phase budget enforcement / token tracking | deferred (budget only does agent-count) |
| Saved-workflow commands + nested workflow(name) | deferred |
| Per-agent tier/model routing | deferred (reuse the existing roles) |
| Real-model e2e (harness runs a multi-specialist fan-out) | pending acceptance (following the subagent 2026-08-03 proof pattern) |

## 9. Tests

- `workflow-journal.test.ts`: 3 cases (lookup hit / hash-mismatch miss / resume
  persistence + overwrite)
- `workflow-runtime.test.ts`: 3 cases (linear script / parallel order preservation /
  **resume replay re-runs only the changed tail** — the core-value assertion)
- `definitions.test.ts`: the command-list snapshot updated (+3 orchestrate ids)

The runtime tests use a mock `SubagentCommandPort` and no real LLM, but walk the full
`runWorkflow → AsyncFunction → journal → replay` chain. A real-model run is a separate
future acceptance (following the subagent 2026-08-03 histone48 dual-specialist
precedent).
