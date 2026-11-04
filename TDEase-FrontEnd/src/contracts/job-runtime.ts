/**
 * Job runtime contract — the read-side IPC surface for background shell jobs,
 * mirroring `subagent-runtime.ts`.
 *
 * A *read-side* contract: the agent-facing surface is the `tdease.job.*`
 * command family (start/status/cancel/peek/list) wired through the Studio
 * command registry + permission gateway — nothing about an agent turn changes.
 * This contract exists so the renderer can observe the per-parent-session job
 * records the registry already tracks, without a parallel data source or a
 * polling loop.
 *
 * Operations, all keyed by the parent sessionId (the one the renderer bound):
 *
 *   list(parentSessionId)          → invoke, full snapshot
 *   cancel(parentSessionId, jobId) → invoke, settles the record
 *   onChanged(parentSessionId, cb) → push, incremental snapshots
 *
 * The snapshot element mirrors `JobStatus` from the Studio command registry
 * one-for-one. One job data model: the registry's record → `JobStatus`
 * projection. The renderer renders it directly with no translation layer.
 */

import type { JobPeek, JobStatus } from '../studio/commands/registry'

/** A read-only snapshot of a parent session's background-job records. */
export type JobSnapshot = ReadonlyArray<JobStatus>

export interface JobBridge {
  /** Full snapshot of all records for a parent session. */
  list(parentSessionId: string): Promise<JobSnapshot>
  /** Cancel a running job. */
  cancel(parentSessionId: string, jobId: string): Promise<{ ok: true }>
  /** Subscribe to records changes (start / settle / cancel). */
  onChanged(parentSessionId: string, onSnapshot: (snapshot: JobSnapshot) => void): () => void
  /** Tail a job's recent stdout/stderr for the panel's peek view. */
  peek?(parentSessionId: string, jobId: string, lines?: number): Promise<JobPeek>
}
