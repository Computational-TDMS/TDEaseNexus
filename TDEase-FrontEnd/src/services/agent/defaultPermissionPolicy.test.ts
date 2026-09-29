import { describe, expect, it } from 'vitest'
import { AGENT_PERMISSION_ACTIONS } from '@/contracts/agent-runtime'
import {
  evaluatePermissionDecision,
  resolvePermission,
  sortPermissionRules,
  systemRulesForMode,
  type PermissionRule,
} from './permissionResolver'
import { deriveWhitelist } from './permissionWhitelist'
import { DEFAULT_POLICY_PRIORITY, defaultPolicyFor, defaultPolicyRules } from './defaultPermissionPolicy'

/** The exact evaluation the tool-call gate runs: frozen rules + whitelist
 *  overlay + shipped policy, sorted, over the ask-mode ladder. */
function evaluate(rules: PermissionRule[], action: string, input?: Record<string, unknown>) {
  const context = { system: systemRulesForMode('ask'), user: [], workspace: [] }
  const ceiling = Object.fromEntries(AGENT_PERMISSION_ACTIONS.map((candidate) => [
    candidate,
    resolvePermission(context, candidate),
  ])) as Record<string, 'allow' | 'ask' | 'deny'>
  return evaluatePermissionDecision(sortPermissionRules(rules), ceiling, action as never, input).decision
}

const withDefaults = (extra: PermissionRule[] = []) => [...extra, ...defaultPolicyRules()]

describe('default review policy (ask authority, priority −2)', () => {
  it('isolates the dangerous set, asks the risky set, runs the rest', () => {
    expect(evaluate(withDefaults(), 'shell.exec', { command: 'cat ~/.ssh/id_rsa' })).toBe('deny')
    expect(evaluate(withDefaults(), 'shell.exec', { command: 'git filter-branch --all' })).toBe('deny')
    expect(evaluate(withDefaults(), 'shell.exec', { command: 'rm -rf build/' })).toBe('ask')
    expect(evaluate(withDefaults(), 'shell.exec', { command: 'git push origin main' })).toBe('ask')
    expect(evaluate(withDefaults(), 'shell.exec', { command: 'sudo apt install htop' })).toBe('ask')
    // The 自动审查 payoff: the innocuous majority never prompts.
    expect(evaluate(withDefaults(), 'shell.exec', { command: 'git status --short' })).toBe('allow')
    expect(evaluate(withDefaults(), 'shell.exec', { command: 'python analysis/run.py' })).toBe('allow')
    expect(evaluate(withDefaults(), 'shell.exec', { command: 'ls -la' })).toBe('allow')
  })

  it('a whitelist entry (−1) silences a policy ask', () => {
    // The card flow: the user approved recursive deletion once for `rm -rf`.
    const whitelist = deriveWhitelist('shell.exec', { command: 'rm -rf build/' })!
    expect(whitelist.rule.priority).toBe(-1)
    expect(evaluate(withDefaults([whitelist.rule]), 'shell.exec', { command: 'rm -rf build/' })).toBe('allow')
    // …but only the approved shape (`rm -rf …` — the scope the button named):
    // a different risky command still asks.
    expect(evaluate(withDefaults([whitelist.rule]), 'shell.exec', { command: 'git push origin main' })).toBe('ask')
  })

  it('hand-written rules (≥ 0) outrank whitelist and the policy', () => {
    const handwritten: PermissionRule = {
      action: 'shell.exec', decision: 'deny', match: { command: '\\bpython\\b' }, priority: 0,
    }
    expect(evaluate(withDefaults([handwritten]), 'shell.exec', { command: 'python analysis/run.py' })).toBe('deny')
  })

  it('credential-ish workspace paths are isolated; .env.example stays reachable', () => {
    expect(evaluate(withDefaults(), 'workspace.read', { path: 'config/server.key' })).toBe('deny')
    expect(evaluate(withDefaults(), 'workspace.write', { path: 'analysis/.env' })).toBe('deny')
    // `**/*.env` is suffix-exact, so the example file falls through to the
    // read ladder — allowed in ask mode.
    expect(evaluate(withDefaults(), 'workspace.read', { path: 'analysis/.env.example' })).toBe('allow')
    expect(evaluate(withDefaults(), 'workspace.write', { path: 'analysis/notes.md' })).toBe('ask')
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
