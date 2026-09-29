import { describe, expect, it } from 'vitest'
import { PiActCollector } from './translate-pi'

describe('PiActCollector', () => {
  it('records settled facts and discards provider stream deltas', () => {
    const collector = new PiActCollector()
    collector.observe({ type: 'thinking_delta', content: 'First thought.' })
    collector.observe({ type: 'thinking_delta', content: ' Second thought.' })
    collector.observe({ type: 'tool_requested', call_id: 'call_1', name: 'tdease.runs.status', args: { run_id: 'run_1' } })
    collector.observe({ type: 'tool_completed', call_id: 'call_1', ok: true, result: { run_id: 'run_1' } })
    collector.observe({ type: 'assistant_completed', content: 'Run run_1 is running.', usage: { input_tokens: 8, output_tokens: 3 } })

    const finished = collector.finish()
    expect(finished).toEqual({
      events: [
        // The settled record carries the measured reasoning span. Its exact
        // value is wall-clock, so presence and type are asserted below.
        expect.objectContaining({ type: 'thinking.recorded', content: 'First thought. Second thought.' }),
        { type: 'tool.requested', call_id: 'call_1', name: 'tdease.runs.status', args: { run_id: 'run_1' } },
        { type: 'tool.completed', call_id: 'call_1', ok: true, result: { run_id: 'run_1' } },
        { type: 'message.completed', role: 'assistant', content: 'Run run_1 is running.' },
      ],
      usage: { input_tokens: 8, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0 },
      suspended_ms: 0,
    })
    const thinking = finished.events[0] as { duration_ms?: number }
    expect(thinking.duration_ms).toBeTypeOf('number')
    expect(thinking.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('preserves assistant text emitted before a tool call and the final follow-up', () => {
    const collector = new PiActCollector()
    collector.observe({ type: 'assistant_completed', content: 'The workflow was submitted.' })
    collector.observe({ type: 'tool_requested', call_id: 'call_1', name: 'tdease.media.attach', args: { path: 'Snakefile' } })
    collector.observe({
      type: 'tool_completed',
      call_id: 'call_1',
      ok: false,
      error: { code: 'UNSUPPORTED_MEDIA', message: 'Unsupported media type.' },
    })
    collector.observe({ type: 'assistant_completed', content: 'I can check the logs next.' })

    expect(collector.finish().events).toEqual([
      { type: 'message.completed', role: 'assistant', content: 'The workflow was submitted.' },
      { type: 'tool.requested', call_id: 'call_1', name: 'tdease.media.attach', args: { path: 'Snakefile' } },
      {
        type: 'tool.completed',
        call_id: 'call_1',
        ok: false,
        error: { code: 'UNSUPPORTED_MEDIA', message: 'Unsupported media type.' },
      },
      { type: 'message.completed', role: 'assistant', content: 'I can check the logs next.' },
    ])
  })

  it('sums provider cache counters across assistant messages so the turn carries them', () => {
    // The turn-level ledger entry can only show a hit ratio if the per-request
    // cacheRead/cacheWrite survive aggregation — they are summed, not averaged.
    const collector = new PiActCollector()
    collector.observe({
      type: 'assistant_completed',
      content: 'step one',
      usage: { input_tokens: 120, output_tokens: 40, cache_read_tokens: 8_000, cache_write_tokens: 3_000 },
    })
    collector.observe({ type: 'assistant_completed', content: 'step two', usage: { input_tokens: 90, output_tokens: 30 } })
    collector.observe({
      type: 'assistant_completed',
      content: 'step three',
      usage: { input_tokens: 60, output_tokens: 20, cache_read_tokens: 12_500, cache_write_tokens: 0 },
    })

    expect(collector.finish().usage).toEqual({
      input_tokens: 270,
      output_tokens: 90,
      cache_read_tokens: 20_500,
      cache_write_tokens: 3_000,
    })
  })
})
