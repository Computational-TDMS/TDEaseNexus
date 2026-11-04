import { describe, expect, it } from 'vitest'
import { AGENT_PERMISSION_ACTIONS } from '@/contracts/agent-runtime'
import {
  evaluatePermissionDecision,
  parseWorkspacePermissionPolicy,
  READ_ACTIONS,
  resolvePermission,
  sortPermissionRules,
  systemRulesForMode,
  WRITE_ACTIONS,
  type PermissionRule,
} from './permissionResolver'
import {
  deriveWhitelist,
  deriveWhitelistForTool,
  mergeWhitelistRule,
  serializePolicy,
} from './permissionWhitelist'
import { DEFAULT_POLICY_PRIORITY, defaultPolicyFor, defaultPolicyRules } from './defaultPermissionPolicy'

describe('systemRulesForMode (single source of the permission ladder)', () => {
  it('covers every registered action exactly once across the three tiers', () => {
    const all = [...READ_ACTIONS, ...WRITE_ACTIONS]
    expect(new Set(all).size).toBe(all.length)
    expect(all.every((action) => (AGENT_PERMISSION_ACTIONS as readonly string[]).includes(action))).toBe(true)
  })

  it('ask mode: reads allowed, writes and always-ask actions gated', () => {
    const rules = systemRulesForMode('ask')
    const decision = (action: string) => rules.find((rule) => rule.action === action)?.decision
    expect(decision('workspace.read')).toBe('allow')
    expect(decision('workflow.dry_run')).toBe('allow')
    // workflow.preflight backs the mutating workflow.prepare — gated like a write.
    expect(decision('workflow.preflight')).toBe('ask')
    expect(decision('workflow.submit')).toBe('ask')
    expect(decision('shell.exec')).toBe('ask')
  })

  it('auto mode: writes allowed, always-ask actions still gated', () => {
    const rules = systemRulesForMode('auto')
    const decision = (action: string) => rules.find((rule) => rule.action === action)?.decision
    expect(decision('workspace.write')).toBe('allow')
    expect(decision('workflow.preflight')).toBe('allow')
    expect(decision('run.cancel')).toBe('ask')
  })

  it('falls back to the same ladder when no rule matches', () => {
    const empty = { system: [], user: [], workspace: [] }
    expect(resolvePermission(empty, 'workspace.read')).toBe('allow')
    expect(resolvePermission(empty, 'run.list')).toBe('allow')
    expect(resolvePermission(empty, 'workspace.write')).toBe('ask')
  })
})

describe('Workspace permission policy', () => {
  it('parses the canonical versioned policy', () => {
    expect(parseWorkspacePermissionPolicy(JSON.stringify({
      version: 1,
      rules: [{ action: 'shell.exec', decision: 'deny' }],
    }))).toEqual({
      version: 1,
      rules: [{ action: 'shell.exec', decision: 'deny' }],
    })
  })

  it('rejects unknown actions instead of silently ignoring them', () => {
    expect(() => parseWorkspacePermissionPolicy(JSON.stringify({
      version: 1,
      rules: [{ action: 'workspace.escape', decision: 'allow' }],
    }))).toThrow('action is not registered')
  })

  it('keeps the strictest decision across all policy layers', () => {
    const decision = resolvePermission({
      system: [{ action: 'workspace.write', decision: 'allow' }],
      user: [{ action: 'workspace.write', decision: 'ask' }],
      workspace: [{ action: 'workspace.write', decision: 'deny' }],
    }, 'workspace.write')
    expect(decision).toBe('deny')
  })

  it('parameterized rules never tighten the coarse ceiling (v1 semantics preserved)', () => {
    // The ceiling merge must ignore match rules entirely, or an override
    // could leak into what delegation and display treat as the per-action
    // ladder.
    const decision = resolvePermission({
      system: systemRulesForMode('ask'),
      user: [],
      workspace: [{ action: 'workspace.write', decision: 'allow', match: { command: '^git' } }],
    }, 'workspace.write')
    expect(decision).toBe('ask')
  })
})

