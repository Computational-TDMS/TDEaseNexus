import { describe, expect, it } from 'vitest'
import { createTurnPhaseTracker, nextTurnPhase } from './turn-phase'

const at = (ms: number) => ms
const snapshot = (phase: 'waiting' | 'thinking' | 'responding' | 'executing', startedAt: number) => ({ phase, phaseStartedAt: startedAt })

describe('turn phase derivation', () => {
  it('locks the event→phase mapping', () => {
    const now = at(1_000)
    expect(nextTurnPhase(snapshot('executing', 0), { type: 'turn_started' }, now))
      .toEqual({ phase: 'waiting', phaseStartedAt: now })
    expect(nextTurnPhase(snapshot('waiting', 0), { type: 'thinking_delta' }, now))
      .toEqual({ phase: 'thinking', phaseStartedAt: now })
    expect(nextTurnPhase(snapshot('thinking', 0), { type: 'text_delta' }, now))
      .toEqual({ phase: 'responding', phaseStartedAt: now })
    expect(nextTurnPhase(snapshot('responding', 0), { type: 'event_committed', event: { type: 'tool.requested' } }, now))
      .toEqual({ phase: 'executing', phaseStartedAt: now })
  })

  it('keeps the phase on unrecognized events — the default branch is the rule', () => {
    const previous = snapshot('executing', 500)
    for (const event of [
      { type: 'event_committed', event: { type: 'tool.completed' } },
      { type: 'event_committed', event: { type: 'message.completed' } },
      { type: 'turn_terminal' } as never,
      { type: 'future_event' } as never,
    ]) {
      expect(nextTurnPhase(previous, event, 9_000)).toBe(previous)
    }
  })

  it('does not restart the phase clock for repeated same-phase events', () => {
    const thinking = snapshot('thinking', 1_000)
    expect(nextTurnPhase(thinking, { type: 'thinking_delta' }, 4_000)).toBe(thinking)
    const responding = snapshot('responding', 1_000)
    expect(nextTurnPhase(responding, { type: 'text_delta' }, 4_000)).toBe(responding)
  })

  it('re-enters executing with a fresh clock after returning to responding', () => {
    let state = snapshot('executing', 100)
    state = nextTurnPhase(state, { type: 'text_delta' }, at(200))
    expect(state.phase).toBe('responding')
    state = nextTurnPhase(state, { type: 'event_committed', event: { type: 'tool.requested' } }, at(300))
    expect(state).toEqual({ phase: 'executing', phaseStartedAt: 300 })
  })

  it('names the executing activity — the map names the seam it is looking at', () => {
    const state = nextTurnPhase(
      snapshot('responding', 0),
      { type: 'event_committed', event: { type: 'tool.requested', name: 'tdease.spectra.query' } },
      at(1_000),
    )
    expect(state).toEqual({ phase: 'executing', phaseStartedAt: 1_000, activity: 'tdease.spectra.query' })
    // Returning to the model stream drops the activity: thinking/responding
    // look at the stream, not at a tool seam.
    const streaming = nextTurnPhase(state, { type: 'thinking_delta' }, at(2_000))
    expect(streaming.activity).toBeUndefined()
  })

  it('carries the call subject beside the activity — and drops it when the stream resumes', () => {
    const state = nextTurnPhase(
      snapshot('responding', 0),
      { type: 'event_committed', event: { type: 'tool.requested', name: 'bash', subject: 'npm test' } },
      at(1_000),
    )
    expect(state.subject).toBe('npm test')
    const streaming = nextTurnPhase(state, { type: 'text_delta' }, at(2_000))
    expect(streaming.subject).toBeUndefined()
  })

  it('refreshes identity and clock on a back-to-back requested call', () => {
    // The second call is a new step: keeping the first call's name until the
    // stream moved on made the status line describe work that had finished.
    let state = nextTurnPhase(
      snapshot('waiting', 0),
      { type: 'event_committed', event: { type: 'tool.requested', name: 'read', subject: 'a.ts' } },
      at(1_000),
    )
    expect(state).toEqual({ phase: 'executing', phaseStartedAt: 1_000, activity: 'read', subject: 'a.ts' })
    state = nextTurnPhase(
      state,
      { type: 'event_committed', event: { type: 'tool.requested', name: 'bash', subject: 'npm test' } },
      at(5_000),
    )
    expect(state).toEqual({ phase: 'executing', phaseStartedAt: 5_000, activity: 'bash', subject: 'npm test' })
  })
})

describe('turn phase tracker', () => {
  it('start() reopens the waiting window with a fresh clock', () => {
    let now = at(1_000)
    const tracker = createTurnPhaseTracker(() => now)
    tracker.apply({ type: 'text_delta' })
    now = at(5_000)
    expect(tracker.start()).toEqual({ phase: 'waiting', phaseStartedAt: 5_000 })
    expect(tracker.snapshot().phase).toBe('waiting')
  })

  it('folds events in order — the tool-executing turn reads correctly', () => {
    let now = at(0)
    const tracker = createTurnPhaseTracker(() => now)
    expect(tracker.snapshot().phase).toBe('waiting')
    now = 2_000
    expect(tracker.apply({ type: 'thinking_delta' }).phase).toBe('thinking')
    now = 3_000
    expect(tracker.apply({ type: 'text_delta' }).phase).toBe('responding')
    now = 4_000
    expect(tracker.apply({ type: 'event_committed', event: { type: 'tool.requested' } }).phase).toBe('executing')
    now = 9_000
    tracker.apply({ type: 'event_committed', event: { type: 'tool.completed' } })
    // A long tool run stays executing — a stuck turn reads as stuck.
    expect(tracker.snapshot()).toEqual({ phase: 'executing', phaseStartedAt: 4_000 })
  })
})
