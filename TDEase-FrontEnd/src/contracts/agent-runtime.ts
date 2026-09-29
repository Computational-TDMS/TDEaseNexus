/**
 * Agent runtime contract v2 — the stable IPC surface between the Vue Renderer
 * and the Electron main `AgentRuntime`.
 *
 * This is the single authority for the new ownership model
 * (docs/design/AGENT-LOOP.md, AGENT-CONTRACT.md):
 *
 *   - One user message → exactly one Node `prompt()` call. That one call is one
 *     Pi *agent run*, which internally contains multiple Pi turns / provider
 *     requests / tool batches. TDEase does not wrap a second model loop.
 *   - The Renderer submits only identity and user preferences, never credentials,
 *     tool definitions, the System Prompt, permission functions, references, or
 *     Workspace absolute paths.
 *   - Provider, Prompt, Skill, Tool, Permission, references and persistence all
 *     live in Node; the Renderer renders events and emits approval decisions.
 *
 * Correctness rules baked into this contract (see turn-definition.ts):
 *   - `@` references are parsed by Node from the user message; the Renderer
 *     never pre-resolves them (Node owns Workspace/System roots).
 *   - No `AbortSignal` crosses IPC (it is not structured-cloneable across the
 *     Electron boundary); abort is a separate `agent.abort` command.
 *   - `agentTools` are the user's preferences; Node computes the final tool
 *     ceiling from mindset + preferences.
 *
 * The vocabulary below is deliberately tiny and closed. Anything not listed
 * here MUST NOT cross the Agent IPC boundary.
 */

import type { SessionEvent } from '../agent/events'

// ── Permission model (shared with the Studio command registry) ────────────────

export type AgentPermissionDecision = 'allow' | 'ask' | 'deny'

export const AGENT_PERMISSION_ACTIONS = [
  'workspace.read', 'workspace.write',
  'workflow.preflight', 'workflow.dry_run', 'workflow.submit', 'workflow.cancel',
  'run.list', 'run.wait', 'run.fetch', 'run.pull_file', 'run.resume', 'run.cancel', 'run.overwrite', 'run.trash', 'run.restore',

  'analysis.execute', 'evidence.scan', 'overwrite.conflict', 'shell.exec',
  // A reversible, auditable local reference note (uniprot.note / revise). It
  // never overwrites the remote authority record — it is a local overlay the
  // read merges in — so `inline` stakes, not `document`.
  'reference.note',
  // Delegating compute/authority to a child session (subagent.spawn) and
  // aborting one (subagent.cancel). cancel is a separate action so an approval
  // card says "cancel this child", not the confusing "subagent.spawn denied"
  // (SUBAGENT-RUNTIME.md §11.3).
  'subagent.spawn', 'subagent.cancel',
] as const
export type AgentPermissionAction = (typeof AGENT_PERMISSION_ACTIONS)[number]

/** Frozen per-session declarative decision snapshot (deny > ask > allow). */
export type PermissionSnapshot = Readonly<Record<AgentPermissionAction, AgentPermissionDecision>>

/**
 * Parameter-level predicate that narrows one permission rule to specific tool
 * calls (the pi-permission style). Absent, the rule is action-level and only
 * feeds the coarse ceiling; present, it is an override consulted per call.
 * Plain data on purpose: it must survive deepFreeze, structured clone and a
 * JSON policy file round-trip. Patterns are validated (and compiled once,
 * cached) at parse time — a rule that cannot compile never reaches a binding.
 */
export interface AgentPermissionMatch {
  /** RegExp source tested against the bash `command` input (raw + whitespace-collapsed). */
  command?: string
  /** Glob patterns (`**` crosses directories, `*` stays within one) against the call's path input. */
  paths?: string[]
  /** Input key holding the path; default resolves path → filePath → directory → cwd. */
  pathParam?: string
}

/**
 * One permission rule. Action-level rules ({action, decision}) merge into the
 * coarse ceiling deny-dominantly — they can only ever tighten. Rules carrying
 * `match` are overrides: at call time the highest-priority rule whose
 * predicate matches wins (ties resolve deny > ask > allow), so a workspace can
 * say `bash(command: "^git ")` → allow while the ladder keeps shell.exec ask.
 */
