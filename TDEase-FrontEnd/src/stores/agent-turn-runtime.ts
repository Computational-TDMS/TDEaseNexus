/**
 * The agent store's turn-runtime slice: the per-session reactive fields that
 * drive the Composer's busy flag, the edge indicator, the HUD bindings, and
 * the parallel-send guard — plus the typed-ahead prompt queue drained once a
 * turn settles. Pure view state on the session record; never persisted.
 *
 * The slice resolves sessions through the metadata slice's `sessionOf`
 * (injected, see agent.ts) — it owns writers, not the session list itself.
 */

import { shallowReactive } from 'vue'
import type { ContextUsageSnapshot } from '@/contracts/agent-runtime'
import type { AgentSession } from './agent-session-meta'

/**
 * Per-session turn runtime state — the reactive fields that drive the
 * Composer's busy flag, the edge indicator, the HUD bindings, and the
 * parallel-send guard.
 *
 * This lives ON the session (not as a single-instance ref in `useAgentTurn`)
 * because turn state belongs to a session, not to the app. The old
 * single-instance `sending`/`streaming` model assumed one in-flight turn at a
 * time, so a second session's `send` was refused while the first was still
 * prompting (`if (sending.value) return`), and events for the non-active
 * session were dropped — a multi-session deadlock. The non-reactive companions
 * (streamBuffer, live assistant id, timers) stay in `useAgentTurn`'s
 * per-session map; only the reactive display fields live here.
 */
export interface SessionTurnRuntime {
  /**
   * "A prompt is in flight" — true from send() until the bridge resolves (or
   * throws). Derived-window bookkeeping, not an independent flag: patchTurn
   * enforces the invariant `sending === (state === 'acting' before settle)`,
   * so the two can never disagree about whether a turn is in flight.
   */
  sending: boolean
  /**
   * "Deltas are currently arriving" — flips on the first text/thinking delta
   * and off at settlement. Distinct from `sending` because the bridge can sit
   * between prompt-accepted and first-delta (waiting on the model) with
   * sending=true, streaming=false — Composer's disabled state keys on that
   * difference and the streaming-message-id pointer must not attach during it.
   */
  streaming: boolean
  /**
   * "A manual /compact is summarizing THIS session" — the transcript's live
   * compaction divider keys on it. Per-session like every other turn flag: as
   * a single-instance ref it bled into whichever session the user switched
   * to mid-compact, showing "compacting context" over an untouched session.
   */
  compacting: boolean
  state: 'idle' | 'acting' | 'suspended' | 'halted' | 'failed'
  lastOutcome: 'resolved' | 'blocked' | 'halted' | 'failed' | 'cancelled' | null
  /**
   * True when a turn settled while this session was NOT the active view — the
   * result landed but the user has not seen it yet. Cleared the moment the
   * session becomes active. Drives the unread dot in SessionList so the user
   * can tell, at a glance, which finished sessions still have unseen results.
   */
  unreadSettlement: boolean
  /**
   * Tool calls in the live turn. Single-written by the runtime-event fold
   * (`noteTurnFact`), reconciled with the log's `usage.tool_calls` at
   * settlement — never counted by a view (the HUD reads it).
   */
  toolCalls: number
  /**
   * Provider requests prepared in the live turn — the `model.request.prepared`
   * atoms' own request_seq, which is what "act N" on the HUD means.
   */
  requests: number
}

export function createTurnRuntime(): SessionTurnRuntime {
  return { sending: false, streaming: false, compacting: false, state: 'idle', lastOutcome: null, unreadSettlement: false, toolCalls: 0, requests: 0 }
}

/**
 * Derive the legacy three-word runtime status from the turn runtime — the
 * single writable source. `running` maps to the whole in-flight window
 * (sending or streaming), `failed` to a failed/halted settlement, `idle`
 * otherwise. `halted` reads as idle deliberately: halted means "stopped by
 * the user", which is at rest, not a failure (SessionList's failed dot must
 * not light up for a deliberate stop).
 */
function deriveRuntimeStatus(turn: SessionTurnRuntime): NonNullable<AgentSession['runtimeStatus']> {
  if (turn.state === 'failed' || (turn.lastOutcome === 'failed' && turn.state === 'idle')) return 'failed'
  if (turn.sending || turn.streaming || turn.state === 'acting' || turn.state === 'suspended') return 'running'
  return 'idle'
}

