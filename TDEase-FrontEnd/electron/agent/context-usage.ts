/**
 * context-usage — Node-side context occupancy snapshot.
 *
 * Occupancy is computed by Pi's own `AgentSession.getContextUsage()` (last valid
 * assistant usage as the ground-truth baseline + `estimateTokens` on the
 * trailing delta; `tokens: null` after compaction until the next response).
 * We don't re-implement that estimator — this module only shapes Pi's answer
 * and the last valid usage's cache figures into the `ContextUsageSnapshot` the
 * renderer gauge consumes.
 *
 * `toContextSnapshot` is a pure function so the compaction/cache nulling rules
 * are unit-testable without a live AgentSession.
 */

import {
  getLastAssistantUsage,
  type ContextUsage,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent'

import type { ContextUsageSnapshot } from '../../src/contracts/agent-runtime'

/**
 * Shape Pi's context answer + the last valid assistant usage's cache figures
 * into the renderer snapshot.
 *
 * - No Pi context answer → `null` (nothing to report; the caller stays silent).
 * - `tokens === null` (compaction, or never measured) → cache is ALSO null:
 *   the last usage would reflect pre-compaction context, so any cache figure
 *   derived from it would be stale. Honest unknown beats a stale number.
 * - Otherwise cache comes from the last valid assistant usage found on the
 *   branch (skips aborted/error/zero-token messages, per Pi's own semantics).
 */
export function toContextSnapshot(
  context: ContextUsage | undefined,
  branch: SessionEntry[],
): ContextUsageSnapshot | null {
  if (!context) return null
  if (context.tokens === null) return { tokens: null, cache: null }
  const last = getLastAssistantUsage(branch)
  return {
    tokens: context.tokens,
    cache: last
      ? { read: last.cacheRead, write: last.cacheWrite, uncached: last.input }
      : null,
  }
}