export interface AgentPermissionRule {
  action: AgentPermissionAction
  decision: AgentPermissionDecision
  match?: AgentPermissionMatch
  /** Higher runs first. Default 0. */
  priority?: number
  /** Human-readable rationale; surfaces on the approval card and deny message. */
  note?: string
}

// ── Tool profile (mindset ceiling + Agent Tools narrowing) ────────────────────

export const AGENT_BUILTIN_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'] as const
export type AgentBuiltinToolName = (typeof AGENT_BUILTIN_TOOL_NAMES)[number]

/**
 * The user's fine-grained Agent Tools toggles — the ONLY tool preferences that
 * cross the boundary. Node derives the binding's ToolCeiling from mindset +
 * these settings via the shared `createAgentToolProfile` (src/agent/tool-profile.ts);
 * the Renderer derives its UI preview from the same function, so the settings
 * page can never promise a tool the ceiling does not grant.
 */
export const AGENT_TOOL_SETTING_KEYS = [
  'discovery',
  'workflow',
  'runObservation',
  'runControl',
  'workspaceWrite',
  'shell',
  'mcp',
] as const

export type AgentToolSettingKey = (typeof AGENT_TOOL_SETTING_KEYS)[number]

export type AgentToolSettings = Readonly<Record<AgentToolSettingKey, boolean>>

export const DEFAULT_AGENT_TOOL_SETTINGS: AgentToolSettings = Object.freeze({
  // Internal-test default: every capability on. The executor prompt and
  // workflow skill name runs.resume / runs.overwrite / bash explicitly, and a
  // tool named in the prompt but absent from the schema is the "phantom tool"
  // defect. Defaulting anything off here re-introduces that gap. mcp is safe
  // to leave on: with no MCP servers configured the `mcp` tool exists but its
  // `servers` action returns an empty list.
  discovery: true,
  workflow: true,
  runObservation: true,
  runControl: true,
  workspaceWrite: true,
  shell: true,
  mcp: true,
})

/** Fill missing keys with defaults; unknown keys are dropped. */
export function normalizeAgentToolSettings(value: unknown): AgentToolSettings {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return Object.freeze(Object.fromEntries(AGENT_TOOL_SETTING_KEYS.map((key) => [
    key,
    typeof record[key] === 'boolean' ? record[key] : DEFAULT_AGENT_TOOL_SETTINGS[key],
  ])) as Record<AgentToolSettingKey, boolean>)
}

/**
 * The derived, mindset-narrowed builtin/MCP surface. Never crosses IPC — both
 * sides compute it from mindset + AgentToolSettings via createAgentToolProfile.
 */
export interface AgentToolPreferences {
  readonly builtins: ReadonlyArray<AgentBuiltinToolName>
  readonly mcp: boolean
}

/**
 * The default turn budget. One source: Node enforces, the Renderer HUD displays.
 *
 * The wall-clock limit is a lifecycle invariant, not an analysis strategy. The
 * 30-minute default halted legitimate multi-hour synthesis turns (qualified
 * chlamy attempts 33/34 both died at exactly 1804 s), so the backstop is now
 * 2 hours — far beyond any observed legitimate turn, still bounded so a
 * scripted runner can never hang forever.
 */
export const DEFAULT_TURN_BUDGETS = Object.freeze({ wallClockMs: 2 * 60 * 60 * 1000 })

// ── Identity, mindset, authority, model ───────────────────────────────────────

export type MindsetId = 'explorer' | 'executor'
export type AuthorityId = 'ask' | 'auto'
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AgentModelMetadata {
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow?: number
  maxTokens?: number
}

/**
 * The model the Renderer selected. `providerId`/`modelId` are the *only* model
 * facts that cross the boundary: Node resolves credentials, base URL, headers
 * and metadata from `<Client System>/settings.json`. The Renderer never sees the
 * resolved secret.
 */
export interface ModelSelector {
  readonly providerId: string
  readonly modelId: string
}

