---
type: design
title: PTC reliability — comparison with deepseek-harness's programmatic execution
description: Compares TDEase's PTC (model-written JS scripts, gated tool(name,args) execution) axis by axis against deepseek-harness's three pieces (dsh-tool-workflow script orchestration, dsh-tool-bash structured shell results, dsh-terminal+dsh-tool-bash-persistent persistent PTY), deriving an actionable reliability gap and optimization list; O1 (bash structured results) and the E2E are implemented.
status: implemented
---

# PTC reliability — comparison with deepseek-harness

> Status: **comparison complete; O1 (bash structured results) and a real-toolchain E2E
> implemented.** This file is the reliability appendix to `PTC-RUNTIME.md`: it answers
> "where our PTC differs from deepseek's implementation, what is unreliable, and in
> what order to fix it". The comparison targets are deepseek-harness's (DSH)
> `@deepseek-ai/dsh-tool-workflow` (programmatic execution of model-written scripts),
> `@deepseek-ai/dsh-tool-bash` / `dsh-tool-pwsh` (single-shot shell execution and the
> result contract), and `@deepseek-ai/dsh-terminal` + `dsh-terminal-bash` +
> `dsh-tool-bash-persistent` (persistent PTY sessions). Code basis: the locally
> installed `@deepseek-ai/dsh-*` packages (the bundles keep source comments) and DSH's
> official terminal subsystem documentation (upstream `docs/subsystems/terminal.zh.md`
> in the dsh repo, not vendored here).

## 0. Decision summary

| # | Decision | Rationale |
|---|---|---|
| D1 | **The benchmark is DSH's workflow tool, not the PTY**: TDEase PTC and `dsh-tool-workflow` are 1:1 isomorphic — both are "the model writes a JS script, the harness executes it on its behalf, and returns the script's final value". DSH's PTY (persistent shell) collapses **shell state** (cwd/env/exported variables preserved across calls) — a different axis, deferred to stage two | A comparison must first aim at the same capability. Mis-comparing "programmatic tool calling" with a PTY conflates two different problems: script reliability vs shell-state persistence |
| D2 | **The most glaring gap = a bash non-zero exit throws and kills the script in PTC**: TDEase's bash is Pi's `createBashTool`, which `throw`s when `exitCode !== 0` (bash.js 305-307); DSH's bash renders non-zero exits **into the result text** (an `[exit code: N]` marker) and never throws — "reported, not errored". In scientific workflows, `grep` with no match (exit 1) and mid-pipeline failures are routine; scripts must be able to branch, not die | DSH's renderer explicitly says "Non-zero exits are reported, not errored — the model decides how to react". PTC scripts are isomorphic to the model and inherit the same philosophy |
| D3 | **O1 happens only at the PTC entrance**: the direct-call path (the model issuing bash call by call) keeps Pi's throwing contract unchanged; PTC's `tool()` classifies the three known Pi outcome messages into the structured result `{text, exitCode, timedOut, aborted}` | Touching the direct path's UI/prompt contracts (error cards, "investigate failures" guidance) is a whole-block change, and throwing is a useful signal when the model calls directly; throwing is only fatal under scripted batch execution. Both entrances share the same wrapped tool; the classification is collected at the PTC layer, zero intrusion into direct calls |
| D4 | **E2E uses the real toolchain**: real `createToolGateway` + real `NodePermissionGateway` + the real Pi bash tool + a real Git Bash subprocess running `execPtcScript` | Unit tests with fake tools verify runtime bookkeeping, not "how a script behaves on real bash". AGENTS.md: end-to-end is the core |
| D5 | **The live-model smoke is a user-environment step**: `agent-harness-cli.ts` already exists; running a real-model PTC session needs provider credentials in the desktop settings; this file gives the command rather than pretending verification in a credential-less environment | STATUS.md's exact words, "Harness-level smoke with a live model session remains to be run" — the only unclosed verification; record it honestly instead of faking one |

## 1. Axis-by-axis comparison

| Axis | TDEase PTC (`ptc-runtime.ts`) | DSH `dsh-tool-workflow` | DSH `dsh-tool-bash` (single-shot shell) |
|---|---|---|---|
| Script carrier | `node:vm` context (hardened 2026-08-20); globals `tool(name, args)` / `log` via self-deleting bridges | `new Function`/engine executing `script`, globals `agent(prompt, opts)`, `pipeline`, `parallel`, `phase`, `log`, `args` | no script; the model calls item by item in JSON |
| Failure semantics | `tool()` throws (the script can catch); **a bash non-zero exit throws and kills the script (pre-O1)** | plain throws kill the script; `opts.schema` validation failures and hook misuse (bad args/unknown options/over limit) **always kill the script**; **per-item agent failure → null (the item is dropped, the script continues)** | non-zero exit = a marker in the result text; only infrastructure failures (spawn error, abort) are isError |
| Result shape | `{text, details}` (text-centric) | with `opts.schema`, returns a **validated object**; otherwise the final text; result `{runId, agentsStarted, result}` | canonical DTO: `{kind, exitCode, signal, timedOut, aborted, timeoutMs, stdout:{text,truncated,spillPath}, stderr}` |
| Argument validation | the runtime only checks that `args` is an object; bad arguments surface as wrapped-tool/command errors | `opts.schema` rejects invalid arguments; failure kills the script | schemastery validates the schema before execute; unknown fields rejected |
| Timeout | wall-clock race + AbortSignal; a pure-JS infinite loop is uninterruptible (documented) | `exec.signal` bridges `run.cancel()`, incl. aborts issued before start | `dsh-timeout` deadline; abort triggers tree-level termination |
| Budget | 200 calls / 120s (cap 300s) | concurrency/total caps; exceeding kills the script | none (single call) |
| Audit | audit emit per sub-call + produced-path accounting | run-start/run-end projected into the Session (only members matching run.id) | tool/call, tool/result events |
| Lifecycle | synchronous inline, completes within a tool call | `try/finally` always disposes; non-completed terminal causes → isError | process tree SIGTERM→grace→SIGKILL |

