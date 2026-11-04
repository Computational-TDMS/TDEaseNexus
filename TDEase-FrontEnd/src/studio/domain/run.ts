import type { RunId, Sha256, WorkspaceId } from './identity'

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'

/**
 * Execution modes and the event→status mapping below mirror the shared
 * lifecycle declaration (`tdease-backend/src/contracts/run_lifecycle.json`,
 * loaded by the Backend's `run_projector.py`). The Client keeps its own live
 * projection — it must apply events before the Backend index reflects them —
 * so the declaration cannot be imported here (a repository-path import is
 * forbidden by design/THREE-REPOSITORY-ARCHITECTURE.md). The parity test
 * `run-lifecycle-parity.test.ts` reads that JSON and fails when the two drift.
 */
export const EXECUTION_MODES = ['execute', 'continue'] as const
export type ExecutionMode = (typeof EXECUTION_MODES)[number]

export interface RunSummary {
  id: RunId
  workspaceId: WorkspaceId
  title: string
  status: RunStatus
  cores: number
  error?: string
  rerunMode: 'resume' | 'overwrite'
  labels: Readonly<Record<string, string>>
  createdAt: string
  startedAt?: string
  finishedAt?: string
  resultCount: number
  lastEventSeq: number
  workspaceRunPath?: string
  currentRevision?: string
  activeRevision?: string
  queuedRevision?: string
  executionCount?: number
}

export interface RunWaitResult {
  status: RunStatus
  waitedMs: number
}

/**
 * The half-open interval from a `run.started` event to its terminal event
 * (CORE-ARCHITECTURE.md §1.3). An open range (`terminalSeq: null`) is a live
 * process. Derived from the event log by the projector — never stored as an
 * entity.
 */
export interface ExecutionRange {
  startSeq: number
  terminalSeq: number | null
  terminalType: string | null
}

export interface NodeBinding {
  id: string
  version: string
  digest: Sha256
  rules: ReadonlyArray<string>
}

export interface TrashedRunSummary {
  id: RunId
  workspaceId: WorkspaceId
  title: string
  previousStatus: RunStatus
  deletedAt: string
  deletedBy: string
}

export interface RunEvent {
  runId: RunId
  seq: number
  type: string
  timestamp: string
  data: Readonly<Record<string, unknown>>
}

export function runStatusForEvent(type: string): RunStatus | null {
  switch (type) {
    case 'run.queue_requested': return 'QUEUED'
    case 'run.started': return 'RUNNING'
    case 'run.succeeded': return 'SUCCEEDED'
    case 'run.failed': return 'FAILED'
    case 'run.cancelled': return 'CANCELLED'
    default: return null
  }
}
