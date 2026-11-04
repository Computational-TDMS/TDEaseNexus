---
type: design
title: PTC runtime — programmatic tool calling (scripted tool execution, fewer agent round-trips)
description: tdease.ptc.exec; tool(name, args) inside JS scripts executes session-registered tools after per-call gating through the same ToolCallGate; dual budget (200 calls / 120s); no journal; an independent ptcEnabled switch.
status: implemented
---

# PTC runtime (Programmatic Tool Calling)

> Status: **implemented.** One command (`tdease.ptc.exec`) is exposed via the Studio
> command registry; `electron/agent/ptc-runtime.ts` executes model-written JS scripts
> in an isolated `node:vm` context (hardened 2026-08-20) whose only globals are
> self-deleting bootstrap wrappers bridging `tool` / `log` — host objects never cross,
> the boundary is JSON-only. **Positioning: fewer agent
> round-trips** — the model writes one script and completes N gated tool calls
> (loops/conditions/in-memory joins) within a single tool call. It is not subagent
> orchestration (that is ORCHESTRATE-RUNTIME.md) — two distinct capabilities, two
> independent switches.
>
> **Reliability:** the axis-by-axis comparison with deepseek-harness, the gap list, and
> the axis-by-axis comparison, the gap list and the landed optimizations are archived at `archive/docs-prune-2026-10-12/docs/design/PTC-RELIABILITY.md`; the surviving boundary is §5 below. Core
> change (O1): bash's non-zero exit/timeout/abort becomes a **structured result**
> (`exitCode`/`timedOut`/`aborted`) inside the script, no longer throwing and killing
> the script — aligned with DSH's "reported, not errored".

## 0. Decision summary

| # | Decision | Rationale |
|---|---|---|
| D1 | **One policy gate, two entrances**: `tool-call-gate.ts` extracted from tdease-extension's `tool_call` hook (data-access guards + tdeasenexus-toolbox direct-call avoidance + the deny-dominated permission ceiling + the 'ask' approval flow); the hook and each PTC `tool()` share it | Scripts must not become a bypass around the direct-call policy. The extraction is a refactor, not a new layer: hook behavior unchanged (existing tests all green), zero new permission logic in PTC. Model-behavior guards (the repeat-call ledger, loop hints, terminal-error blocking) stay in the hook — they guide "the model choosing its next step", not "the program the model already wrote" |
| D2 | **The callable surface = the session's canonicalTools verbatim roster** (`tdease.*` + all builtins + mcp); what executes is the same gateway-wrapped tool object | No second registry, no enlarged surface. Containment and parameter constraints live in the wrappers; what the script gets is isomorphic to a direct call. All builtins is a product decision: read/write/bash inside a script is a legitimate composition need; per-call gating guarantees permission equivalence |
| D3 | **No journal** | orchestrate replays `agent()` because spawn is side-effect-free bookkeeping; PTC issues real tool calls whose writes must never be silently replayed. Determinacy is the script author's; the runtime provides two budget backstops |
| D4 | **Dual budget**: call count (default 200) + wall clock (default 120s, cap 300s, aligned with bash). The timeout propagates via AbortSignal to execute (the bash subprocess is killed); a pure-JS infinite loop cannot be interrupted, but the race guarantees the tool call returns a timeout error | One PTC invocation is a turn-level commitment, not a background task; long jobs go to `tdease.job.start` or a skill script. The 200 cap draws the line between "collapsing round-trips" and "batch processing" — the latter should be a skill script over files |
| D5 | **An independent `ptcEnabled` switch** (a binding flag + a settings-page toggle), not reusing `orchestrateEnabled` | Two distinct capabilities (the user's call): orchestration = subagent organization, PTC = tool execution. One flag gates command injection (`context.ptc`) and the prompt fragment (`ptc_policy.md`); they appear and hide together |
| D6 | Honest results: the script's return value is JSON-serialized then head/tail truncated (~64KB); `log()` capped at 200 lines; each sub-call emits an audit event (UI transparency identical to direct calls); successful writes are recorded in the produced-path ledger | Bulk data stays in workspace files; the return value carries only a summary — isomorphic to the existing tool_policy constraint |
| D7 | The script's globals are only `tool(name, args)` and `log(...)`; no require/Date/fs/network; execution is a **`node:vm` realm** (a hardened refinement of the original direct `AsyncFunction`) — the context is created with only two bootstrap wrappers that delete themselves after first use, so host objects never reach script scope and the script↔host boundary stays JSON | Reads/writes go through `tool('read'/'write')` under containment; heavy computation is not PTC's job (skill scripts + CLI). The vm realm is determinism/隔离 hygiene, not the security boundary — the gate and the wrappers' containment hold regardless (same reasoning as ORCHESTRATE D1) |

## 1. First principle

A PTC script **is not a new execution engine**. It is the **batch expression** of "the
N tool calls the model has already decided to make": the round-trips (N
request/responses) collapse to 1, and intermediate results stay in script memory
rather than the transcript. All existing boundaries apply unchanged — every `tool()`
passes the same gate, runs the same wrapped tool, and `'ask'` actions still pop
approvals.

