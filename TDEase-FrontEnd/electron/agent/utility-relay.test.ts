/**
 * Focused protocol tests for the agent utility relay: message framing,
 * request/response correlation, push fan-out (with the child-resolved parent
 * session hint), reverse RPC, usage-ledger replay, the oversized-message cap,
 * and respawn-on-exit with bind replay — exercised over an in-memory port
 * pair connecting the real client (utility-client.ts) to the real host
 * (utility-host-core.ts) with a fake runtime and fake spawn.
 */
import { describe, expect, it, vi } from 'vitest'

import type { AgentRuntime } from './agent-runtime'
import type { UsageLedger } from '../../src/ai/core/usage-ledger'
import { createAgentRuntimeClient, type AgentChildLike } from './utility-client'
import { createAgentHost, type HostPort } from './utility-host-core'
import { clampForRelay, findRelayClampMarker, RELAY_MESSAGE_CAP_BYTES, RELAY_STRING_CAP_BYTES, asciiByteLength } from './utility-protocol'

/** In-memory ordered port pair: each endpoint delivers to the other's listeners. */
function createPortPair(): { main: HostPort; child: HostPort } {
  const mainListeners: Array<(m: unknown) => void> = []
  const childListeners: Array<(m: unknown) => void> = []
  return {
    main: {
      post: (m) => { for (const l of [...childListeners]) l(m) },
      onMessage: (l) => { mainListeners.push(l) },
    },
    child: {
      post: (m) => { for (const l of [...mainListeners]) l(m) },
      onMessage: (l) => { childListeners.push(l) },
    },
  }
}

/** Fake utilityProcess child running the real host against a fake runtime.
 * Exposes the host so tests can fire push callbacks / reverse calls. */
function spawnFakeHost(runtime: AgentRuntime): AgentChildLike & { exit(code: number): void; host: ReturnType<typeof createAgentHost> } {
  const exitListeners: Array<(code: number) => void> = []
  const { main, child } = createPortPair()
  const host = createAgentHost({ port: child })
  host.attach(runtime)
  const wrapper = {
    on: (event: 'message' | 'exit', listener: (value: never) => void) => {
      if (event === 'message') main.onMessage(listener as (m: unknown) => void)
      else exitListeners.push(listener as (code: number) => void)
      return wrapper
    },
    postMessage: (message: unknown) => {
      if ((message as { t?: string })?.t === 'init') {
        // Boot handshake: the child-side entry constructs the runtime, then
        // answers ready — delivered as a child-origin message.
        child.post({ t: 'ready' })
        return
      }
      main.post(message)
    },
    kill: () => undefined,
    exit: (code: number) => { for (const l of [...exitListeners]) l(code) },
    host,
  }
  return wrapper
}

function fakeRuntime(overrides: Partial<Record<string, unknown>> = {}): AgentRuntime {
  return {
    bindSession: vi.fn(async () => ({ ok: true as const, sessionId: 's1' })),
    prompt: vi.fn(async () => ({ ok: true as const })),
    abort: vi.fn(async () => ({ ok: true as const })),
    compact: vi.fn(async () => ({ ok: true as const })),
    fork: vi.fn(async () => ({ ok: true as const })),
    dispose: vi.fn(async () => ({ ok: true as const })),
    disposeAll: vi.fn(async () => ({ ok: true as const })),
    resolveApproval: vi.fn(() => ({ ok: true as const })),
    listSubagents: vi.fn(() => []),
    cancelSubagent: vi.fn(async () => ({ ok: true as const })),
    peekSubagent: vi.fn(async () => ({ lines: [] })),
    listJobs: vi.fn(() => []),
    listSessionRuns: vi.fn(() => []),
    cancelJob: vi.fn(async () => ({ ok: true as const })),
    peekJob: vi.fn(async () => ({ lines: [] })),
    parentSessionOf: vi.fn(() => undefined),
    readSessionEvents: vi.fn(async () => []),
    ...overrides,
  } as unknown as AgentRuntime
}

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined }

