import {
  AGENT_PERMISSION_ACTIONS,
  type AgentPermissionAction,
  type AgentPermissionDecision,
  type AgentPermissionMatch,
  type AgentPermissionRule,
  type PermissionSnapshot,
} from '@/contracts/agent-runtime'

export type PermissionDecision = AgentPermissionDecision
export const PERMISSION_ACTIONS = AGENT_PERMISSION_ACTIONS
export type PermissionAction = AgentPermissionAction
export type PermissionMatch = AgentPermissionMatch
export type PermissionRule = AgentPermissionRule

export function isPermissionAction(value: string): value is PermissionAction {
  return (PERMISSION_ACTIONS as ReadonlyArray<string>).includes(value)
}

export interface PermissionContext { system: PermissionRule[]; user: PermissionRule[]; workspace: PermissionRule[] }

export type PermissionMode = 'ask' | 'auto'

/**
 * Single source of truth for the mode ladder. Both the Renderer
 * (src/services/agent/permissionMode.ts) and Electron main (electron/agent/agent-runtime.ts)
 * build their system rules from `systemRulesForMode`, so the ladder cannot drift.
 */
export const READ_ACTIONS: readonly PermissionAction[] = [
  'workspace.read',
  'run.wait',
  'run.fetch',
  'run.list',
  'workflow.dry_run',
]

export const WRITE_ACTIONS: readonly PermissionAction[] = [
  // workflow.preflight backs workflow.prepare, which is `mutates: true`
  // (freezing a Run writes plan state): it belongs with the writes even
  // though it never reaches the Backend.
  'workflow.preflight',
  'workflow.submit',
  'workspace.write',
  'analysis.execute',
  'run.pull_file',
  'run.resume',
  'run.restore',
  // reference.note backs uniprot.note/revise: a reversible, auditable local
  // overlay (allow in auto, ask in ask) — same tier as the other writes that
  // never reach a destructive remote mutation.
  'reference.note',
  // shell.exec gates bash AND mcp (agent-runtime.ts buildToolActions). It is
  // reclassified from ALWAYS_ASK to WRITE: the real safety boundary is
  // permission-gateway.ts (cwd containment to the Workspace root + the
  // destructive-command blacklist), which holds regardless of the allow/deny
  // decision — so prompting on every bash call in `auto` was noise, not
  // safety. In `auto` it now runs; in `ask` it asks once, then the
  // session-grant set (approval-coordinator) remembers the answer.
  'shell.exec',
  // subagent.spawn spends real tokens and is model-initiated, but it is
  // reversible (the child can be cancelled) and the child inherits the
  // parent's permission ceiling + gateway. Reclassified from ALWAYS_ASK to
  // WRITE on the same grounds as shell.exec. subagent.cancel STAYS in
  // ALWAYS_ASK because aborting a child mid-flight is irreversible.
  'subagent.spawn',
]

/**
 * Build the system rules for a PermissionMode, covering every registered action.
 * - read actions → allow (both modes)
 * - write actions → allow in auto, ask in ask
 * - always-ask actions → ask (both modes)
 */
export function systemRulesForMode(mode: PermissionMode): PermissionRule[] {
  const writeDecision: PermissionDecision = mode === 'auto' ? 'allow' : 'ask'
  return AGENT_PERMISSION_ACTIONS.map((action) => ({
    action,
    decision: READ_ACTIONS.includes(action)
      ? 'allow'
      : WRITE_ACTIONS.includes(action)
        ? writeDecision
        : 'ask',
  }))
}

export interface WorkspacePermissionPolicy {
  /** `1` = action-level rules only; `2` = may carry parameterized rules. */
  version: 1 | 2
  rules: PermissionRule[]
}

const rank: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 }

/**
 * Deny-dominant merge over ACTION-LEVEL rules only. This is the coarse
 * ceiling: a layer can tighten (allow → ask → deny) but never loosen, which
 * is what keeps a workspace policy from out-permitting the system ladder.
 * Parameterized rules never enter this merge — they are the override channel
 * (evaluatePermissionDecision), where specificity is allowed to beat the
 * ladder on purpose.
 */
export function resolvePermission(context: PermissionContext, action: PermissionAction): PermissionDecision {
  const rules = [...context.system, ...context.user, ...context.workspace]
    .filter((rule) => rule.action === action && !rule.match)
  if (!rules.length) return READ_ACTIONS.includes(action) ? 'allow' : 'ask'
  return rules.sort((a, b) => rank[b.decision] - rank[a.decision]).at(0)?.decision ?? 'ask'
}