// ── bindSession: the only session-creation command ────────────────────────────

/**
 * Freezes one Agent binding. Node resolves provider/model/permission/tool
 * ceiling from trusted roots and returns the binding summary.
 *
 * No `references` field: Node parses `@` tokens from each prompt's message
 * itself. No `signal`: abort is a separate command (AbortSignal is not
 * structured-cloneable across Electron IPC).
 */
/**
 * Internal delegation inputs for a child session bound by the subagent
 * registry. NEVER crosses IPC: `assertBindSessionInput` rejects any bind that
 * carries it, so only in-process callers (which run inside the Electron main
 * process, under the parent's own spawn gate) can supply it.
 */
export interface BindSessionDelegation {
  /**
   * The parent's frozen permission ceiling, inherited verbatim. A child never
   * re-resolves `.tdease/permissions.json` or its own authority ladder — the
   * deny>ask>allow order makes "same as parent" the strictest legal starting
   * point, and re-resolution from `authority: 'auto'` was how a child could
   * out-permit its `ask` parent (AGENT-LIFECYCLE.md §Delegation).
   */
  readonly permissionCeiling: PermissionSnapshot
  /**
   * The parent's frozen parameter-level overrides, inherited verbatim. Like the
   * ceiling, a child never re-resolves the workspace policy: "same as parent"
   * is the strictest legal starting point. Absent when the parent bound with
   * no parameterized rules.
   */
  readonly permissionRules?: ReadonlyArray<AgentPermissionRule>
  /**
   * The parent session id on whose stream the child's approval cards surface.
   * A child session has no renderer subscription of its own, so its `ask`
   * decisions would otherwise hang forever; the card rides the parent channel
   * and resolution routes back to the child's coordinator by `approvalId`.
   */
  readonly approvalPresenterSessionId: string
}

export interface BindSessionInput {
  readonly workspaceId: string
  readonly sessionId: string
  readonly mindset: MindsetId
  readonly authority: AuthorityId
  readonly model: ModelSelector
  readonly thinkingLevel: ThinkingLevel
  readonly agentTools: AgentToolSettings
  /** Optional exact child capability ceiling. Children inherit the parent's
   *  normal tool surface unless the spawn caller explicitly narrows it here. */
  readonly toolAllowlist?: ReadonlyArray<string>
  /** Internal: delegation identity for registry-bound child sessions. */
  readonly delegation?: BindSessionDelegation
  /**
   * Optional system-prompt override for subagent children. When set, the
   * prompt pipeline renders it as an extra `subagent_role` fragment after the
   * common safety policy. A regular (parent) bind never sets this, so the
   * default assembly is unchanged for them.
   */
  readonly systemPromptOverride?: string
  /** Opt-in orchestration runtime (`orchestrate.run/wait/status` + the script
   *  policy fragment). When false/absent, the orchestrate.* tool surface is
   *  never injected and the prompt carries no orchestration guidance — the
   *  agent has no way to discover or invoke the capability. */
  readonly orchestrateEnabled?: boolean
  /** Opt-in programmatic tool calling (`tdease.ptc.exec` + its policy
   *  fragment). A distinct capability from orchestration: scripted tool calls
   *  that collapse agent round-trips, not subagent organization. When
   *  false/absent the command is not advertised and the prompt carries no PTC
   *  guidance. */
  readonly ptcEnabled?: boolean
}

export interface ProviderSummary {
  readonly providerId: string
  readonly displayName: string
  readonly models: ReadonlyArray<string>
  /** Whether a usable credential exists in settings.json. Never the secret. */
  readonly configured: boolean
}

export interface BoundSession {
  readonly ok: true
  readonly generation: number
  /** resumed from an existing model-session/ transcript, else fresh. */
  readonly resumed: boolean
  readonly resumeError: string | null
  readonly modelMeta: AgentModelMetadata
  readonly provider: ProviderSummary
}

// ── prompt: one user message → one Pi prompt() (one agent run) ────────────────

export interface PromptInput {
  readonly sessionId: string
  readonly message: string
}

