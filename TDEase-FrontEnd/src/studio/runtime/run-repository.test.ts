import { describe, expect, it, vi } from 'vitest'
import { asRunId, asWorkspaceId } from '../domain/identity'
import type { RunEvent, RunSummary } from '../domain/run'
import type { BackendGateway } from '../ports/backend-gateway'
import { RunRepository } from './run-repository'
import { RunSubscriptions } from './run-subscriptions'

function summary(id: string, status: RunSummary['status'] = 'RUNNING'): RunSummary {
  return {
    id: asRunId(id), workspaceId: asWorkspaceId('ws'), title: id, status,
    cores: 4, rerunMode: 'resume', labels: {},
    createdAt: '2026-07-26T00:00:00Z', resultCount: 0, lastEventSeq: 3,
  }
}

function replayRunning(handler: ((event: RunEvent) => void) | undefined): void {
  const runId = asRunId('run-1')
  handler?.({ runId, seq: 1, type: 'run.submitted', timestamp: 'now', data: { revision_id: 'rev-1' } })
  handler?.({ runId, seq: 2, type: 'run.queue_requested', timestamp: 'now', data: { revision_id: 'rev-1', mode: 'execute' } })
  handler?.({ runId, seq: 3, type: 'run.started', timestamp: 'now', data: { revision_id: 'rev-1', mode: 'execute' } })
}

function listenerCount(repository: RunRepository): number {
  return (repository as unknown as { listeners: Set<unknown> }).listeners.size
}