// ── Parameter-level evaluation (the pi-permission-style override channel) ─────

export interface PermissionEvaluation {
  decision: PermissionDecision
  /** The parameterized rule that matched, when one did. */
  matched?: PermissionRule
}

/**
 * Resolve one call's decision: the highest-priority parameterized rule whose
 * predicate matches wins; with no match, the coarse ceiling decides.
 *
 * `rules` must already be sorted (`sortPermissionRules`) — bind time sorts and
 * deep-freezes the array, so the per-call path never re-sorts. A rule whose
 * predicate does not apply (no command on a read call, no path on a bash call)
 * is skipped, never treated as a match, so a non-matching override always
 * degrades to the ladder, never to a silent allow.
 */
export function evaluatePermissionDecision(
  rules: ReadonlyArray<PermissionRule>,
  ceiling: PermissionSnapshot,
  action: PermissionAction,
  input?: Readonly<Record<string, unknown>>,
): PermissionEvaluation {
  for (const rule of rules) {
    if (rule.action !== action || !rule.match) continue
    if (ruleMatches(rule.match, input)) return { decision: rule.decision, matched: rule }
  }
  const fallback = ceiling[action]
  if (fallback === undefined) {
    throw new Error(`Permission ceiling has no decision for action: ${action}`)
  }
  return { decision: fallback }
}

/**
 * Priority descending; ties resolve deny > ask > allow (the same deny-dominant
 * spirit as the ceiling); stable for equal pairs so layer order (system, user,
 * workspace) survives as written. Returns a new array; never mutates.
 */
export function sortPermissionRules(rules: ReadonlyArray<PermissionRule>): PermissionRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) =>
      (b.rule.priority ?? 0) - (a.rule.priority ?? 0)
      || rank[b.rule.decision] - rank[a.rule.decision]
      || a.index - b.index)
    .map((entry) => entry.rule)
}

/** All predicates of a rule must hold; a rule with only some predicates ignores the rest. */
function ruleMatches(match: PermissionMatch, input?: Readonly<Record<string, unknown>>): boolean {
  if (!input) return false
  if (match.command !== undefined) {
    const command = typeof input.command === 'string' ? input.command : undefined
    // Test the raw text and a whitespace-collapsed form: `rm  -rf` must not
    // evade `rm -rf`, while the raw form still rules on exact tokens.
    if (!command) return false
    const pattern = commandPattern(match.command)
    if (!pattern.test(command) && !pattern.test(command.replace(/\s+/g, ' '))) return false
  }
  if (match.paths !== undefined) {
    const found = pathInputOf(input, match.pathParam)
    if (found === undefined) return false
    if (!match.paths.some((glob) => globToRegExp(glob).test(found.value))) return false
  }
  return true
}

/** The default path-key precedence every path-matching consumer shares. */
const PATH_INPUT_KEYS = ['path', 'filePath', 'directory', 'cwd'] as const

/**
 * The single source of the path-input contract: which input key carries the
 * path, and its normalized form. Every path-matching consumer MUST derive
 * from here — the whitelist derivation (`permissionWhitelist.ts`) builds
 * globs against exactly this normal form, so a second normalizer would let a
 * derived rule silently stop matching its own matcher. A `preferredKey`
 * (rule-level `match.pathParam`) is exclusive: no fallback to the defaults.
 * Case-sensitive on purpose: a case mismatch means the rule does not apply,
 * which falls back to the ladder — the safe direction; case-folding could
 * widen a `deny` glob on POSIX.
 */
export function pathInputOf(
  input: Readonly<Record<string, unknown>>,
  preferredKey?: string,
): { key: string; value: string } | undefined {
  for (const key of preferredKey ? [preferredKey] : PATH_INPUT_KEYS) {
    const value = input[key]
    if (typeof value !== 'string' || !value.trim()) continue
    return {
      key,
      // Workspace-relative POSIX-ish form: what the policy author sees in
      // the file tools.
      value: value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''),
    }
  }
  return undefined
}

// Pattern compilation is cached by source: rules are frozen at bind time, so
// the cache is bounded by the policy size and every call after the first is a
// Map hit.
const commandPatternCache = new Map<string, RegExp>()
const globCache = new Map<string, RegExp>()

function commandPattern(source: string): RegExp {
  let pattern = commandPatternCache.get(source)
  if (!pattern) {
    // No flags on purpose: a `g` flag would carry lastIndex across calls and
    // make `test` stateful.
    pattern = new RegExp(source)
    commandPatternCache.set(source, pattern)
  }
  return pattern
}

