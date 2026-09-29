/**
 * Subagent runtime contract — the read-side IPC surface for the Agent
 * inspector (palot inspector migration, Phase B).
 *
 * This is deliberately a *read-side* contract. The agent-facing subagent
 * surface is still the three command primitives (`spawn` / `status` /
 * `cancel`) wired through the Studio command registry and the permission
 * gateway — nothing about an agent *turn* changes. This contract exists so
 * the renderer can observe the per-parent-session run records the registry
 * already tracks, without a parallel data source or a polling loop.
 *
 * Three operations, all keyed by the *parent* sessionId (the one the
 * renderer bound and owns):
 *
 *   list(parentSessionId)            → invoke, full snapshot
 *   cancel(parentSessionId, subId)   → invoke, settles the record
 *   onChanged(parentSessionId, cb)   → push, incremental snapshots
 *
 * The snapshot element type mirrors `SubagentStatus` from the Studio command
 * registry one-for-one. There is exactly one subagent data model: the
 * registry's `RunRecord` → `SubagentStatus` projection. The renderer renders
 * it directly with no translation layer.
 */

import type { SubagentPeek, SubagentStatus } from '../studio/commands/registry'

/** A read-only snapshot of a parent session's subagent records. */
export type SubagentSnapshot = ReadonlyArray<SubagentStatus>

export interface SubagentBridge {
  /** Full snapshot of all records for a parent session. */
  list(parentSessionId: string): Promise<SubagentSnapshot>
  /** Cancel a running/blocked subagent; captures its partial result. */
  cancel(parentSessionId: string, subagentId: string): Promise<{ ok: true; result?: SubagentStatus['result'] }>
  /** Subscribe to records changes (spawn / state transition / cancel). */
  onChanged(parentSessionId: string, onSnapshot: (snapshot: SubagentSnapshot) => void): () => void
  /** Tail a child's recent activity for the panel's peek view. */
  peek?(parentSessionId: string, subagentId: string, lines?: number): Promise<SubagentPeek>
}
