import type { ActEvent, JsonObject, JsonValue, SessionError, TurnUsage } from './vocabulary'

/** Normalized provider observations. Vendor event names do not leave this adapter. */
export type PiTurnObservation =
  | { type: 'thinking_delta'; content: string }
  | { type: 'tool_requested'; call_id: string; name: string; args: JsonObject }
  | { type: 'approval_requested'; call_id: string; action: string; basis: string }
  | { type: 'approval_resolved'; call_id: string; decision: string; by: string; suspended_ms: number }
  | { type: 'tool_completed'; call_id: string; ok: true; result: JsonValue }
  | { type: 'tool_completed'; call_id: string; ok: false; error: SessionError }
  | {
      type: 'assistant_completed'
      content: string
      usage?: Partial<Pick<TurnUsage, 'input_tokens' | 'output_tokens'>> & {
        /** Provider-reported prompt-cache counters (Pi normalizes to cacheRead/cacheWrite). */
        cache_read_tokens?: number
        cache_write_tokens?: number
      }
    }

/**
 * Collapses a provider act into appendable facts. It deliberately has no Pi
 * import, so the vendor vocabulary cannot leak into the durable event log.
 */
export class PiActCollector {
  private readonly events: ActEvent[] = []
  private thinking = ''
  /** When the open reasoning segment received its first delta (0 = none open). */
  private thinkingStartedAt = 0
  private inputTokens = 0
  private outputTokens = 0
  private cacheReadTokens = 0
  private cacheWriteTokens = 0
  private suspendedMs = 0

  observe(observation: PiTurnObservation): ReadonlyArray<ActEvent> {
    const previousLength = this.events.length
    switch (observation.type) {
      case 'thinking_delta':
        if (!this.thinkingStartedAt) this.thinkingStartedAt = Date.now()
        this.thinking += observation.content
        break
      case 'tool_requested':
        this.flushThinking()
        this.events.push({
          type: 'tool.requested',
          call_id: observation.call_id,
          name: observation.name,
          args: observation.args,
        })
        break
      case 'approval_requested':
        this.flushThinking()
        this.events.push({
          type: 'approval.requested',
          call_id: observation.call_id,
          action: observation.action,
          basis: observation.basis,
        })
        break
      case 'approval_resolved':
        this.flushThinking()
        this.events.push({
          type: 'approval.resolved',
          call_id: observation.call_id,
          decision: observation.decision,
          by: observation.by,
        })
        this.suspendedMs += normaliseTokens(observation.suspended_ms)
        break
      case 'tool_completed':
        this.flushThinking()
        if (observation.ok) {
          this.events.push({
            type: 'tool.completed', call_id: observation.call_id, ok: true, result: observation.result,
          })
        } else {
          this.events.push({
            type: 'tool.completed', call_id: observation.call_id, ok: false, error: observation.error,
          })
        }
        break
      case 'assistant_completed':
        this.flushThinking()
        if (observation.content.trim()) {
          this.events.push({ type: 'message.completed', role: 'assistant', content: observation.content })
        }
        this.inputTokens += normaliseTokens(observation.usage?.input_tokens)
        this.outputTokens += normaliseTokens(observation.usage?.output_tokens)
        this.cacheReadTokens += normaliseTokens(observation.usage?.cache_read_tokens)
        this.cacheWriteTokens += normaliseTokens(observation.usage?.cache_write_tokens)
    }
    return this.events.slice(previousLength).map(clone)
  }

  finish(): {
    events: ReadonlyArray<ActEvent>
    usage: Pick<TurnUsage, 'input_tokens' | 'output_tokens'> & { cache_read_tokens: number; cache_write_tokens: number }
    suspended_ms: number
  } {
    this.flushThinking()
    return {
      events: this.events.map(clone),
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.outputTokens,
        cache_read_tokens: this.cacheReadTokens,
        cache_write_tokens: this.cacheWriteTokens,
      },
      suspended_ms: this.suspendedMs,
    }
  }

  private flushThinking(): void {
    if (!this.thinking) return
    // The segment's span ends where the reasoning ended: the next non-thinking
    // observation (or finish()) is the flush itself, so "now" IS the segment
    // boundary — the measurement needs no extra end signal.
    const durationMs = this.thinkingStartedAt ? Math.max(0, Date.now() - this.thinkingStartedAt) : 0
    this.events.push({ type: 'thinking.recorded', content: this.thinking, duration_ms: durationMs })
    this.thinking = ''
    this.thinkingStartedAt = 0
  }
}

function normaliseTokens(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}
