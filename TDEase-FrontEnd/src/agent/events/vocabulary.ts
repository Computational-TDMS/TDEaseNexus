/**
 * Canonical facts persisted for an Agent session. Streaming provider deltas do
 * not belong here: every entry is a settled, replayable fact.
 */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

export type TurnId = string
export type CallId = string

export type TurnOutcome = 'resolved' | 'blocked' | 'halted'

export interface TurnUsage {
  input_tokens: number
  output_tokens: number
  tool_calls: number
  wall_clock_ms: number
}

export interface SessionError {
  code: string
  message: string
}

export type SessionEventType =
  | 'turn.started'
  | 'thinking.recorded'
  | 'tool.requested'
  | 'approval.requested'
  | 'approval.resolved'
  | 'tool.completed'
  | 'message.completed'
  | 'card.created'
  | 'model.request.prepared'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled'
  | 'context.compacted'

/** Why a compaction ran — mirrors the Pi session event's own vocabulary. */
export type CompactionReason = 'manual' | 'threshold' | 'overflow'

export interface ContextCompactedEvent {
  seq: number
  type: 'context.compacted'
  reason: CompactionReason
  /** Context size before the compaction, in tokens, when the run reported it. */
  tokens_before?: number
  /** The summarizer's own estimate of the post-compaction size, when reported. */
  tokens_after?: number
}

interface SessionEventBase<Type extends SessionEventType> {
  seq: number
  type: Type
  turn_id: TurnId
}

export interface TurnStartedEvent extends SessionEventBase<'turn.started'> {
  user_message: string
  prompt_snapshot_digest: string
  model: string
  mindset: string
  authority: string
}

export interface ThinkingRecordedEvent extends SessionEventBase<'thinking.recorded'> {
  content: string
  /**
   * Wall-clock span of the reasoning segment: first thinking delta → the next
   * non-thinking observation. A settled measurable fact (like
   * `TurnUsage.wall_clock_ms`), not a timestamp — the event log records no
   * wall clock. Optional so pre-existing logs (written before the field)
   * still validate and load.
   */
  duration_ms?: number
}

export interface ToolRequestedEvent extends SessionEventBase<'tool.requested'> {
  call_id: CallId
  name: string
  args: JsonObject
}

export interface ApprovalRequestedEvent extends SessionEventBase<'approval.requested'> {
  call_id: CallId
  action: string
  basis: string
}

export interface ApprovalResolvedEvent extends SessionEventBase<'approval.resolved'> {
  call_id: CallId
  decision: string
  by: string
  /** Set when the user's answer deepened into a whitelist rule
   *  (`allow_always`): the same rule is session-overlay live and persisted
   *  into the workspace policy by the host. Audit/replay-visible only. */
  whitelisted?: true
}

export type ToolCompletedEvent = SessionEventBase<'tool.completed'> & {
  call_id: CallId
  ok: true
  result: JsonValue
  error?: never
} | SessionEventBase<'tool.completed'> & {
  call_id: CallId
  ok: false
  error: SessionError
  result?: never
}

export interface MessageCompletedEvent extends SessionEventBase<'message.completed'> {
  role: 'assistant'
  content: string
}

export interface CardCreatedEvent extends SessionEventBase<'card.created'> {
  call_id: CallId
  kind: string
  ref: string
}

/**
 * Records what one provider request actually saw, so a replay can reconstruct
 * each request even when the `context` hook dynamically changed the context,
 * active tools, model or thinking level mid-run.
 *
 * Content lives in `snapshots/<digest>.md` (content-addressed); the event only
 * carries digests — never the prompt/context bytes themselves. `request_seq` is
 * 1-based within the owning turn.
 */
export interface ModelRequestPreparedEvent extends SessionEventBase<'model.request.prepared'> {
  request_seq: number
  system_prompt_digest: string
  context_digest: string
  active_tools_digest: string
  model: string
  thinking_level: string
}

export interface TurnCompletedEvent extends SessionEventBase<'turn.completed'> {
  outcome: TurnOutcome
  usage: TurnUsage
}

export interface TurnFailedEvent extends SessionEventBase<'turn.failed'> {
  error: SessionError
}

export type TurnCancelledEvent = SessionEventBase<'turn.cancelled'>

