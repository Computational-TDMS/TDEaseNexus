---
type: design
title: TDEase agent loop
description: Turn lifecycle rules the HUD, session host, and runtime cite: settlement outcomes, budget display, suspension, and the derived turn-phase status line.
status: implemented
---

# TDEase agent loop

> The turn lifecycle contract cited across `electron/agent/` and the renderer
> HUD. This file is a 2026-08-16 revival: the original was deleted at some
> point while eight files kept citing its sections, so the rules below are
> re-homed under the section numbers its readers already reference, recorded
> from the behavior the citants verifiably implement. Section content may grow;
> the numbers cited elsewhere (`§3` blocked, `§5` budget amber, `§6` suspended
> clock) are stable.

## 1. One turn, one loop

A turn is one `prompt()` call against a bound session. The SessionHost owns
the loop; nothing else starts provider requests.

## 2. Turn outcomes

A turn settles exactly one way: `resolved`, `blocked`, `halted`, `failed`, or
`cancelled`.

- `halted` — budget exhausted. Distinct from `cancelled` (user abort): a halt
  is the runtime refusing to spend more, not the user refusing to wait.
- `failed` — an error the loop could not contain (provider failure, bind
  failure).

## 3. Blocked is a structural settlement

"I cannot proceed" is a fact, not a paragraph of prose: the model calls
`session.reportBlocked`, and the SessionHost settles the turn as `blocked`
with the reason and what is needed to unblock it. Only a successful
`reportBlocked` call settles the turn as blocked — a failed call must not
manufacture a blocked settlement.

## 4. Observability, not prerequisites

Usage writes, tool audits, and compact eval records are observability: their
failure degrades history, never the turn in flight. A turn must not block on
an observability write.

## 5. Budget display: neutral until 80%, then amber

The HUD renders `elapsed / deadline` neutral until 80% of the wall-clock
budget, then amber. The HUD shows the numbers it is given, verbatim — it
computes nothing.

## 6. Suspension pauses the clock

A turn suspended for approval reads `waiting for you` on its clock, and the
clock does not advance the display while suspended. The approval is part of
the turn; the budget display treats the waiting as the user's time, not the
model's.

## 7. The status line is a derived map of the running turn (2026-08-16)

While a turn is live, the HUD shows a phase, an activity, and two clocks. The
status line is not decoration: it is the running system seen from the outside,
organized the way the loop is actually built — each phase maps onto a real
subsystem, so reading the status line is reading the architecture:

| Phase | Subsystem it maps onto |
|---|---|
| `waiting` | the provider boundary — turn live, no first token yet |
| `thinking` | the model stream — reasoning deltas arriving |
| `responding` | the model stream — text deltas arriving |
| `executing` | the tool gate & port seam — a tool call in flight, and `activity` names WHICH tool |

Two clocks: the phase elapsed answers *what is it doing / how long has this
step taken*; the turn elapsed (§5) answers *how long has the whole turn taken*.

Rules:

1. **A phase is derived from the runtime event stream, never a new session
   event or agent state.** `turn_started → waiting`, `thinking_delta →
   thinking`, `text_delta → responding`, `tool.requested → executing` (carrying
   the tool name as `activity`). The mapping lives in one module
   (`src/agent/turn-phase.ts`), is closed, and is total: an unrecognized event
   keeps the current phase; nothing in it throws.
2. A phase clock restarts only on a real phase transition; repeated
   same-phase events do not reset it. `activity` lives only on `executing` —
   the other phases look at the stream, not at a tool seam.
3. One tracker per live turn (the analogue of the elapsed clock); no timers
   live in the derivation module — the HUD's existing interval renders both
   clocks.
4. A long tool run stays `executing` with its name and clock — a slow or
   stuck turn must read as stuck *at the seam it is stuck on*, which is the
   entire reason the phase exists.
5. The same organization extends past the parent turn: subagents and jobs are
   background task records on one shared bookkeeping module
   (`electron/agent/task-records.ts`) with their own running/settled states;
   the Activity capsule's counts are the same map at a wider zoom.

### Alternatives considered

- **Phases as session events or agent state.** Rejected: a persistent,
  model-visible phase would require a new session event with no benefit to
  the model; phase is a rendering fact of the UI layer.
- **Driving phases from the prompt/bind promise flow** (the pre-2026-08-16
  shape: `preparing`/`connecting`/`finalizing` assigned imperatively around
  `bind()`/`prompt()`). Rejected: the phases smeared across the composable's
  control flow, `connecting` was never assigned (dead vocabulary), tool
  execution was invisible, and a `finalizing` phase fired on promise
  resolution rather than any observable event.
- **Bare phases without the executing activity.** Rejected: `executing`
  without naming what executes is a spinner, not a map — the user cannot tell
  a four-minute `workflow.dryRun` from a stuck `bash` without the tool name.
- **Only the phase, or only elapsed.** Rejected: each answers a different
  question; the HUD shows both.
