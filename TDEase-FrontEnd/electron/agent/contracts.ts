/**
 * Internal contracts for the electron/agent/** Node AgentRuntime.
 *
 * Every module under electron/agent/ implements the interfaces defined here.
 * Keeping them in one place lets the modules be written in parallel without
 * interface drift: a module exports a concrete class/interface that satisfies
 * the contract named here, and the composition root (agent-runtime.ts) wires
 * them together.
 *
 * External contract: src/contracts/agent-runtime.ts (Renderer ↔ Node IPC).
 * Three-state model: electron/agent/turn-definition.ts.
 */

import type {
  AgentModelMetadata,
  AgentPermissionAction,
  AgentPermissionDecision,
  AgentPermissionRule,
  AuthorityId,
  MindsetId,
  ModelSelector,
  PermissionSnapshot,
  ThinkingLevel,
} from '../../src/contracts/agent-runtime'
import type {
  ActEvent,
  EventInput,
  SessionEvent,
} from '../../src/agent/events'
import type { ContentRef } from '../../src/agent/ports/content-store'
import type { TurnCard } from '../../src/contracts/turn-card'
import type { CostRates } from '../../src/ai/core/usage-ledger'
import type {
  AgentRunDefinition,
  ProviderRequestSnapshot,
  SessionBinding,
  ToolCeiling,
} from './turn-definition'

// ── Shared port types (mirror src/agent/ports where useful) ───────────────────

export type { ContentRef, EventInput, SessionEvent, ActEvent }

/** A resolved, ready-to-freeze provider+model with its credentials. Node-only. */
export interface ResolvedProvider {
  readonly providerId: string
  readonly modelId: string
  readonly api: string
  readonly baseUrl: string
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly modelMeta?: AgentModelMetadata
}

/** One assembled prompt fragment, with its origin and digest for audit. */
export interface PromptFragment {
  readonly slot:
    | 'base-role'
    | 'tool-policy'
    | 'delegation-policy'
    | 'orchestrate-policy'
    | 'ptc-policy'
    | 'mindset'
    | 'safety'
    | 'subagent-role'
    | 'skill-index'
    | 'referenced-skill'
    | 'referenced-context'
    | 'workspace-context'
  readonly origin: string
  readonly content: string
  readonly digest: string
}

/** The fully assembled system prompt for one agent run, frozen at before_agent_start. */
export interface AssembledPrompt {
  readonly systemPrompt: string
  readonly digest: string
  readonly fragments: ReadonlyArray<PromptFragment>
}

/** A resolved @-reference, frozen into the snapshot. Bytes never leave Node. */
export interface ResolvedReference {
  readonly kind: 'run' | 'file' | 'skill'
  readonly refId: string
  readonly label: string
  readonly body?: string
  readonly found: boolean
}

// ── Component interfaces ─────────────────────────────────────────────────────

/**
 * Owns `.tdease/sessions/<id>/` on disk: session.json, events.jsonl,
 * snapshots/<digest>.md, content/<digest>.blob, model-session/ (Pi transcript).
 *
 * Reuses the pure logic in src/agent/events (JsonlSessionLog) and
 * src/agent/prompt (PromptSnapshotStore) but backed by Node fs instead of IPC.
 */
export interface SessionStore {
  /** Absolute dir for one session: <workspaceRoot>/.tdease/sessions/<id>. */
  sessionDir(sessionId: string): string
  /** Absolute dir for the Pi model-session transcript. */
  modelSessionDir(sessionId: string): string
  ensureSessionDirs(sessionId: string): void
  appendEvent(sessionId: string, event: EventInput): Promise<SessionEvent>
  readEvents(sessionId: string): Promise<ReadonlyArray<SessionEvent>>
  /** Append one per-turn roadmap card to turns.jsonl (src/contracts/turn-card.ts). */
  appendTurnCard(sessionId: string, card: TurnCard): Promise<void>
  /** All recorded turn cards, in append order. Empty for a fresh session. */
  readTurnCards(sessionId: string): Promise<ReadonlyArray<TurnCard>>
  writeSnapshot(sessionId: string, digest: string, content: string): Promise<void>
  readSnapshot(sessionId: string, digest: string): Promise<string | undefined>
  putContent(sessionId: string, content: string, mediaType?: string): Promise<ContentRef>
  getContent(sessionId: string, ref: ContentRef): Promise<string>
  /** Whether a model-session transcript already exists (resume vs fresh). */
  hasTranscript(sessionId: string): boolean
  /**
   * Copy the conversation artifacts (events.jsonl, snapshots/, content/) of a
   * source session into a fork target. Without this a forked session keeps its
   * Pi transcript but loses the entire visible conversation. Missing source
   * artifacts are skipped (a fresh session has nothing to clone).
   */
  cloneConversation(sourceId: string, targetId: string): Promise<void>
}

