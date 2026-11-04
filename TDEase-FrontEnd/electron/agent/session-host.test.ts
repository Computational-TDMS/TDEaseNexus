import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_TURN_BUDGETS } from '../../src/contracts/agent-runtime'
import type { TurnCard } from '../../src/contracts/turn-card'
import type { ActEvent, EventInput } from '../../src/agent/events'
import { deepFreeze, type SessionBinding } from './turn-definition'
import { SessionHost } from './session-host'

/**
 * Core-chain coverage for the two turn-settlement paths that only exist in
 * this class: a successful `tdease.session.reportBlocked` call upgrading the
 * outcome to `blocked`, and the wall-clock deadline aborting the turn into
 * `halted`. Pi itself is stubbed at `host.session` — everything else on the
 * host (store, prompt pipeline, observers, sink) is a recording fake.
 */

interface Harness {
  host: SessionHost
  appended: EventInput[]
  turnCards: TurnCard[]
  terminals: Array<{ turnId: string; outcome: string }>
  contextUsageEmits: Array<{ sessionId: string; usage: { tokens: number | null } }>
  usage: { finishUsage: ReturnType<typeof vi.fn>; errorUsage: ReturnType<typeof vi.fn> }
}

function makeHarness(options: {
  settledEvents?: ActEvent[]
  /** F1 test seam: return true to make the store reject one appendEvent. */
  failAppendEvent?: (event: EventInput) => boolean
  /** F12 test seam: session ids the store reports as having a transcript. */
  transcriptIds?: string[]
} = {}): Harness {
  const appended: EventInput[] = []
  const turnCards: TurnCard[] = []
  const terminals: Array<{ turnId: string; outcome: string }> = []
  const contextUsageEmits: Array<{ sessionId: string; usage: { tokens: number | null } }> = []
  const usage = { finishUsage: vi.fn(), errorUsage: vi.fn() }
  const binding = deepFreeze<SessionBinding>({
    workspaceId: 'workspace',
    sessionId: 'session',
    workspaceRoot: '/tmp/workspace',
    authority: 'ask',
    permissionCeiling: {} as SessionBinding['permissionCeiling'],
    toolCeiling: { builtins: [], mcp: false },
    generation: 1,
  })
  const host = new SessionHost({
    binding,
    model: { providerId: 'provider', modelId: 'model' },
    thinkingLevel: 'off',
    agentDir: '/tmp/agent',
    providers: {} as never,
    store: {
      appendEvent: async (_sessionId: string, event: EventInput) => {
        if (options.failAppendEvent?.(event)) throw new Error('transient append failure')
        appended.push(event)
        return { ...event, seq: appended.length } as never
      },
      readTurnCards: async () => turnCards,
      appendTurnCard: async (_sessionId: string, card: TurnCard) => { turnCards.push(card) },
      writeSnapshot: async () => undefined,
      hasTranscript: (sessionId: string) => options.transcriptIds?.includes(sessionId) ?? false,
    } as never,
    prompt: {
      resolveReferences: async () => [],
      assembleForRun: async () => ({ systemPrompt: 'system', digest: 'digest', fragments: [] }),
      snapshotProviderRequest: vi.fn(),
    } as never,
    approvals: { request: vi.fn(), resolve: vi.fn(), cancelSession: vi.fn() } as never,
    events: {
      observe: () => [],
      transientDelta: () => null,
      reset: vi.fn(),
      finish: () => ({ events: options.settledEvents ?? [], usage: { input_tokens: 3, output_tokens: 4 }, suspended_ms: 0 }),
    } as never,
    observers: {
      startUsage: () => 'usage-handle',
      finishUsage: usage.finishUsage,
      errorUsage: usage.errorUsage,
      auditTool: vi.fn(),
    } as never,
    sink: {
      textDelta: vi.fn(),
      thinkingDelta: vi.fn(),
      approvalRequested: vi.fn(),
      eventCommitted: vi.fn(),
      turnTerminal: (_sessionId: string, turnId: string, outcome: string) => terminals.push({ turnId, outcome }),
    } as never,
    tools: [],
    activeToolNames: [],
    toolNames: { rewriteForProvider: (value: string) => value, toCanonical: (value: string) => value, toProvider: (value: string) => value } as never,
    actionForTool: () => undefined,
    ambient: {
      drainSettledJobs: () => [],
      drainSettledSubagents: () => [],
      hasActiveSubagents: () => false,
      readWorkspaceBytes: async () => new Uint8Array(),
      emitContextUsage: (sessionId, usage) => contextUsageEmits.push({ sessionId, usage }),
    },
  })
  return { host, appended, turnCards, terminals, contextUsageEmits, usage }
}

