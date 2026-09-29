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
