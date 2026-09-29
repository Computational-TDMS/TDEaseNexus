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

## Crash residue (measured 2026-09-05)

A graceful quit kills every tracked process tree through the quit gate: the
default quit is prevented **synchronously** in `before-quit` (Electron does
not await async handlers — a `preventDefault` after the first `await` arrives
after teardown already began, reproduced and fixed the same day), then a
bounded sweep (agent `disposeAll` → job `cancelAll` with exit confirmation →
Backend stop → `app.exit(0)`) runs under a 15s hard cap, so the sweep always
completes before process exit (verified against real Electron).

A hard `kill -9` of Electron cannot run cleanup code. Measured on this
machine: job-style children (Git Bash via the registry's spawn shape) died
within ~1–2s of the parent's SIGKILL — MSYS2 propagates parent death; a
PowerShell child behaved the same. This is runtime-dependent behaviour, not a
guarantee. The records are marked `JOB_ORPHANED` / `SUBAGENT_ORPHANED` on the
next start either way. The guaranteed mechanism is a Windows Job Object
(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) bound to each spawned child — needs a
native shim, tracked in `docs/STATUS.md` Open items, and superseded in scope
by SMK sandbox isolation (workstream 4), which owns real file isolation.

Two boundaries stated once: **a persistent shell does not survive app exit by
design**, and **a Job Object is process cleanup, not a file sandbox**.

## Conflicts resolved by this design (2026-09-05 audit + same-day review)

1. **`AGENT-CONTRACT.md` §2 said children "reuse the parent's … permission
   path"; the code bound them at `authority: 'auto'` and re-resolved the
   snapshot.** The contract was right; the code was the defect. Fixed by
   ceiling inheritance (Phase 1).
2. **`job.status` was agent-visible** — a polling vector next to the
   completion-injection contract that exists precisely so the model never
   polls. Fixed by `job.wait` + hiding `job.status` from the agent surface
   (Phase 2).
3. **`AgentRuntime.abort`/`dispose` leaked running background jobs** — the
   abort cascade covered orchestrate + subagents but not jobs, and dispose
   killed neither. Fixed by `cancelAll` in the owner registry (Phase 3).
4. **`before-quit` only stopped the Backend** — agent sessions (and their PTYs
   and jobs) had no quit path at all. Fixed by the synchronous quit gate
   (Phase 3).
5. **The private-path judgment ran on the raw input string, before
   containment resolved the target** (2026-09-05 review P1) —
   `.tdease/./permissions.json`, absolute-inside-workspace and case variants
   rewrote the policy file. Fixed by judging the RESOLVED absolute path (and
   a normalized second view for the bash preflight).
6. **`followup` recomputed the role-default tool surface instead of the
   spawn's granted scope** (review P1) — a first-pass `read`-only child
   resumed with bash/write/edit. Fixed by persisting the delegation scope as
   a creation fact and re-binding with it.
7. **`before-quit` called `preventDefault` after its first `await`** (review
   P1) — Electron does not await handlers, so teardown outran the sweep.
   Fixed by the synchronous gate + bounded sweep above (real-Electron
   verified).
8. **`job.wait` returned state without output while marking the result
   notified** (review P2) — the completion reached nobody. Fixed by riding
   the same announcement projection (with bounded tails) the context hook
   uses. Same review round: pre-cancelled wait signals return immediately,
   `job.peek` reads the live record tail, and `whenSettled` waiters dispose
   on abandon instead of lingering.
