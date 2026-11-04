/**
 * Derives a TurnCard from one turn's settled facts. Pure and programmatic:
 * the collector counts tool names and harvests run-id pointers as the act
 * events stream past, and `buildTurnCard` freezes the result at turn settle.
 * No LLM is ever involved (src/contracts/turn-card.ts states the contract).
 */

import type { ActEvent } from '../../src/agent/events'
import type { TurnCard, TurnCardOutcome } from '../../src/contracts/turn-card'

const INTENT_MAX_LENGTH = 100

export interface TurnCardInput {
  readonly turnId: string
  readonly sessionId: string
  readonly index: number
  readonly startedAt: number
  readonly userMessage: string
  readonly outcome: TurnCardOutcome
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number; readonly wall_clock_ms: number }
}

/**
 * Accumulates the per-turn facts that cannot be recomputed at settle time
 * from the turn context alone: which tools ran (and how often) and which run
 * ids surfaced. One instance per turn; the SessionHost feeds it every
 * canonical act event as it is observed.
 */
export class TurnCardCollector {
  private readonly tools = new Map<string, number>()
  private readonly runIds = new Set<string>()

  observe(event: ActEvent): void {
    if (event.type === 'tool.requested') {
      this.tools.set(event.name, (this.tools.get(event.name) ?? 0) + 1)
      this.harvestRunId(event.args)
      return
    }
    if (event.type === 'tool.completed' && event.ok) this.harvestRunId(event.result)
  }

  toolSummary(): Record<string, number> {
    return Object.fromEntries([...this.tools.entries()].sort(([a], [b]) => a.localeCompare(b)))
  }

  runIdList(): string[] | undefined {
    return this.runIds.size ? [...this.runIds].sort() : undefined
  }

  /** A run id is only ever a pointer already present in the event stream —
   *  `run_id` string fields on tool args/results. Never invented. */
  private harvestRunId(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const runId = (value as Record<string, unknown>).run_id
    if (typeof runId === 'string' && runId.trim()) this.runIds.add(runId)
  }
}

export function buildTurnCard(input: TurnCardInput, collector: TurnCardCollector): TurnCard {
  return {
    turnId: input.turnId,
    sessionId: input.sessionId,
    index: input.index,
    ts: new Date(input.startedAt).toISOString(),
    intent: intentOf(input.userMessage),
    outcome: input.outcome,
    toolSummary: collector.toolSummary(),
    ...(collector.runIdList() ? { runIds: collector.runIdList() } : {}),
    durationMs: input.usage.wall_clock_ms,
    tokens: { input: input.usage.input_tokens, output: input.usage.output_tokens },
  }
}

/** The user message's first line, truncated — the turn's stated intent. */
function intentOf(message: string): string {
  const firstLine = (message.split('\n', 1)[0] ?? '').trim()
  return firstLine.length > INTENT_MAX_LENGTH ? firstLine.slice(0, INTENT_MAX_LENGTH) : firstLine
}