function fakeLedger() {
  const events: Array<{ op: string; requestId?: string; status?: string }> = []
  let seq = 0
  const ledger: UsageLedger = {
    start: (meta) => {
      const requestId = `real_${++seq}`
      events.push({ op: 'start', requestId })
      return { requestId, startedAt: new Date().toISOString() }
    },
    finish: (requestId) => { events.push({ op: 'finish', requestId }); return null },
    recordError: (requestId, _error, status) => { events.push({ op: 'recordError', requestId, status }); return null },
    list: () => [],
    subscribe: () => () => undefined,
    clear: () => undefined,
    flush: () => undefined,
  }
  return { ledger, events }
}

function makeClient(spawn: () => AgentChildLike, extra: Partial<Parameters<typeof createAgentRuntimeClient>[0]> = {}) {
  const { ledger, events } = fakeLedger()
  const push = {
    turnEvent: vi.fn(),
    runsInvalidated: vi.fn(),
    subagents: vi.fn(),
    jobs: vi.fn(),
    sessionRuns: vi.fn(),
    view: vi.fn(),
    contextUsage: vi.fn(),
  }
  const client = createAgentRuntimeClient({
    spawn,
    init: {},
    push,
    deps: {
      resolveWorkspaceRoot: async (id) => `/ws/${id}`,
      backendConnection: () => ({ baseUrl: 'http://127.0.0.1:8000', accessToken: null, agentToken: null }),
      usageLedger: ledger,
    },
    crashLog: noopLogger,
    isQuitting: () => false,
    ...extra,
  })
  return { client, push, ledgerEvents: events }
}

