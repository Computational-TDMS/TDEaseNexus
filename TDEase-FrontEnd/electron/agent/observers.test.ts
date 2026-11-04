/**
 * NodeObservers — pins the compact eval audit: each completed tool call emits a
 * flat, tool-typed record to the optional sink, with the eval-relevant field
 * extracted (full bash command, skill id/resource, path, query) and the rest of
 * the args under `detail`. The full conversation truth stays in events.jsonl;
 * this is the trimmed index an eval loop reads without parsing the transcript.
 */
import { describe, expect, it, vi } from 'vitest'
import { NodeObservers } from './observers'

function makeObservers() {
  const sink = vi.fn()
  const observers = new NodeObservers({
    ledger: { start: () => '', finish: () => {}, recordError: () => {} } as never,
    toolAuditSink: sink,
  })
  return { observers, sink }
}

describe('NodeObservers compact eval audit', () => {
  it('emits a flat record for a bash call with the full command', () => {
    const { observers, sink } = makeObservers()
    observers.auditTool(
      's1', 'call-1', 'bash',
      { command: 'uv run --script "$TDEASE_SYSTEM_ASSETS/skills/toppic-suite/scripts/prsm_read.py" rows --path x.tsv' },
      { content: 'ok' }, true,
    )
    expect(sink).toHaveBeenCalledTimes(1)
    const entry = sink.mock.calls[0][0]
    expect(entry.tool).toBe('bash')
    expect(entry.ok).toBe(true)
    expect(entry.command).toContain('prsm_read.py')
    expect(entry.command).toContain('$TDEASE_SYSTEM_ASSETS')
    expect(entry.sessionId).toBe('s1')
    expect(entry.callId).toBe('call-1')
  })

  it('extracts id/resource for tdease.skill.read and path for file tools', () => {
    const { observers, sink } = makeObservers()
    observers.auditTool('s1', 'c2', 'tdease.skill.read', { id: 'system:mass-shift-analysis', resource: 'references/full-workflow.md' }, {}, true)
    observers.auditTool('s1', 'c3', 'read', { path: 'analysis/README.md', limit: 30 }, {}, true)
    const entries = sink.mock.calls.map((c) => c[0])
    expect(entries[0].id).toBe('system:mass-shift-analysis')
    expect(entries[0].resource).toBe('references/full-workflow.md')
    expect(entries[1].path).toBe('analysis/README.md')
    // non-key args stay under detail (limit)
    expect(entries[1].detail).toEqual({ limit: 30 })
  })

  it('records a failed call with ok=false', () => {
    const { observers, sink } = makeObservers()
    observers.auditTool('s1', 'c4', 'bash', { command: 'false' }, { content: 'boom' }, false)
    const entry = sink.mock.calls[0][0]
    expect(entry.ok).toBe(false)
    expect(entry.command).toBe('false')
  })

  it('never throws for malformed args and keeps stable fields', () => {
    const { observers, sink } = makeObservers()
    expect(() => observers.auditTool('s1', 'c5', 'grep', 'not-an-object' as never, {}, true)).not.toThrow()
    const entry = sink.mock.calls[0][0]
    expect(entry.tool).toBe('grep')
    expect(entry.command).toBeUndefined()
  })

  it('does not invoke the sink when none is configured', () => {
    const observers = new NodeObservers({ ledger: {} as never })
    expect(() => observers.auditTool('s1', 'c6', 'bash', { command: 'x' }, {}, true)).not.toThrow()
  })
})

describe('NodeObservers usage accounting', () => {
  function makeLedger() {
    const calls: Array<{ start?: unknown; finish?: unknown }> = []
    const ledger = {
      start: vi.fn((meta: unknown) => {
        calls.push({ start: meta })
        return 'h1'
      }),
      finish: vi.fn((handle: string, result: unknown) => {
        calls.push({ finish: result })
      }),
      recordError: vi.fn(),
    }
    return { ledger, calls }
  }

  it('hands provider cache counters to the ledger so hit ratio is computable', () => {
    const { ledger } = makeLedger()
    const observers = new NodeObservers({ ledger: ledger as never })
    observers.finishUsage('h1', {
      input_tokens: 4_072,
      output_tokens: 3_142,
      cache_read_tokens: 91_000,
      cache_write_tokens: 8_500,
    })
    expect(ledger.finish).toHaveBeenCalledWith('h1', {
      usage: {
        input_tokens: 4_072,
        output_tokens: 3_142,
        cacheRead: 91_000,
        cacheWrite: 8_500,
      },
    })
  })

  it('keeps cache fields optional for providers that do not report them', () => {
    const { ledger } = makeLedger()
    const observers = new NodeObservers({ ledger: ledger as never })
    observers.finishUsage('h1', { input_tokens: 10, output_tokens: 5 })
    expect(ledger.finish).toHaveBeenCalledWith('h1', {
      usage: { input_tokens: 10, output_tokens: 5, cacheRead: undefined, cacheWrite: undefined },
    })
  })

  it('settles a failed handle WITH the partial usage of completed calls', () => {
    const { ledger } = makeLedger()
    const observers = new NodeObservers({ ledger: ledger as never })
    const boom = new Error('stream died')
    observers.errorUsage('h1', boom, 'aborted', {
      input_tokens: 4_072,
      output_tokens: 3_142,
      cache_read_tokens: 91_000,
    })
    expect(ledger.recordError).toHaveBeenCalledWith('h1', boom, 'aborted', {
      usage: { input_tokens: 4_072, output_tokens: 3_142, cacheRead: 91_000, cacheWrite: undefined },
    })
    // Without usage the old shape is preserved — no fabricated payload.
    observers.errorUsage('h1', boom, 'error')
    expect(ledger.recordError).toHaveBeenLastCalledWith('h1', boom, 'error', undefined)
  })

  it('prefers bind-time cost rates over the settings-meta fallback', () => {
    const { ledger } = makeLedger()
    const observers = new NodeObservers({ ledger: ledger as never })
    const provider = { providerId: 'deepseek', modelId: 'm', api: 'openai-completions', modelMeta: { cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } } }
    observers.startUsage({
      model: { providerId: 'deepseek', modelId: 'm' },
      provider,
      cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
    } as never)
    expect(ledger.start).toHaveBeenCalledWith(expect.objectContaining({
      costRates: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
    }))
  })
})