export interface PromptUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly tool_calls: number
  readonly wall_clock_ms: number
}

export type TurnOutcome = 'resolved' | 'blocked' | 'halted' | 'cancelled' | 'failed'

export interface PromptResult {
  readonly ok: true
  readonly generation: number
  readonly turnId: string
  readonly outcome: TurnOutcome
  readonly usage: PromptUsage
}

// ── resolveApproval: the only way a Renderer affects execution ────────────────

export interface ResolveApprovalInput {
  readonly sessionId: string
  readonly approvalId: string
  /**
   * `'allow_session'` settles this approval AND records a standing grant for
   * the action so subsequent calls this session skip the prompt
   * (NodeApprovalCoordinator.sessionGrants). The grant is runtime state — it
   * never enters AgentPermissionDecision (which stays allow|ask|deny) and
   * never persists; see approval-coordinator.ts header.
   *
   * `'allow_always'` settles the approval AND deepens it into a parameterized
   * whitelist rule (permissionWhitelist.ts): a session-scoped overlay rule
   * takes effect immediately, and the rule persists into the workspace
   * `.tdease/permissions.json` for future binds. Persisting is the host's
   * job (the coordinator only carries the callback); the Agent itself can
   * never write that file.
   */
  readonly decision: 'allow' | 'allow_session' | 'allow_always' | 'deny'
}

// ── Node → Renderer events (the runtimeEvent stream) ──────────────────────────

export interface RuntimeTextDelta {
  readonly type: 'text_delta'
  readonly generation: number
  readonly text: string
}

export interface RuntimeThinkingDelta {
  readonly type: 'thinking_delta'
  readonly generation: number
  readonly text: string
}

/**
 * An approval is pending. The Renderer surfaces it; the user's decision comes
 * back via `resolveApproval`. `approvalId` correlates the two. `args` carries
 * the tool's actual arguments so the approval card can show what would run
 * (e.g. the shell command); the Renderer has no other source for them.
 */
export interface RuntimeApprovalRequested {
  readonly type: 'approval_requested'
  readonly generation: number
  readonly approvalId: string
  readonly action: string
  readonly basis: string
  readonly args?: Readonly<Record<string, unknown>>
}

/**
 * A canonical SessionEvent was appended to events.jsonl. The Renderer projects
 * it into the transcript. `event` is a real SessionEvent, not opaque: the
 * vocabulary is the contract and the Renderer already knows how to project it.
 */
export interface RuntimeEventCommitted {
  readonly type: 'event_committed'
  readonly generation: number
  readonly event: SessionEvent
}

export interface RuntimeTurnTerminal {
  readonly type: 'turn_terminal'
  readonly generation: number
  readonly turnId: string
  readonly outcome: TurnOutcome
  readonly usage: PromptUsage
}

/**
 * Transient streaming deltas + committed canonical events + turn terminal.
 *
 * `generation` is on every event so the Renderer can drop stragglers after a
 * switch/dispose. Streaming deltas are display-only; the canonical record is
 * the committed `event_committed`.
 */
export type RuntimeEvent =
  | RuntimeTextDelta
  | RuntimeThinkingDelta
  | RuntimeApprovalRequested
  | RuntimeEventCommitted
  | RuntimeTurnTerminal

// ── Structured runtime failure ────────────────────────────────────────────────

/**
 * A runtime-level failure that is not a normal turn outcome (e.g. the binding
 * is gone, the provider catalog is misconfigured, settings.json is corrupt).
 * Distinct from `outcome: 'failed'`, which is a provider/turn failure recorded
 * in the session event log.
 */
