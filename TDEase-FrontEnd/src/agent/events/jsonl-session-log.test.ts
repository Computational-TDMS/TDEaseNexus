import { describe, expect, it } from 'vitest'
import type { SessionLogTextFile } from '../ports/session-log'
import { createSessionEvent } from './vocabulary'
import { JsonlSessionLog } from './session-log'

class MemoryTextFile implements SessionLogTextFile {
  constructor(private text: string | null = null) {}

  async readText(): Promise<string | null> {
    return this.text
  }

  async appendText(text: string): Promise<void> {
    this.text = `${this.text ?? ''}${text}`
  }

  async replaceText(text: string): Promise<void> {
    this.text = text
  }

  value(): string | null {
    return this.text
  }
}

describe('JsonlSessionLog', () => {
  it('reloads the same ordered events from its JSONL source', async () => {
    const file = new MemoryTextFile()
    const writer = new JsonlSessionLog(file)

    await writer.append({
      type: 'turn.started',
      turn_id: 'turn_1',
      user_message: 'Inspect the workspace.',
      prompt_snapshot_digest: 'prompt_1',
      model: 'test-model',
      mindset: 'analysis',
      authority: 'ask',
    })
    await writer.append({
      type: 'tool.completed',
      turn_id: 'turn_1',
      call_id: 'call_1',
      ok: true,
      result: { nodes: ['node_1'] },
    })

    const reloaded = new JsonlSessionLog(file)
    await expect(reloaded.read()).resolves.toEqual(await writer.read())
  })

  it('rejects nonmonotonic sequence numbers while loading', async () => {
    const started = createSessionEvent({
      type: 'turn.started',
      turn_id: 'turn_1',
      user_message: 'Inspect the workspace.',
      prompt_snapshot_digest: 'prompt_1',
      model: 'test-model',
      mindset: 'analysis',
      authority: 'ask',
    }, 1)
    const completed = createSessionEvent({
      type: 'turn.cancelled',
      turn_id: 'turn_1',
    }, 3)
    const file = new MemoryTextFile(`${JSON.stringify(started)}\n${JSON.stringify(completed)}\n`)

    await expect(new JsonlSessionLog(file).read()).rejects.toThrow('expected seq 2, received 3')
  })

  it('atomically removes only an incomplete trailing line before the next append', async () => {
    const started = createSessionEvent({
      type: 'turn.started',
      turn_id: 'turn_1',
      user_message: 'Inspect the workspace.',
      prompt_snapshot_digest: 'prompt_1',
      model: 'test-model',
      mindset: 'analysis',
      authority: 'ask',
    }, 1)
    const file = new MemoryTextFile(`${JSON.stringify(started)}\n{"type":"message.comp`)
    const recovered = new JsonlSessionLog(file)

    await expect(recovered.read()).resolves.toEqual([started])
    await recovered.append({ type: 'turn.cancelled', turn_id: 'turn_1' })

    const lines = file.value()!.trimEnd().split('\n').map(line => JSON.parse(line))
    expect(lines.map(event => event.type)).toEqual(['turn.started', 'turn.cancelled'])
    expect(lines.map(event => event.seq)).toEqual([1, 2])
  })

  it('a readOnly log reports the torn tail but never rewrites the file', async () => {
    // Repair is a WRITE; only the turn runtime (a writer) may perform it. A
    // viewer constructed readOnly must drop the torn tail from its projection
    // while leaving the file exactly as it found it — a reader rewriting the
    // append-only truth store could race an in-flight append.
    const started = createSessionEvent({
      type: 'turn.started',
      turn_id: 'turn_1',
      user_message: 'Inspect the workspace.',
      prompt_snapshot_digest: 'prompt_1',
      model: 'test-model',
      mindset: 'analysis',
      authority: 'ask',
    }, 1)
    const torn = `${JSON.stringify(started)}\n{"type":"message.comp`
    const file = new MemoryTextFile(torn)

    const viewer = new JsonlSessionLog(file, { readOnly: true })
    await expect(viewer.read()).resolves.toEqual([started])
    expect(file.value()).toBe(torn)
    await expect(viewer.append({ type: 'turn.cancelled', turn_id: 'turn_1' })).rejects.toThrow('read-only')
  })

})