export type SessionEvent =
  | TurnStartedEvent
  | ThinkingRecordedEvent
  | ToolRequestedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ToolCompletedEvent
  | MessageCompletedEvent
  | CardCreatedEvent
  | ModelRequestPreparedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent
  | ContextCompactedEvent

type WithoutSequence<Event> = Event extends { seq: number } ? Omit<Event, 'seq'> : never

/** An event ready for the log. The turn runtime supplies the sequence number. */
export type EventInput = WithoutSequence<SessionEvent>

type ActSessionEvent =
  | ThinkingRecordedEvent
  | ToolRequestedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ToolCompletedEvent
  | MessageCompletedEvent
  | CardCreatedEvent

/**
 * A settled event emitted during one model act. The turn runtime stamps it
 * with the owning turn and appends it to the session log.
 */
export type ActEvent = ActSessionEvent extends infer Event
  ? Event extends { seq: number; turn_id: TurnId }
    ? Omit<Event, 'seq' | 'turn_id'>
    : never
  : never

/** Allocates a sequence number after rejecting any caller-supplied one. */
export function createSessionEvent(input: EventInput, seq: number): SessionEvent {
  assertPositiveInteger(seq, 'seq')
  assertEventInput(input)
  const event: unknown = { ...cloneJson(input), seq }
  assertSessionEvent(event)
  return event
}

/** Returns an independent JSON-safe copy for append-only log consumers. */
export function cloneSessionEvent(event: SessionEvent): SessionEvent {
  assertSessionEvent(event)
  return cloneJson(event)
}

/** Validates one persisted event against the closed session vocabulary. */
export function assertSessionEvent(value: unknown): asserts value is SessionEvent {
  const event = assertRecord(value, 'Session event must be an object')
  assertPositiveInteger(event.seq, 'seq')
  const type = assertEventType(event.type)
  if (type !== 'context.compacted') assertString(event.turn_id, 'turn_id')

  switch (type) {
    case 'context.compacted':
      // Session-scoped: a compaction is a fact about the conversation, not
      // about one turn (manual /compact runs between turns), so unlike every
      // other event it carries no turn_id.
      assertOnlyKeys(event, ['seq', 'type', 'reason', 'tokens_before', 'tokens_after'], type, false)
      if (event.reason !== 'manual' && event.reason !== 'threshold' && event.reason !== 'overflow') {
        fail(`Invalid compaction reason: ${String(event.reason)}`)
      }
      if (hasOwn(event, 'tokens_before')) assertNonNegativeInteger(event.tokens_before, 'tokens_before')
      if (hasOwn(event, 'tokens_after')) assertNonNegativeInteger(event.tokens_after, 'tokens_after')
      return
    case 'turn.started':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'user_message', 'prompt_snapshot_digest', 'model', 'mindset', 'authority'])
      assertString(event.user_message, 'user_message')
      assertString(event.prompt_snapshot_digest, 'prompt_snapshot_digest')
      assertString(event.model, 'model')
      assertString(event.mindset, 'mindset')
      assertString(event.authority, 'authority')
      return
    case 'thinking.recorded':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'content', 'duration_ms'])
      assertString(event.content, 'content')
      if (hasOwn(event, 'duration_ms')) assertNonNegativeInteger(event.duration_ms, 'duration_ms')
      return
    case 'tool.requested':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'call_id', 'name', 'args'])
      assertString(event.call_id, 'call_id')
      assertString(event.name, 'name')
      assertJsonObject(event.args, 'args')
      return
    case 'approval.requested':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'call_id', 'action', 'basis'])
      assertString(event.call_id, 'call_id')
      assertString(event.action, 'action')
      assertString(event.basis, 'basis')
      return
    case 'approval.resolved':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'call_id', 'decision', 'by'])
      assertString(event.call_id, 'call_id')
      assertString(event.decision, 'decision')
      assertString(event.by, 'by')
      return
    case 'tool.completed':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'call_id', 'ok', 'result', 'error'])
      assertString(event.call_id, 'call_id')
      if (typeof event.ok !== 'boolean') fail('ok must be a boolean')
      if (event.ok) {
        if (!hasOwn(event, 'result') || hasOwn(event, 'error')) fail('successful tool.completed requires result and no error')
        assertJsonValue(event.result, 'result')
      } else {
        if (!hasOwn(event, 'error') || hasOwn(event, 'result')) fail('failed tool.completed requires error and no result')
        assertSessionError(event.error, 'error')
      }
      return
    case 'message.completed':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'role', 'content'])
      if (event.role !== 'assistant') fail('message.completed role must be assistant')
      assertString(event.content, 'content')
      return
    case 'card.created':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'call_id', 'kind', 'ref'])
      assertString(event.call_id, 'call_id')
      assertString(event.kind, 'kind')
      assertString(event.ref, 'ref')
      return
    case 'model.request.prepared':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'request_seq', 'system_prompt_digest', 'context_digest', 'active_tools_digest', 'model', 'thinking_level'])
      assertPositiveInteger(event.request_seq, 'request_seq')
      assertString(event.system_prompt_digest, 'system_prompt_digest')
      assertString(event.context_digest, 'context_digest')
      assertString(event.active_tools_digest, 'active_tools_digest')
      assertString(event.model, 'model')
      assertString(event.thinking_level, 'thinking_level')
      return
    case 'turn.completed':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'outcome', 'usage'])
      assertTurnOutcome(event.outcome)
      assertTurnUsage(event.usage)
      return
    case 'turn.failed':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id', 'error'])
      assertSessionError(event.error, 'error')
      return
    case 'turn.cancelled':
      assertEventKeys(event, type, ['seq', 'type', 'turn_id'])
      return
  }
}

