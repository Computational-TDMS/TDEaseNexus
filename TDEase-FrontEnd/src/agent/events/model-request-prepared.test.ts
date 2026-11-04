import { describe, expect, it } from 'vitest'
import { assertSessionEvent, createSessionEvent } from './vocabulary'

/**
 * Locks the `model.request.prepared` event — the replay record for dynamic
 * mid-run context/tools/model/thinking changes. Without it, a `context` hook
 * that rewrote messages mid-run would be unreplayable: the snapshot digest on
 * `turn.started` could not reconstruct what each provider request actually saw.
 */
describe('model.request.prepared event', () => {
  it('is created with digests, model and thinking level (no prompt bytes)', () => {
    const event = createSessionEvent({
      type: 'model.request.prepared',
      turn_id: 'turn_1',
      request_seq: 2,
      system_prompt_digest: 'a'.repeat(64),
      context_digest: 'b'.repeat(64),
      active_tools_digest: 'c'.repeat(64),
      model: 'deepseek/deepseek-chat',
      thinking_level: 'high',
    }, 3)

    expect(event.type).toBe('model.request.prepared')
    expect(event.seq).toBe(3)
    expect(event.request_seq).toBe(2)
    // Only digests cross — never the prompt/context content itself.
    expect(event.system_prompt_digest).toBe('a'.repeat(64))
    expect(event.context_digest).toBe('b'.repeat(64))
    expect(event.active_tools_digest).toBe('c'.repeat(64))
  })

  it('rejects a zero request_seq (sequence is 1-based within the turn)', () => {
    expect(() => createSessionEvent({
      type: 'model.request.prepared',
      turn_id: 'turn_1',
      request_seq: 0,
      system_prompt_digest: 'a'.repeat(64),
      context_digest: 'b'.repeat(64),
      active_tools_digest: 'c'.repeat(64),
      model: 'deepseek/deepseek-chat',
      thinking_level: 'high',
    }, 1)).toThrow('request_seq must be a positive integer')
  })

  it('rejects a missing digest (a replay must be able to resolve every request)', () => {
    expect(() => assertSessionEvent({
      seq: 1, type: 'model.request.prepared', turn_id: 'turn_1', request_seq: 1,
      system_prompt_digest: 'a'.repeat(64),
      // context_digest intentionally missing
      active_tools_digest: 'c'.repeat(64),
      model: 'deepseek/deepseek-chat',
      thinking_level: 'high',
    })).toThrow('missing required field')
  })

  it('rejects an unknown extra field (the vocabulary is closed)', () => {
    expect(() => assertSessionEvent({
      seq: 1, type: 'model.request.prepared', turn_id: 'turn_1', request_seq: 1,
      system_prompt_digest: 'a'.repeat(64),
      context_digest: 'b'.repeat(64),
      active_tools_digest: 'c'.repeat(64),
      model: 'deepseek/deepseek-chat',
      thinking_level: 'high',
      prompt_bytes: 'should not be here',
    })).toThrow('unsupported field')
  })
})