describe('parameterized evaluation (the pi-permission-style override channel)', () => {
  const ceiling = Object.fromEntries(AGENT_PERMISSION_ACTIONS.map((action) => [
    action,
    resolvePermission({ system: systemRulesForMode('ask'), user: [], workspace: [] }, action),
  ])) as Record<string, 'allow' | 'ask' | 'deny'>

  function evaluate(rules: PermissionRule[], action: string, input?: Record<string, unknown>) {
    return evaluatePermissionDecision(
      sortPermissionRules(rules),
      ceiling as never,
      action as never,
      input,
    )
  }

  it('a matching command override beats the ladder, non-matching falls back to it', () => {
    const rules: PermissionRule[] = [
      { action: 'shell.exec', decision: 'allow', match: { command: '^git\\s+(status|diff|log)\\b' }, note: 'read-only git' },
    ]
    const allow = evaluate(rules, 'shell.exec', { command: 'git status --short' })
    expect(allow.decision).toBe('allow')
    expect(allow.matched?.note).toBe('read-only git')
    expect(evaluate(rules, 'shell.exec', { command: 'git push --force' }).decision).toBe('ask')
    // Whitespace-collapsed text must not evade a simple pattern.
    expect(evaluate([{ action: 'shell.exec', decision: 'deny', match: { command: 'rm -rf' } }],
      'shell.exec', { command: 'rm  -rf /' }).decision).toBe('deny')
    // No command input → the rule cannot apply → ladder.
    expect(evaluate(rules, 'shell.exec', {}).decision).toBe('ask')
  })

  it('path globs apply to path-carrying inputs with ** crossing directories', () => {
    const rules: PermissionRule[] = [
      { action: 'workspace.write', decision: 'allow', match: { paths: ['analysis/**', 'reports/*.md'] } },
    ]
    expect(evaluate(rules, 'workspace.write', { path: 'analysis/notes/deep.md' }).decision).toBe('allow')
    expect(evaluate(rules, 'workspace.write', { path: 'reports/summary.md' }).decision).toBe('allow')
    // `*` must not cross a directory separator.
    expect(evaluate(rules, 'workspace.write', { path: 'reports/nested/summary.md' }).decision).toBe('ask')
    expect(evaluate(rules, 'workspace.write', { path: 'secrets/key.md' }).decision).toBe('ask')
  })

  it('priority decides between competing overrides, deny wins ties, write order survives', () => {
    // A specific allow must carry a higher priority than a general ask at the
    // same tier — equal priority means equal rank, and there deny dominates.
    const rules: PermissionRule[] = [
      { action: 'shell.exec', decision: 'allow', match: { command: 'git' }, priority: 1 },
      { action: 'shell.exec', decision: 'deny', match: { command: 'git push' }, priority: 5 },
      { action: 'shell.exec', decision: 'ask', match: { command: '^git' } },
    ]
    expect(evaluate(rules, 'shell.exec', { command: 'git push origin main' }).decision).toBe('deny')
    expect(evaluate(rules, 'shell.exec', { command: 'git status' }).decision).toBe('allow')
    // Equal priority → deny > ask > allow regardless of write order.
    const tied: PermissionRule[] = [
      { action: 'shell.exec', decision: 'allow', match: { command: 'git' } },
      { action: 'shell.exec', decision: 'deny', match: { command: 'git' } },
    ]
    expect(evaluate(tied, 'shell.exec', { command: 'git status' }).decision).toBe('deny')
  })

  it('rules for other actions and action-level rules never fire in the override scan', () => {
    const rules: PermissionRule[] = [
      { action: 'workspace.write', decision: 'allow' },
      { action: 'workspace.write', decision: 'allow', match: { paths: ['**'] } },
    ]
    // shell.exec sees neither: the ceiling decides.
    expect(evaluate(rules, 'shell.exec', { command: 'anything' }).decision).toBe('ask')
  })
})

