import { describe, expect, it } from 'vitest'
import { createRunProgressTracker } from './useRunProgress'
import type { RunEvent } from '@/studio/domain/run'

/**
 * The Runs dock's live job accounting: the workflow.graph event declares the
 * total AND the up-to-date base (finished work the job stream never reports),
 * job transitions reduce to finished/failed with replay-safe dedup, and
 * `sync` reconciles subscriptions so a settled run stops streaming into a
 * dead row.
 */
function event(runId: string, type: string, data: Record<string, unknown>): RunEvent {
  return { runId, seq: 0, type, timestamp: '', data }
}

function harness() {
  const listeners = new Map<string, (event: RunEvent) => void>()
  const unsubscribed: string[] = []
  const tracker = createRunProgressTracker((runId, onEvent) => {
    listeners.set(runId, onEvent)
    return () => { listeners.delete(runId); unsubscribed.push(runId) }
  })
  const emit = (e: RunEvent) => listeners.get(e.runId)?.(e)
  return { tracker, emit, unsubscribed }
}

describe('createRunProgressTracker', () => {
  it('reduces graph + job events to finished/failed, counting up-to-date nodes', () => {
    const { tracker, emit } = harness()
    tracker.sync(['r1'])
    emit(event('r1', 'workflow.graph', { nodes: [
      { id: 1, initial_status: 'up_to_date' },
      { id: 2, initial_status: 'waiting' },
      { id: 3, initial_status: 'waiting' },
    ] }))
    expect(tracker.progress.value.r1).toEqual({ total: 3, finished: 1, failed: 0 })

    emit(event('r1', 'job.started', { job_id: 2 }))
    expect(tracker.progress.value.r1?.finished).toBe(1)
    emit(event('r1', 'job.succeeded', { job_id: 2 }))
    expect(tracker.progress.value.r1).toEqual({ total: 3, finished: 2, failed: 0 })
    emit(event('r1', 'job.failed', { job_id: 3 }))
    expect(tracker.progress.value.r1).toEqual({ total: 3, finished: 3, failed: 1 })
  })

  it('does not double-count replayed or contradicted transitions', () => {
    const { tracker, emit } = harness()
    tracker.sync(['r1'])
    emit(event('r1', 'workflow.graph', { nodes: [{ id: 1, initial_status: 'waiting' }] }))
    emit(event('r1', 'job.succeeded', { job_id: 1 }))
    emit(event('r1', 'job.succeeded', { job_id: 1 }))
    expect(tracker.progress.value.r1?.finished).toBe(1)
    // A retry that fails replaces the outcome — finished stays 1, failed moves.
    emit(event('r1', 'job.failed', { job_id: 1 }))
    expect(tracker.progress.value.r1).toEqual({ total: 1, finished: 1, failed: 1 })
  })

  it('sync drops settled runs: the subscription stops and the row reads clean', () => {
    const { tracker, emit, unsubscribed } = harness()
    tracker.sync(['r1', 'r2'])
    tracker.sync(['r2'])
    expect(unsubscribed).toEqual(['r1'])
    expect(tracker.progress.value.r1).toBeUndefined()
    // Events for the dropped run land nowhere.
    emit(event('r1', 'job.succeeded', { job_id: 9 }))
    expect(tracker.progress.value.r1).toBeUndefined()
    expect(tracker.progress.value.r2).toEqual({ total: 0, finished: 0, failed: 0 })
    tracker.stop()
    expect(unsubscribed).toEqual(['r1', 'r2'])
  })
})