This principle rules out two temptations: (a) adding file/network globals to the
script (that is gate-bypassing, forbidden by D7); (b) adding journal/replay to the
script (that treats side effects as bookkeeping, forbidden by D3).

## 2. Pipeline

```text
The model writes a script ──▶ tdease.ptc.exec {script, timeout?}
                    │  permission: shell.exec (inherits the user's shell caution level)
                    ▼
           execPtcScript (ptc-runtime.ts)
                    │  node:vm context; globals = self-deleting tool/log bridges
                    │  (host objects never cross; JSON-only boundary)
                    ▼
     tool(name, args) ×N ──▶ ToolCallGate.check (guards+permissions+approval)
                    │                    │ block → throw (the script can catch)
                    ▼                    ▼
           canonicalTools[name].execute (containment inside the wrapper)
                    │
                    ├──▶ observers.auditTool (per sub-call, UI-transparent)
                    ├──▶ producedPaths.note (successful writes)
                    ▼
           { text, details } → in-script memory join → return value → truncation → tool result
```

## 3. Wiring points

- `registry.ts`: `PtcCommandPort` / `PtcExecResult` + `CommandContext.ptc`.
- `definitions.ts`: the `ptc.exec` command (`enabled: Boolean(context.ptc)`;
  `renderForAgent` renders ok/call stats/log/error/result).
- `agent-runtime.ts`: creates the port when `input.ptcEnabled` (before tool building,
  so the `enabled` gate sees it); lazy internal resolution — the canonical roster and
  action table are filled after tool building; the turn id via
  `SessionHost.activeTurnId()` after host init. Approval audit events go straight
  through the session store's append (PTC runs inside a tool call; the host's turn
  queue is necessarily busy).
- `prompt-pipeline.ts` / `system-prompt.ts` / `ptc_policy.md`: `ptcEnabled` gates
  fragment assembly simultaneously; `types.ts` gains the `ptc_policy` kind and the
  `ptc-policy` slot.
- Setting: `settings.ts` `ptcEnabled` (localStorage-persisted, default false) →
  `useAgentTurn.bindSession` → the IPC contract `BindSessionInput.ptcEnabled` →
  `SessionBinding.ptcEnabled`; the AgentSettingsTab "capabilities" section toggle
  (zh/en copy).
- prompt-contract: `tool` (the PTC script global) joins the NON_TOOL_WORDS closed set
  (the AsyncFunction parameter list is exactly `(tool, log)`).

## 4. The boundary versus orchestrate

| Axis | orchestrate | PTC |
|---|---|---|
| Composing | subagents (whole sessions) | tool calls (single invocations) |
| Purpose | organizing/parallelizing/replaying multi-step plans | round-trip collapsing (N→1) |
| journal | yes (positional-index replay) | none (side effects are not replayable) |
| Execution model | background run + wait | inline synchronous (time-boxed) |
| Switch | `orchestrateEnabled` | `ptcEnabled` |

The two can coexist in one session (each with its own switch); `ptc_policy.md` states
the division — repeated registered-tool fan-out uses PTC, multi-agent plans use
orchestrate, single calls go direct.

## 5. Known boundaries

- A pure-JS infinite loop is uninterruptible (the race returns a timeout error; the
  process is unharmed) — the same tradeoff as orchestrate.
- **`tool()` failure semantics depend on the tool**: bash's known outcomes (non-zero
  exit/timeout/abort) are **structured results** (`{text, exitCode?, timedOut?,
  aborted?}`) that the script branches on rather than dying from (O1; rationale in the archived PTC-RELIABILITY comparison); other tools' failures still throw (the script can catch and
  tolerate) — the same semantics as direct calls.
- The budgets are global constants (200/120s/300s), not exposed as configuration — run
  real loads first before talking parameterization.
