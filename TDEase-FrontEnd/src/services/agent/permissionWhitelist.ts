/**
 * Whitelist derivation for the approval card's "always allow" choice.
 *
 * When the user answers an approval card with "always allow", the approval is
 * not just a one-off: the call's shape is deepened into a parameterized
 * permission rule (the pi-permission override channel) that persists in the
 * workspace policy — the whitelist accumulates one entry per explicit user
 * approval, and each entry kills exactly one class of future prompts.
 *
 * Everything here is pure and host-free: derivation, merging and scope
 * labeling run identically in the Renderer (card button label) and Electron
 * main (policy persistence). The host that wires persistence up only does
 * file IO around `mergeWhitelistRule`.
 *
 * Two granularity decisions are fixed by the semantics of "the user clicked
 * allow on THIS command":
 *   - bash commands derive a TWO-TOKEN anchored prefix (`git status -sb` →
 *     `^git status\b`): subcommand-level, so approving `git status` never
 *     widens to `git push`. A single-token command degrades to an exact
 *     match.
 *   - path-carrying calls derive the parent directory glob (`analysis/x.md`
 *     → `analysis/**`); a top-level file matches exactly.
 *
 * Derived rules carry `priority: -1`, which sorts them BELOW every hand-
 * written rule (priority ≥ 0), above the shipped default review policy
 * (`defaultPermissionPolicy.ts`, −2), and above the coarse-ladder fallback.
 * That ordering IS the whitelist contract: an explicit hand-written ask or
 * deny always outranks something the user once click-approved; a whitelist
 * entry silences the shipped review policy's asks and the ladder's default
 * ask — which is exactly the "approve once, never prompt again" promise.
 */

import type { AgentPermissionAction } from '@/contracts/agent-runtime'
import { builtinActionFor } from '@/agent/tool-profile'
import { pathInputOf, sortPermissionRules, type PermissionRule } from './permissionResolver'

export const WHITELIST_RULE_PRIORITY = -1
const WHITELIST_RULE_NOTE = 'added by approval card'

/** The whitelistable slice of the ONE builtin action table: only actions
 *  whose calls carry an honest narrower-than-action shape (bash commands,
 *  workspace paths). Read/mcp resolve through the same table but derive no
 *  shape, so the whitelist contract stays "the button names a real scope". */
function whitelistableActionForTool(toolName: string): AgentPermissionAction | undefined {
  const action = builtinActionFor(toolName)
  return action === 'shell.exec' || action === 'workspace.write' ? action : undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface WhitelistDerivation {
  rule: PermissionRule
  /** Human-readable scope for the card button, e.g. `git status …`. */
  scope: string
}

/**
 * Derive the whitelist rule one approval implies, or undefined when the call
 * has no honest narrower-than-action shape (abstract actions like run.trash
 * have nothing to match on — "always allow" there would be a blanket action
 * grant, which the card must never offer).
 */
export function deriveWhitelist(
  action: AgentPermissionAction,
  input?: Readonly<Record<string, unknown>>,
): WhitelistDerivation | undefined {
  if (!input) return undefined
  if (action === 'shell.exec') {
    const command = typeof input.command === 'string' ? input.command.trim().replace(/\s+/g, ' ') : ''
    if (!command) return undefined
    const tokens = command.split(' ')
    // Two tokens anchor the subcommand (`git status`), one token is exact
    // (`npm run` alone stays exactly that, never `^npm\b`).
    const head = tokens.length === 1 ? escapeRegExp(tokens[0]) : `${escapeRegExp(tokens[0])} ${escapeRegExp(tokens[1])}`
    const source = tokens.length === 1 ? `^${head}$` : `^${head}\\b`
    return {
      rule: {
        action,
        decision: 'allow',
        match: { command: source },
        priority: WHITELIST_RULE_PRIORITY,
        note: WHITELIST_RULE_NOTE,
      },
      scope: tokens.length === 1 ? command : `${tokens[0]} ${tokens[1]} …`,
    }
  }
  const path = pathInputOf(input)
  if (path && action === 'workspace.write') {
    // `pathInputOf` already produced the matcher's normal form — the glob is
    // built against exactly what the matcher will compare against.
    const normalized = path.value
    if (!normalized || normalized.includes('*')) return undefined
    const slash = normalized.lastIndexOf('/')
    // A file inside a directory whitelists that directory; a top-level file
    // whitelists exactly itself.
    const glob = slash === -1 ? normalized : `${normalized.slice(0, slash)}/**`
    return {
      rule: {
        action,
        decision: 'allow',
        match: { paths: [glob], ...(path.key !== 'path' ? { pathParam: path.key } : {}) },
        priority: WHITELIST_RULE_PRIORITY,
        note: WHITELIST_RULE_NOTE,
      },
      scope: slash === -1 ? normalized : `${normalized.slice(0, slash)}/`,
    }
  }
  return undefined
}

/**
 * The card-side view: does THIS tool call offer "always allow", and at what
 * scope? The renderer passes the tool name (not the action) — `toolName` is
 * what the approval block carries.
 */
export function deriveWhitelistForTool(
  toolName: string,
  input?: Readonly<Record<string, unknown>>,
): WhitelistDerivation | undefined {
  const action = whitelistableActionForTool(toolName)
  if (!action) return undefined
  return deriveWhitelist(action, input)
}

function sameMatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Merge one whitelist rule into an existing rule list. Idempotent on
 * (action, decision, match): clicking "always allow" twice, or across
 * sessions, must not duplicate entries — the first rule stands. Returns the
 * full sorted list (hand-written rules keep their priority order; whitelist
 * entries sort together at -1, in first-written order) and whether anything
 * was added, so the host skips the file write when nothing changed.
 */
export function mergeWhitelistRule(
  rules: ReadonlyArray<PermissionRule>,
  derivation: WhitelistDerivation,
): { rules: PermissionRule[]; added: boolean } {
  const duplicate = rules.some((rule) =>
    rule.action === derivation.rule.action
    && rule.decision === derivation.rule.decision
    && sameMatch(rule.match, derivation.rule.match))
  if (duplicate) return { rules: [...rules], added: false }
  return { rules: sortPermissionRules([...rules, derivation.rule]), added: true }
}

/**
 * Serialize a rule list as the v2 policy document body (the exact shape
 * `parseWorkspacePermissionPolicy` accepts). Whitespace-stable for tests and
 * for diff-quiet writes.
 */
export function serializePolicy(rules: ReadonlyArray<PermissionRule>): string {
  return `${JSON.stringify({ version: 2, rules }, null, 2)}\n`
}