## 2. Reliability gaps (located in code)

1. **G1 — a bash non-zero exit kills the script (top priority; fixed by O1)**.
   `createBashTool` `throw`s when `exitCode !== 0` (`dist/core/tools/bash.js`); PTC's
   `tool()` wraps it as `tool(bash) failed: <output>\n\nCommand exited with code 1`
   and marks the call `ok:false`. One `grep` without a match terminates the whole
   script — in scientific pipelines that is the most common "normal non-zero". DSH
   instead puts `[exit code: N]` into the result text; the call returns normally.
2. **G2 — script behavior on real tools was never verified end-to-end (fixed by O3)**.
   The 8 unit tests in `ptc-runtime.test.ts` all use `fakeTool`; a real gateway + real
   bash never ran; STATUS.md admits the live smoke was never run. On the real chain,
   "how bad arguments error, how a timeout kills the bash tree, how a deny breaks"
   were all unverified.
3. **G3 — argument-error messages rely on downstream fallbacks**. `tool('bash',
   {cmd:'ls'})` (wrong key) never reaches bash execution; the gateway's
   `assertShellCommand(String(command||''))` intercepts it with "A shell command is
   required." — right direction, but the message says "empty command" rather than
   "wrong key". Missing is a layer of fail-fast validation by tool schema (DSH
   validates via schemastery before execute). Moderate impact: locatable, but the
   model has to guess.
4. **G4 — results are text-centric; script control flow relies on string matching**.
   Matches like `r.text.includes('[exit code: 1]')` are no longer needed after O1
   (structured fields exist); but `read`/studio-command results are still rendered
   text, and scripts parse via regex — a structural gap versus DSH workflow's
   schema-validated results; an "upgrade path", not this round.
5. **G5 — live smoke missing**. The only unclosed verification; see D5.

## 3. Optimization list (priority-ordered)

| Priority | Item | Content | Status |
|---|---|---|---|
| P0 | O1 | bash's non-zero exit/timeout/abort inside PTC → structured result `{text, exitCode, timedOut, aborted}`, no throw; audit records `ok:true` (the call completed; the outcome is structured) | ✅ implemented this round (`ptc-runtime.ts` `classifyShellOutcome`) |
| P0 | O3 | real-toolchain E2E: multiple calls, structured non-zero exits, gate deny, timeout | ✅ implemented this round (`ptc-runtime.e2e.test.ts`) |
| P1 | O4 | live-smoke command documented + executed on the user side | 📋 `agent-harness-cli.ts` ready; the command in §4 |
| P2 | O2 | fail-fast validation by tool schema (aligning with DSH schemastery) | ⏳ advancing together with the self-built bash tool's schema convergence (persistent bash already carries a TypeBox parameter schema) |
| P2 | G4 | result-structuring upgrade (details contracts for studio commands/read) | ⏳ partially done: persistent bash already returns `details.{exitCode,timedOut,truncated,reset}`, and PTC lifts them to the top level |
| P3 | — | persistent PTY (the shell-state axis) | ✅ implemented; see `PTY-RUNTIME.md` (the three-layer port of dsh-terminal / dsh-tool-bash-persistent) |

## 4. Boundaries and follow-ups

- **PTC and PTY are two axes**: PTC collapses **round-trips** (N request/responses →
  1); the persistent PTY collapses **shell state** (cwd/env/exported variables
  preserved across calls; interactive programs become usable). Stage two delivered:
  the `bash` tool upgraded to a persistent PTY (`PTY-RUNTIME.md`) with non-zero exits
  structurally reported — G4 closed on the bash face (`details.exitCode` + the PTC
  top-level lift).
- **Live-smoke command** (needs provider credentials in the desktop settings):
  `node electron/dist/agent-harness.cjs <workspace> '<prompt>'` — the prompt has the
  model write a `tdease.ptc.exec` script containing one non-zero-exit bash and one
  deny/ask path.
- **O1's honest boundary**: `classifyShellOutcome` matches the Pi bash tool's stable
  error strings (`Command exited with code N` / `Command timed out after N seconds` /
  `Command aborted`); the E2E locks those three strings; persistent bash no longer
  throws those strings, so the function degrades to an infrastructure-failure
  fallback; if Pi upgrades and changes the wording, the tests go red first.
- When code and this file conflict, handle per AGENTS.md: either the doc is stale and
  must be corrected, or the code is defective.
