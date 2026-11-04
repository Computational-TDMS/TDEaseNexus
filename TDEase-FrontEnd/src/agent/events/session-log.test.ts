import { describe, expect, it } from 'vitest'
import { InMemorySessionLog } from './session-log'

describe('InMemorySessionLog', () => {
  it('allocates contiguous sequence numbers in append order', async () => {
    const log = new InMemorySessionLog()

    const started = await log.append({
      type: 'turn.started',
      turn_id: 'turn_1',
      user_message: 'Inspect the workspace.',
      prompt_snapshot_digest: 'prompt_1',
      model: 'test-model',
      mindset: 'analysis',
      authority: 'ask',
    })
    const completed = await log.append({
      type: 'message.completed',
      turn_id: 'turn_1',
      role: 'assistant',
      content: 'The workspace contains one Snakefile.',
    })

    expect(started.seq).toBe(1)
    expect(completed.seq).toBe(2)
    await expect(log.read()).resolves.toEqual([started, completed])
  })
})