export interface ProviderSummary {
  readonly providerId: string
  readonly displayName: string
  readonly models: ReadonlyArray<string>
  readonly configured: boolean
}

/**
 * Node-owned provider catalog + credentials. Reads from
 * <Client System>/settings.json (schemaVersion 3, top-level providers). The
 * Renderer never sees secrets; it only gets ProviderSummary via BoundSession.
 */
export interface ProviderRegistry {
  resolve(selector: ModelSelector): ResolvedProvider
  summarize(): ReadonlyArray<ProviderSummary>
  /** True when the selected provider has a usable credential. */
  isConfigured(selector: ModelSelector): boolean
  /**
   * Freeze a discovered model-capability digest into settings.json's
   * `providers.<id>.models.<modelId>` (field-level merge, atomic, never
   * throws). Optional: read-only fakes omit it and the digest simply is not
   * persisted. The capability seam reads the block back as its
   * highest-priority input on the next bind.
   */
  persistModelMeta?(selector: ModelSelector, meta: AgentModelMetadata): Promise<void>
}

/**
 * Assembles the frozen system prompt for one agent run (before_agent_start),
 * and records per-provider-request context snapshots (context hook).
 */
export interface PromptPipeline {
  /** Resolve @-references from the user message against Workspace/System roots. */
  resolveReferences(message: string): Promise<ReadonlyArray<ResolvedReference>>
  /** Assemble the run-level system prompt (frozen for the whole prompt()). */
  assembleForRun(
    binding: SessionBinding,
    run: AgentRunDefinition,
    references: ReadonlyArray<ResolvedReference>,
  ): Promise<AssembledPrompt>
  /** Snapshot one provider request's context for replay (model.request.prepared). */
  snapshotProviderRequest(
    turnId: string,
    requestSeq: number,
    systemPromptDigest: string,
    messages: unknown,
    activeTools: ReadonlyArray<string>,
    model: ModelSelector,
    thinkingLevel: ThinkingLevel,
  ): ProviderRequestSnapshot
}

/**
 * The unbypassable permission + containment layer. Every tool call (builtin,
 * TDEase, MCP) passes through here. deny > ask > allow against the frozen
 * SessionBinding.permissionCeiling.
 */
export interface PermissionGateway {
  decide(action: AgentPermissionAction): AgentPermissionDecision
  /**
   * Decide one concrete call: parameterized rules (the binding's frozen
   * `permissionRules`) are consulted first — the highest-priority rule whose
   * command/path predicate matches wins — and with no match the coarse
   * `decide` ceiling applies. Same evaluation lives in the Renderer for the
   * settings preview; both sides import it from permissionResolver.ts, so the
   * semantics cannot drift.
   */
  decideCall(action: AgentPermissionAction, input?: Readonly<Record<string, unknown>>): AgentPermissionDecision
  /** Resolve + contain a Workspace-relative path. Throws on escape. */
  resolveWorkspacePath(relative: string, operation: 'read' | 'write'): string
  /** Assert a bash cwd is inside the Workspace. */
  assertCommandCwd(cwd?: string): string
  /** Preflight a shell command against the destructive-command blacklist. */
  assertShellCommand(command: string): void
}