function installSession(host: SessionHost, session: unknown): void {
  ;(host as unknown as { session: unknown }).session = session
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionHost turn settlement', () => {
  it('settles a normal turn as resolved', async () => {
    const { host, appended, terminals, usage } = makeHarness()
    const session = {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    }
    installSession(host, session)

    const result = await host.prompt('go', 'analysis')

    expect(result.outcome).toBe('resolved')
    expect(appended.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'resolved' })
    expect(terminals.at(-1)?.outcome).toBe('resolved')
    expect(session.abort).not.toHaveBeenCalled()
    // The ledger settles exactly once, with the collector's usage.
    expect(usage.finishUsage).toHaveBeenCalledWith('usage-handle', { input_tokens: 3, output_tokens: 4 })
    expect(usage.errorUsage).not.toHaveBeenCalled()
  })

  it('settles the turn as blocked when reportBlocked completed during the run', async () => {
    const { host, appended, terminals } = makeHarness()
    const session = {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => {
        // What the tool_result hook does on a successful reportBlocked call.
        ;(host as unknown as { activeRun: { blocked: unknown } }).activeRun.blocked = {
          reason: 'no fasta reference found',
          needed: 'a fasta file in the Workspace',
        }
      }),
      abort: vi.fn(async () => undefined),
    }
    installSession(host, session)

    const result = await host.prompt('go', 'analysis')

    expect(result.outcome).toBe('blocked')
    expect(appended.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'blocked' })
    expect(terminals.at(-1)?.outcome).toBe('blocked')
  })

  it('aborts the turn into halted when the wall-clock budget expires', async () => {
    vi.useFakeTimers()
    const { host, appended, terminals } = makeHarness()
    let rejectPrompt: (error: Error) => void = () => undefined
    const session = {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPrompt = reject })),
      abort: vi.fn(async () => {
        rejectPrompt(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      }),
    }
    installSession(host, session)

    const pending = host.prompt('go', 'analysis')
    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_BUDGETS.wallClockMs)
    const result = await pending

    expect(session.abort).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('halted')
    expect(appended.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'halted' })
    expect(terminals.at(-1)?.outcome).toBe('halted')
  })

  it('stays halted when Pi resolves prompt normally after deadline abort', async () => {
    vi.useFakeTimers()
    const { host, appended, terminals, usage } = makeHarness()
    let resolvePrompt: () => void = () => undefined
    const session = {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve })),
      abort: vi.fn(async () => { resolvePrompt() }),
    }
    installSession(host, session)

    const pending = host.prompt('go', 'analysis')
    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_BUDGETS.wallClockMs)
    const result = await pending

    expect(result.outcome).toBe('halted')
    expect(appended.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'halted' })
    expect(terminals.at(-1)?.outcome).toBe('halted')
    // This path used to settle NOTHING — the handle leaked and the turn's
    // real consumption vanished from usage statistics. It must land as an
    // aborted entry carrying the completed calls' partial usage.
    expect(usage.errorUsage).toHaveBeenCalledWith('usage-handle', expect.anything(), 'aborted', { input_tokens: 3, output_tokens: 4 })
    expect(usage.finishUsage).not.toHaveBeenCalled()
  })

  it('settles a provider failure as an error entry that still carries partial usage', async () => {
    const { host, usage } = makeHarness()
    installSession(host, {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => { throw new Error('provider exploded') }),
      abort: vi.fn(async () => undefined),
    })

    const result = await host.prompt('go', 'analysis')

    expect(result.outcome).toBe('failed')
    expect(usage.errorUsage).toHaveBeenCalledWith('usage-handle', expect.objectContaining({ message: 'provider exploded' }), 'error', { input_tokens: 3, output_tokens: 4 })
  })

  it('settles a user-aborted turn as cancelled even when Pi resolves prompt normally', async () => {
    const { host, appended, terminals } = makeHarness()
    let resolvePrompt: () => void = () => undefined
    const session = {
      // Pi resolves prompt() instead of throwing on a user stop — the abort
      // flag, not an exception, must carry the outcome.
      messages: [{ role: 'assistant', stopReason: 'aborted' }],
      prompt: vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve })),
      abort: vi.fn(async () => { resolvePrompt() }),
    }
    installSession(host, session)

    const pending = host.prompt('go', 'analysis')
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled())
    await host.abort()
    const result = await pending

    expect(result.outcome).toBe('cancelled')
    expect(appended.at(-1)).toMatchObject({ type: 'turn.cancelled' })
    expect(terminals.at(-1)?.outcome).toBe('cancelled')
  })

  it('does not poison the next turn after a user abort', async () => {
    const { host } = makeHarness()
    let resolvePrompt: () => void = () => undefined
    const session = {
      messages: [{ role: 'assistant', stopReason: 'aborted' }],
      prompt: vi.fn(() => new Promise<void>((resolve) => { resolvePrompt = resolve })),
      abort: vi.fn(async () => { resolvePrompt() }),
    }
    installSession(host, session)

    const pending = host.prompt('go', 'analysis')
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled())
    await host.abort()
    await pending

    // The abort flag is per-turn: a stop clicked between turns must not
    // mislabel the next one.
    session.prompt = vi.fn(async () => undefined)
    const next = await host.prompt('again', 'analysis')
    expect(next.outcome).toBe('resolved')
  })

  it('does not let a previous turn deadline halt a settled turn', async () => {
    vi.useFakeTimers()
    const { host, appended } = makeHarness()
    const session = {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    }
    installSession(host, session)

    const result = await host.prompt('go', 'analysis')
    await vi.advanceTimersByTimeAsync(DEFAULT_TURN_BUDGETS.wallClockMs * 2)

    expect(result.outcome).toBe('resolved')
    expect(session.abort).not.toHaveBeenCalled()
    expect(appended.filter((event) => event.type === 'turn.completed')).toHaveLength(1)
  })
})

