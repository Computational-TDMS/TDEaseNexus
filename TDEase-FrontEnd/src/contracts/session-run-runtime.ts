/**
 * Session-run runtime contract — the read-side IPC surface for runs a single
 * Agent session DISPATCHED, mirroring `job-runtime.ts`.
 *
 * First principles: the workspace's run list (runs store / runs.* commands)
 * answers "what runs exist here"; THIS contract answers "what runs did this
 * conversation start". Membership is seeded by the dispatch points inside the
 * Node StudioRuntime (`onRunDispatched`: analysis run/submit, runs.rerun);
 * live status rides the run repository's change stream. Observation-only
 * reads (`runs.status` / `runs.wait`) never add membership.
 *
 * Operations, keyed by the parent sessionId:
 *   list(parentSessionId)          → invoke, full snapshot
 *   onChanged(parentSessionId, cb) → push, incremental snapshots
 *
 * The snapshot element is the domain `RunSummary` as-is — the renderer renders
 * title/status directly and opens the run page by id; there is no projection.
 */

import type { RunSummary } from '../studio/domain/run'

/** A read-only snapshot of a parent session's dispatched runs. */
export type SessionRunSnapshot = ReadonlyArray<RunSummary>

export interface SessionRunBridge {
  /** Full snapshot of all dispatched runs for a parent session. */
  list(parentSessionId: string): Promise<SessionRunSnapshot>
  /** Subscribe to snapshot changes (dispatch / status transition). */
  onChanged(parentSessionId: string, onSnapshot: (snapshot: SessionRunSnapshot) => void): () => void
}
