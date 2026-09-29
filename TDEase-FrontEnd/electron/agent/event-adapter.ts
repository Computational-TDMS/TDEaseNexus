/**
 * Node-side EventAdapter: turns Pi's native runtime events into canonical
 * SessionEvents (via PiActCollector) and transient streaming deltas.
 *
 * The collapse logic — buffering thinking deltas into a single
 * `thinking.recorded`, attributing usage to the assistant message, computing
 * suspended_ms across approvals — is owned by PiActCollector (src/agent/events/
 * translate-pi.ts) and is reused here unchanged. This class is only the Pi
 * vocabulary → PiTurnObservation translation, mirroring the field-name handling
 * in the former Renderer event adapter (the reference for what Pi
 * actually emits in 0.80.3: `assistantMessageEvent`, `toolCall?.name`,
 * `toolCall?.id`, `result.content[].text`, `message.usage`).
 *
 * Two output channels, intentionally split:
 *   - `observe()` returns committed ActEvents (facts; persisted to events.jsonl
 *     by the composition root). Idempotent: a replay re-derives the same list.
 *   - `transientDelta()` returns display-only streaming text/thinking for the
 *     Renderer. These never touch the durable log; the canonical record is the
 *     `message.completed` / `thinking.recorded` ActEvent.
 */

import type { ActEvent, JsonObject, JsonValue, SessionError } from '../../src/agent/events/vocabulary'
import type { PiTurnObservation } from '../../src/agent/events/translate-pi'
import type { EventAdapter } from './contracts'

import { PiActCollector } from '../../src/agent/events/translate-pi'
import { createToolNameProtocol, type ToolNameProtocol } from '../../src/ai/core/tool-name-protocol'

// The canonical TDEase tool names this binding registered. Empty ⇒ no
// rewriting; Pi events then carry provider names verbatim. The protocol is
// built from the custom-tool name list and leaves builtins
// (read/grep/.../mcp) untouched because they already lack dots.
export interface NodeEventAdapterOptions {
  readonly toolNames?: ReadonlyArray<string>
}

export class NodeEventAdapter implements EventAdapter {
  private collector: PiActCollector
  private readonly names: ToolNameProtocol

  constructor(options: NodeEventAdapterOptions = {}) {
    this.collector = new PiActCollector()
    this.names = createToolNameProtocol(options.toolNames ?? [])
  }

  observe(rawEvent: unknown): ReadonlyArray<ActEvent> {
    const observation = this.toObservation(rawEvent)
    if (observation) return this.collector.observe(observation)
    return []
  }

  transientDelta(rawEvent: unknown): { kind: 'text' | 'thinking'; text: string } | null {
    if (!rawEvent || typeof rawEvent !== 'object') return null
    const event = rawEvent as Record<string, unknown>
    if (event.type !== 'message_update') return null
    const update = event.assistantMessageEvent as Record<string, unknown> | undefined
    if (!update) return null
    if (update.type === 'text_delta') {
      const text = typeof update.delta === 'string' ? update.delta : ''
      return { kind: 'text', text }
    }
    if (update.type === 'thinking_delta') {
      const text = typeof update.delta === 'string' ? update.delta : ''
      return { kind: 'thinking', text }
    }
    return null
  }

