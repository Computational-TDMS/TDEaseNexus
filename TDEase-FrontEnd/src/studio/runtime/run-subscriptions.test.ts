import { describe, expect, it, vi } from 'vitest'
import { asRunId } from '../domain/identity'
import type { BackendGateway } from '../ports/backend-gateway'
import { RunSubscriptions } from './run-subscriptions'

describe('RunSubscriptions', () => {
  it('delivers a synchronous completion without leaving a stale channel', () => {
    const done = vi.fn()
    const backend = {
      subscribeRun: vi.fn((_runId, _afterSeq, _onEvent, onDone) => {
        onDone()
        return vi.fn()
      }),
    } as unknown as BackendGateway
    const subscriptions = new RunSubscriptions(backend)

    subscriptions.subscribe(asRunId('run-sync'), 0, vi.fn(), done)

    expect(done).toHaveBeenCalledOnce()
    expect(subscriptions.has(asRunId('run-sync'))).toBe(false)
  })

  it('shares one upstream stream between repository state and document graph listeners', () => {
    const stop = vi.fn()
    const backend = { subscribeRun: vi.fn().mockReturnValue(stop) } as unknown as BackendGateway
    const subscriptions = new RunSubscriptions(backend)
    const runId = asRunId('run-1')

    const stopState = subscriptions.subscribe(runId, 0, vi.fn())
    const stopGraph = subscriptions.subscribe(runId, 0, vi.fn())
    expect(backend.subscribeRun).toHaveBeenCalledOnce()

    stopGraph()
    expect(stop).not.toHaveBeenCalled()
    expect(subscriptions.has(runId)).toBe(true)
    stopState()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('drops a completed channel and stale unsubscribe cannot stop its replacement', () => {
    const channels: Array<{ done: () => void; stop: ReturnType<typeof vi.fn> }> = []
    const backend = {
      subscribeRun: vi.fn((_runId, _afterSeq, _onEvent, onDone) => {
        const stop = vi.fn()
        channels.push({ done: onDone, stop })
        return stop
      }),
    } as unknown as BackendGateway
    const subscriptions = new RunSubscriptions(backend)
    const runId = asRunId('run-1')

    const staleUnsubscribe = subscriptions.subscribe(runId, 0, vi.fn())
    channels[0]!.done()
    expect(subscriptions.has(runId)).toBe(false)

    const currentUnsubscribe = subscriptions.subscribe(runId, 7, vi.fn())
    staleUnsubscribe()
    expect(subscriptions.has(runId)).toBe(true)
    expect(channels[1]!.stop).not.toHaveBeenCalled()

    currentUnsubscribe()
    expect(channels[1]!.stop).toHaveBeenCalledOnce()
    expect(subscriptions.has(runId)).toBe(false)
  })
})
