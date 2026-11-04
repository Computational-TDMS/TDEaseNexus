---
type: design
title: Agent lifecycle & ownership matrix
description: One matrix for every runtime entity (Session, PTY, background job, subagent, Run, Backend, Web share): who creates it, whose permission applies, how it is waited on, and how it dies.
status: partial
---

# Agent lifecycle & ownership matrix

> The single lifecycle reference for the hardening plan (task_plan.md). One row
> per entity, one column per lifecycle question. Where a cell names code, that
> code is the owner of the answer — read it before changing the behaviour.
> Implementation status is governed by `docs/STATUS.md`, not by this file.

## Two deployment modes

| Mode | Workspace data | AI runtime | Compute (Run/SMK) | Ownership |
| --- | --- | --- | --- | --- |
| **Desktop-hosted** (today) | Local disk, bound by the local host | Electron main process (`AgentRuntime`) | Local Backend process supervised by `BackendManager` | Electron owns Backend, PTY, jobs, sessions; quit/crash rules below |
| **Remote compute Backend** (planned, Phase 5) | Local | Client (renderer + Electron) | Remote Backend, connected by URL + scoped token | Backend owns Run/SMK lifecycle; client disconnect must not orphan them |

Everything in the matrix below describes the desktop-hosted mode unless a row
says otherwise.

## The matrix

| Entity | Created by | Permission source | Wait surface | Normal end | User stop (`agent.abort`) | Session dispose | App quit | Crash / kill -9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Session** (agent binding) | `agent:bind-session` IPC | `loadPermissionSnapshot` (frozen ceiling; delegated children inherit the parent's ceiling verbatim — see §Delegation) | `prompt()` resolves at turn terminal | `agent:dispose` | `SessionHost.abort` (turn settles `cancelled`) | yes | `before-quit` → `AgentRuntime.disposeAll` | gone; revive on re-bind |
| **Subagent** (child session) | `subagent.spawn` via parent registry | **Inherits the parent's frozen ceiling** (`delegation.permissionCeiling`); tool surface narrowed by allowlist; never re-resolves `authority: auto` | `subagent.wait` (subscribe, no polling) | child settles → host disposed | parent abort cancels every running child (partial results kept) | parent dispose disposes children (`childSessions` map) | with parent session | revive marks `SUBAGENT_ORPHANED` |
| **Background job** (child process) | `job.start` via parent registry | parent's PermissionGateway preflights command + cwd **before spawn** | `job.wait` (shared settle promise per job, no polling); `job.peek` for live tails | process exit settles record | parent abort cancels all running jobs (`cancelAll`) | session dispose cancels all running jobs | `before-quit` → same dispose path | revive marks `JOB_ORPHANED`; the OS process itself is best-effort (see §Crash residue) |
| **PTY terminal** (persistent shell) | `bash` tool via owner-scoped `PtyTerminalService` | parent's gateway: cwd containment + command preflight per call | synchronous tool call (short commands only, 300s cap) | `pty.kill` or owner dispose | PTY survives a stop (shell state is durable by design) | `ptyTerminals.disposeAll()` | with session dispose | ConPTY closes with the host process; revive needs nothing |
| **Run** (analysis compute) | `workflow.run` / `runs.resume` via Studio runtime | Backend principal + workspace root grant; local ceiling gates the dispatching call | `runs.wait` (consumes the run repository stream; deadline 300s, re-callable) | Backend settles `SUCCEEDED`/`FAILED`/`CANCELLED` | `runs.cancel` (Backend-side, always-ask) | runs keep running by design (workspace data) | Backend keeps running (own process) | Backend restarts → run repository re-syncs |
| **Backend process** | `BackendManager.start` | loopback only; Bearer token reserved for remote mode | health handshake at boot | `BackendManager.stop` on quit | n/a | n/a | `before-quit` stops it | child exit → `CHILD_EXITED` failure surface |
| **Web share** (first slice, 2026-09-05) | host opts in from Settings (`settings.json` `sharing`; default OFF + loopback) | guest token; read-only view of ONE registered workspace; `containedPath` + registry membership; host-only config/token | browser page (login → file list → read/download) | disable or rotate token (sessions die at once); 12h session TTL | n/a | n/a | quit sweep stops it; boot re-applies an enabled config | share state is the settings file |

## Delegation (Phase 1 contract)

- The **local host is the only permission-elevation source**. Elevation happens
  exactly twice: the user picks the authority (`ask`/`auto`) and the user
  answers an approval card. `.tdease/permissions.json` is workspace policy the
  user authors; the agent cannot read or write it (runtime-private path), and
  the frozen ceiling makes mid-session edits inert regardless.
- A child session's ceiling is the **parent's frozen ceiling, verbatim**
  (`decisionOf(child) ≤ decisionOf(parent)` per action under the
  deny > ask > allow order). The child may narrow its tool surface; it may
  never widen anything. There is no `authority: 'auto'` re-resolution for
  children.
- An `ask` decision inside a child surfaces an approval card **on the parent
  conversation's stream** (`approvalPresenterSessionId`); the resolution
  routes back to the child's own coordinator by `approvalId`. Session grants
  recorded for a child are scoped to that child and die with it.
- Session grants (`allow_session`) are per-session runtime state: they never
  cross sessions, never survive restart, and are cleared on abort/dispose.
  Expiry = session lifetime. Delegation scope = the narrowed allowlist +
  inherited ceiling, recorded on the binding (`delegatedFrom`,
  `delegationScope`) and visible in the compact tool audit.

## Process-ownership boundaries (surviving facts)

Two boundaries stated once: **a persistent shell does not survive app exit by
design**, and **a Job Object is process cleanup, not a file sandbox**. The
quit gate is synchronous with a bounded sweep (agent disposeAll → job
cancelAll → Backend stop) under a 15s hard cap; the Job Object shim itself
ships (verified on-machine, `DESKTOP-PACKAGING.md`). The 2026-09-05 crash
measurements and the eight resolved audit conflicts are archived at
`archive/docs-prune-2026-10-12/docs/design/AGENT-LIFECYCLE-archived-sections.md`
(git history holds them; AGENT-CONTRACT §7 cites the two decisions that became
contract).
