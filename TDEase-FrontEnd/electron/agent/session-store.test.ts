import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NodeSessionStore } from './session-store'

describe('NodeSessionStore.cloneConversation', () => {
  let root: string
  let store: NodeSessionStore

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-session-store-'))
    store = new NodeSessionStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('copies events.jsonl, snapshots and content so a fork keeps its conversation', async () => {
    store.ensureSessionDirs('source')
    const sourceDir = store.sessionDir('source')
    await fs.writeFile(path.join(sourceDir, 'events.jsonl'), '{"seq":1}\n', 'utf8')
    await fs.writeFile(path.join(sourceDir, 'snapshots', 'a'.repeat(64) + '.md'), 'prompt', 'utf8')
    await fs.writeFile(path.join(sourceDir, 'content', 'b'.repeat(64) + '.blob'), 'blob', 'utf8')

    await store.cloneConversation('source', 'fork')

    const forkDir = store.sessionDir('fork')
    expect(readFileSync(path.join(forkDir, 'events.jsonl'), 'utf8')).toBe('{"seq":1}\n')
    expect(readFileSync(path.join(forkDir, 'snapshots', 'a'.repeat(64) + '.md'), 'utf8')).toBe('prompt')
    expect(readFileSync(path.join(forkDir, 'content', 'b'.repeat(64) + '.blob'), 'utf8')).toBe('blob')
    // The Pi transcript is NOT part of the clone — SessionManager.forkFrom owns it.
    expect(existsSync(path.join(forkDir, 'model-session'))).toBe(true)
  })

  it('tolerates a source with no turns yet (nothing to clone, no throw)', async () => {
    store.ensureSessionDirs('source')
    await expect(store.cloneConversation('source', 'fork')).resolves.toBeUndefined()
    expect(existsSync(path.join(store.sessionDir('fork'), 'events.jsonl'))).toBe(false)
  })

  it('rejects path-unsafe session ids instead of escaping the session dir', async () => {
    await expect(store.cloneConversation('../escape', 'fork')).rejects.toThrow('Invalid session id')
    await expect(store.cloneConversation('source', 'a/b')).rejects.toThrow('Invalid session id')
  })
})

describe('NodeSessionStore turn cards', () => {
  let root: string
  let store: NodeSessionStore

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-session-store-'))
    store = new NodeSessionStore(root)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('round-trips cards through turns.jsonl and drops a crash-truncated tail', async () => {
    const card = {
      turnId: 'turn_1', sessionId: 'session', index: 0, ts: '2026-07-28T00:00:00.000Z',
      intent: 'check the qc run', outcome: 'resolved' as const,
      toolSummary: { 'tdease.runs.status': 1 }, durationMs: 10, tokens: { input: 1, output: 2 },
    }
    expect(await store.readTurnCards('session')).toEqual([])

    await store.appendTurnCard('session', card)
    await store.appendTurnCard('session', { ...card, turnId: 'turn_2', index: 1 })

    expect(await store.readTurnCards('session')).toEqual([card, { ...card, turnId: 'turn_2', index: 1 }])
    expect(readFileSync(path.join(store.sessionDir('session'), 'turns.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)

    // A mid-append crash leaves a partial tail line; the projection drops it.
    await fs.appendFile(path.join(store.sessionDir('session'), 'turns.jsonl'), '{"turnId":"turn_3"', 'utf8')
    expect((await store.readTurnCards('session')).map((item) => item.turnId)).toEqual(['turn_1', 'turn_2'])
  })

  it('carries turns.jsonl into a fork alongside events.jsonl', async () => {
    store.ensureSessionDirs('source')
    const sourceDir = store.sessionDir('source')
    await fs.writeFile(path.join(sourceDir, 'turns.jsonl'), '{"turnId":"turn_1"}\n', 'utf8')

    await store.cloneConversation('source', 'fork')

    expect(readFileSync(path.join(store.sessionDir('fork'), 'turns.jsonl'), 'utf8')).toBe('{"turnId":"turn_1"}\n')
  })
})