describe('Run repository', () => {
  it('shares one Backend SSE subscription and applies monotonic events', async () => {
    let handler: ((event: RunEvent) => void) | undefined
    let done: (() => void) | undefined
    const stop = vi.fn()
    const backend = {
      listRuns: vi.fn().mockResolvedValue({ items: [summary('run-1')], total: 1, offset: 0, limit: 50, hasMore: false }),
      listTrash: vi.fn().mockResolvedValue([]),
      subscribeRun: vi.fn((_id, _after, next, complete) => { handler = next; done = complete; return stop }),
    } as unknown as BackendGateway
    const subscriptions = new RunSubscriptions(backend)
    const repository = new RunRepository(backend, subscriptions)
    await repository.load({ workspaceId: 'ws' })

    expect(backend.subscribeRun).toHaveBeenCalledTimes(1)
    replayRunning(handler)
    handler?.({ runId: asRunId('run-1'), seq: 4, type: 'run.succeeded', timestamp: 'now', data: { revision_id: 'rev-1' } })
    handler?.({ runId: asRunId('run-1'), seq: 3, type: 'run.failed', timestamp: 'old', data: { revision_id: 'rev-1' } })
    expect(repository.snapshot().runs.get(asRunId('run-1'))).toMatchObject({ status: 'SUCCEEDED', lastEventSeq: 4 })
    done?.()
    expect(subscriptions.has(asRunId('run-1'))).toBe(false)
    expect(stop).not.toHaveBeenCalled()
  })


  it('drainSettledRuns announces exactly once, and only runs it watched go terminal', async () => {
    let handler: ((event: RunEvent) => void) | undefined
    const backend = {
      listRuns: vi.fn().mockResolvedValue({ items: [summary('run-1')], total: 1, offset: 0, limit: 50, hasMore: false }),
      listTrash: vi.fn().mockResolvedValue([]),
      getRun: vi.fn().mockResolvedValue(summary('run-done', 'SUCCEEDED')),
      subscribeRun: vi.fn((_id, _after, next) => { handler = next; return () => {} }),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    await repository.load({ workspaceId: 'ws' })

    // A run already terminal on first sight (refresh) never announces.
    await repository.refresh(asRunId('run-done'))
    expect(repository.drainSettledRuns()).toHaveLength(0)

    handler?.({ runId: asRunId('run-1'), seq: 4, type: 'run.succeeded', timestamp: 'now', data: { revision_id: 'rev-1' } })
    const drained = repository.drainSettledRuns()
    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({ id: asRunId('run-1'), status: 'SUCCEEDED' })
    // Drained exactly once.
    expect(repository.drainSettledRuns()).toHaveLength(0)
  })

  it('opens and closes an execution range for an observed Run as its lifecycle events arrive', async () => {
    let handler: ((event: RunEvent) => void) | undefined
    const backend = {
      listRuns: vi.fn().mockResolvedValue({ items: [summary('run-1')], total: 1, offset: 0, limit: 50, hasMore: false }),
      listTrash: vi.fn().mockResolvedValue([]),
      subscribeRun: vi.fn((_id, _after, next) => { handler = next; return () => {} }),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    await repository.load({ workspaceId: 'ws' })

    replayRunning(handler)
    expect(repository.snapshot().ranges.get(asRunId('run-1'))).toEqual([
      { queueSeq: 2, startSeq: 3, revisionId: 'rev-1', mode: 'execute', terminalSeq: null, terminalType: null },
    ])

    handler?.({ runId: asRunId('run-1'), seq: 9, type: 'run.failed', timestamp: 'now', data: { revision_id: 'rev-1' } })
    expect(repository.snapshot().ranges.get(asRunId('run-1'))).toEqual([
      { queueSeq: 2, startSeq: 3, revisionId: 'rev-1', mode: 'execute', terminalSeq: 9, terminalType: 'run.failed' },
    ])
  })

  it('reconciles terminal details from the public Run resource after the SSE transition', async () => {
    let handler: ((event: RunEvent) => void) | undefined
    let done: (() => void) | undefined
    const terminal = {
      ...summary('run-1', 'FAILED'), lastEventSeq: 9,
      error: 'real process exited with code 1', finishedAt: '2026-07-26T00:02:00Z',
    }
    const backend = {
      listRuns: vi.fn().mockResolvedValue({ items: [summary('run-1')], total: 1, offset: 0, limit: 50, hasMore: false }),
      listTrash: vi.fn().mockResolvedValue([]),
      getRun: vi.fn().mockResolvedValue(terminal),
      subscribeRun: vi.fn((_id, _after, next, complete) => { handler = next; done = complete; return () => {} }),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    await repository.load({ workspaceId: 'ws' })

    replayRunning(handler)
    handler?.({ runId: asRunId('run-1'), seq: 9, type: 'run.failed', timestamp: 'now', data: { revision_id: 'rev-1' } })
    done?.()
    await vi.waitFor(() => expect(repository.snapshot().runs.get(asRunId('run-1'))).toMatchObject({
      status: 'FAILED', error: 'real process exited with code 1', finishedAt: '2026-07-26T00:02:00Z',
    }))
    expect(backend.getRun).toHaveBeenCalledWith(asRunId('run-1'))
  })

  it('starts a fresh execution range once a Continue re-establishes observation', async () => {
    const backend = {
      rerun: vi.fn().mockResolvedValue(summary('run-1', 'RUNNING')),
      subscribeRun: vi.fn().mockReturnValue(() => {}),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    await repository.rerun(asRunId('run-1'), 'resume')
    expect(repository.snapshot().ranges.get(asRunId('run-1'))).toEqual([])
  })

  it('reruns in the same Run identity and resumes observation', async () => {
    const backend = {
      rerun: vi.fn().mockResolvedValue(summary('run-1', 'QUEUED')),
      subscribeRun: vi.fn().mockReturnValue(() => {}),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    await expect(repository.rerun(asRunId('run-1'), 'resume')).resolves.toMatchObject({ id: 'run-1', status: 'QUEUED' })
    expect(backend.rerun).toHaveBeenCalledWith(asRunId('run-1'), 'resume')
  })

  it('replaces a terminal observation on rerun and converges on SSE done', async () => {
    const channels: Array<{
      event: (event: RunEvent) => void
      done: () => void
      stop: ReturnType<typeof vi.fn>
    }> = []
    const terminal = {
      ...summary('run-1', 'SUCCEEDED'), lastEventSeq: 7,
      finishedAt: '2026-07-26T00:02:00Z', resultCount: 2,
    }
    const backend = {
      rerun: vi.fn().mockResolvedValue({ ...summary('run-1', 'QUEUED'), lastEventSeq: 5 }),
      getRun: vi.fn().mockResolvedValue(terminal),
      subscribeRun: vi.fn((_id, _after, event, done) => {
        const stop = vi.fn()
        channels.push({ event, done, stop })
        return stop
      }),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    repository.track({ ...summary('run-1', 'FAILED'), lastEventSeq: 4 })

    await repository.rerun(asRunId('run-1'), 'resume')
    expect(repository.snapshot().runs.get(asRunId('run-1'))?.status).toBe('QUEUED')
    expect(channels).toHaveLength(1)

    const channel = channels[0]!
    replayRunning(channel.event)
    channel.event({ runId: asRunId('run-1'), seq: 4, type: 'run.failed', timestamp: 'now', data: { revision_id: 'rev-1' } })
    channel.event({ runId: asRunId('run-1'), seq: 5, type: 'run.queue_requested', timestamp: 'now', data: { revision_id: 'rev-1', mode: 'continue' } })
    channel.event({ runId: asRunId('run-1'), seq: 6, type: 'run.started', timestamp: 'now', data: { revision_id: 'rev-1', mode: 'continue' } })
    channel.event({ runId: asRunId('run-1'), seq: 7, type: 'run.succeeded', timestamp: 'now', data: { revision_id: 'rev-1' } })
    channel.done()

    await vi.waitFor(() => expect(repository.snapshot().runs.get(asRunId('run-1'))).toMatchObject({
      status: 'SUCCEEDED', lastEventSeq: 7, resultCount: 2,
    }))
    expect(backend.getRun).toHaveBeenCalledWith(asRunId('run-1'))
    expect(channels).toHaveLength(1)
  })

  it('does not let an older terminal refresh overwrite a newer rerun snapshot', async () => {
    let resolveRefresh: ((run: RunSummary) => void) | undefined
    const backend = {
      getRun: vi.fn().mockImplementation(() => new Promise<RunSummary>((resolve) => { resolveRefresh = resolve })),
      subscribeRun: vi.fn().mockReturnValue(() => {}),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    repository.track({ ...summary('run-1', 'RUNNING'), lastEventSeq: 6 })
    const refreshing = repository.refresh(asRunId('run-1'))

    repository.track({ ...summary('run-1', 'QUEUED'), lastEventSeq: 8 })
    resolveRefresh?.({ ...summary('run-1', 'FAILED'), lastEventSeq: 7 })

    await expect(refreshing).resolves.toMatchObject({ status: 'QUEUED', lastEventSeq: 8 })
    expect(repository.snapshot().runs.get(asRunId('run-1'))).toMatchObject({ status: 'QUEUED', lastEventSeq: 8 })
  })

  it('does not synchronously emit the current snapshot when requested by wait-style consumers', () => {
    const repository = new RunRepository({} as BackendGateway, new RunSubscriptions({} as BackendGateway))
    const listener = vi.fn()
    repository.onChange(listener, false)
    expect(listener).not.toHaveBeenCalled()
  })

  it('returns the current status when a bounded wait deadline expires', async () => {
    vi.useFakeTimers()
    try {
      const backend = {
        getRun: vi.fn().mockResolvedValue(summary('run-1', 'RUNNING')),
        subscribeRun: vi.fn().mockReturnValue(() => {}),
      } as unknown as BackendGateway
      const repository = new RunRepository(backend, new RunSubscriptions(backend))
      const waiting = repository.wait(asRunId('run-1'), 1_000)
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(waiting).resolves.toMatchObject({ status: 'RUNNING', waitedMs: 1_000 })
      expect(backend.getRun).toHaveBeenCalledWith(asRunId('run-1'))
      expect(listenerCount(repository)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // The user-stop contract: a turn parked in runs.wait must settle the moment
  // the tool call's abort signal fires — not stay parked until the deadline
  // while the run keeps executing in the background.
  it('settles the wait at once when the abort signal fires, run still running', async () => {
    vi.useFakeTimers()
    try {
      const backend = {
        getRun: vi.fn().mockResolvedValue(summary('run-1', 'RUNNING')),
        subscribeRun: vi.fn().mockReturnValue(() => {}),
      } as unknown as BackendGateway
      const repository = new RunRepository(backend, new RunSubscriptions(backend))
      const controller = new AbortController()
      const waiting = repository.wait(asRunId('run-1'), 300_000, controller.signal)
      await Promise.resolve() // let the refresh() preflight run

      controller.abort()
      const result = await waiting

      expect(result).toMatchObject({ status: 'RUNNING' })
      expect(result.waitedMs).toBeLessThan(300_000)
      expect(listenerCount(repository)).toBe(0)
      // The deadline timer must not fire into the settled wait.
      await vi.advanceTimersByTimeAsync(300_000)
      await expect(waiting).resolves.toBe(result)
    } finally {
      vi.useRealTimers()
    }
  })

  // docs/STATUS.md, defect #2: `wait()` used to do
  // `stop = this.onChange(listener)`, where `listener` itself calls `stop()`.
  // If the notification that settles `wait()` is the FIRST one the listener
  // ever receives — delivered synchronously, in the same call stack as
  // registration — `stop` was still the placeholder no-op and the listener
  // was never removed. This test proves the fix by construction: exactly one
  // listener is registered while `wait()` is pending, the very first
  // notification it receives is the terminal one, and the listener is gone
  // the instant `wait()` settles — not merely "eventually", but synchronously
  // within the same `emit()` call that resolved it.
  it('does not leak the wait() listener when the terminal Run arrives on the first notification it receives', async () => {
    let handler: ((event: RunEvent) => void) | undefined
    const backend = {
      getRun: vi.fn().mockResolvedValue(summary('run-1', 'RUNNING')),
      subscribeRun: vi.fn((_id, _after, next) => { handler = next; return () => {} }),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))

    const waiting = repository.wait(asRunId('run-1'), 1_000)
    await vi.waitFor(() => expect(handler).toBeTypeOf('function'))
    expect(listenerCount(repository)).toBe(1)

    // The first — and only — notification this listener ever receives is
    // already terminal. Delivery is synchronous: `handler` calls straight
    // into `RunRepository`'s internal `emit()`, which calls the listener,
    // which calls `settle()`, all in one call stack.
    replayRunning(handler)
    handler?.({ runId: asRunId('run-1'), seq: 4, type: 'run.succeeded', timestamp: 'now', data: { revision_id: 'rev-1' } })
    expect(listenerCount(repository)).toBe(0)

    await expect(waiting).resolves.toMatchObject({ status: 'SUCCEEDED' })
    expect(listenerCount(repository)).toBe(0)
  })

  it('settles a bounded wait when the observed Run becomes terminal', async () => {
    let handler: ((event: RunEvent) => void) | undefined
    const backend = {
      getRun: vi.fn().mockResolvedValue(summary('run-1', 'RUNNING')),
      subscribeRun: vi.fn((_id, _after, next) => { handler = next; return () => {} }),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    const waiting = repository.wait(asRunId('run-1'), 1_000)
    await vi.waitFor(() => expect(handler).toBeTypeOf('function'))
    replayRunning(handler)
    handler?.({ runId: asRunId('run-1'), seq: 4, type: 'run.succeeded', timestamp: 'now', data: { revision_id: 'rev-1' } })

    await expect(waiting).resolves.toMatchObject({ status: 'SUCCEEDED' })
    expect(listenerCount(repository)).toBe(0)
  })

  it('coalesces overlapping loadMore calls onto one Backend page request', async () => {
    let resolvePage: ((value: unknown) => void) | undefined
    const backend = {
      listRuns: vi.fn()
        .mockResolvedValueOnce({ items: [], total: 2, offset: 0, limit: 1, hasMore: true })
        .mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve })),
      listTrash: vi.fn().mockResolvedValue([]),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    await repository.load({ limit: 1 })
    const first = repository.loadMore()
    const second = repository.loadMore()
    expect(backend.listRuns).toHaveBeenCalledTimes(2)
    resolvePage?.({ items: [], total: 2, offset: 1, limit: 1, hasMore: false })
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(backend.listRuns).toHaveBeenCalledTimes(2)
  })

  it('keeps recoverable trash as management state, not a Run status', async () => {
    const trashed = {
      id: asRunId('run-1'), workspaceId: asWorkspaceId('ws'), title: 'run-1',
      previousStatus: 'FAILED' as const, deletedAt: 'now', deletedBy: 'user',
    }
    const backend = {
      listRuns: vi.fn().mockResolvedValue({ items: [], total: 7, offset: 0, limit: 50, hasMore: false }),
      trashRun: vi.fn(), listTrash: vi.fn().mockResolvedValue([trashed]),
    } as unknown as BackendGateway
    const repository = new RunRepository(backend, new RunSubscriptions(backend))
    await repository.trash(asRunId('run-1'))
    expect(repository.snapshot().trash).toEqual([trashed])
    expect(repository.snapshot().total).toBe(7)
    expect([...repository.snapshot().runs.values()].some((run) => (run.status as string) === 'TRASHED')).toBe(false)
  })
})
