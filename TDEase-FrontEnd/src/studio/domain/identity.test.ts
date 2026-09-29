import { describe, expect, it } from 'vitest'
import { asRelativePath, asSha256 } from './identity'

describe('domain identity boundaries', () => {
  it('normalizes safe workspace-relative paths', () => {
    expect(asRelativePath('scripts\\analysis.py')).toBe('scripts/analysis.py')
  })

  it.each(['C:/data/input.raw', '/data/input.raw', '../input.raw', 'results//output.tsv'])(
    'rejects a path outside the canonical relative-path contract: %s',
    (path) => expect(() => asRelativePath(path)).toThrow(),
  )

  it('normalizes and validates sha256 values', () => {
    expect(asSha256('A'.repeat(64))).toBe('a'.repeat(64))
    expect(() => asSha256('not-a-digest')).toThrow()
  })
})
