import { describe, expect, it } from 'vitest'
import type { MentionToken } from './mention-token'
import type { ResolvedMention } from './mention-source'
import { composeReferencedContext, REFERENCED_SECTION_HEADING } from './mention-context'

function ref(token: MentionToken, label: string, body?: string, found = true): ResolvedMention {
  return { token, label, body, found }
}

describe('composeReferencedContext', () => {
  it('returns undefined for an empty list (snapshot-digest stable for mention-less turns)', () => {
    expect(composeReferencedContext([])).toBeUndefined()
  })

  it('renders a simple reference with no body', () => {
    const out = composeReferencedContext([ref({ kind: 'run', refId: 'r1' }, 'TopPIC run, status SUCCEEDED')])
    expect(out).toBe(`${REFERENCED_SECTION_HEADING}\n\n- @run:r1 — TopPIC run, status SUCCEEDED`)
  })

  it('renders a file reference with its body in a fenced block', () => {
    const out = composeReferencedContext([ref({ kind: 'file', refId: 'a.md' }, 'a.md', 'line one\nline two')])
    expect(out).toBe(
      `${REFERENCED_SECTION_HEADING}\n\n`
      + '- @file:a.md — a.md\n'
      + '  ```\n'
      + '  line one\n'
      + '  line two\n'
      + '  ```',
    )
  })

  it('states not-found references plainly rather than omitting them', () => {
    const out = composeReferencedContext([ref({ kind: 'file', refId: 'gone.md' }, 'file gone.md (not found)', undefined, false)])
    expect(out).toContain('- @file:gone.md — file gone.md (not found)')
    expect(out).not.toContain('```')
  })

  it('renders multiple references in order', () => {
    const out = composeReferencedContext([
      ref({ kind: 'run', refId: 'r1' }, 'Run r1'),
      ref({ kind: 'file', refId: 'f1' }, 'File f1'),
    ])
    expect(out).toContain('- @run:r1 — Run r1')
    expect(out).toContain('- @file:f1 — File f1')
    const runIdx = out!.indexOf('@run:r1')
    const fileIdx = out!.indexOf('@file:f1')
    expect(runIdx).toBeLessThan(fileIdx)
  })

  it('omits the fence when the body is blank', () => {
    const out = composeReferencedContext([ref({ kind: 'skill', refId: 'qc' }, 'qc skill', '   ')])
    expect(out).not.toContain('```')
  })
})
