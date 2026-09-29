/**
 * The agent store's approval-queue slice: pending tool approvals awaiting a
 * user click on a permission card. Fully standalone — no session state behind
 * it (see agent.ts for the composition).
 */

import { ref } from 'vue'
import { nextId } from './agent-id'

/**
 * The choices an approval card can carry across IPC. `allow_always` deepens
 * the approval into a whitelist rule (session overlay + persisted workspace
 * policy entry) — see permissionWhitelist.ts; the card only offers it when
 * the call has an honest narrower-than-action shape.
 */
export type ApprovalDecision = 'allow' | 'allow_session' | 'allow_always' | 'deny'

export interface ApprovalRequest {
  id: string
  action: string
  reason: string
  /** The tool call's actual arguments, when supplied (native Pi bridge). */
  args?: Record<string, unknown>
  /**
   * Resolves the awaiting Promise in permissionMode. Carries the full decision
   * so `'allow_session'` reaches the coordinator's grant set; `boolean` would
   * collapse it to allow-once and silently lie.
   */
  resolve: (decision: ApprovalDecision) => void
}

export function createApprovalQueueSlice() {
  /** Pending tool approvals awaiting a user click on a permission card. */
  const pendingApprovals = ref<ApprovalRequest[]>([])

  function pushApproval(req: Omit<ApprovalRequest, 'id'> & { id?: string }): string {
    const id = req.id ?? nextId('approval')
    pendingApprovals.value.push({ ...req, id })
    return id
  }

  function resolveApproval(id: string, decision: ApprovalDecision): void {
    const idx = pendingApprovals.value.findIndex(a => a.id === id)
    if (idx === -1) return
    const [req] = pendingApprovals.value.splice(idx, 1)
    req.resolve(decision)
  }

  return { pendingApprovals, pushApproval, resolveApproval }
}
