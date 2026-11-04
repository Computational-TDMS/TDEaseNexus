/**
 * Three-state model for the Node AgentRuntime, replacing the previous wrong
 * "single prompt fully frozen" assumption.
 *
 * Pi 0.80.3 reality (verified against dist/core/*.d.ts):
 *   - One TDEase user message = one `AgentSession.prompt()` = one Pi *agent run*
 *   - One agent run contains multiple Pi *turns*
 *   - Each Pi turn may produce one provider request + a batch of tool executions
 *   - `AgentSession` exposes `setActiveTools`/`setModel`/`setThinkingLevel` and
 *     the `context` hook rewrites messages before every provider request, all
 *     taking effect inside one running prompt() without recreating the session
 *
 * Therefore the model has three levels of state, each with its own freeze rule:
 *
 *   1. SessionBinding     — Workspace/Session/Authority/permission+tool ceiling.
 *                           Frozen for the binding's lifetime. Cannot be widened
 *                           by any hook (security boundary, AGENT-CONTRACT.md §1).
 *   2. AgentRunDefinition — one prompt()'s inputs (message, mindset,
 *                           wall-clock budget, referenced-asset digest,
 *                           initial model/thinking). Frozen at
 *                           before_agent_start for replayability of the run's
 *                           base System Prompt.
 *   3. ProviderRequestSnapshot — what each individual provider request actually
 *                           saw (system prompt digest, context digest, active
 *                           tools digest, model, thinking level). Recomputed by
 *                           the `context` hook; recorded as
 *                           `model.request.prepared` so dynamic mid-run changes
 *                           are replayable.
 *
 * What may change inside one prompt() (via Pi native hooks): model, thinking
 * level, active tools, context messages.
 * What may NEVER change inside one prompt(): Workspace identity, authority,
 * permission ceiling, tool ceiling, Workspace containment.
 *
 * This file deliberately does NOT re-enumerate Pi's adjustability (the previous
 * InTurnAdjustable/NextTurnAdjustable enums were a wrong, shrunk copy of Pi's
 * real capabilities). Pi itself defines the real knobs; TDEase only freezes the
 * security boundary and records what each provider request actually saw.
 */

import type {
  AgentPermissionAction,
  AgentPermissionDecision,
  AgentPermissionRule,
  AuthorityId,
  MindsetId,
  ModelSelector,
  PermissionSnapshot,
  ThinkingLevel,
} from '../../src/contracts/agent-runtime'

// ── Level 1: SessionBinding — frozen for the binding's lifetime ──────────────

/**
 * The tool ceiling: the maximum tool surface this binding ever permits. A hook
 * may call `setActiveTools` to *narrow* the active set, never to exceed it.
 */
export interface ToolCeiling {
  /** Builtin tools the mindset + Agent Tools settings permit (read/write/edit/bash/...). */
  readonly builtins: ReadonlyArray<string>
  /** Whether MCP servers may be enabled. */
  readonly mcp: boolean
}

/**
 * Frozen per Workspace/Session binding. Node owns this; the Renderer only
 * supplied the inputs that produced it.
 *
 * `generation` is the monotonic counter Node uses to discard events that arrive
 * after a Workspace switch, dispose or rebuild — a late straggler from
 * generation N must never render against generation N+1.
 */
export interface SessionBinding {
  readonly workspaceId: string
  readonly sessionId: string
  /** Absolute Workspace root. Node-only; never crosses to the Renderer. */
  readonly workspaceRoot: string
  readonly authority: AuthorityId
  /** The deny-dominant permission snapshot, resolved once at bind time. */
  readonly permissionCeiling: PermissionSnapshot
  /**
   * Parameter-level overrides (pi-permission style), sorted by priority and
   * frozen at bind time alongside the ceiling. The only way a specific call
   * may beat the ladder (e.g. `bash ^git ` → allow while shell.exec is ask);
   * with no matching override the coarse ceiling decides, so a policy without
   * parameterized rules behaves exactly as the ladder alone. Delegated
   * children inherit this array verbatim, never re-resolved.
   */
  readonly permissionRules?: ReadonlyArray<AgentPermissionRule>
  /** The maximum tool surface; active tools may narrow but never exceed it. */
  readonly toolCeiling: ToolCeiling
  readonly generation: number
  /** Subagent role briefing (base + role system_prompt); undefined for parents. */
  readonly systemPromptOverride?: string
  /**
   * Delegation identity, set only on registry-bound child sessions: the parent
   * sessionId this binding inherited its frozen ceiling from. Audit-facing
   * (tool audit rows and approval events can name the parent task); it has no
   * runtime effect — the ceiling itself was already frozen from the parent.
   */
  readonly delegatedFrom?: string
  /** The tool allowlist the parent narrowed this child to (same audit story
   *  as `delegatedFrom`; absent for parents and un-narrowed children). */
  readonly delegationScope?: ReadonlyArray<string>
  /** When true, the PTC policy fragment is assembled and `tdease.ptc.exec` is
   *  injected. Off by default — programmatic tool calling is an opt-in
   *  capability, never advertised until the session enables it. */
  readonly ptcEnabled?: boolean
}

// ── Level 2: AgentRunDefinition — frozen at before_agent_start ────────────────

export interface TurnBudgets {
  readonly wallClockMs: number
}

/**
 * The inputs to one `prompt()`. Frozen at `before_agent_start` so the run's base
 * System Prompt (assembled from the contributors in prompt-pipeline.ts) is
 * replayable from `referencedAssetsDigest` + the binding.
 */
export interface AgentRunDefinition {
  readonly turnId: string
  readonly userMessage: string
  readonly mindset: MindsetId
  readonly budgets: TurnBudgets
  /** Digest of the frozen @-referenced asset content for this run. */
  readonly referencedAssetsDigest: string
  /** Initial model/thinking; hooks may change these for later provider requests. */
  readonly initialModel: ModelSelector
  readonly initialThinkingLevel: ThinkingLevel
  /** The composer's inline-visualization toggle as dispatched with this turn.
   *  Turn-scoped by construction: it is frozen here, before assembly, so each
   *  turn's prompt records the answering mode it ran under. */
  readonly inlineVisualization?: boolean
}

// ── Level 3: ProviderRequestSnapshot — recorded per provider request ─────────

/**
 * What one provider request actually saw. Emitted as a `model.request.prepared`
 * canonical event so a replay can reconstruct each provider request even when
 * the `context` hook dynamically changed the context, active tools, model or
 * thinking level mid-run.
 *
 * Content lives in `snapshots/<digest>.md` (content-addressed); the event only
 * carries digests — never the prompt/context bytes themselves.
 */
export interface ProviderRequestSnapshot {
  readonly turnId: string
  /** 1-based sequence of this provider request within the run. */
  readonly requestSeq: number
  readonly systemPromptDigest: string
  readonly contextDigest: string
  readonly activeToolsDigest: string
  readonly model: ModelSelector
  readonly thinkingLevel: ThinkingLevel
}

// ── Digest helpers ────────────────────────────────────────────────────────────

/** Stable stringification for digest inputs — key order must be deterministic. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalize(item)]))
  }
  return value
}

/**
 * Recursively freeze a binding/ceiling so a Pi hook cannot widen the security
 * boundary by mutating it. `Object.freeze` is shallow; a ceiling whose nested
 * `builtins` array stayed mutable would let a hook `push('bash')` past the
 * mindset ceiling. The Node AgentRuntime builds every binding through this.
 */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}