export interface AgentRuntimeFailure {
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

// ── Live context-usage snapshot (the `context:changed` read-side push) ────────
//
// Pushed from Node on the dedicated `context:changed` side channel (mirroring
// `subagent:changed` / `job:changed`) — a UI-read data stream that stays off the
// `RuntimeEvent` union. `tokens` is Pi's `getContextUsage()` estimate of the
// next request's context size; `null` means unknown (post-compaction, until the
// next valid assistant usage). `cache` carries the LAST valid assistant request's
// cache figures, so the renderer can show a hit rate (read/(read+write+uncached));
// `null` whenever `tokens` is unknown.

export interface ContextCacheUsage {
  readonly read: number
  readonly write: number
  readonly uncached: number
}

export interface ContextUsageSnapshot {
  readonly tokens: number | null
  readonly cache: ContextCacheUsage | null
}

// ── The typed preload bridge ──────────────────────────────────────────────────

export type AgentBridgeResult<T> = T | AgentRuntimeFailure

export interface AgentBridge {
  bindSession(input: BindSessionInput): Promise<AgentBridgeResult<BoundSession>>
  prompt(input: PromptInput): Promise<AgentBridgeResult<PromptResult>>
  abort(sessionId: string): Promise<{ ok: true }>
  compact(sessionId: string): Promise<{ ok: true }>
  fork(sessionId: string, targetSessionId: string): Promise<{ ok: true }>
  dispose(sessionId: string): Promise<{ ok: true }>
  resolveApproval(input: ResolveApprovalInput): Promise<{ ok: true }>
  /** Subscribe to the runtimeEvent stream for one session. Returns unsubscribe. */
  subscribe(
    sessionId: string,
    onEvent: (event: RuntimeEvent) => void,
  ): () => void
  /** Subscribe to live context-usage snapshots for one session. Optional —
   *  web/demo bridges omit it, and consumers degrade to an unknown gauge. */
  onContextChanged?(
    sessionId: string,
    onUsage: (usage: ContextUsageSnapshot) => void,
  ): () => void
}

// ── Validators (used by main's ipc handlers) ──────────────────────────────────

export function assertBindSessionInput(value: unknown): asserts value is BindSessionInput {
  requireRecord(value, 'bindSession input')
  // Delegation is a main-process-internal field: a renderer that supplies one
  // is trying to self-declare an inherited ceiling. Fail closed.
  if ('delegation' in value) fail('bindSession delegation is internal and never crosses IPC')
  requireString(value.workspaceId, 'workspaceId')
  requireString(value.sessionId, 'sessionId')
  if (!isOneOf(value.mindset, MINDSET_IDS)) fail('mindset must be explorer|executor')
  if (!isOneOf(value.authority, AUTHORITY_IDS)) fail('authority must be ask|auto')
  requireRecord(value.model, 'model')
  requireString(value.model.providerId, 'model.providerId')
  requireString(value.model.modelId, 'model.modelId')
  if (!isOneOf(value.thinkingLevel, THINKING_LEVELS)) fail('thinkingLevel is invalid')
  assertAgentToolSettings(value.agentTools)
}

const MINDSET_IDS = ['explorer', 'executor'] as const
const AUTHORITY_IDS = ['ask', 'auto'] as const
const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function isOneOf(candidate: unknown, allowed: ReadonlyArray<string>): boolean {
  return typeof candidate === 'string' && allowed.includes(candidate)
}

export function assertPromptInput(value: unknown): asserts value is PromptInput {
  requireRecord(value, 'prompt input')
  requireString(value.sessionId, 'sessionId')
  requireString(value.message, 'message')
}

export function assertResolveApprovalInput(value: unknown): asserts value is ResolveApprovalInput {
  requireRecord(value, 'resolveApproval input')
  requireString(value.sessionId, 'sessionId')
  requireString(value.approvalId, 'approvalId')
  if (value.decision !== 'allow' && value.decision !== 'allow_session' && value.decision !== 'deny') {
    fail('decision must be allow|allow_session|deny')
  }
}

function assertAgentToolSettings(value: unknown): asserts value is AgentToolSettings {
  requireRecord(value, 'agentTools')
  const known = new Set<string>(AGENT_TOOL_SETTING_KEYS)
  for (const [key, setting] of Object.entries(value)) {
    if (!known.has(key)) fail(`agentTools has unknown setting: ${key}`)
    if (typeof setting !== 'boolean') fail(`agentTools.${key} must be boolean`)
  }
}

function requireRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`)
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`)
}

function fail(message: string): never {
  throw new TypeError(message)
}
