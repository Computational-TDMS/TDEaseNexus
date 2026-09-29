/**
 * Result availability — CORE-ARCHITECTURE.md §3.2-§3.4.
 *
 * Four states, and collapsing any two of them into a spinner is the defect
 * this function exists to prevent. `ResultCache.availability()`
 * (`studio/ports/result-cache.ts`) answers only the first three, because the
 * local cache cannot know whether the Backend still publishes the digest it
 * holds. Joining that answer with the Published Result projection is what
 * produces `unavailable` — §3.4's `superseded` case, "not an error to be
 * papered over".
 *
 * Pure and input-only on purpose: the caller
 * (`stores/documents.ts#describeResult`, whose `ResultOverview` this feeds,
 * rendered by `components/documents/ResultDocument.vue`) is the one that
 * talks to a Backend and a cache. Ordering matters and is stated once here:
 * unpublished beats every cache fact, because a cached copy of a superseded
 * digest is still a superseded Result.
 */
export type ResultAvailability = 'remote' | 'cached' | 'conflict' | 'unavailable'

export interface ResultAvailabilityFacts {
  /** The Backend still publishes exactly this `resultId`+`digest` pair. */
  published: boolean
  /** The local cache holds this key, and its digest equals the ref's. */
  cachedDigestMatches: boolean
  /** The local cache holds this key under a *different* digest. */
  cachedDigestConflicts: boolean
}

export function projectResultAvailability(facts: ResultAvailabilityFacts): ResultAvailability {
  if (!facts.published) return 'unavailable'
  if (facts.cachedDigestConflicts) return 'conflict'
  if (facts.cachedDigestMatches) return 'cached'
  return 'remote'
}
