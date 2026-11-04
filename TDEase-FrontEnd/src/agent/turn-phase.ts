/**
 * Turn phase — the status line's derived map of a running turn.
 *
 * A phase is NOT a session event and NOT agent state: it is a presentation
 * fact the UI derives from the runtime event stream the session already
 * emits. The four phases are not arbitrary UI states — each maps onto a real
 * subsystem of the agent loop, so the status line is the system seen from the
 * outside, organized the way the loop is actually built:
 *
 *   waiting    — the provider boundary: turn live, no first token yet
 *   thinking   — the model stream: reasoning deltas arriving
 *   responding — the model stream: text deltas arriving
 *   executing  — the tool gate & port seam: a tool call is in flight, and
 *                `activity` names WHICH tool (tdease.spectra.query, bash…)
 *
 * The mapping is total and closed: every unrecognized event keeps the current
 * phase (the default branch), and nothing here ever throws — a future event
 * type must not break the status line. Rendering the phase elapsed alongside
 * the turn elapsed answers the two questions a running turn owes the user:
 * what is it doing, and how long has this step taken.
 */

export type TurnPhase = 'waiting' | 'thinking' | 'responding' | 'executing'

export interface TurnPhaseSnapshot {
  readonly phase: TurnPhase
  /** Epoch ms of the last phase transition — drives the phase clock. */
  readonly phaseStartedAt: number
  /** While executing: the canonical tool name in flight. The map names the
   *  seam it is looking at — `executing` without a name is a spinner. */
  readonly activity?: string
  /** While executing: the call's human subject ("npm test", a file name) —
   *  the intent line's object, distilled from the call args at the fold site
   *  (tool-identity.ts `toolSubject`). The action alone says WHAT kind of
   *  work; the subject says WHICH work. */
  readonly subject?: string
}

/** The event shapes that can move a phase. Structural on purpose: the module
 *  stays renderer/electron-agnostic and testable with plain objects. */
export type TurnPhaseEvent =
  | { type: 'turn_started' }
  | { type: 'thinking_delta' }
  | { type: 'text_delta' }
  | { type: 'event_committed'; event: { type: string; name?: string; subject?: string } }

/** The event→phase mapping. Closed vocabulary, mergeable by construction:
 *  callers feed every runtime event through `nextTurnPhase`; the default
 *  branch (phase unchanged) is the rule, not an afterthought. */
export function nextTurnPhase(
  previous: TurnPhaseSnapshot,
  event: TurnPhaseEvent,
  now: number,
): TurnPhaseSnapshot {
  switch (event.type) {
    case 'turn_started':
      return { phase: 'waiting', phaseStartedAt: now }
    case 'thinking_delta':
      return previous.phase === 'thinking'
        ? previous
        : { phase: 'thinking', phaseStartedAt: now }
    case 'text_delta':
      return previous.phase === 'responding'
        ? previous
        : { phase: 'responding', phaseStartedAt: now }
    case 'event_committed':
      // Every requested call is a new step: the identity (activity + subject)
      // and the phase clock both refresh — a back-to-back second call must not
      // keep showing the first call's name until the stream moves on.
      if (event.event.type === 'tool.requested') {
        return {
          phase: 'executing',
          phaseStartedAt: now,
          ...(event.event.name !== undefined ? { activity: event.event.name } : {}),
          ...(event.event.subject !== undefined ? { subject: event.event.subject } : {}),
        }
      }
      return previous
    default:
      return previous
  }
}

/**
 * The single controller for one live turn's phase state (the status-line
 * analogue of the elapsed clock): `start()` reopens the waiting window for a
 * new turn, `apply()` folds an event in, `snapshot()` is what the HUD reads.
 * One tracker per live turn — no timers live here; the existing HUD interval
 * renders both clocks from `snapshot()` + its own tick.
 */
export function createTurnPhaseTracker(now: () => number = Date.now) {
  let state: TurnPhaseSnapshot = { phase: 'waiting', phaseStartedAt: now() }
  return {
    start(): TurnPhaseSnapshot {
      state = { phase: 'waiting', phaseStartedAt: now() }
      return state
    },
    apply(event: TurnPhaseEvent): TurnPhaseSnapshot {
      state = nextTurnPhase(state, event, now())
      return state
    },
    snapshot(): TurnPhaseSnapshot {
      return state
    },
  }
}