  finish(): {
    events: ReadonlyArray<ActEvent>
    usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }
    suspended_ms: number
  } {
    const result = this.collector.finish()
    return {
      events: result.events,
      usage: result.usage,
      suspended_ms: result.suspended_ms,
    }
  }

  /**
   * Start a fresh collector for a new Pi act (one prompt()'s worth of events).
   * The composition root calls this before each prompt() so events from a prior
   * run cannot bleed into the next; finish() of the prior run already flushed.
   */
  reset(): void {
    this.collector = new PiActCollector()
  }

  // ── Pi event → PiTurnObservation ──────────────────────────────────────────
  //
  // Pi stamps the
  // tool identity on either the top-level fields (toolCallId/toolName) or the
  // nested toolCall object ({id,name,arguments}); we read both. Tool names are
  // mapped back to canonical dotted form so the durable log is provider-agnostic
  // — a TDEase tool named tdease.workflow.dryRun must not be recorded as
  // tdease_workflow_dryRun just because the provider namespace bans dots.

  private toObservation(rawEvent: unknown): PiTurnObservation | null {
    if (!rawEvent || typeof rawEvent !== 'object') return null
    const event = rawEvent as Record<string, unknown>

    if (event.type === 'tool_execution_start') {
      const callId = pickString(event.toolCallId) ?? pickString((event.toolCall as Record<string, unknown> | undefined)?.id)
      const name = pickString(event.toolName) ?? pickString((event.toolCall as Record<string, unknown> | undefined)?.name)
      const args = pickArgs(event.args, (event.toolCall as Record<string, unknown> | undefined)?.arguments)
      if (!callId || !name) return null
      return {
        type: 'tool_requested',
        call_id: callId,
        name: this.names.toCanonical(name),
        args,
      }
    }

    if (event.type === 'tool_execution_end') {
      const callId = pickString(event.toolCallId) ?? pickString((event.toolCall as Record<string, unknown> | undefined)?.id)
      const name = pickString(event.toolName) ?? pickString((event.toolCall as Record<string, unknown> | undefined)?.name)
      if (!callId || !name) return null
      const isError = event.isError === true
      if (isError) {
        return {
          type: 'tool_completed',
          call_id: callId,
          ok: false,
          error: toolError(event.result),
        }
      }
      return {
        type: 'tool_completed',
        call_id: callId,
        ok: true,
        result: toolResult(event.result),
      }
    }

    if (event.type === 'message_end') {
      const message = event.message as Record<string, unknown> | undefined
      if (!message || message.role !== 'assistant') return null
      const content = assistantText(message)
      const usage = message.usage as Record<string, unknown> | undefined
      const inputTokens = numberOr(usage?.input, usage?.inputTokens)
      const outputTokens = numberOr(usage?.output, usage?.outputTokens)
      return {
        type: 'assistant_completed',
        content,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: numberOr(usage?.cacheRead, usage?.cacheReadTokens),
          cache_write_tokens: numberOr(usage?.cacheWrite, usage?.cacheWriteTokens),
        },
      }
    }

    // message_update carries deltas; observe() ignores them because the
    // canonical text lands via message_end's message.completed. Thinking deltas
    // are the exception: they are folded into a single thinking.recorded by the
    // collector, so we forward thinking_delta here. Text deltas are display-only
    // and go through transientDelta() instead.
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent as Record<string, unknown> | undefined
      if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
        return { type: 'thinking_delta', content: update.delta }
      }
    }

    return null
  }
}

// ── Pi payload helpers ───────────────────────────────────────────────────────

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberOr(...values: ReadonlyArray<unknown>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 0
}

function pickArgs(primary: unknown, secondary: unknown): JsonObject {
  const candidate = primary ?? secondary
  // The collector stamps args onto a tool.requested event whose vocabulary
  // requires a JsonObject. A non-object or non-JSON-safe args is downgraded to
  // {} rather than thrown — a malformed tool call is still a fact worth
  // recording, and the args payload is secondary to the call_id + name.
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return jsonSafe(candidate) as JsonObject
  }
  return {}
}

function toolResult(result: unknown): JsonValue {
  // Pi returns AgentToolResult (content + details); the durable fact we keep is
  // the joined text. A tool that appends Workspace-relative markdown links
  // (bash auto-presentation) relies on those links surviving as text so the
  // renderer can hydrate them, so the text is preserved verbatim — never
  // re-parsed into a structure that would drop the trailing markdown.
  if (!result) return ''
  const record = result as Record<string, unknown>
  if (Array.isArray(record.content)) {
    const text = record.content
      .map((block) => (block && typeof block === 'object' ? pickString((block as Record<string, unknown>).text) : undefined))
      .filter((line): line is string => typeof line === 'string')
      .join('\n')
    if (text) return jsonSafe(text) as JsonValue
  }
  return jsonSafe(result) as JsonValue
}

function toolError(result: unknown): SessionError {
  // Keep code precedence as details.code | error.code | result.code and derive
  // the message from joined content; the
  // joined text is recomputed from toolResult so the error message matches what
  // the renderer would have displayed.
  const record = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  const details = record.details as Record<string, unknown> | undefined
  const error = record.error as Record<string, unknown> | undefined
  const code =
    pickString(details?.code) ??
    pickString(error?.code) ??
    pickString(record.code) ??
    'PI_TOOL_ERROR'
  const message = stringOr(toolResult(result), 'Tool execution failed.')
  return { code, message }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function assistantText(message: Record<string, unknown>): string {
  const content = message.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => {
      if (!block || typeof block !== 'object') return false
      const record = block as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string'
    })
    .map((block) => (block as Record<string, unknown>).text as string)
    .join('\n')
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { summary: 'Tool result could not be serialized for the session log.' }
  }
}
