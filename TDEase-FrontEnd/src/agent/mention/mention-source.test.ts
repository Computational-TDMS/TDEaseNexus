import { describe, expect, it } from 'vitest'
import type { MentionSources } from './mention-source'
import { capFileBody, FILE_BODY_BYTE_CAP, resolveMention, resolveMentions } from './mention-source'
import type { MentionToken } from './mention-token'

function sources(overrides: Partial<MentionSources> = {}): MentionSources {
  return {
    resolveRun: async () => null,
    resolveCanvas: async () => null,
    resolveFile: async () => null,
    resolveSkill: async () => null,
    ...overrides,
  }
}

describe('resolveMention', () => {
  it('returns the resolver result when found', async () => {
    const run: MentionToken = { kind: 'run', refId: 'r1' }
    const src = sources({
      resolveRun: async () => ({ token: run, label: 'Run r1', found: true }),
    })
    expect(await resolveMention(run, src)).toEqual({ token: run, label: 'Run r1', found: true })
  })

  it('returns a not-found placeholder when the resolver returns null', async () => {
    const file: MentionToken = { kind: 'file', refId: 'gone.md' }
    const result = await resolveMention(file, sources())
    expect(result.found).toBe(false)
    expect(result.label).toBe('file gone.md (not found)')
  })

  it('never throws — a resolver rejection becomes not-found', async () => {
    const run: MentionToken = { kind: 'run', refId: 'r1' }
    const src = sources({ resolveRun: async () => { throw new Error('boom') } })
    const result = await resolveMention(run, src)
    expect(result.found).toBe(false)
  })
})

describe('resolveMentions', () => {
  it('resolves every token in order, mixing found and not-found', async () => {
    const tokens: MentionToken[] = [
      { kind: 'run', refId: 'r1' },
      { kind: 'file', refId: 'gone.md' },
    ]
    const src = sources({
      resolveRun: async () => ({ token: tokens[0], label: 'Run r1', found: true }),
    })
    const out = await resolveMentions(tokens, src)
    expect(out).toHaveLength(2)
    expect(out[0].found).toBe(true)
    expect(out[1].found).toBe(false)
  })
})

describe('capFileBody', () => {
  it('returns short text unchanged', () => {
    expect(capFileBody('short')).toBe('short')
  })

  it('truncates with a marker at the cap', () => {
    const big = 'x'.repeat(FILE_BODY_BYTE_CAP + 100)
    const out = capFileBody(big)
    expect(out.length).toBeLessThan(big.length)
    expect(out).toContain('truncated')
    expect(out.endsWith(`… (truncated at ${FILE_BODY_BYTE_CAP} bytes)`)).toBe(true)
  })

  it('respects a custom cap', () => {
    expect(capFileBody('abcdef', 3)).toBe('abc\n\n… (truncated at 3 bytes)')
  })
})
