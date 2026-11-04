import { describe, expect, it } from 'vitest'
import { isStructuredError, type StructuredError } from './errors'

function makeError(overrides: Partial<StructuredError> = {}): StructuredError {
  return {
    code: 'WORKSPACE_PATH_ESCAPE',
    domain: 'workspace',
    message: 'The submitted path resolves outside the approved Workspace root.',
    remedy: 'Choose a file inside the opened Workspace, or open the containing folder as the Workspace.',
    retryable: false,
    ...overrides,
  }
}

describe('isStructuredError', () => {
  it('accepts a minimal valid envelope', () => {
    expect(isStructuredError(makeError())).toBe(true)
  })

  it('accepts an envelope with details and cause populated', () => {
    const error = makeError({
      details: { path: '../../etc/passwd' },
      cause: { runId: 'run_x', eventSeq: 12 },
    })
    expect(isStructuredError(error)).toBe(true)
  })

  it('accepts every declared error domain', () => {
    const domains: StructuredError['domain'][] = [
      'workspace',
      'run',
      'engine',
      'agent',
      'backend',
      'environment',
    ]
    for (const domain of domains) {
      expect(isStructuredError(makeError({ domain }))).toBe(true)
    }
  })

  it('rejects a plain Error instance', () => {
    expect(isStructuredError(new Error('boom'))).toBe(false)
  })

  it('rejects null and non-object values', () => {
    expect(isStructuredError(null)).toBe(false)
    expect(isStructuredError(undefined)).toBe(false)
    expect(isStructuredError('WORKSPACE_PATH_ESCAPE')).toBe(false)
    expect(isStructuredError(42)).toBe(false)
  })

  it('rejects a partial object missing remedy and retryable', () => {
    const partial = { code: 'X', domain: 'workspace', message: 'oops' }
    expect(isStructuredError(partial)).toBe(false)
  })

  it('rejects an invalid domain', () => {
    expect(isStructuredError(makeError({ domain: 'unknown' as unknown as StructuredError['domain'] }))).toBe(false)
  })

  it('rejects a non-string code', () => {
    const bad = { ...makeError(), code: 42 as unknown as string }
    expect(isStructuredError(bad)).toBe(false)
  })

  it('rejects a non-boolean retryable', () => {
    const bad = { ...makeError(), retryable: 'false' as unknown as boolean }
    expect(isStructuredError(bad)).toBe(false)
  })

  it('rejects a cause with a wrong-typed field', () => {
    const bad = makeError({ cause: { eventSeq: 'twelve' as unknown as number } })
    expect(isStructuredError(bad)).toBe(false)
  })

  it('rejects details that is an array rather than a record', () => {
    const bad = { ...makeError(), details: ['not', 'a', 'record'] as unknown as Record<string, unknown> }
    expect(isStructuredError(bad)).toBe(false)
  })
})