describe('v2 policy parsing', () => {
  it('parses a v2 document with match, priority and note', () => {
    const policy = parseWorkspacePermissionPolicy(JSON.stringify({
      version: 2,
      rules: [{
        action: 'shell.exec',
        decision: 'allow',
        match: { command: '^git\\b' },
        priority: 10,
        note: 'read-only git',
      }],
    }))
    expect(policy.version).toBe(2)
    expect(policy.rules[0].match).toEqual({ command: '^git\\b' })
    expect(policy.rules[0].priority).toBe(10)
    expect(policy.rules[0].note).toBe('read-only git')
  })

  it('rejects a command regex that does not compile, naming the rule', () => {
    expect(() => parseWorkspacePermissionPolicy(JSON.stringify({
      version: 2,
      rules: [{ action: 'shell.exec', decision: 'allow', match: { command: '^git(' } }],
    }))).toThrow(/rules\[0\]\.match\.command does not compile/)
  })

  it('rejects an empty match object and a bad paths array', () => {
    expect(() => parseWorkspacePermissionPolicy(JSON.stringify({
      version: 2,
      rules: [{ action: 'shell.exec', decision: 'allow', match: {} }],
    }))).toThrow('must declare command or paths')
    expect(() => parseWorkspacePermissionPolicy(JSON.stringify({
      version: 2,
      rules: [{ action: 'shell.exec', decision: 'allow', match: { paths: [] } }],
    }))).toThrow('must be a non-empty array')
  })

  it('rejects an unknown version', () => {
    expect(() => parseWorkspacePermissionPolicy(JSON.stringify({ version: 3, rules: [] })))
      .toThrow('version 1 or 2')
  })
})

describe('deriveWhitelist', () => {
  it('derives a two-token anchored prefix for bash commands', () => {
    const derived = deriveWhitelist('shell.exec', { command: 'git status -sb' })
    expect(derived?.rule.match).toEqual({ command: '^git status\\b' })
    expect(derived?.rule.decision).toBe('allow')
    expect(derived?.rule.priority).toBe(-1)
    expect(derived?.scope).toBe('git status …')
    // The pattern must actually match the original command and its variants
    // within scope…
    expect(new RegExp('^git status\\b').test('git status -sb')).toBe(true)
    // …and the derived rule must be parseable by the policy parser.
    expect(() => parseWorkspacePermissionPolicy(serializePolicy([derived!.rule]))).not.toThrow()
  })

  it('degrades a single-token command to an exact match', () => {
    const derived = deriveWhitelist('shell.exec', { command: 'ls' })
    expect(derived?.rule.match).toEqual({ command: '^ls$' })
    expect(derived?.scope).toBe('ls')
    expect(new RegExp('^ls$').test('ls -la')).toBe(false)
    // Two tokens stay subcommand-level: `npm run` alone matches, and so does
    // every `npm run <script>` — that IS the approved class.
    const prefix = deriveWhitelist('shell.exec', { command: 'npm run' })
    expect(prefix?.rule.match).toEqual({ command: '^npm run\\b' })
    expect(new RegExp('^npm run\\b').test('npm run build')).toBe(true)
  })

  it('collapses whitespace and escapes regex metacharacters before anchoring', () => {
    const derived = deriveWhitelist('shell.exec', { command: '  my-tool   (preview)  status' })
    expect(derived?.rule.match).toEqual({ command: '^my-tool \\(preview\\)\\b' })
  })

  it('derives a parent-directory glob for path-carrying writes', () => {
    const derived = deriveWhitelist('workspace.write', { path: 'analysis/notes/deep.md' })
    expect(derived?.rule.match).toEqual({ paths: ['analysis/notes/**'] })
    expect(derived?.scope).toBe('analysis/notes/')
  })

  it('matches a top-level file exactly and keeps non-default path params', () => {
    expect(deriveWhitelist('workspace.write', { path: 'README.md' })?.rule.match).toEqual({ paths: ['README.md'] })
    expect(deriveWhitelist('workspace.write', { filePath: 'a/b.md' })?.rule.match).toEqual({
      paths: ['a/**'],
      pathParam: 'filePath',
    })
  })

  it('derives nothing without an honest narrower shape', () => {
    expect(deriveWhitelist('shell.exec', {})).toBeUndefined()
    expect(deriveWhitelist('shell.exec', { command: '   ' })).toBeUndefined()
    expect(deriveWhitelist('shell.exec', undefined)).toBeUndefined()
    // No path input → no shape.
    expect(deriveWhitelist('workspace.write', { command: 'x' })).toBeUndefined()
    // A glob in the input path is the model trying to widen the entry.
    expect(deriveWhitelist('workspace.write', { path: 'analysis/**' })).toBeUndefined()
    // Abstract irreversible actions never derive — no blanket action grants.
    expect(deriveWhitelist('run.trash', { runId: 'r1' })).toBeUndefined()
    expect(deriveWhitelist('subagent.cancel', { subagentId: 's1' })).toBeUndefined()
  })

  it('maps only the whitelistable tool slice', () => {
    expect(deriveWhitelistForTool('bash', { command: 'git status' })?.scope).toBe('git status …')
    expect(deriveWhitelistForTool('edit', { path: 'docs/x.md' })?.scope).toBe('docs/')
    // Unknown builtins, TDEase commands and MCP calls derive nothing.
    expect(deriveWhitelistForTool('tdease.workflow.submit', { planRef: 'p1' })).toBeUndefined()
    expect(deriveWhitelistForTool('mcp', { action: 'call' })).toBeUndefined()
  })
})

