/**
 * Node-side ApprovalCoordinator: the bridge between `decide() === 'ask'` and
 * the user's yes/no in the Renderer.
 *
 * When the PermissionGateway returns 'ask' for a tool, the ToolGateway calls
 * `request()` here, which returns a Promise<boolean> that blocks the Pi tool
 * loop until the Renderer answers via `resolveApproval` IPC. The loop MUST stay
 * blocked (Pi is single-writer for one session) so the user's decision is
 * honored — the alternative (timing out and guessing) would either auto-allow a
 * sensitive action or auto-deny a legitimate one.
 *
 * The one escape hatch is `cancelSession`: on abort/dispose, every pending
 * approval for one session is rejected with `Error('Approval cancelled')` AND
 * that session's grant set is cleared, so the Pi loop unblocks instead of
 * hanging forever waiting for a user who has moved on. Generation discipline
 * (turn-definition.ts) means a late `resolve` from a disposed session is a
 * clean no-op, not a use-after-free.
 *
 * ## Session grant set (`allowsSessionGrant`)
 *
 * The third resolve choice, `'allow_session'`, records a standing per-Session
 * grant for the action the approval was about. `hasSessionGrant` is consulted
 * by the `tool_call` hook (tdease-extension.ts) BEFORE prompting: if the user
 * already said "allow for this session" for that action this turn, the prompt
 * is skipped and the call proceeds. Grants are pure in-memory runtime state —
 * they never cross IPC as a decision value (`AgentPermissionDecision` stays a
 * closed allow|ask|deny vocabulary), never touch the permission snapshot, and
 * never persist to disk. They die with the session (`cancelSession` clears
 * them), which is what makes "allow for this session" honest: it does not
 * survive a restart and cannot leak into another Workspace's session
 * (AGENT-CONTRACT.md §4 — a session never inherits the previous authorization).
 *
 * This module owns only the promise + grant bookkeeping. It does NOT emit the
 * `approval_requested` Renderer event itself — that is the composition root's
 * job (it owns the RuntimeEventSink and the generation check). To keep that
 * wiring in one place without this module taking a hard dependency on the sink,
 * the constructor accepts an optional `onPending` callback fired exactly when a
 * request is created.
 *
 * ## Whitelist overlay (`allow_always`)
 *
 * The fourth resolve choice, `'allow_always'`, deepens the approval into a
 * parameterized whitelist rule (permissionWhitelist.ts). The derived rule
 * joins `sessionRules` — consulted by the tool_call gate AFTER the frozen
 * binding rules, so it can silence a ladder ask but never a hand-written
 * rule — and rides the `onWhitelistRule` callback to the host, which persists
 * it into the workspace policy for future binds. The overlay is runtime
 * state: it dies with the session even though the persisted rule survives,
 * because the persisted copy is what future binds freeze in. Re-deriving is
 * idempotent on merge, so answering "always allow" twice never duplicates an
 * entry.
 */

import { randomUUID } from 'node:crypto'

import type { AgentPermissionAction, AgentPermissionRule } from '../../src/contracts/agent-runtime'
import { deriveWhitelist } from '../../src/services/agent/permissionWhitelist'

import type { ApprovalCoordinator, ApprovalResolution } from './contracts'

/**
 * Fired the instant a pending approval is created (before the caller awaits the
 * returned promise). The composition root wires this to the RuntimeEventSink so
 * the Renderer learns an approval is needed. `args` carries the tool's actual
 * arguments so the approval UI can show what is about to run (e.g. the shell
 * command). The Renderer has no other source for them: the approval stream is
 * independent of `tool.requested`, and the Renderer keeps no call_id→args map
 * to correlate the two. `basis` is the human-readable reason to surface.
 */
export type ApprovalPendingCallback = (info: {
  approvalId: string
  sessionId: string
  action: string
  basis: string
  args?: Readonly<Record<string, unknown>>
}) => void

interface PendingEntry {
  approvalId: string
  resolve: (resolution: ApprovalResolution) => void
  reject: (error: unknown) => void
  sessionId: string
  action: AgentPermissionAction
  /** The call args the pending approval was created with — the raw material
   *  the "always allow" whitelist deepening derives its rule from. */
  args?: Readonly<Record<string, unknown>>
}

/** Fired when "always allow" produced a whitelist rule. Persistence is the
 *  host's job (it owns the workspace path and the atomic-write queue); the
 *  callback may return a promise and MUST NOT block the tool loop —
 *  rejections are the host's to log. */
export type WhitelistRuleCallback = (info: {
  sessionId: string
  action: AgentPermissionAction
  rule: AgentPermissionRule
  /** Human-readable scope, e.g. `git status …` (audit/event text). */
  scope: string
}) => void | Promise<void>

export class NodeApprovalCoordinator implements ApprovalCoordinator {
  /** Keyed by approvalId — the correlation id that crosses IPC. */
  private readonly pending = new Map<string, PendingEntry>()

  /**
   * Per-Session standing grants. Keyed by sessionId, then a Set of actions the
   * user chose "Allow for this session" for. See the class header for why this
   * is runtime state, not a decision value. Lazily created on first grant.
   */
  private readonly sessionGrants = new Map<string, Set<AgentPermissionAction>>()

  /**
   * Per-Session whitelist overlay: rules added by "always allow" answers this
   * session. These take effect immediately (the binding's frozen rules are
   * immutable by design — the card answer is the sanctioned elevation), and
   * the host persists the same rules for future binds. Dies with the session.
   */
  private readonly sessionRules = new Map<string, AgentPermissionRule[]>()

