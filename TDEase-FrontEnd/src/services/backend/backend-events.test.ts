import { afterEach, describe, expect, it, vi } from 'vitest'
import { TDEaseClient } from './backend'

afterEach(() => {
  vi.unstubAllGlobals()
})

function sseResponse(body: string): Response {
  const bytes = new TextEncoder().encode(body)
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function event(seq: number, type: string): string {
  return `id: ${seq}\ndata: ${JSON.stringify({
    schema_version: 3,
    run_id: 'run-fast',
    seq,
    timestamp: 'now',
    type,
    level: 'info',
    message: '',
    data: { revision_id: 'revision-fast' },
  })}\n\n`
}

describe('Run event SSE transport', () => {
  it('delivers every journal event before reporting terminal done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(
      event(1, 'run.queue_requested')
      + event(2, 'run.succeeded')
      + 'event: done\ndata: {"status":"SUCCEEDED","last_event_id":2}\n\n',
    )))
    const client = new TDEaseClient('http://backend.test')
    const observed: string[] = []

    await new Promise<void>((resolve) => {
      client.subscribeEvents(
        'run-fast',
        (current) => observed.push(current.type),
        0,
        () => {
          observed.push('done')
          resolve()
        },
      )
    })

    expect(observed).toEqual(['run.queue_requested', 'run.succeeded', 'done'])
  })

  it('reconnects an unsealed stream from its last delivered event id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(event(1, 'run.queue_requested')))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'RUNNING', event_seq_last: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse(
        event(2, 'run.succeeded')
        + 'event: done\ndata: {"status":"SUCCEEDED","last_event_id":2}\n\n',
      ))
    vi.stubGlobal('fetch', fetchMock)
    const client = new TDEaseClient('http://backend.test')
    const observed: number[] = []

    await new Promise<void>((resolve) => {
      client.subscribeEvents('run-fast', (current) => observed.push(current.seq), 0, resolve)
    })

    expect(observed).toEqual([1, 2])
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/api/v2/runs/run-fast')
    expect(new Headers(fetchMock.mock.calls[2]![1].headers).get('Last-Event-ID')).toBe('1')
  })

  it('rejects a done checkpoint that overtakes the delivered cursor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(
        event(1, 'run.queue_requested')
        + 'event: done\ndata: {"status":"SUCCEEDED","last_event_id":2}\n\n',
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'SUCCEEDED', event_seq_last: 2,
      }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse(
        event(2, 'run.succeeded')
        + 'event: done\ndata: {"status":"SUCCEEDED","last_event_id":2}\n\n',
      ))
    vi.stubGlobal('fetch', fetchMock)
    const client = new TDEaseClient('http://backend.test')
    const observed: number[] = []

    await new Promise<void>((resolve) => {
      client.subscribeEvents('run-fast', (current) => observed.push(current.seq), 0, resolve)
    })

    expect(observed).toEqual([1, 2])
    expect(new Headers(fetchMock.mock.calls[2]![1].headers).get('Last-Event-ID')).toBe('1')
  })

  it('uses terminal status as the convergence seal when the stream closes without done', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sseResponse(event(1, 'run.succeeded')))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'SUCCEEDED', event_seq_last: 1,
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new TDEaseClient('http://backend.test')
    const observed: string[] = []

    await new Promise<void>((resolve) => {
      client.subscribeEvents(
        'run-fast',
        (current) => observed.push(current.type),
        0,
        () => {
          observed.push('done')
          resolve()
        },
      )
    })

    expect(observed).toEqual(['run.succeeded', 'done'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps independent subscribers to the same Run isolated', async () => {
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      signals.push(signal)
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.close(), { once: true })
        },
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }))
    }))
    const client = new TDEaseClient('http://backend.test')

    const stopRepository = client.subscribeEvents('run-fast', () => {})
    const stopGraph = client.subscribeEvents('run-fast', () => {})
    await vi.waitFor(() => expect(signals).toHaveLength(2))

    expect(signals[0]!.aborted).toBe(false)
    expect(signals[1]!.aborted).toBe(false)
    stopGraph()
    expect(signals[0]!.aborted).toBe(false)
    expect(signals[1]!.aborted).toBe(true)
    stopRepository()
  })
})
