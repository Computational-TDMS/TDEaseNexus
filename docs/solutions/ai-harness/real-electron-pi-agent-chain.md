---
title: "Convergence of errors, tools, and persistence in the real Electron Pi Agent chain"
date: 2026-07-28
module: ai-harness
problem_type: integration_issue
component: ai_harness
severity: critical
symptoms:
  - Provider rejects the request after receiving a dotted tool name
  - A Provider error is displayed by the Renderer as completed with zero tokens
  - The original errors of HTTP 401 and 400 are lost while crossing layers
  - A tool call has no evidence it went through the Node permission and tool gateway
  - Session events.jsonl shows duplicate seq or is missing the final event
root_cause: protocol_mismatch
resolution_type: protocol_change
related_components: [frontend, storage, testing]
tags: [electron, pi-agent, provider-protocol, tool-gateway, session-jsonl, ipc]
---

# Convergence of errors, tools, and persistence in the real Electron Pi Agent chain

## Problem

Every local module of the Agent can pass its unit tests while the real desktop chain still
fails at any boundary — Provider, Pi, Node gateway, Session persistence, or Renderer
projection. The completion bar must be that the whole real chain produces a consistent
terminal state, not that some transformation function returns the expected value.

The real ownership chain is:

```text
Electron Renderer
  -> preload IPC
  -> Node AgentRuntime
  -> real Pi AgentSession
  -> provider-compatible HTTP
  -> Pi tool call
  -> Node permission/tool gateway
  -> tool result back to Pi/provider
  -> Session events.jsonl + Pi transcript
  -> Renderer transcript projection
```

## Symptoms

- Canonical tool names like `tdease.workflow.run` were sent to the Provider verbatim,
  violating the function-name constraint.
- After Pi returned an assistant `stopReason: error`, Node still committed
  `turn.completed`, or the UI showed completion with zero tokens.
- Provider 401/400 were wrapped into generic errors; the user never saw the real response
  content.
- Tool calls executed only inside test doubles, with no proof that the production Node
  gateway, permissions, and Workspace containment took effect.
- Concurrent events each created their own `JsonlSessionLog` instance; multiple appends
  read the same line count simultaneously and assigned duplicate `seq`.

## What Didn't Work

- Testing only the tool-name converter. It cannot prove the production runtime actually
  hands the converted definitions to the Provider.
- Testing only the `turn.failed` Vue component. It cannot prove the failure event really
  lands on disk and is replayed by the Renderer.
- Letting the Renderer call tool handlers directly. It bypasses the Pi tool loop, the Node
  permission gateway, and the model round-trip.
- Writing `turn.failed` first and then throwing to IPC after a Provider failure. The
  Renderer enters its transient error branch and skips `loadHistory()`, so the DOM never
  shows the canonical failure just written.
- Creating an independent log instance per append while relying only on the per-instance
  queue. There is no mutual exclusion between instances, so duplicate sequence numbers
  still occur.

## Solution

### 1. A bidirectional tool-name protocol at the Provider boundary

Node builds a single mapping from the canonical tool set:

```text
tdease.workflow.run -> tdease_workflow_run -> tdease.workflow.run
```

- Tool definitions, descriptions, and the system prompt sent to the Provider use the
  provider-safe name.
- After Pi events return, the reverse mapping restores the canonical name before writing
  the Session log.
- Name collisions are rejected at mapping construction; silent overwrites are forbidden.

### 2. `stopReason:error` is a failure terminal state

After `session.prompt()` returns, check Pi's last assistant message. If
`stopReason === 'error'`, form `turn.failed` from `errorMessage`. SessionHost writes the
terminal state and returns:

```ts
{ ok: true, outcome: 'failed', turnId, usage }
```

Here `ok` means the IPC command completed and formed the canonical turn terminal — not
that the model succeeded. The Renderer therefore keeps reading `events.jsonl` and projects
the ErrorCard from the same source of truth. The original text of 401, 400, and the
Provider finish reason lives in `turn.failed.error.message`.

### 3. Node is the sole owner of tool execution

The custom tool definitions Pi receives are constructed by the Node `ToolGateway`. Every
execution follows a fixed order:

```text
Pi tool request
  -> Node permission decision / approval
  -> realpath-contained Workspace arguments
  -> real builtin or Studio command
  -> AgentToolResult
  -> Pi tool message
  -> next Provider HTTP request
```

The test must see `role: tool` plus real file contents in the Provider-captured second
request to prove the result really returned to the model instead of dying inside Node
after execution.

### 4. IPC carries declarative settings only

The Renderer passes `AgentToolSettings`; Node uses the shared `createAgentToolProfile()`
to derive builtins, Studio commands, and the MCP ceiling from mindset and settings. Do not
let the Renderer pass already-derived `{ builtins, mcp }`, otherwise the validator, UI
preview, and Node runtime easily diverge in schema.

### 5. Session appends are serialized globally per session

`NodeSessionStore.appendEvent()` enters a session-level promise queue before creating and
calling `JsonlSessionLog`. That way every event re-reads the file only after the previous
append completes, assigns the next `seq`, and appends.

Final invariant:

```ts
events.map(event => event.seq) === events.map((_, index) => index + 1)
```

## Why This Works

The fixes cover every real ownership boundary instead of building a second set of Agent
semantics in the Renderer or the tests. The Provider sees a legal protocol, Pi keeps a
real multi-turn tool loop, Node exclusively owns permissions and execution, the Session
log exclusively owns durable facts, and the Renderer only projects durable events. HTTP,
the Pi transcript, JSONL, and the DOM can therefore cross-check one another.

## Prevention

- Any Agent runtime change must pass the real Electron Agent E2E; unit-test count is not a
  completion bar.
- The Provider fixture must check the actual HTTP request body for dotted tool names.
- Every provider failure must be asserted to have a `turn.failed` and no `turn.completed`
  for the same turn.
- Every tool scenario must assert that the Provider's follow-up request contains the real
  `role: tool` result.
- Every acceptance checks that the JSONL `seq` is strictly consecutive integers.
- The Renderer must not persist a second transcript nor execute production Agent tools
  itself.

## Related

- [Goal-only real Electron Agent E2E](./goal-oriented-real-electron-agent-e2e.md)
- [Electron Desktop runtime, packaging, and crash diagnostics](../electron-desktop-runtime/README.md)
