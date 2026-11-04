import { describe, expect, it } from 'vitest'
import { asRunId, asWorkspaceId } from '../domain/identity'
import type { RunEvent, RunSummary } from '../domain/run'
import { applyRunEvent, type RunProjection } from './run-projector'

const run: RunSummary = {
  id: asRunId('run-1'), workspaceId: asWorkspaceId('workspace-1'), title: 'Run 1',
  status: 'QUEUED', cores: 4, rerunMode: 'resume', labels: {},
  createdAt: '2026-07-26T00:00:00Z', resultCount: 0, lastEventSeq: 1,
}

function event(seq: number, type: string, data: Readonly<Record<string, unknown>> = {}, runId = run.id): RunEvent {
  return { runId, seq, type, timestamp: '2026-07-26T00:00:01Z', data }
}

describe('run projector', () => {
  const projection: RunProjection = {
    run,
    lifecycleStatus: 'QUEUED',
    currentRevisionId: 'rev-1',
    queuedMode: 'execute',
    queuedAtSeq: 1,
    ranges: [],
  }

  it('applies canonical lifecycle events', () => {
    expect(applyRunEvent(projection, event(2, 'run.started', { revision_id: 'rev-1', mode: 'execute' })).run)
      .toMatchObject({ status: 'RUNNING', lastEventSeq: 2 })
  })

  it('ignores duplicate, stale and foreign events by identity', () => {
    expect(applyRunEvent(projection, event(1, 'run.failed', { revision_id: 'rev-1' }))).toBe(projection)
    expect(applyRunEvent(projection, event(2, 'run.failed', { revision_id: 'rev-1' }, asRunId('run-2')))).toBe(projection)
  })

  it('advances sequence without inventing lifecycle state for technical events', () => {
    expect(applyRunEvent(projection, event(2, 'job.started')).run).toMatchObject({ status: 'QUEUED', lastEventSeq: 2 })
  })

  it('opens and closes execution ranges across events, incrementally', () => {
    let current = projection
    current = applyRunEvent(current, event(2, 'run.started', { revision_id: 'rev-1', mode: 'execute' }))
    expect(current.ranges).toEqual([{ queueSeq: 1, startSeq: 2, revisionId: 'rev-1', mode: 'execute', terminalSeq: null, terminalType: null }])
    current = applyRunEvent(current, event(9, 'run.failed', { revision_id: 'rev-1' }))
    expect(current.ranges).toEqual([{ queueSeq: 1, startSeq: 2, revisionId: 'rev-1', mode: 'execute', terminalSeq: 9, terminalType: 'run.failed' }])
    current = applyRunEvent(current, event(10, 'run.queue_requested', { revision_id: 'rev-1', mode: 'continue' }))
    expect(current.run.status).toBe('QUEUED')
    current = applyRunEvent(current, event(11, 'run.started', { revision_id: 'rev-1', mode: 'continue' }))
    current = applyRunEvent(current, event(31, 'run.succeeded', { revision_id: 'rev-1' }))
    expect(current.ranges).toEqual([
      { queueSeq: 1, startSeq: 2, revisionId: 'rev-1', mode: 'execute', terminalSeq: 9, terminalType: 'run.failed' },
      { queueSeq: 10, startSeq: 11, revisionId: 'rev-1', mode: 'continue', terminalSeq: 31, terminalType: 'run.succeeded' },
    ])
    expect(current.run).toMatchObject({ status: 'SUCCEEDED', lastEventSeq: 31 })
  })

  it('queues a new definition behind a running execution instead of replacing it', () => {
    // A Run is always editable: a revision submitted while an execution runs is
    // pending. The live execution keeps its range and stays the projected
    // status; when it terminates, the Run is queued for the new definition.
    let current = applyRunEvent(projection, event(2, 'run.started', { revision_id: 'rev-1', mode: 'execute' }))
    current = applyRunEvent(current, event(3, 'run.submitted', { revision_id: 'rev-2' }))
    current = applyRunEvent(current, event(4, 'run.queue_requested', { revision_id: 'rev-2', mode: 'execute' }))

    expect(current.run.status).toBe('RUNNING')
    expect(current.currentRevisionId).toBe('rev-2')
    expect(current.ranges).toEqual([{ queueSeq: 1, startSeq: 2, revisionId: 'rev-1', mode: 'execute', terminalSeq: null, terminalType: null }])

    current = applyRunEvent(current, event(5, 'run.succeeded', { revision_id: 'rev-1' }))
    expect(current.run.status).toBe('QUEUED')
    expect(current.ranges).toEqual([{ queueSeq: 1, startSeq: 2, revisionId: 'rev-1', mode: 'execute', terminalSeq: 5, terminalType: 'run.succeeded' }])
  })
})
