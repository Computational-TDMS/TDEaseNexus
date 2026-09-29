/**
 * Node-side SessionStore: owns `.tdease/sessions/<id>/` on disk.
 *
 * The layout is content-addressed so any byte that ever needs replay (system
 * prompt snapshots, large tool-result bodies) lives in its own file keyed by a
 * SHA-256 digest, and the append-only `events.jsonl` only ever records digests
 * and small structured facts (AGENT-CONTRACT.md §2, FILE-LAYOUT.md §3.1):
 *
 *   <workspaceRoot>/.tdease/sessions/<sessionId>/
 *     session.json
 *     events.jsonl
 *     turns.jsonl           (one TurnCard per settled turn — src/contracts/turn-card.ts)
 *     model-session/        (Pi transcript dir; created empty here, Pi owns it)
 *     snapshots/<digest>.md
 *     content/<digest>.blob
 *
 * This module is intentionally thin over the pure logic that already lives in
 * src/agent: the JSONL seq-allocation + validation is `JsonlSessionLog`, and the
 * digest is the webcrypto port. Backing those with Node `fs` is the only new
 * thing here — every byte written still passes through the same validators the
 * Renderer-side log used, so a corrupted tail line is repaired the same way.
 *
 * Security: `sessionId` and every `digest` are validated against strict regexes
 * before they touch the filesystem, so a hostile/buggy caller cannot escape the
 * session dir with `../` or forge a path into a sibling session. Atomic writes
 * (temp + rename with Windows EPERM backoff) mirror electron/main.ts so the
 * agent runtime rewriting session.json in a tight loop does not trip the
 * `workspace:write-text-atomic` EPERM storm.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'

import type { EventInput, SessionEvent } from '../../src/agent/events'
import type { ContentRef } from '../../src/agent/ports/content-store'
import type { SessionLogTextFile } from '../../src/agent/ports/session-log'
import type { TurnCard } from '../../src/contracts/turn-card'

import { JsonlSessionLog } from '../../src/agent/events/session-log'
import { assertSha256 } from '../../src/agent/prompt/digest'
import { writeTextAtomicQueued } from '../atomic-write'

import type { SessionStore } from './contracts'

/** Session ids are opaque client-chosen strings, but only `[A-Za-z0-9_-]+` is
 *  safe to embed in a filesystem path. Anything else is a bug or an attack. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/
/** SHA-256 hex digest, lowercase. Validated before any path is built. */
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

// ── SessionStore ─────────────────────────────────────────────────────────────

export class NodeSessionStore implements SessionStore {
  private readonly root: string
  private readonly appendTails = new Map<string, Promise<void>>()
  /**
   * One log instance per live session, so `JsonlSessionLog`'s internal
   * entries cache actually survives between appends. A fresh instance per
   * append re-read and re-parsed the whole events.jsonl every time — the
   * dominant main-process long-task as a session grows (O(n²) over a turn's
   * events). Bounded: the least-recently-used log beyond this many sessions
   * is dropped (the file is the truth; a dropped cache only costs one re-read).
   */
  private readonly logCache = new Map<string, JsonlSessionLog>()
  private static readonly LOG_CACHE_LIMIT = 8

  constructor(workspaceRoot: string) {
    this.root = workspaceRoot
  }

  private logFor(sessionId: string): JsonlSessionLog {
    const cached = this.logCache.get(sessionId)
    if (cached) {
      // LRU touch: delete+set re-inserts at the map's tail.
      this.logCache.delete(sessionId)
      this.logCache.set(sessionId, cached)
      return cached
    }
    const log = new JsonlSessionLog(this.logFile(sessionId))
    this.logCache.set(sessionId, log)
    if (this.logCache.size > NodeSessionStore.LOG_CACHE_LIMIT) {
      const oldest = this.logCache.keys().next().value
      if (oldest !== undefined && oldest !== sessionId) this.logCache.delete(oldest)
    }
    return log
  }

  /** Absolute dir for one session: <workspaceRoot>/.tdease/sessions/<id>. */
  sessionDir(sessionId: string): string {
    this.assertSessionId(sessionId)
    return path.join(this.root, '.tdease', 'sessions', sessionId)
  }

