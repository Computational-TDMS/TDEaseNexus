---
type: design
title: PTY runtime — persistent bash sessions (upgrading the existing bash tool)
description: Following deepseek-harness's dsh-terminal / dsh-terminal-bash / dsh-tool-bash-persistent three layers, implement in electron/agent an owner-scoped terminal registry + a node-pty bash backend + a marker-frame-protocol persistent tool; the bash tool upgrades from per-call bash -c to a resident interactive shell, with state preserved across calls and non-zero exits structurally reported.
status: implemented
---

# PTY runtime (Persistent Bash)

> Status: **implemented.** The `bash` tool (a built-in in `tool-gateway.ts`) is
> upgraded from Pi's `createBashTool` (a `bash -c` per call, stateless) to a
> **persistent PTY bash**: cwd / exported variables / functions persist across calls;
> commands use a random marker frame protocol to determine completion boundaries;
> non-zero exits are structurally reported (`[exit code: N]` + `details.exitCode`);
> timeout/abort/shell-exit all reset the session, which is rebuilt on the next call.
> Code in `electron/agent/pty-terminal.ts` (registry), `pty-bash-backend.ts`
> (backend), `persistent-bash-tool.ts` (tool) — a direct port of the DSH three layers.

## 0. Decision summary

| # | Decision | Rationale |
|---|---|---|
| D1 | **Copy DSH's three-layer split verbatim**: `PtyTerminalService` (owner-scoped registry, handling id/publish/ownership/cleanup) ↔ `BashPtyBackend` (node-pty allocation, escape sanitization, bounded scrollback, readiness polling) ↔ `createPersistentBashTool` (marker frame protocol, serial queue, timeout→reset, result rendering) | The user's directive was "follow dsh-terminal / dsh-terminal-bash / dsh-tool-bash-persistent"; keeping the APIs comparable to DSH (spawn/startSend/read/signal/kill/list) allows adding a pwsh backend or named multi-sessions later |
| D2 | **Windows readiness detection uses a prompt-marker, not process groups**: ConPTY has no POSIX process groups; DSH's `inspectForeground`/pgid checks do not exist on Windows; instead a triple judgment — the OSC 133 `;D;` marker + a controlled PS1 tail + output-quiet time; SIGINT is delivered to the foreground via the `\x03` control character through bash job control | First principle: readiness is fundamentally "the shell is back at the prompt waiting for input"; the marker expresses that directly and is more cross-platform than process-group checks |
| D3 | **The marker frame protocol matches DSH**: `printf '<start>'; eval -- '<cmd>'; status=$?; printf '<end>$status'`; completion = the end marker appearing in scrollback, the exit code parsed from the marker line; send-wait only does "write + wait until ready"; the tool layer loops to confirm by itself | Command completion is decoupled from "send returning" — long commands, silent commands, and slow output all work; corresponds line by line to DSH's `executeCommand` loop |
| D4 | **The command deadline starts once the session is ready**, excluding cold start (spawn+initialization) | Cold start is ~10s; counting it into a 2s command timeout would guarantee a first-command timeout; timeout semantics = "command execution timed out" |
| D5 | **The gateway no longer injects a default cwd into bash** (the old `assertCommandCwd(undefined)→workspaceRoot` behavior deleted): the persistent shell starts at the workspace root; only an explicit model-passed cwd triggers `cd` (containment still asserted) | Injecting the workspace root on every call = resetting the shell back to the root before every command, wiping the state persistence (a probe confirmed the backend cd's correctly and the tool layer was being wiped by the gateway injection) |
| D6 | **The direct-call path also becomes reported-not-errored** (an upgrade side effect; the user accepted that "the behavior change is big"): non-zero exits return a result instead of throwing; PTC's `classifyShellOutcome` degrades to a fallback (real infrastructure failures still throw) | Consistent with DSH; PTC's O1 structured lift (details.exitCode → r.exitCode) unified across both paths |
| D7 | **One registry per agent session**: created by `AgentRuntime.bindSession`, released on `dispose` (`disposeAll` kills the shells first, then deletes the records); subagent sessions are each independent | A child agent's shells can never be reached by the parent session's tool calls |

## 1. First principle

The persistent PTY **is not a new execution engine**; it collapses "N interactions
with the same shell" into one resident session. All existing boundaries apply
unchanged: every call passes the same gateway wrapping (cwd containment assertions,
destructive-command preflight, the `shell.exec` permission ceiling); the shell process
belongs to the agent session, and session destruction kills the process tree.

## 2. Pipeline

```text
The model ──bash {command, timeout?, cwd?}──▶ gateway wrapping (containment+preflight)
        │  owner = the agent session
        ▼
  createPersistentBashTool.execute (serial queue: one command at a time per session)
        │  get(): lazy spawn (node-pty bash --noprofile --norc -i; env = the skill-runtime
        │         env + PS1/OSC133 marker) → initialize → cache the sessionId
        ▼
  executeCommand: wrapCommand(marker) → startSend(wrapped, submit)
        │  loop: readOutput delta → read(scrollback) pagination
        │        ├─ end marker appears → parse the exit code → structured result
        │        ├─ command deadline reached → SIGINT(\x03) + reset + partial output
        │        ├─ shell exited → reset + [shell exited: code N]
        │        └─ prompt complete → partial output (the boundary without an end marker)
        ▼
  { content: [text + markers such as [exit code: N]], details: {exitCode, timedOut, truncated, reset} }
```

## 3. Wiring points

- `agent-runtime.ts`: bindSession creates the `PtyTerminalService` → the
  `tool-gateway.ts` `terminals` option; `dispose` runs `entry.ptyTerminals.disposeAll()`.
- `tool-gateway.ts`: the `bash` factory in `buildBuiltinTools` = `defineTool` wrapping
  `createPersistentBashTool` (name/label/description/parameters defined by the
  gateway, execute provided by the tool); the spawn env keeps the spawnHook semantics
  (uv PATH, UV_*, TDEASE_SYSTEM_ASSETS, TDEASE_WORKSPACE, managed-bin PATH prefix,
  TEMP).
- `ptc-runtime.ts`: `tool()` lifts the structured fields in `details`
  (exitCode/timedOut/aborted/truncated) to the top level; scripts branch uniformly on
  `r.exitCode`.
- Build: `build-main.mjs` EXTERNAL gains `node-pty` (a native module, not
  bundleable); `electron-builder.json` asarUnpack gains
  `**/node_modules/node-pty/**` (pty.node + conpty.dll must be unpacked).

## 4. The boundary versus PTC / single-shot execution

| Axis | old bash (replaced) | persistent PTY bash (now) | PTC |
|---|---|---|---|
| State | none (bash -c per call) | cwd/env/functions persist across calls | in-script memory join |
| Completion detection | process exit | end marker (scrollback) | script return value |
| Non-zero exit | throws | reported ([exit code: N]) | structured r.exitCode |
| Timeout | kills the process tree | SIGINT + reset + partial output | wall-clock + budget |

## 5. Known boundaries (Windows/ConPTY)

- SIGINT is delivered to the foreground command via `\x03`; SIGTERM/SIGKILL have no
  control-character equivalents and directly terminate the whole session (the reset
  path). POSIX process-group signals are unsupported.
- `pwd` prints msys-style paths in Git Bash (`/tmp/...`), differently shaped from
  Windows absolute paths — tests assert accordingly.
- node-pty prints `AttachConsole failed` noise in console-less hosts (the vitest
  environment); harmless; the Electron main process has a console and never shows it.
- Bounded scrollback (10k lines / 4MB): when output exceeds the limit, the tail is
  kept, and the result carries a truncated marker plus a lost-prefix notice.
- When code and this file conflict, handle per AGENTS.md: either the doc is stale and
  must be corrected, or the code is defective.