describe('mergeWhitelistRule', () => {
  const derived = () => deriveWhitelist('shell.exec', { command: 'git status' })!

  it('appends the rule sorted below hand-written rules', () => {
    const handwritten = { action: 'shell.exec', decision: 'deny', match: { command: 'rm -rf' }, priority: 0 }
    const { rules, added } = mergeWhitelistRule([handwritten], derived())
    expect(added).toBe(true)
    // Hand-written (p0) sorts before the whitelist entry (p-1).
    expect(rules.map((rule) => rule.priority)).toEqual([0, -1])
  })

  it('keeps multiple whitelist entries in first-written order', () => {
    const first = deriveWhitelist('shell.exec', { command: 'git status' })!
    const second = deriveWhitelist('shell.exec', { command: 'npm run' })!
    const once = mergeWhitelistRule([], first).rules
    const twice = mergeWhitelistRule(once, second).rules
    expect(twice.map((rule) => rule.match?.command)).toEqual(['^git status\\b', '^npm run\\b'])
  })

  it('is idempotent on (action, decision, match)', () => {
    const once = mergeWhitelistRule([], derived())
    const twice = mergeWhitelistRule(once.rules, derived())
    expect(twice.added).toBe(false)
    expect(twice.rules).toHaveLength(1)
  })

  it('round-trips through the v1→v2 policy parser', () => {
    const v1 = parseWorkspacePermissionPolicy(JSON.stringify({
      version: 1,
      rules: [{ action: 'shell.exec', decision: 'deny' }],
    }))
    const merged = mergeWhitelistRule(v1.rules, deriveWhitelist('shell.exec', { command: 'git status' })!)
    const reparsed = parseWorkspacePermissionPolicy(serializePolicy(merged.rules))
    expect(reparsed.version).toBe(2)
    expect(reparsed.rules).toHaveLength(2)
  })
})