describe('SessionHost context-usage emit', () => {
  it('emits the final occupancy at turn terminal from getContextUsage', async () => {
    const { host, contextUsageEmits } = makeHarness()
    installSession(host, {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      getContextUsage: () => ({ tokens: 12_345, contextWindow: 200_000, percent: 6 }),
    })

    const result = await host.prompt('go', 'analysis')

    expect(result.outcome).toBe('resolved')
    expect(contextUsageEmits.at(-1)).toMatchObject({ sessionId: 'session', usage: { tokens: 12_345 } })
  })

  it('emits null after compact() — occupancy unknown until the next response', async () => {
    const { host, contextUsageEmits } = makeHarness()
    const compact = vi.fn(async () => undefined)
    installSession(host, {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      compact,
      getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    })

    await host.compact()

    expect(compact).toHaveBeenCalledTimes(1)
    expect(contextUsageEmits.at(-1)).toMatchObject({ sessionId: 'session', usage: { tokens: null } })
  })

  it('stays silent when the injected session has no getContextUsage (harness stub)', async () => {
    const { host, contextUsageEmits } = makeHarness()
    installSession(host, {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    })

    const result = await host.prompt('go', 'analysis')

    expect(result.outcome).toBe('resolved')
    expect(contextUsageEmits).toEqual([])
  })
})

describe('SessionHost compaction recording', () => {
  // The Pi session is observed raw (no live subscribe in the harness), so the
  // tests drive `observe()` exactly as the session's subscribe callback would.
  it('records a completed compaction as a session-scoped context.compacted event', async () => {
    const { host, appended } = makeHarness()
    const observe = (host as unknown as { observe(raw: unknown): void }).observe
    observe.call(host, { type: 'compaction_end', reason: 'manual', aborted: false, result: { tokensBefore: 152345.7, estimatedTokensAfter: 18000 } })
    await (host as unknown as { flushPersistence(): Promise<void> }).flushPersistence()
    expect(appended).toEqual([
      { type: 'context.compacted', reason: 'manual', tokens_before: 152346, tokens_after: 18000 },
    ])
  })

  it('records nothing for an aborted, resultless or pre-start compaction', async () => {
    const { host, appended } = makeHarness()
    const observe = (host as unknown as { observe(raw: unknown): void }).observe
    observe.call(host, { type: 'compaction_start', reason: 'manual' })
    observe.call(host, { type: 'compaction_end', reason: 'manual', aborted: true, result: { tokensBefore: 100 } })
    observe.call(host, { type: 'compaction_end', reason: 'threshold', aborted: false, result: undefined })
    await (host as unknown as { flushPersistence(): Promise<void> }).flushPersistence()
    expect(appended).toEqual([])
  })
})

describe('SessionHost image attachment (multimodal)', () => {
  it('text-only model: marker stays inert, no bytes read, prompt without images', async () => {
    const { host } = makeHarness()
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]))
    ;(host as unknown as { options: { ambient: { readWorkspaceBytes: unknown } } }).options.ambient.readWorkspaceBytes = readBytes
    const session = {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    }
    installSession(host, session)

    const result = await host.prompt('[attached_image: fig.png] go', 'analysis')

    expect(result.outcome).toBe('resolved')
    expect(readBytes).not.toHaveBeenCalled()
    expect(session.prompt).toHaveBeenCalledWith('[attached_image: fig.png] go', undefined)
  })

  it('multimodal model: resolves the marker and passes images to session.prompt', async () => {
    const { host } = makeHarness()
    const bytes = new Uint8Array([137, 80, 78, 71])
    const readBytes = vi.fn(async () => bytes)
    ;(host as unknown as { options: { ambient: { readWorkspaceBytes: unknown } } }).options.ambient.readWorkspaceBytes = readBytes
    ;(host as unknown as { supportsImages: boolean }).supportsImages = true
    const session = {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    }
    installSession(host, session)

    const result = await host.prompt('[attached_image: fig.png] describe', 'analysis')

    expect(result.outcome).toBe('resolved')
    expect(readBytes).toHaveBeenCalledWith('fig.png')
    expect(session.prompt).toHaveBeenCalledWith('[attached_image: fig.png] describe', {
      images: [{ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }],
    })
  })
})