  /** Absolute dir for the Pi model-session transcript (Pi owns its contents). */
  modelSessionDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'model-session')
  }

  /** Idempotent: creates the session tree (including empty model-session/). */
  ensureSessionDirs(sessionId: string): void {
    const dir = this.sessionDir(sessionId)
    // `mkdirSync` is the right primitive here: this is called synchronously at
    // bind time so the dirs exist before any async write races a first event.
    // The four subdirs are created explicitly rather than via a loop so the
    // layout is self-documenting and a future addition is a deliberate edit.
    mkdirSync(dir, { recursive: true })
    mkdirSync(path.join(dir, 'model-session'), { recursive: true })
    mkdirSync(path.join(dir, 'snapshots'), { recursive: true })
    mkdirSync(path.join(dir, 'content'), { recursive: true })
  }

  async appendEvent(sessionId: string, event: EventInput): Promise<SessionEvent> {
    this.assertSessionId(sessionId)
    const prior = this.appendTails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = prior.then(() => current)
    this.appendTails.set(sessionId, tail)
    await prior
    try {
      const dir = this.sessionDir(sessionId)
      mkdirSync(dir, { recursive: true })
      return await this.logFor(sessionId).append(event)
    } finally {
      release()
      if (this.appendTails.get(sessionId) === tail) this.appendTails.delete(sessionId)
    }
  }

  async readEvents(sessionId: string): Promise<ReadonlyArray<SessionEvent>> {
    // `readWithPresence` is used (rather than `read`) so a missing file is a
    // clean empty array instead of an ENOENT thrown through the log.
    const log = this.logFor(sessionId)
    const read = await log.readWithPresence().catch((error: unknown) => {
      // ENOENT → fresh session, no events yet. Any other read error (corrupt
      // JSONL, permission) must surface: silently returning [] would hide a
      // real corruption from the replay path.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { exists: false, events: [] as ReadonlyArray<SessionEvent> }
      }
      throw error
    })
    return read.events
  }

  async appendTurnCard(sessionId: string, card: TurnCard): Promise<void> {
    this.assertSessionId(sessionId)
    const dir = this.sessionDir(sessionId)
    mkdirSync(dir, { recursive: true })
    // Ordering across turns is guaranteed by the caller: the SessionHost
    // chains every card write onto the same per-session append queue that
    // serializes events.jsonl, so no second writer exists to interleave with.
    await fs.appendFile(path.join(dir, 'turns.jsonl'), `${JSON.stringify(card)}\n`, 'utf8')
  }

  async readTurnCards(sessionId: string): Promise<ReadonlyArray<TurnCard>> {
    this.assertSessionId(sessionId)
    let text: string
    try {
      text = await fs.readFile(path.join(this.sessionDir(sessionId), 'turns.jsonl'), 'utf8')
    } catch (error) {
      // Missing log = fresh session, no turns yet.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw error
    }
    // A crash can truncate the tail line mid-append. The read side is a
    // projection, not a dump: a line that does not parse is dropped, not
    // fatal — the surviving cards are still a truthful roadmap.
    const cards: TurnCard[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { cards.push(JSON.parse(line) as TurnCard) } catch { /* truncated tail */ }
    }
    return cards
  }

  async writeSnapshot(sessionId: string, digest: string, content: string): Promise<void> {
    this.assertDigest(digest)
    const target = path.join(this.sessionDir(sessionId), 'snapshots', `${digest}.md`)
    await writeTextAtomicQueued(target, content)
  }

  async readSnapshot(sessionId: string, digest: string): Promise<string | undefined> {
    this.assertDigest(digest)
    const target = path.join(this.sessionDir(sessionId), 'snapshots', `${digest}.md`)
    try {
      return await fs.readFile(target, 'utf8')
    } catch (error) {
      // Missing snapshot is a normal "not yet assembled" state, not an error.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async putContent(sessionId: string, content: string, mediaType = 'text/plain'): Promise<ContentRef> {
    // The content_ref IS the digest of the bytes — content-addressed storage
    // means identical bodies dedupe on disk for free, and the event log only
    // ever records the ref. `Buffer.byteLength` gives the UTF-8 byte count
    // (not the JS string length), matching what a reader will pull back.
    const digest = sha256Hex(content)
    const target = path.join(this.sessionDir(sessionId), 'content', `${digest}.blob`)
    await writeTextAtomicQueued(target, content)
    return { content_ref: digest, media_type: mediaType, byte_length: Buffer.byteLength(content, 'utf8') }
  }

  async getContent(sessionId: string, ref: ContentRef): Promise<string> {
    // Validate the ref BEFORE building a path: a forged `content_ref` is the
    // only way a caller could otherwise reach an arbitrary filename under
    // content/. `assertSha256` throws on anything that is not 64 lowercase hex
    // chars, which is exactly the namespace `putContent` ever writes.
    assertSha256(ref.content_ref)
    const target = path.join(this.sessionDir(sessionId), 'content', `${ref.content_ref}.blob`)
    return fs.readFile(target, 'utf8')
  }

  /**
   * True when a Pi transcript already exists under model-session/. Used at bind
   * time to decide resume-vs-fresh: an existing transcript means Pi can pick up
   * context, an empty/missing dir means a brand new AgentSession.
   *
   * "Non-empty" specifically requires at least one `.jsonl`, because Pi may
   * create bookkeeping files we do not want to mistake for a transcript.
   */
  hasTranscript(sessionId: string): boolean {
    const dir = this.modelSessionDir(sessionId)
    if (!existsSync(dir)) return false
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return false
    }
    return entries.some((name) => name.endsWith('.jsonl'))
  }

  /**
   * Copy events.jsonl + the content-addressed stores (snapshots/, content/)
   * into a fork target. The event log references snapshot/content by digest,
   * so all three must travel together or the fork's replay hits missing refs.
   */
  async cloneConversation(sourceId: string, targetId: string): Promise<void> {
    const source = this.sessionDir(sourceId)
    this.ensureSessionDirs(targetId)
    const target = this.sessionDir(targetId)
    for (const subdir of ['snapshots', 'content']) {
      const from = path.join(source, subdir)
      if (existsSync(from)) await fs.cp(from, path.join(target, subdir), { recursive: true, force: true })
    }
    try {
      await fs.copyFile(path.join(source, 'events.jsonl'), path.join(target, 'events.jsonl'))
    } catch (error) {
      // A source with no turns yet has no log — the fork starts empty.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    try {
      await fs.copyFile(path.join(source, 'turns.jsonl'), path.join(target, 'turns.jsonl'))
    } catch (error) {
      // Turn cards travel with the conversation they summarize; same ENOENT rule.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Backs a JsonlSessionLog with fs. readText returns null on ENOENT so the log
   * treats a missing file as "no events" rather than an error; replaceText is
   * used by the log to repair a truncated tail line.
   */
  private logFile(sessionId: string): SessionLogTextFile {
    const file = path.join(this.sessionDir(sessionId), 'events.jsonl')
    return {
      readText: async () => {
        try {
          return await fs.readFile(file, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
          throw error
        }
      },
      appendText: (text: string) => fs.appendFile(file, text, 'utf8'),
      // Atomic on replace too: the repair rewrites the whole file, so a crash
      // mid-repair must not leave a half-truncated events.jsonl.
      replaceText: (text: string) => writeTextAtomicQueued(file, text),
    }
  }

  private assertSessionId(sessionId: string): void {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      // Path-safety guard: sessionId is interpolated directly into a path, so a
      // value containing `..` or a separator could escape the session dir.
      throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`)
    }
  }

  private assertDigest(digest: string): void {
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
      throw new Error(`Invalid digest: ${JSON.stringify(digest)}`)
    }
  }
}

// ── Plain helpers (kept module-local; no need to import from src/) ────────────
//
// `createWebCryptoSha256Digest` would also work (Node has globalThis.crypto), but
// putContent/getContent need a synchronous path-independent hash and we already
// pull in node:crypto for randomUUID. Using `createHash` directly avoids an
// unnecessary async hop on a hot path (tool results can be large and frequent).
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