export function createTurnRuntimeSlice(
  sessionOf: (sessionId: string) => AgentSession | undefined,
) {
  /**
   * Patch a session's turn runtime. Turn state is pure in-memory view state
   * (never persisted), so this does NOT bump
   * `updatedAt`, which would otherwise fire the durable-sessions watcher on
   * every streaming tick.
   */
  function patchTurn(id: string, patch: Partial<SessionTurnRuntime>): void {
    const session = sessionOf(id)
    if (!session) return
    // Streaming deltas call this per token; a no-op patch must not mint a new
    // turn object — the reference churn re-renders the HUD and session list
    // on every token for nothing.
    const current = session.turn as unknown as Record<string, unknown>
    const incoming = patch as unknown as Record<string, unknown>
    if (Object.keys(patch).every((key) => current[key] === incoming[key])) return
    // shallowReactive (allSessions is a shallowRef — see agent-session-meta):
    // the spread below would otherwise install a raw object whose only
    // in-place write (the sending/streaming invariant) silently loses
    // reactivity.
    session.turn = shallowReactive({ ...session.turn, ...patch })
    // Field invariants, enforced at the single write gate rather than trusted
    // to every call site: (1) `sending` and `streaming` are mutually exclusive
    // windows of one in-flight turn — streaming without sending is a lost
    // settle; (2) the derived status projection follows its source in the same
    // write, so no reader observes a stale runtimeStatus between a turn patch
    if (session.turn.streaming) session.turn.sending = true
    session.runtimeStatus = deriveRuntimeStatus(session.turn)
  }

  /**
   * Single-writer turn facts: applied ONLY from the runtime-event fold in
   * useAgentTurn (`event_committed`), so the HUD's act/calls numbers and any
   * other reader derive from one truth instead of per-view counters. The
   * input is the atom itself — the store speaks the event vocabulary, never
   * bare increments.
   */
  function noteTurnFact(id: string, fact:
    | { type: 'turn.started' }
    | { type: 'model.request.prepared'; requestSeq: number }
    | { type: 'tool.requested' }
    | { type: 'settled'; toolCalls: number }): void {
    const session = sessionOf(id)
    if (!session) return
    switch (fact.type) {
      case 'turn.started':
        session.turn = shallowReactive({ ...session.turn, toolCalls: 0, requests: 0 })
        break
      case 'model.request.prepared':
        session.turn = shallowReactive({ ...session.turn, requests: fact.requestSeq })
        break
      case 'tool.requested':
        session.turn = shallowReactive({ ...session.turn, toolCalls: session.turn.toolCalls + 1 })
        break
      case 'settled':
        session.turn = shallowReactive({ ...session.turn, toolCalls: fact.toolCalls })
        break
    }
  }

  /**
   * Patch a session's live context occupancy (pushed over `context:changed`).
   * In-memory view state like `turn` — no `updatedAt` bump, so the persistent
   * sessions watcher doesn't fire on every gauge tick.
   */
  function patchContextUsage(id: string, usage: ContextUsageSnapshot): void {
    const session = sessionOf(id)
    if (session) session.contextUsage = usage
  }

  // ── Per-session prompt queue (typed-ahead messages for a busy session) ──────

  function enqueuePrompt(sessionId: string, message: string): void {
    const session = sessionOf(sessionId)
    if (!session || !message) return
    // shallowReactive: dequeue/remove mutate this array in place via splice;
    // a raw replacement array would swallow those (allSessions is shallow).
    session.queuedPrompts = shallowReactive([...session.queuedPrompts, message])
  }

  /** Take the head of the queue (the next turn to run), or undefined when empty. */
  function dequeuePrompt(sessionId: string): string | undefined {
    const session = sessionOf(sessionId)
    const [head] = session?.queuedPrompts.splice(0, 1) ?? []
    return head
  }

  /** Drop one queued message by position — the chip's × in the Composer. */
  function removeQueuedPrompt(sessionId: string, index: number): void {
    sessionOf(sessionId)?.queuedPrompts.splice(index, 1)
  }

  return {
    patchTurn,
    noteTurnFact,
    patchContextUsage,
    enqueuePrompt,
    dequeuePrompt,
    removeQueuedPrompt,
  }
}