describe('SessionHost turn cards', () => {
  it('appends one card per settled turn with programmatic fields', async () => {
    const { host, turnCards, appended } = makeHarness({
      settledEvents: [
        { type: 'tool.requested', call_id: 'call_1', name: 'tdease.runs.status', args: { run_id: 'run_1' } },
        { type: 'tool.requested', call_id: 'call_2', name: 'tdease.runs.status', args: { run_id: 'run_1' } },
        { type: 'tool.completed', call_id: 'call_2', ok: true, result: { run_id: 'run_2' } },
      ],
    })
    installSession(host, {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    })

    const result = await host.prompt('check the qc run\nwith details', 'analysis')

    expect(result.outcome).toBe('resolved')
    expect(turnCards).toHaveLength(1)
    const card = turnCards[0]
    expect(card).toMatchObject({
      turnId: result.turnId,
      sessionId: 'session',
      index: 0,
      intent: 'check the qc run',
      outcome: 'resolved',
      toolSummary: { 'tdease.runs.status': 2 },
      runIds: ['run_1', 'run_2'],
      tokens: { input: 3, output: 4 },
    })
    expect(typeof card.durationMs).toBe('number')
    expect(typeof card.ts).toBe('string')
    // The card's turn is the turn events.jsonl recorded.
    expect(appended.find((event) => event.type === 'turn.started')).toMatchObject({ turn_id: card.turnId })
  })

  it('indexes cards across turns and truncates the intent at 100 chars', async () => {
    const { host, turnCards } = makeHarness()
    installSession(host, {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    })

    await host.prompt('first', 'analysis')
    await host.prompt(` ${'x'.repeat(120)}`, 'analysis')

    expect(turnCards.map((card) => card.index)).toEqual([0, 1])
    expect(turnCards[1].intent).toHaveLength(100)
    expect(turnCards[1].toolSummary).toEqual({})
    expect(turnCards[1]).not.toHaveProperty('runIds')
  })

  it('still writes the card when the turn fails — with zeroed tokens', async () => {
    const { host, turnCards } = makeHarness()
    installSession(host, {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => { throw new Error('provider exploded') }),
      abort: vi.fn(async () => undefined),
    })

    const result = await host.prompt('go', 'analysis')

    expect(result.outcome).toBe('failed')
    expect(turnCards).toHaveLength(1)
    expect(turnCards[0]).toMatchObject({ outcome: 'failed', tokens: { input: 0, output: 0 } })
  })

  it('never lets a failing card write fail the turn', async () => {
    const { host, turnCards } = makeHarness()
    const store = (host as unknown as { options: { store: { appendTurnCard: unknown } } }).options.store
    store.appendTurnCard = async () => { throw new Error('disk full') }
    installSession(host, {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    })

    const result = await host.prompt('go', 'analysis')

    expect(result.outcome).toBe('resolved')
    expect(turnCards).toHaveLength(0)
  })
})

describe('SessionHost append-track recovery (F1)', () => {
  it('fails the turn on a transient append failure but re-arms the queue for the next turn', async () => {
    let failedOnce = false
    const { host, appended } = makeHarness({
      failAppendEvent: (event) => {
        if (event.type === 'turn.started' && !failedOnce) {
          failedOnce = true
          return true
        }
        return false
      },
    })
    installSession(host, {
      messages: [{ role: 'assistant', stopReason: 'stop' }],
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
    })

    // Turn 1: the append failure is loud — the turn fails with it.
    await expect(host.prompt('first', 'analysis')).rejects.toThrow('transient append failure')

    // Turn 2: the queue is NOT poisoned — events append again (the pre-fix
    // behavior skipped every append for the rest of the binding's life).
    const result = await host.prompt('second', 'analysis')
    expect(result.outcome).toBe('resolved')
    expect(appended.some((event) => event.type === 'turn.started')).toBe(true)
    expect(appended.at(-1)).toMatchObject({ type: 'turn.completed', outcome: 'resolved' })
  })
})

describe('SessionHost fork (F12)', () => {
  it('refuses a fork onto a target that already has a transcript', async () => {
    const { host } = makeHarness({ transcriptIds: ['occupied'] })
    installSession(host, { messages: [], sessionManager: {} })
    await expect(host.fork('occupied')).rejects.toThrow(/already has a transcript/)
  })
})
