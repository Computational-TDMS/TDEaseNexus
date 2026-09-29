import { describe, expect, it } from 'vitest'
import { parseWorkspacePermissionPolicy } from './permissionResolver'
import {
  deriveWhitelist,
  deriveWhitelistForTool,
  mergeWhitelistRule,
  serializePolicy,
} from './permissionWhitelist'

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