/** Compile one policy glob. `**` crosses directories, `*` and `?` stay within one. */
export function globToRegExp(pattern: string): RegExp {
  let compiled = globCache.get(pattern)
  if (compiled) return compiled
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        while (pattern[i + 1] === '*') i++
        if (pattern[i + 1] === '/') {
          // `**/` matches zero or more leading directories: `**/foo` hits
          // `foo` itself and `a/b/foo`.
          i++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  compiled = new RegExp(`${source}$`)
  globCache.set(pattern, compiled)
  return compiled
}

// ── Policy file parsing (v1 action-level, v2 parameterized) ──────────────────

/**
 * Parse `.tdease/permissions.json`. v1 documents keep working unchanged —
 * their rules parse as match-less v2 rules and behave exactly as before
 * (tighten-only, deny-dominant). v2 adds `match`, `priority` and `note`.
 * Command patterns are compile-checked here, at the boundary, so a regex
 * typo surfaces as a policy error naming the rule instead of a silent
 * never-matching override (path globs cannot fail to compile — the glob
 * compiler escapes every literal character).
 */
export function parseWorkspacePermissionPolicy(content: string): WorkspacePermissionPolicy {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error('.tdease/permissions.json must contain valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('.tdease/permissions.json must be an object')
  }
  const document = value as Record<string, unknown>
  if ((document.version !== 1 && document.version !== 2) || !Array.isArray(document.rules)) {
    throw new Error('.tdease/permissions.json must have version 1 or 2 and a rules array')
  }
  const rules = document.rules.map((rule, index) => parseRule(rule, index))
  return { version: document.version, rules }
}

function parseRule(value: unknown, index: number): PermissionRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`permissions.json rules[${index}] must be an object`)
  }
  const rule = value as Record<string, unknown>
  if (typeof rule.action !== 'string' || !isPermissionAction(rule.action)) {
    throw new Error(`permissions.json rules[${index}].action is not registered`)
  }
  if (rule.decision !== 'allow' && rule.decision !== 'ask' && rule.decision !== 'deny') {
    throw new Error(`permissions.json rules[${index}].decision must be allow, ask, or deny`)
  }
  if (rule.match === undefined && rule.priority === undefined && rule.note === undefined) {
    return { action: rule.action, decision: rule.decision }
  }
  if (rule.priority !== undefined && (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority))) {
    throw new Error(`permissions.json rules[${index}].priority must be a finite number`)
  }
  if (rule.note !== undefined && typeof rule.note !== 'string') {
    throw new Error(`permissions.json rules[${index}].note must be a string`)
  }
  return {
    action: rule.action,
    decision: rule.decision,
    ...(rule.match !== undefined ? { match: parseMatch(rule.match, index) } : {}),
    ...(rule.priority !== undefined ? { priority: rule.priority } : {}),
    ...(rule.note !== undefined ? { note: rule.note } : {}),
  }
}

function parseMatch(value: unknown, index: number): PermissionMatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`permissions.json rules[${index}].match must be an object`)
  }
  const match = value as Record<string, unknown>
  if (match.command === undefined && match.paths === undefined) {
    throw new Error(`permissions.json rules[${index}].match must declare command or paths`)
  }
  if (match.command !== undefined) {
    if (typeof match.command !== 'string' || !match.command) {
      throw new Error(`permissions.json rules[${index}].match.command must be a non-empty string`)
    }
    try {
      new RegExp(match.command)
    } catch (error) {
      throw new Error(`permissions.json rules[${index}].match.command does not compile: ${String(error)}`, { cause: error })
    }
  }
  if (match.paths !== undefined) {
    // No compile check needed: globToRegExp escapes every literal character,
    // so any string yields a safe pattern. Type is all we validate here.
    if (!Array.isArray(match.paths) || !match.paths.length || match.paths.some((path) => typeof path !== 'string' || !path)) {
      throw new Error(`permissions.json rules[${index}].match.paths must be a non-empty array of non-empty strings`)
    }
  }
  if (match.pathParam !== undefined && (typeof match.pathParam !== 'string' || !match.pathParam)) {
    throw new Error(`permissions.json rules[${index}].match.pathParam must be a non-empty string`)
  }
  return {
    ...(match.command !== undefined ? { command: match.command } : {}),
    ...(match.paths !== undefined ? { paths: match.paths as string[] } : {}),
    ...(match.pathParam !== undefined ? { pathParam: match.pathParam } : {}),
  }
}