  constructor(
    private readonly onPending?: ApprovalPendingCallback,
    private readonly onWhitelistRule?: WhitelistRuleCallback,
  ) {}

  /**
   * Create a pending approval and return a promise that resolves to `true` when
   * the user allows it, `false` when they deny. The promise is stored so a late
   * `resolve` (Renderer answered after a parallel cancel) is a clean no-op.
   *
   * `args` is forwarded to `onPending` so the Renderer can show what the tool
   * is about to do. See ApprovalPendingCallback for why the Renderer needs it.
   */
  request(
    sessionId: string,
    action: AgentPermissionAction,
    basis: string,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<ApprovalResolution> {
    const approvalId = randomUUID()
    return new Promise<ApprovalResolution>((resolve, reject) => {
      this.pending.set(approvalId, { approvalId, resolve, reject, sessionId, action, args })
      // Fire after the entry is registered, so a synchronous `resolve` racing
      // in (unlikely but possible if the sink dispatches immediately) finds it.
      if (this.onPending) {
        try {
          this.onPending({ approvalId, sessionId, action, basis, args })
        } catch {
          // A sink error must not strand the approval: the promise is already
          // in the map, so a later resolve/cancel still works. Swallow and let
          // the normal approval flow proceed.
        }
      }
    })
  }

  /**
   * Settle one pending approval. A decision for an unknown id is a clean no-op:
   * it means a stale/late/duplicate answer arrived after cancelSession or after
   * the user already answered once. Throwing here would crash the Renderer's
   * IPC handler for a benign race, which is worse than ignoring it.
   *
   * `'allow_session'` settles the current promise as allowed AND records a
   * standing grant for `(entry.sessionId, entry.action)` so the `tool_call`
   * hook can skip the prompt on subsequent calls to the same action this
   * session. See `hasSessionGrant`. `'allow'` settles once and records nothing.
   *
   * `'allow_always'` deepens the approval into a whitelist rule: the derived
   * rule joins the session overlay immediately (this session's later matching
   * calls skip the prompt) and rides `onWhitelistRule` to the host for
   * persistence. The write is fire-and-forget — a failing policy write must
   * never block the Pi tool loop, and the overlay already covers this session.
   */
  resolve(approvalId: string, decision: 'allow' | 'allow_session' | 'allow_always' | 'deny'): void {
    const entry = this.pending.get(approvalId)
    if (!entry) return
    this.pending.delete(approvalId)
    if (decision === 'allow_session') {
      let grants = this.sessionGrants.get(entry.sessionId)
      if (!grants) {
        grants = new Set()
        this.sessionGrants.set(entry.sessionId, grants)
      }
      grants.add(entry.action)
    }
    if (decision === 'allow_always' && entry.args) {
      const derivation = deriveWhitelist(entry.action, entry.args)
      if (derivation) {
        let rules = this.sessionRules.get(entry.sessionId)
        if (!rules) {
          rules = []
          this.sessionRules.set(entry.sessionId, rules)
        }
        rules.push(derivation.rule)
        if (this.onWhitelistRule) {
          try {
            const result: void | Promise<void> = this.onWhitelistRule({
              sessionId: entry.sessionId,
              action: entry.action,
              rule: derivation.rule,
              scope: derivation.scope,
            })
            if (result instanceof Promise) {
              result.catch(() => {
                // The overlay already covers this session; a failed persist
                // only costs future sessions. The host logs its own IO errors.
              })
            }
          } catch {
            // Same contract: a synchronous callback error must not break the
            // turn.
          }
        }
      }
    }
    entry.resolve(decision === 'deny' ? 'deny' : decision === 'allow_always' ? 'allow_always' : 'allow')
  }

  /**
   * Did the user already grant this action for this session? Called by the
   * `tool_call` hook before prompting. A grant recorded under a disposed
   * session is unreachable (cancelSession cleared it), so this never honors a
   * stale authorization from a different session.
   */
  hasSessionGrant(sessionId: string, action: AgentPermissionAction): boolean {
    return this.sessionGrants.get(sessionId)?.has(action) ?? false
  }

  sessionRulesFor(sessionId: string): ReadonlyArray<AgentPermissionRule> {
    return this.sessionRules.get(sessionId) ?? []
  }

  /**
   * Reject every pending approval for one session AND clear its grant set.
   * Called on abort/dispose so the Pi loop's `await request(...)` unblocks with
   * an error the tool runner turns into a `turn.cancelled` outcome, rather than
   * hanging on a user who will never answer — and so the grants die with the
   * session (§4 isolation).
   *
   * Iterating then deleting is safe because we snapshot the matching ids first;
   * rejecting cannot synchronously re-enter this map.
   */
  cancelSession(sessionId: string): void {
    const doomed: PendingEntry[] = []
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) doomed.push(entry)
    }
    for (const entry of doomed) {
      // Delete before reject so a `.catch` handler that calls back into the
      // coordinator cannot observe its own just-cancelled entry. Keyed by
      // approvalId (the map key), NOT sessionId.
      this.pending.delete(entry.approvalId)
      entry.reject(new Error('Approval cancelled'))
    }
    // Grants and whitelist rules are session-scoped runtime state: they must
    // not survive the session or leak to a later session bound under the same
    // id. (A persisted whitelist rule — the host's write — intentionally does
    // survive: the user asked for it explicitly.)
    this.sessionGrants.delete(sessionId)
    this.sessionRules.delete(sessionId)
  }
}
