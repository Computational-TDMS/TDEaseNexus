// The failure contract (CORE-ARCHITECTURE.md §7.1-§7.4).
//
// Every failure surfaced to a human or to the Agent is this one envelope.
// `domain: 'engine'` is special (§7.2): a Snakemake job failing is a
// successful *observation* of a Run that failed, not a product error. See
// `ErrorCard.vue`, which is the only renderer of this type.

export type ErrorDomain = 'workspace' | 'run' | 'engine' | 'agent' | 'backend' | 'environment'

export interface StructuredError {
  /** A closed, versioned enumeration member. New codes are additive; existing codes never change meaning. */
  code: string
  domain: ErrorDomain
  /** One sentence, human-facing. Never a stack trace. Never parsed by any component. */
  message: string
  /** One actionable sentence. If no remedy can be written, the error is not yet understood well enough to ship. */
  remedy: string
  /** Machine-readable: the Agent decides whether to retry without parsing prose. */
  retryable: boolean
  /** Structured and secret-free by construction, not by redaction-at-display. */
  details?: Readonly<Record<string, unknown>>
  /** Links to the event or log range that explains the error, so diagnosis never requires text search. */
  cause?: { runId?: string; eventSeq?: number; sessionId?: string; turnId?: string }
}

/** Narrows `value` to `StructuredError`. Rejects a plain `Error` and any partial shape. */
export function isStructuredError(value: unknown): value is StructuredError {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>

  if (typeof candidate.code !== 'string' || candidate.code.length === 0) return false
  if (!isErrorDomain(candidate.domain)) return false
  if (typeof candidate.message !== 'string' || candidate.message.length === 0) return false
  if (typeof candidate.remedy !== 'string' || candidate.remedy.length === 0) return false
  if (typeof candidate.retryable !== 'boolean') return false

  if ('details' in candidate && candidate.details !== undefined) {
    if (typeof candidate.details !== 'object' || candidate.details === null || Array.isArray(candidate.details)) {
      return false
    }
  }

  if ('cause' in candidate && candidate.cause !== undefined) {
    if (typeof candidate.cause !== 'object' || candidate.cause === null || Array.isArray(candidate.cause)) {
      return false
    }
    const cause = candidate.cause as Record<string, unknown>
    for (const key of ['runId', 'eventSeq', 'sessionId', 'turnId'] as const) {
      if (key in cause && cause[key] !== undefined) {
        const expected = key === 'eventSeq' ? 'number' : 'string'
        if (typeof cause[key] !== expected) return false
      }
    }
  }

  return true
}

function isErrorDomain(value: unknown): value is ErrorDomain {
  return (
    value === 'workspace' ||
    value === 'run' ||
    value === 'engine' ||
    value === 'agent' ||
    value === 'backend' ||
    value === 'environment'
  )
}
