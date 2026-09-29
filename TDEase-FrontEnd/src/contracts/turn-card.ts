/**
 * One compact record per Agent turn — the roadmap/retrospective layer below
 * Evidence. Evidence (src/services/workspace/workspaceEvidence.ts) records scientific
 * claims that need adjudication; a TurnCard records what one turn intended
 * and how it settled, so a compacted session can recover "where the task
 * stands and what comes next".
 *
 * Every field is derived programmatically from the turn's own events and
 * context — never an LLM summary. Cards carry pointers (run ids), not
 * content. Persisted as JSONL at `.tdease/sessions/<id>/turns.jsonl` by the
 * Electron SessionHost; read through the `turns.list` / `turns.read` Studio
 * commands as a projection, not a dump.
 */

export type TurnCardOutcome = 'resolved' | 'blocked' | 'halted' | 'cancelled' | 'failed'

export interface TurnCard {
  readonly turnId: string
  readonly sessionId: string
  /** 0-based position of the turn within the session's card log. */
  readonly index: number
  /** ISO timestamp of when the turn started. */
  readonly ts: string
  /** First line of the user message, truncated — the turn's stated intent. */
  readonly intent: string
  readonly outcome: TurnCardOutcome
  /** Tool name → call count for this turn. No arguments, no results. */
  readonly toolSummary: Readonly<Record<string, number>>
  /** Run ids that appeared in this turn's tool events. Omitted when none. */
  readonly runIds?: ReadonlyArray<string>
  readonly durationMs?: number
  readonly tokens?: { readonly input: number; readonly output: number }
}

/** The list projection: everything `turns.list` returns per card. */
export interface TurnCardProjection {
  readonly turnId: string
  readonly index: number
  readonly intent: string
  readonly outcome: TurnCardOutcome
  readonly ts: string
}

export function projectTurnCard(card: TurnCard): TurnCardProjection {
  return {
    turnId: card.turnId,
    index: card.index,
    intent: card.intent,
    outcome: card.outcome,
    ts: card.ts,
  }
}
