/**
 * Chat content-block types — the discriminated-union model for assistant
 * message bodies, ported from openhanako's chat-types.ts.
 *
 * Two "species":
 *   - TextDecorator: assembled from the streaming buffer in display order
 *     (thinking → tool_group → text). Updatable (the inflight message's
 *     blocks are mutated as deltas arrive).
 *   - RichBlock: pushed as discrete events, never updatable. This port
 *     only carries the `permission` rich block (openhanako has more:
 *     artifact, skill, cron_confirm, etc., none of which TDEase uses).
 *
 * The store (agent.ts) wraps these in AgentChatMessage.blocks: ContentBlock[].
 */

/**
 * Render status for one tool call. `cancelled` is first-class (assistant-ui's
 * status vocabulary): a turn that ends without a call completing must render
 * that call as interrupted — neutral glyph, never the red failure cross, and
 * never the running dots that would otherwise tick forever in a replay.
 */
export type ToolStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'

/** A single tool invocation within a tool_group block. */
export interface ToolCall {
  id: string
  name: string
  args?: Record<string, unknown>
  /** Has the model finished emitting this call (result arrived or error). */
  done: boolean
  /** Did the call succeed. */
  success: boolean
  /** Normalized status for rendering. */
  status: ToolStatus
  /** Error message if status==='failed'. */
  error?: string
  /**
   * Bounded preview of the tool's output, carried on a settled successful
   * call (agentui tool-ui: an expansion must add what the summary hid — the
   * result preview is the one dimension an args summary can never show).
   * Undefined = not carried (call unsettled, or a legacy event without a
   * result). Present with empty `text` = the tool explicitly produced no
   * output, which renders as its own "no output" state instead of silence.
   */
  resultPreview?: ToolResultPreview
  /** Optional short detail pulled from args (e.g. the command, the path). */
  detail?: ToolDetail
  /**
   * The resolved approval for this call, if it was gated on consent. Folded
   * INTO the tool call (not emitted as a separate permission block) so a
   * replayed turn shows the tool once — name + args + the approval decision
   * on one row — instead of a duplicate tool row plus a bulky permission card.
   * Live pending approvals never land here; they render in the ApprovalModal.
   */
  approval?: ToolApproval
}

/** A settled approval attached to a tool call (replay-only; never pending). */
export interface ToolApproval {
  /** 'approved' | 'declined' — the user's recorded decision. */
  decision: 'approved' | 'declined'
  /** Human-readable reason the approval was requested. */
  reason?: string
}

/** Bounded output preview on a settled successful tool call. */
export interface ToolResultPreview {
  /** Verbatim head of the output ('' = the tool produced no output). */
  text: string
  /** True when `text` was cut at the projection's preview budget. */
  truncated: boolean
  /** Verbatim length of the full output before truncation. */
  totalChars: number
}

export interface ToolDetail {
  text: string
  /** Tooltip with the full (untruncated) sensitive value. */
  title?: string
  /** File path or URL; present → render as clickable link. */
  href?: string
  /** 'file' uses openFile, 'url' uses openExternal. */
  hrefType?: 'file' | 'url'
}

// ── TextDecorator species ────────────────────────────────────────────────────

export interface ThinkingBlock {
  type: 'thinking'
  id: string
  text: string
  sealed: boolean
  /** How long the reasoning segment ran (ms). Stamped when the block seals —
   *  live by the store, durably by the `thinking.recorded` event. Old blocks
   *  and legacy logs predate it, so it stays optional. */
  durationMs?: number
}
export interface ToolGroupBlock { type: 'tool_group'; id: string; tools: ToolCall[] }
export interface TextBlock { type: 'text'; id: string; text: string }

export type TextDecorator = ThinkingBlock | ToolGroupBlock | TextBlock

// ── RichBlock species ────────────────────────────────────────────────────────

export type PermissionStatus = 'pending' | 'confirmed' | 'rejected' | 'timeout' | 'aborted'

export interface PermissionBlock {
  type: 'permission'
  id: string
  /** Tool name awaiting approval (e.g. 'tdease.workflow.submit'). */
  toolName: string
  /** Args the tool wants to run with, shown for transparency. */
  args?: Record<string, unknown>
  /** Human-readable reason why approval is being asked. */
  reason?: string
  status: PermissionStatus
  /** The decision recorded by the boundary, when it has resolved. */
  decision?: string
  /** False for a historical pending approval with no live resolver to receive a click. */
  actionable?: boolean
}

export type RichBlock = PermissionBlock

// ── Session-marker species ───────────────────────────────────────────────────

/**
 * A completed context compaction — projected from the session-scoped
 * `context.compacted` event. It owns no turn and speaks for the model, not
 * as the model: the transcript renders it as a divider ("context compacted"),
 * never as an utterance. Token counts are the run's own measurements and are
 * absent whenever it did not report them.
 */
export interface CompactionBlock {
  type: 'compaction'
  id: string
  reason: 'manual' | 'threshold' | 'overflow'
  tokensBefore?: number
  tokensAfter?: number
}

export type ContentBlock = TextDecorator | RichBlock | CompactionBlock

// ── Message wrapper ──────────────────────────────────────────────────────────

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant'
  /** User messages carry plain text; assistant messages carry blocks. */
  content?: string
  blocks?: ContentBlock[]
}