describe('default review policy (ask authority, priority −2)', () => {
  /** The exact evaluation the tool-call gate runs: frozen rules + whitelist
   *  overlay + shipped policy, sorted, over the ask-mode ladder. */
  function evaluateWithDefaults(extra: PermissionRule[], action: string, input?: Record<string, unknown>) {
    const context = { system: systemRulesForMode('ask'), user: [], workspace: [] }
    const ceiling = Object.fromEntries(AGENT_PERMISSION_ACTIONS.map((candidate) => [
      candidate,
      resolvePermission(context, candidate),
    ])) as Record<string, 'allow' | 'ask' | 'deny'>
    const rules = [...extra, ...defaultPolicyRules()]
    return evaluatePermissionDecision(sortPermissionRules(rules), ceiling as never, action as never, input).decision
  }

  it('isolates the dangerous set, asks the risky set, runs the rest', () => {
    expect(evaluateWithDefaults([], 'shell.exec', { command: 'cat ~/.ssh/id_rsa' })).toBe('deny')
    expect(evaluateWithDefaults([], 'shell.exec', { command: 'git filter-branch --all' })).toBe('deny')
    expect(evaluateWithDefaults([], 'shell.exec', { command: 'rm -rf build/' })).toBe('ask')
    expect(evaluateWithDefaults([], 'shell.exec', { command: 'git push origin main' })).toBe('ask')
    expect(evaluateWithDefaults([], 'shell.exec', { command: 'sudo apt install htop' })).toBe('ask')
    // The default review payoff: the innocuous majority never prompts.
    expect(evaluateWithDefaults([], 'shell.exec', { command: 'git status --short' })).toBe('allow')
    expect(evaluateWithDefaults([], 'shell.exec', { command: 'python analysis/run.py' })).toBe('allow')
    expect(evaluateWithDefaults([], 'shell.exec', { command: 'ls -la' })).toBe('allow')
  })

  it('a whitelist entry (−1) silences a policy ask', () => {
    // The card flow: the user approved recursive deletion once for `rm -rf`.
    const whitelist = deriveWhitelist('shell.exec', { command: 'rm -rf build/' })!
    expect(whitelist.rule.priority).toBe(-1)
    expect(evaluateWithDefaults([whitelist.rule], 'shell.exec', { command: 'rm -rf build/' })).toBe('allow')
    // …but only the approved shape (`rm -rf …` — the scope the button named):
    // a different risky command still asks.
    expect(evaluateWithDefaults([whitelist.rule], 'shell.exec', { command: 'git push origin main' })).toBe('ask')
  })

  it('hand-written rules (≥ 0) outrank whitelist and the policy', () => {
    const handwritten: PermissionRule = {
      action: 'shell.exec', decision: 'deny', match: { command: '\\bpython\\b' }, priority: 0,
    }
    expect(evaluateWithDefaults([handwritten], 'shell.exec', { command: 'python analysis/run.py' })).toBe('deny')
  })

  it('credential-ish workspace paths are isolated; .env.example stays reachable', () => {
    expect(evaluateWithDefaults([], 'workspace.read', { path: 'config/server.key' })).toBe('deny')
    expect(evaluateWithDefaults([], 'workspace.write', { path: 'analysis/.env' })).toBe('deny')
    // `**/*.env` is suffix-exact, so the example file falls through to the
    // read ladder — allowed in ask mode.
    expect(evaluateWithDefaults([], 'workspace.read', { path: 'analysis/.env.example' })).toBe('allow')
    expect(evaluateWithDefaults([], 'workspace.write', { path: 'analysis/notes.md' })).toBe('ask')
  })

  it('policy rules are all parameterized at −2 with a note', () => {
    const rules = defaultPolicyRules()
    expect(rules.length).toBeGreaterThan(10)
    expect(rules.every((rule) => rule.match && rule.priority === DEFAULT_POLICY_PRIORITY)).toBe(true)
    expect(rules.every((rule) => typeof rule.note === 'string' && rule.note)).toBe(true)
  })

  it('mounts only under ask authority', () => {
    expect(defaultPolicyFor('ask').length).toBe(defaultPolicyRules().length)
    expect(defaultPolicyFor('auto')).toEqual([])
  })
})