/**
 * Manages pending approvals. When PermissionGateway.decide returns 'ask', the
 * ToolGateway calls request(); this blocks until the Renderer resolves it via
 * resolveApproval IPC. On turn abort/dispose, cancelAll() rejects every pending
 * promise so the Pi loop is unblocked.
 */
/** How a pending approval settled. `allow_always` additionally implies the
 *  whitelist deepening (session overlay + persisted rule) — see
 *  permissionWhitelist.ts and the coordinator's `sessionRulesFor`. */
export type ApprovalResolution = 'allow' | 'allow_always' | 'deny'

export interface ApprovalCoordinator {
  request(
    sessionId: string,
    action: AgentPermissionAction,
    basis: string,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<ApprovalResolution>
  resolve(approvalId: string, decision: 'allow' | 'allow_session' | 'allow_always' | 'deny'): void
  /** True if the user chose "allow for this session" for this action this session. */
  hasSessionGrant(sessionId: string, action: AgentPermissionAction): boolean
  /**
   * The session's whitelist overlay: rules the user added via "always allow"
   * on an approval card this session. Merged AFTER the binding's frozen rules
   * by the caller — overlay entries (priority -1) can silence a ladder ask
   * but never a hand-written rule. Dies with the session.
   */
  sessionRulesFor(sessionId: string): ReadonlyArray<AgentPermissionRule>
  /** Reject all pending approvals for a session (abort/dispose). */
  cancelSession(sessionId: string): void
}

/** Callback Node uses to push transient events to the Renderer for one session. */
export interface RuntimeEventSink {
  textDelta(sessionId: string, text: string): void
  thinkingDelta(sessionId: string, text: string): void
  approvalRequested(
    sessionId: string,
    approvalId: string,
    action: string,
    basis: string,
    args?: Readonly<Record<string, unknown>>,
  ): void
  eventCommitted(sessionId: string, event: SessionEvent): void
  turnTerminal(
    sessionId: string,
    turnId: string,
    outcome: 'resolved' | 'blocked' | 'halted' | 'cancelled' | 'failed',
    usage: { input_tokens: number; output_tokens: number; tool_calls: number; wall_clock_ms: number },
  ): void
}

/**
 * Translates Pi's native events (message_update, tool_execution_start/end, etc.)
 * into canonical SessionEvents and transient streaming deltas. Mirrors
 * src/agent/events/translate-pi.ts (PiActCollector) but Node-side and emitting
 * both canonical events (via SessionStore) and transient deltas (via sink).
 */
export interface EventAdapter {
  /** Observe one raw Pi event; returns the canonical events to append. */
  observe(rawEvent: unknown): ReadonlyArray<ActEvent>
  /** Extract a transient streaming delta from a raw Pi event, if any. */
  transientDelta(rawEvent: unknown): { kind: 'text' | 'thinking'; text: string } | null
  /** Finish the current act: flush + return usage. */
  finish(): {
    events: ReadonlyArray<ActEvent>
    usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }
    suspended_ms: number
  }
}

/**
 * Usage + audit observers. Failures here MUST NOT interrupt the model call —
 * they are observability, not prerequisites (AGENT-LOOP.md).
 */
export interface Observers {
  /** Start a usage record for one LLM call. Returns a handle to finish/error.
   *  `cost` — per-token rates resolved at bind time (pi catalog or settings
   *  meta); absent → the observer falls back to the settings meta only. */
  startUsage(meta: { model: ModelSelector; provider: ResolvedProvider; cost?: CostRates }): string
  finishUsage(handle: string, usage: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens?: number
    cache_write_tokens?: number
  }): void
  /** Settle a handle that did not resolve normally. `usage` — the partial
   *  usage of the LLM calls that DID complete before the failure — is real
   *  consumption and must reach the ledger, or every aborted long turn (the
   *  most cache-heavy workloads) silently vanishes from statistics. */
  errorUsage(handle: string, error: unknown, status: 'error' | 'aborted', usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_tokens?: number
    cache_write_tokens?: number
  }): void
  /** Audit a tool call (best-effort, never throws). `identity` carries the
   *  binding facts every permission decision was made under (authority,
   *  delegation parent + granted scope) — optional so callers without a
   *  binding still audit. */
  auditTool(sessionId: string, callId: string, name: string, args: unknown, result: unknown, ok: boolean,
    identity?: { authority?: 'ask' | 'auto'; delegatedFrom?: string; delegationScope?: ReadonlyArray<string> }): void
}