function assertEventInput(value: unknown): asserts value is EventInput {
  const event = assertRecord(value, 'Event input must be an object')
  if (hasOwn(event, 'seq')) fail('Event input must not provide seq')
  assertSessionEvent({ ...event, seq: 1 })
}

function assertEventType(value: unknown): SessionEventType {
  const types: ReadonlySet<string> = new Set([
    'turn.started',
    'thinking.recorded',
    'tool.requested',
    'approval.requested',
    'approval.resolved',
    'tool.completed',
    'message.completed',
    'card.created',
    'model.request.prepared',
    'turn.completed',
    'turn.failed',
    'turn.cancelled',
    'context.compacted',
  ])
  if (typeof value !== 'string' || !types.has(value)) fail(`Unknown session event type: ${String(value)}`)
  return value as SessionEventType
}

function assertEventKeys(event: Record<string, unknown>, type: SessionEventType, allowed: ReadonlyArray<string>): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(event)) {
    if (!allowedKeys.has(key)) fail(`${type} contains unsupported field: ${key}`)
  }
  for (const key of allowed) {
    if (key === 'result' || key === 'error' || key === 'duration_ms') continue
    if (!hasOwn(event, key)) fail(`${type} is missing required field: ${key}`)
  }
}

function assertTurnOutcome(value: unknown): asserts value is TurnOutcome {
  if (value !== 'resolved' && value !== 'blocked' && value !== 'halted') fail(`Invalid turn outcome: ${String(value)}`)
}

function assertTurnUsage(value: unknown): asserts value is TurnUsage {
  const usage = assertRecord(value, 'usage must be an object')
  const keys = ['input_tokens', 'output_tokens', 'tool_calls', 'wall_clock_ms']
  assertOnlyKeys(usage, keys, 'usage')
  for (const key of keys) assertNonNegativeInteger(usage[key], `usage.${key}`)
}

function assertSessionError(value: unknown, field: string): asserts value is SessionError {
  const error = assertRecord(value, `${field} must be an object`)
  assertOnlyKeys(error, ['code', 'message'], field)
  assertString(error.code, `${field}.code`)
  assertString(error.message, `${field}.message`)
}

function assertJsonObject(value: unknown, field: string): asserts value is JsonObject {
  if (!isRecord(value)) fail(`${field} must be a JSON object`)
  assertJsonValue(value, field)
}

function assertJsonValue(value: unknown, field: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${field} must not contain a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJsonValue(item, `${field}[${index}]`)
    return
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${field}.${key}`)
    return
  }
  fail(`${field} must be JSON-safe`)
}

function assertOnlyKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>, field: string, requireAll = true): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field} contains unsupported field: ${key}`)
  }
  if (!requireAll) return
  for (const key of keys) if (!hasOwn(value, key)) fail(`${field} is missing required field: ${key}`)
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') fail(`${field} must be a string`)
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) fail(`${field} must be a positive integer`)
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) fail(`${field} must be a non-negative integer`)
}

function assertRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) fail(message)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

function fail(message: string): never {
  throw new Error(`Invalid session event: ${message}`)
}
