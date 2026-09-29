---
title: "Goal-only real Electron Agent end-to-end acceptance"
date: 2026-07-28
module: ai-harness
problem_type: best_practice
component: testing
severity: critical
applies_when:
  - Modifying AgentRuntime, Pi session, Provider, tool gateway, or Renderer transcript
  - Modifying Electron preload IPC or main-window lifecycle
  - Local unit tests pass but cannot prove the desktop Agent works for the user
related_components: [ai_harness, frontend, storage, infrastructure]
tags: [electron-e2e, playwright, goal-oriented-testing, provider-fixture, black-box, acceptance]
---

# Goal-only real Electron Agent end-to-end acceptance

## Context

Agent problems span Renderer, preload, Electron main, Pi, the HTTP Provider, Node tools,
and disk. Adding many unit tests per module keeps proving local implementations yet never
answers the only question that matters: after the user sends a message in the real main
window, do they get a success or failure result consistent with the Pi and Session facts?

End-to-end tests should be designed around the goal only, not around the count of internal
functions.

## Guidance

### Fix the single acceptance chain

```text
real Electron
  -> preload IPC
  -> Node AgentRuntime
  -> real Pi AgentSession
  -> Provider-compatible HTTP fixture
  -> tool call
  -> Node permission/tool gateway
  -> Session events.jsonl
  -> Renderer transcript
```

Only the external Provider, which cannot be controlled stably inside a test, may be
replaced. The HTTP fixture must run a real loopback server, receive the real protocol
requests the Pi adapter sends, and return a Provider-compatible streaming response.
Electron, IPC, Pi, the Node gateway, the Workspace filesystem, and the Renderer are never
replaced.

### Cover the goal matrix in a single launch

Use one Playwright spec, one Electron/Backend launch, and cover sequentially with
`test.step`:

1. Tool round-trip success.
2. Streaming `finish_reason` mapped to Pi `stopReason:error`.
3. HTTP 401 preserved as an error.
4. HTTP 400 preserved as an error.
5. DOM, Pi transcript, and Session JSONL agree three ways.
6. Main window exists, DevTools detached, window close and activate rebuild.

Do not relaunch Electron for every response code. Isolation comes from one test using its
own temporary `user-data-dir` and Workspace, not from repeatedly executing the expensive
full startup chain.

### The Provider fixture must capture requests

The fixture does not just return canned text; it must also record headers and the JSON
body so you can assert:

- No advertised function name contains `.`.
- The first request contains the expected tools.
- The second request after a tool call contains `role: tool`.
- The tool message contains Workspace content read by the real Node gateway.

### Three-way consistency is the final assertion

A successful turn must satisfy all of:

| Surface | Evidence |
|---|---|
| Window DOM | Shows the final assistant text and resolved outcome |
| Pi transcript | Contains the tool result and final assistant message |
| Session JSONL | Contains `tool.requested`, `tool.completed`, `message.completed`, `turn.completed` |

A failed turn must satisfy all of:

| Surface | Evidence |
|---|---|
| Window DOM | Shows the failed block and the original error |
| Pi transcript | Stores the Provider error message |
| Session JSONL | Final event is `turn.failed`; no fabricated `turn.completed` |

Additionally, the whole JSONL's `seq` must be strictly `1..N`.

### Window lifecycle is verified at the Electron layer

DevTools is a separate `WebContents` and may not appear in `BrowserWindow.getAllWindows()`.
Check the main window's `webContents.devToolsWebContents` and confirm the detached DevTools
URL in `webContents.getAllWebContents()`.

Close and rebuild use Electron main's `BrowserWindow.close()` and
`app.emit('activate')`. After rebuild, confirm `.activity-rail` is mounted via the new
BrowserWindow ID and `webContents.executeJavaScript()`, avoiding dependence on a Playwright
Page handle that may go stale when DevTools remounts.

## Why This Matters

These tests directly constrain user-observable outcomes and durable facts. Any protocol
mismatch, swallowed error, tool bypass, persistence race, missing preload, or window
lifecycle problem in any layer makes the test fail in the same goal chain. This reduces
useless unit tests, repeated launches, and misdirected local patching, protecting future
development attention.

## When to Apply

- Any behavior change to Agent, Provider, or tool definitions.
- Changes to the preload IPC contract, Node ownership, or permission boundaries.
- Changes to Session event vocabulary, projection, or persistence.
- Changes to the Electron main window, DevTools, or activate/close behavior.

Pure transformation functions and state-machine boundaries can still keep narrow unit
tests, but they cannot replace this acceptance gate.

## Examples

Standard command:

```powershell
cd TDEase-FrontEnd
$env:PLAYWRIGHT_HTML_OPEN='never'
pnpm run test:e2e:desktop
```

Completion evidence should look like:

```text
Running 1 test using 1 worker
ok 1 [desktop] real Electron Agent acceptance chain
1 passed
```

This result only means something when the spec already asserts the full goal matrix;
"Electron can start" by itself does not equal an Agent E2E pass.

## Related

- [Convergence of errors, tools, and persistence in the real Electron Pi Agent chain](./real-electron-pi-agent-chain.md)
- [Electron Desktop runtime, packaging, and crash diagnostics](../electron-desktop-runtime/README.md)