describe('agent utility relay', () => {
  it('correlates concurrent requests to responses', async () => {
    const runtime = fakeRuntime({
      prompt: vi.fn(async (input: { message: string }) => ({ ok: true as const, echoed: input.message })),
    })
    const { client } = makeClient(() => spawnFakeHost(runtime))
    const [a, b, c] = await Promise.all([
      client.prompt({ sessionId: 's1', message: 'one' } as never),
      client.prompt({ sessionId: 's1', message: 'two' } as never),
      client.prompt({ sessionId: 's1', message: 'three' } as never),
    ])
    expect(a).toMatchObject({ ok: true, echoed: 'one' })
    expect(b).toMatchObject({ ok: true, echoed: 'two' })
    expect(c).toMatchObject({ ok: true, echoed: 'three' })
  })

  it('propagates host errors as rejections with the message intact', async () => {
    const runtime = fakeRuntime({ prompt: vi.fn(async () => { throw new Error('model unavailable') }) })
    const { client } = makeClient(() => spawnFakeHost(runtime))
    await expect(client.prompt({ sessionId: 's1', message: 'x' } as never)).rejects.toThrow('model unavailable')
  })

  it('fans push events out with the parent-session hint resolved child-side', async () => {
    const runtime = fakeRuntime({ parentSessionOf: vi.fn((id: string) => (id === 'child_1' ? 'parent_1' : undefined)) })
    const children: Array<ReturnType<typeof spawnFakeHost>> = []
    const { client, push } = makeClient(() => {
      const c = spawnFakeHost(runtime)
      children.push(c)
      return c
    })
    await client.listSubagents('warmup')

    // The runtime's push handlers (wired to the relay host inside the child)
    // emit a subagent's turn event; the host attaches the parent hint.
    children[0].host.push.turnEvent('child_1', { type: 'text_delta' })
    expect(push.turnEvent).toHaveBeenCalledWith('child_1', { type: 'text_delta' }, 'parent_1')

    children[0].host.push.subagents?.('parent_1', [])
    expect(push.subagents).toHaveBeenCalledWith('parent_1', [])

    children[0].host.push.runsInvalidated?.('ws_1')
    expect(push.runsInvalidated).toHaveBeenCalledWith('ws_1')
  })

  it('serves reverse calls into main-owned deps, echoing the child id', async () => {
    const runtime = fakeRuntime()
    const children: Array<ReturnType<typeof spawnFakeHost>> = []
    const { client } = makeClient(() => {
      const c = spawnFakeHost(runtime)
      children.push(c)
      return c
    })
    await client.listSubagents('warmup')

    await expect(children[0].host.call('resolveWorkspaceRoot', ['ws_7'])).resolves.toBe('/ws/ws_7')
    await expect(children[0].host.call('backendConnection', [])).resolves.toMatchObject({ baseUrl: 'http://127.0.0.1:8000' })
  })

  it('replays usage-ledger ops in order with request-id translation', async () => {
    const runtime = fakeRuntime()
    const children: Array<ReturnType<typeof spawnFakeHost>> = []
    const { client, ledgerEvents } = makeClient(() => {
      const c = spawnFakeHost(runtime)
      children.push(c)
      return c
    })
    await client.listSubagents('warmup')

    const first = children[0].host.ledger.start({ model: { providerId: 'p', modelId: 'm' } })
    children[0].host.ledger.finish(first.requestId, { usage: { input_tokens: 1, output_tokens: 2 } })
    const second = children[0].host.ledger.start({ model: { providerId: 'p', modelId: 'm' } })
    children[0].host.ledger.recordError(second.requestId, 'boom', 'error')

    // Ops replay on main's ledger in arrival order; the child-generated opaque
    // handle is translated to the ledger's own requestId (real_ prefix here).
    expect(ledgerEvents.map((e) => `${e.op}:${e.requestId}`)).toEqual([
      'start:real_1',
      'finish:real_1',
      'start:real_2',
      'recordError:real_2',
    ])
  })

  it('rejects in-flight requests when the child exits and respawns', async () => {
    vi.useFakeTimers()
    try {
      let spawnCount = 0
      const children: Array<ReturnType<typeof spawnFakeHost>> = []
      const runtime = fakeRuntime()
      const spawn = () => { spawnCount += 1; const c = spawnFakeHost(runtime); children.push(c); return c }
      const { client } = makeClient(spawn, { respawnDelayMs: 100 })
      // Boot the first child.
      await client.listSubagents('s1')
      expect(spawnCount).toBe(1)

      // Kill it while a slow prompt is in flight; only that call parks.
      const runtimeSlow = runtime as unknown as { prompt: ReturnType<typeof vi.fn> }
      let parking = true
      runtimeSlow.prompt.mockImplementation(() => (parking ? new Promise(() => undefined) : Promise.resolve({ ok: true as const })))
      const inflight = client.prompt({ sessionId: 's1', message: 'x' } as never)
      // Let the call finish its ensureChild microtask so the request is posted
      // before the process dies.
      await Promise.resolve()
      children[0].exit(1)
      parking = false
      await expect(inflight).rejects.toThrow(/exited \(code 1\)/)

      // Respawn scheduled; after the delay a new child exists and works.
      await vi.advanceTimersByTimeAsync(150)
      expect(spawnCount).toBe(2)
      const result = await client.prompt({ sessionId: 's1', message: 'again' } as never)
      expect(result).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rebinds owned sessions after a respawn from the cached bind input', async () => {
    vi.useFakeTimers()
    try {
      let spawnCount = 0
      const children: Array<ReturnType<typeof spawnFakeHost>> = []
      const runtime = fakeRuntime({
        bindSession: vi.fn(async (input: { sessionId: string }) => ({ ok: true as const, sessionId: input.sessionId })),
      })
      const spawn = () => { spawnCount += 1; const c = spawnFakeHost(runtime); children.push(c); return c }
      const rebinds: string[] = []
      const { client } = makeClient(spawn, {
        respawnDelayMs: 50,
        onSessionRebound: (sessionId) => rebinds.push(sessionId),
      })
      await client.bindSession({ sessionId: 'sess_A', workspaceId: 'ws' } as never)
      expect((runtime.bindSession as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
      children[0].exit(2)
      await vi.advanceTimersByTimeAsync(80)
      expect(spawnCount).toBe(2)
      // bindSession replayed into the fresh child.
      expect((runtime.bindSession as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(rebinds).toContain('sess_A')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('clampForRelay', () => {
  it('truncates oversized strings with a marker and leaves small values untouched', () => {
    const small = clampForRelay({ text: 'hello' })
    expect(small.truncated).toBe(false)
    expect(small.value).toEqual({ text: 'hello' })

    const huge = 'x'.repeat(RELAY_STRING_CAP_BYTES + 1000)
    const result = clampForRelay({ text: huge }, { byteLength: asciiByteLength })
    expect(result.truncated).toBe(true)
    expect((result.value as { text: string }).text.length).toBeLessThanOrEqual(RELAY_STRING_CAP_BYTES)
    expect((result.value as { text: string }).text).toContain('truncated by agent utility relay')
    // The original was not mutated.
    expect(huge.length).toBe(RELAY_STRING_CAP_BYTES + 1000)
  })

  it('degrades collection entries that exceed the remaining message budget', () => {
    const rows = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']
    const result = clampForRelay({ rows }, {
      stringCapBytes: 8,
      // Object + key + array overhead eats most of this; the third entry no
      // longer fits and is degraded (empty, or replaced by the in-band
      // __relayTruncated marker), never silently whole.
      messageCapBytes: 52,
      byteLength: asciiByteLength,
    })
    expect(result.truncated).toBe(true)
    expect(result.dropped).toBe(false)
    const kept = (result.value as { rows: unknown[] }).rows
    // Count only surviving string payload — a trailing marker entry is
    // protocol overhead, not kept data.
    const keptChars = kept.filter((entry): entry is string => typeof entry === 'string').join('').length
    expect(keptChars).toBeLessThan(rows.join('').length)
  })

  it('passes structured-cloneable exotica (Uint8Array, Date) through verbatim', () => {
    const bytes = new Uint8Array([1, 2, 3, 250])
    const when = new Date('2026-01-01T00:00:00Z')
    const result = clampForRelay({ bytes, when, nested: [{ blob: bytes }] })
    expect(result.truncated).toBe(false)
    expect((result.value as { bytes: Uint8Array }).bytes).toEqual(bytes)
    expect((result.value as { when: Date }).when).toEqual(when)
  })

  it('tombstones a payload it cannot bring under the message cap', () => {
    // A typed array passes through the walk verbatim (clamping would corrupt
    // it), so only the post-walk size check can catch it — replaced wholesale
    // by the explicit __relayDropped tombstone.
    const result = clampForRelay({ blob: new Uint8Array(32) }, {
      stringCapBytes: 8,
      messageCapBytes: 40,
      byteLength: asciiByteLength,
    })
    expect(result.dropped).toBe(true)
    expect(result.value).toEqual({ __relayDropped: true })
  })

  it('appends in-band __relayTruncated markers when a collection tail is dropped, and receivers can detect them (F4)', () => {
    // Array tail: entries stop being copied once the budget dies — a marker
    // entry rides in place of the dropped tail.
    const arrayCut = clampForRelay({ rows: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] }, {
      stringCapBytes: 8,
      messageCapBytes: 52,
      byteLength: asciiByteLength,
    })
    expect(arrayCut.truncated).toBe(true)
    expect(arrayCut.dropped).toBe(false)
    const rows = (arrayCut.value as { rows: unknown[] }).rows
    expect(rows.at(-1)).toEqual({ __relayTruncated: true })
    expect(findRelayClampMarker(arrayCut.value)).toBe('__relayTruncated')

    // Object tail: a trailing marker KEY marks the dropped keys.
    const objectCut = clampForRelay({ a: 'aaaaaaaa', b: 'bbbbbbbb', c: 'cccccccc' }, {
      stringCapBytes: 8,
      messageCapBytes: 34,
      byteLength: asciiByteLength,
    })
    expect(objectCut.truncated).toBe(true)
    expect((objectCut.value as Record<string, unknown>).__relayTruncated).toBe(true)
    expect(findRelayClampMarker(objectCut.value)).toBe('__relayTruncated')

    // Wholesale tombstone detection, and clean payloads detect nothing.
    expect(findRelayClampMarker({ __relayDropped: true })).toBe('__relayDropped')
    expect(findRelayClampMarker({ ok: true, rows: [1, 2, 3] })).toBe(null)
  })

  it('refuses to dispatch a request whose args carry a clamp marker (F4)', async () => {
    const runtime = fakeRuntime({ listSubagents: vi.fn(() => []) })
    const children: Array<ReturnType<typeof spawnFakeHost>> = []
    const { client } = makeClient(() => {
      const c = spawnFakeHost(runtime)
      children.push(c)
      return c
    })
    await client.listSubagents('warmup')
    expect((runtime.listSubagents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)

    // A clamped request (marker in args) must be answered with an error, not
    // dispatched against corrupt data.
    const marked = clampForRelay({ rows: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'] }, {
      stringCapBytes: 8,
      messageCapBytes: 52,
      byteLength: asciiByteLength,
    })
    children[0].postMessage({ t: 'req', id: 999, m: 'listSubagents', a: [marked.value] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((runtime.listSubagents as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('rejects prompt/bindSession whose args were clamped by the relay instead of sending corrupt data (F5)', async () => {
    const runtime = fakeRuntime()
    const { client } = makeClient(() => spawnFakeHost(runtime))
    // > RELAY_MESSAGE_CAP_BYTES of message → clamped → prompt refuses.
    const huge = 'x'.repeat((RELAY_MESSAGE_CAP_BYTES / 2) + 1024)
    await expect(client.prompt({ sessionId: 's1', message: huge } as never)).rejects.toThrow(/truncated by the relay clamp/)
    // A tombstoned payload (giant non-clampable view) rejects for ANY method.
    const blob = new Uint8Array(RELAY_MESSAGE_CAP_BYTES + 1024)
    await expect(client.peekSubagent('p', 's', blob as never)).rejects.toThrow(/exceeded the relay message cap/)
    expect((runtime.prompt as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('settles in-flight ledger rows as aborted when the child exits (F8)', async () => {
    const runtime = fakeRuntime()
    const children: Array<ReturnType<typeof spawnFakeHost>> = []
    const { client, ledgerEvents } = makeClient(() => {
      const c = spawnFakeHost(runtime)
      children.push(c)
      return c
    })
    await client.listSubagents('warmup')
    const handle = children[0].host.ledger.start({ model: { providerId: 'p', modelId: 'm' } })
    children[0].exit(1)
    // The never-finished row settles on main's ledger instead of leaking.
    expect(ledgerEvents).toEqual([
      { op: 'start', requestId: 'real_1' },
      { op: 'recordError', requestId: 'real_1', status: 'aborted' },
    ])
  })

  it('backs off exponentially and stops respawning after repeated crashes (F6)', async () => {
    vi.useFakeTimers()
    try {
      let spawnCount = 0
      const children: Array<ReturnType<typeof spawnFakeHost>> = []
      const runtime = fakeRuntime()
      const spawn = () => { spawnCount += 1; const c = spawnFakeHost(runtime); children.push(c); return c }
      const { client } = makeClient(spawn, { respawnDelayMs: 10 })
      await client.listSubagents('warmup')
      expect(spawnCount).toBe(1)

      // Crash 5 times in a row without a served response in between: the
      // respawn delay doubles each cycle (backoff) and the 5th opens the
      // circuit breaker — no further spawns, calls fail fast.
      for (let i = 2; i <= 5; i++) {
        children.at(-1)!.exit(1)
        await vi.advanceTimersByTimeAsync(120_000)
        expect(spawnCount).toBe(i)
      }
      children.at(-1)!.exit(1)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(spawnCount).toBe(5)
      await expect(client.listSubagents('s1')).rejects.toThrow(/crashed repeatedly/)
    } finally {
      vi.useRealTimers()
    }
  })
})
