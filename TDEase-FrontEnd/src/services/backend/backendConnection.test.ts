import { afterEach, describe, expect, it, vi } from 'vitest'
import { backendConnectionSupervisor, monitoredBackendFetch } from './backendConnection'

afterEach(() => {
  vi.restoreAllMocks()
  backendConnectionSupervisor.disable()
})

describe('backend connection supervision', () => {
  it('recognizes a ready compatible Backend and records its generation', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'ready', instance_id: 'instance-a', generation: 'gen-a',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ protocol_version: 3 }), { status: 200 }))

    const state = await backendConnectionSupervisor.connect('http://backend.test', null)

    expect(state.phase).toBe('online')
    expect(state.instanceId).toBe('instance-a')
    expect(state.generation).toBe('gen-a')
  })

  it('refuses an unsupported protocol without retrying it as a network failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ protocol_version: 99 }), { status: 200 }))

    const state = await backendConnectionSupervisor.connect('http://backend.test', null)

    expect(state.phase).toBe('incompatible')
    expect(state.error).toContain('protocol 99')
  })

  it('does not retain protocol 2 compatibility after the v3 contract change', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ protocol_version: 2 }), { status: 200 }))

    const state = await backendConnectionSupervisor.connect('http://backend.test', null)

    expect(state.phase).toBe('incompatible')
    expect(state.error).toContain('protocol 2')
  })

  it('marks a timed out request offline instead of leaving an operation pending forever', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ protocol_version: 3 }), { status: 200 }))
      .mockImplementation((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))

    await backendConnectionSupervisor.connect('http://backend.test', null)

    await expect(monitoredBackendFetch('http://backend.test/api/data', {}, 5)).rejects.toThrow()
    expect(backendConnectionSupervisor.current().phase).toBe('degraded')
  })

  it('ignores a late transport failure from the previous Backend target', async () => {
    let rejectOldRequest!: (reason: unknown) => void
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'ready', instance_id: 'instance-a', generation: 'gen-a',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ protocol_version: 3 }), { status: 200 }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOldRequest = reject }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'ready', instance_id: 'instance-b', generation: 'gen-b',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ protocol_version: 3 }), { status: 200 }))

    await backendConnectionSupervisor.connect('http://backend-a.test', null)
    const oldRequest = monitoredBackendFetch('http://backend-a.test/api/data')
    await backendConnectionSupervisor.connect('http://backend-b.test', null)
    rejectOldRequest(new TypeError('old Backend disconnected'))
    await expect(oldRequest).rejects.toThrow('old Backend disconnected')

    expect(backendConnectionSupervisor.current()).toMatchObject({
      phase: 'online', baseUrl: 'http://backend-b.test', generation: 'gen-b',
    })
  })
})
