---
type: contract
title: TDEase Agent session events
description: Sole authority for the canonical session event vocabulary, its invariants, the dual-log contract with the Pi SDK, and the derived-projection family.
status: implemented
---

# TDEase Agent session events

> Sole authority for the canonical session event vocabulary — the atoms every
> interaction with the Agent settles into, the invariants the log maintains,
> and the contract that separates this log from the Pi SDK's own session
> entries. The vocabulary is the code (`src/agent/events/vocabulary.ts`); this
> document records the invariants the code cannot self-prove and the decisions
> behind them.

## 1. Boundary

Every Agent interaction — user prompt, provider request, tool call, approval,
settlement — settles into ONE append-only log per session:
`<workspace>/.tdease/sessions/<sessionId>/events.jsonl`. Streaming provider
deltas never enter it; the log holds settled, replayable facts only. The
Renderer, the subagent §6 handoff, fork, and the trajectory inspector all read
this one log. A second, independently persisted copy of the same conversation
facts would be a defect (CORE-ARCHITECTURE.md §2).

## 2. The vocabulary

Closed set of thirteen atoms, runtime-validated on append and on read
(`assertSessionEvent` — an unknown type or an unexpected field is a hard
failure, not a warning):

| Atom | Carries | Written when |
| --- | --- | --- |
| `turn.started` | user_message, prompt_snapshot_digest, model, mindset, authority | a turn opens |
| `thinking.recorded` | content | a reasoning segment settles |
| `tool.requested` | call_id, name, args | the model dispatches a tool |
| `approval.requested` | call_id, action, basis | a gated call waits on the user |
| `approval.resolved` | call_id, decision, by | the user decides |
| `tool.completed` | call_id, ok, result \| error | the call settles |
| `message.completed` | role, content | an assistant message settles |
| `card.created` | call_id, kind, ref | a rich card lands |
| `model.request.prepared` | request_seq, system_prompt/context/active_tools digests, model, thinking_level | before every provider request |
| `turn.completed` | outcome, usage | the turn settles normally |
| `turn.failed` | error | the turn fails |
| `turn.cancelled` | — | the user aborts |
| `context.compacted` | reason (`manual`\|`threshold`\|`overflow`), tokens_before?, tokens_after? | the session's context is compacted |

`model.request.prepared` is the context atom: it records what that request
actually saw, so a replay reconstructs every request even when the context hook
changed context, tools, model or thinking level mid-run. Bodies live
content-addressed in `snapshots/<digest>.md` beside the log; the event carries
digests only. `context.compacted` is the one session-scoped atom: it carries no
`turn_id`, because a compaction is a fact about the conversation, not one turn
(a manual `/compact` runs between turns).

## 3. Invariants

1. **Settled only.** Streaming deltas (`text_delta`, `thinking_delta`) travel
   the transient RuntimeEvent push and never persist. Replay must not depend
   on transport chunking.
2. **Contiguous sequence numbers.** `seq` starts at 1 and never gaps; the
   projections enforce it (`projectSessionEvents`, `projectTrajectory`).
3. **Every event belongs to a turn** (`turn_id`) — except the session-scoped
   `context.compacted`, which belongs to the conversation. An event for an
   unknown turn is a projection failure, not a silent skip.
4. **Wall clock lives only in `turn.completed.usage`.** Activity rows derive
   their ordering position from `seq`, never from timestamps.
5. **Append-only.** Nothing edits or reorders the log; a fork copies the log
   plus the snapshots and content it references (digest-addressed, so all
   three travel together or the fork's replay hits missing refs).

## 4. The dual-log contract

Two append-only records of one conversation exist, by design, with different
owners — they are two aggregates, not two truths about one fact:

- **`events.jsonl` (ours)** — settled facts. Owns: the Renderer's transcript
  replay, settlement facts, the subagent §6 result extraction, fork, the
  trajectory inspector.
- **Pi session entries (the SDK's)** — provider-facing context assembly: its
  own message entries, compaction frontier, branching tree under
  `modelSessionDir`. We never read it directly; `SessionManager` owns it.

Resume re-reads both (ours via `readWithPresence`, theirs via
`SessionManager.continueRecent`). The atom `model.request.prepared` is the
bridge: any compaction or context change on Pi's side surfaces here as the
next request's digest chain.

## 5. One vocabulary, N derived maps

Projections are pure functions over the atoms; none holds state, none consults
another:

- `src/agent/events/project.ts` — the transcript view (messages, activities,
  settlements).
- `src/agent/events/trajectory.ts` — the trajectory inspector (one row per
  turn: prompt, requests with digest chain, tool calls, settlement).
- `src/agent/turn-phase.ts` — the statusline phase map, derived from the live
  RuntimeEvent stream (the same vocabulary's transient side).
- Store facts are single-written: the runtime-event fold
  (`noteTurnFact`) is the only writer of turn fact numbers; views (HUD)
  read them — never count their own.

## 6. Alternatives considered

- **One log (Pi's) with everything derived from it.** Rejected: our settled
  view serves UI replay and the subagent §6 handoff without coupling to the
  SDK's provider-context representation; Pi may compact or branch its entries
  freely while our facts stay stable.
- **Streaming deltas in the log.** Rejected — the closed-step rule: transient
  chunks belong to the open step's view only; persistence would make replay
  depend on chunk boundaries.
- **A compaction atom** (`context.compacted`). First deferred: the frontier
  is derivable from the `model.request.prepared` digest chain. Accepted
  2026-09-06 when the transcript gained a user-visible compaction divider —
  the divider needs the reason and the token delta, which the digest chain
  does not carry; the atom is session-scoped (no `turn_id`) so a manual
  `/compact` between turns can record it.
- **A retry-attribution atom** (dsh's `llm/retry` pattern). Deferred until
  Pi-internal retries need user-facing attribution; `request_seq` increments
  already record the attempt chain.
- **Atoms on the reactive session object.** Rejected at implementation: the
  recursive `SessionEvent` JSON tree breaks Vue's deep ref unwrap (TS2589);
  atoms live in a shallow map beside the sessions (`sessionAtoms`).