/**
 * The ambient services a live turn consults — everything the loop itself does
 * not own but must reach: background-task drains (jobs, subagents), the
 * delegation carve-out probe, workspace byte reads for image markers, the
 * produced-path ledger, and the context-occupancy push. One seam instead of
 * six optional fields each spawning a conditional branch: the composition
 * root supplies a complete object (a session without a capability gets a
 * no-op), and host/extension code reads one name.
 */
export interface TurnAmbient {
  /** Drain newly-settled background jobs for the context hook to announce. */
  drainSettledJobs(): ReadonlyArray<import('../../src/studio/commands/registry').JobStatus>
  /** Drain newly-settled subagents (each carrying its §6 result). */
  drainSettledSubagents(): ReadonlyArray<import('../../src/studio/commands/registry').SubagentStatus>
  /** Drain Backend runs that went terminal while the session watched them —
   *  the `runs.*` analogue of the two drains above. */
  drainSettledRuns(): ReadonlyArray<import('../../src/studio/domain/run').RunSummary>
  /** Non-consuming probe: does this session still have running subagents?
   *  The wall-clock deadline holds its abort while true so delegated work is
   *  never orphaned at settlement. Must not drain or mutate registry state. */
  hasActiveSubagents(): boolean
  /** Read a workspace-relative file as raw bytes for `[attached_image: path]`
   *  markers. Containment-checked by the supplying bridge. */
  readWorkspaceBytes(relative: string): Promise<Uint8Array>
  /** Push live context occupancy to the renderer — a read-side channel,
   *  never a turn event. */
  emitContextUsage(sessionId: string, usage: import('../../src/contracts/agent-runtime').ContextUsageSnapshot): void
  /** Produced-path ledger shared with this session's gateway: write/edit
   *  targets noted by the tool_result hook; the historical-analysis guard
   *  exempts covered paths. Optional — absent keeps the pre-ledger guard. */
  producedPaths?: import('./tdease-extension').ProducedPathLedger
}

/**
 * The runtime's one outward event surface. Every push channel the renderer
 * consumes — turn events, Run invalidation, subagent/job record snapshots,
 * context occupancy — is a member of this object, so the runtime's push
 * vocabulary is named once and grows in exactly one place. Turn events are
 * the only model-visible stream; the rest are read-side pushes kept off the
 * RuntimeEvent union deliberately.
 */
export interface RuntimePush {
  /** The turn-event stream (text/thinking deltas, approvals, committed
   *  events, terminal). The only channel the agent transcript consumes. */
  turnEvent(sessionId: string, event: import('../../src/contracts/agent-runtime').RuntimeEvent): void
  /** A Run projection changed (backend invalidation). */
  runsInvalidated?(workspaceId: string): void
  /** Subagent record snapshots (spawn / transition / cancel). */
  subagents?(sessionId: string, snapshot: ReadonlyArray<import('../../src/studio/commands/registry').SubagentStatus>): void
  /** Background-job record snapshots (start / settle / cancel). */
  jobs?(sessionId: string, snapshot: ReadonlyArray<import('../../src/studio/commands/registry').JobStatus>): void
  /** Runs DISPATCHED by this session, with live status — the Agent page's
   *  run list shows only these, never the workspace's run history. */
  sessionRuns?(sessionId: string, snapshot: ReadonlyArray<import('../../src/studio/domain/run').RunSummary>): void
  /** Live context occupancy. */
  contextUsage?(sessionId: string, usage: import('../../src/contracts/agent-runtime').ContextUsageSnapshot): void
}

export type { SessionBinding, AgentRunDefinition, ProviderRequestSnapshot, ToolCeiling }
export type { AgentPermissionAction, AgentPermissionDecision, PermissionSnapshot, MindsetId, AuthorityId, ThinkingLevel, ModelSelector }
