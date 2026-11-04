import { describe, expect, it } from 'vitest'
import { createToolNameProtocol } from './tool-name-protocol.ts'

describe('ToolNameProtocol', () => {
  it('replaces dots with underscores for provider names', () => {
    const names = createToolNameProtocol(['tdease.workflow.dryRun', 'tdease.evidence.write'])
    expect(names.toProvider('tdease.workflow.dryRun')).toBe('tdease_workflow_dryRun')
    expect(names.toProvider('tdease.evidence.write')).toBe('tdease_evidence_write')
  })

  it('maps provider names back to canonical names', () => {
    const names = createToolNameProtocol(['tdease.workflow.dryRun'])
    expect(names.toCanonical('tdease_workflow_dryRun')).toBe('tdease.workflow.dryRun')
  })

  it('rewrites canonical references in prompt prose', () => {
    const names = createToolNameProtocol(['tdease.workflow.dryRun', 'tdease.evidence.write'])
    expect(
      names.rewriteForProvider('Call tdease.workflow.dryRun, then tdease.evidence.write.'),
    ).toBe('Call tdease_workflow_dryRun, then tdease_evidence_write.')
  })

  it('leaves builtins and unregistered names untouched', () => {
    const names = createToolNameProtocol(['tdease.workflow.dryRun'])
    expect(names.toProvider('read')).toBe('read')
    expect(names.toProvider('mcp')).toBe('mcp')
    expect(names.toCanonical('read')).toBe('read')
    expect(names.rewriteForProvider('Use read and bash freely.')).toBe('Use read and bash freely.')
  })

  it('distinguishes shared-prefix tools (longest-first rewrite)', () => {
    const names = createToolNameProtocol(['tdease.evidence.write', 'tdease.evidence.writeBulk'])
    expect(names.toProvider('tdease.evidence.write')).toBe('tdease_evidence_write')
    expect(names.toProvider('tdease.evidence.writeBulk')).toBe('tdease_evidence_writeBulk')
    expect(names.rewriteForProvider('tdease.evidence.writeBulk then tdease.evidence.write'))
      .toBe('tdease_evidence_writeBulk then tdease_evidence_write')
  })

  it('does not match dotted spans inside longer dotted paths', () => {
    const names = createToolNameProtocol(['tdease.evidence.write'])
    // `\\b` keeps the dotted JSON-path tail `evidence.write` from matching
    // `tdease.evidence.write` -- it would otherwise corrupt prose like schema paths.
    expect(names.rewriteForProvider('see schema.evidence.write for details'))
      .toBe('see schema.evidence.write for details')
  })

  it('throws on a provider-name collision between distinct canonical names', () => {
    // `tdease.a.b` and `tdease.a_b` both encode to `tdease_a_b`; refusing is
    // the single-source-of-truth rule -- silent shadowing would make the audit
    // log and the UI disagree on which tool ran.
    expect(() => createToolNameProtocol(['tdease.a.b', 'tdease.a_b']))
      .toThrow('Tool name protocol collision')
  })

  it('is a no-op for an empty tool set', () => {
    const names = createToolNameProtocol([])
    expect(names.toProvider('anything')).toBe('anything')
    expect(names.toCanonical('anything')).toBe('anything')
    expect(names.rewriteForProvider('plain prose')).toBe('plain prose')
  })
})
