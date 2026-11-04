import type { AgentPermissionAction } from '../../src/contracts/agent-runtime'
import type { EventInput } from '../../src/agent/events'
import { evaluatePermissionDecision, sortPermissionRules } from '../../src/services/agent/permissionResolver'
import type { ApprovalCoordinator, SessionBinding } from './contracts'

/** Paths produced during the current turn, used only for provenance/audit. */
export interface ProducedPathLedger {
  note(path: string): void
  covers(path: string): boolean
}

export function createProducedPathLedger(): ProducedPathLedger {
  const produced = new Set<string>()
  const normalize = (value: string) => value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
  return {
    note(path) {
      const value = normalize(path)
      if (value) produced.add(value)
    },
    covers(path) {
      const value = normalize(path)
      return Boolean(value) && [...produced].some((item) => value === item || value.startsWith(`${item}/`))
    },
  }
}

/** Scrub credential-shaped keys from anything headed for the audit log. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    /api[-_]?key|authorization|access[-_]?token|secret/i.test(key) ? '[REDACTED]' : redact(item),
  ]))
}

export interface ToolCallGateOptions {
  readonly binding: SessionBinding
  readonly approvals: ApprovalCoordinator
  /** Retained for wiring compatibility; no filesystem/scientific gate uses it. */
  readonly producedPaths?: ProducedPathLedger
  readonly actionForTool: (toolName: string) => AgentPermissionAction | undefined
  readonly append: (event: EventInput) => Promise<void>
  readonly turnId: () => string
}

export interface ToolCallGate {
  check(toolName: string, input: unknown, callId: string): Promise<{ block: string } | undefined>
}

/** The only invocation gate: authorization and interactive approval. */
export function createToolCallGate(options: ToolCallGateOptions): ToolCallGate {
  return {
    async check(toolName, input, callId) {
      const action = options.actionForTool(toolName)
      if (!action) return undefined
      // Rules in priority order: the binding's frozen rules first, then the
      // session's whitelist overlay (priority -1 entries from "always allow"
      // answers). Re-sorting per call is deliberate — the combined array is a
      // handful of rules, and the sort is what makes "hand-written rules
      // outrank the overlay, overlay outranks the ladder" hold for every
      // call shape without any hidden state.
      const args = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Readonly<Record<string, unknown>>
        : undefined
      const evaluation = evaluatePermissionDecision(
        sortPermissionRules([
          ...(options.binding.permissionRules ?? []),
          ...options.approvals.sessionRulesFor(options.binding.sessionId),
        ]),
        options.binding.permissionCeiling,
        action,
        args,
      )
      const ruleNote = evaluation.matched?.note ? ` — ${evaluation.matched.note}` : ''
      if (evaluation.decision === 'deny') return { block: `Permission denied: ${action}${ruleNote}` }
      if (evaluation.decision !== 'ask') return undefined

      if (options.approvals.hasSessionGrant(options.binding.sessionId, action)) {
        await options.append({
          type: 'approval.resolved',
          turn_id: options.turnId(),
          call_id: callId,
          decision: 'approved',
          by: 'session-grant',
        })
        return undefined
      }

      const basis = `${toolName} requested ${action}${ruleNote}`
      await options.append({
        type: 'approval.requested',
        turn_id: options.turnId(),
        call_id: callId,
        action,
        basis,
      })
      const resolution = await options.approvals.request(
        options.binding.sessionId,
        action,
        basis,
        args,
      )
      await options.append({
        type: 'approval.resolved',
        turn_id: options.turnId(),
        call_id: callId,
        decision: resolution === 'deny' ? 'declined' : 'approved',
        by: 'user',
        ...(resolution === 'allow_always' ? { whitelisted: true } : {}),
      })
      return resolution === 'deny' ? { block: `Permission declined: ${action}` } : undefined
    },
  }
}
