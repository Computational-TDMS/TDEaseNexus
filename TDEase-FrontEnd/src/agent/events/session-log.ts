import type { SessionLog, SessionLogTextFile } from '../ports/session-log'
import {
  assertSessionEvent,
  cloneSessionEvent,
  createSessionEvent,
  type EventInput,
  type SessionEvent,
} from './vocabulary'

export interface JsonlSessionLogRead {
  exists: boolean
  events: ReadonlyArray<SessionEvent>
}

/** An in-memory append-only log for deterministic unit tests and headless callers. */
export class InMemorySessionLog implements SessionLog {
  private readonly entries: SessionEvent[] = []

  async append(input: EventInput): Promise<SessionEvent> {
    const event = createSessionEvent(input, this.entries.length + 1)
    this.entries.push(event)
    return cloneSessionEvent(event)
  }

  async read(): Promise<ReadonlyArray<SessionEvent>> {
    return this.entries.map(cloneSessionEvent)
  }
}

/**
 * JSONL-backed session log. It validates the entire file before exposing any
 * event and serializes appenders so sequence allocation stays single-writer.
 *
 * REPAIR OWNERSHIP: a torn tail (a partially-written append) is repaired by
 * REWRITING the file via `replaceText` — a WRITE. Only the turn runtime is a
 * writer of the log; a read-side instance (the subagent/inspector viewer) must
 * be constructed `readOnly`, which drops the torn tail from the events but
 * never touches the file. Two repairing instances racing an in-flight append
 * was a real correctness hazard: the append-only truth store must not be
 * writable by its readers.
 */
export class JsonlSessionLog implements SessionLog {
  private entries: SessionEvent[] | undefined
  private exists: boolean | undefined
  private loading: Promise<void> | undefined
  private appendTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: SessionLogTextFile,
    private readonly options: { readOnly?: boolean } = {},
  ) {}

  append(input: EventInput): Promise<SessionEvent> {
    if (this.options.readOnly) {
      return Promise.reject(new Error('This session log is read-only; the viewer must not append'))
    }
    const operation = this.appendTail.then(() => this.appendOne(input))
    this.appendTail = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  async read(): Promise<ReadonlyArray<SessionEvent>> {
    return (await this.readWithPresence()).events
  }

  /** Reads the log while preserving the distinction between no file and an empty file. */
  async readWithPresence(): Promise<JsonlSessionLogRead> {
    await this.appendTail
    await this.ensureLoaded()
    return { exists: this.exists!, events: this.entries!.map(cloneSessionEvent) }
  }

  private async appendOne(input: EventInput): Promise<SessionEvent> {
    await this.ensureLoaded()
    const event = createSessionEvent(input, this.entries!.length + 1)
    await this.file.appendText(`${JSON.stringify(event)}\n`)
    this.exists = true
    this.entries!.push(event)
    return cloneSessionEvent(event)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.entries !== undefined) return
    if (!this.loading) {
      this.loading = this.file.readText()
        .then(async (text) => {
          this.exists = text !== null
          const loaded = readJsonl(text ?? '')
          // Repair (a write) belongs to writer instances only.
          if (loaded.repairedText !== undefined && !this.options.readOnly) {
            await this.file.replaceText(loaded.repairedText)
          }
          this.entries = loaded.events
        })
        .catch((error: unknown) => {
          this.loading = undefined
          throw error
        })
    }
    await this.loading
  }
}

function readJsonl(text: string): { events: SessionEvent[]; repairedText?: string } {
  if (text.length === 0) return { events: [] }
  const endsWithNewline = /\r?\n$/.test(text)
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()

  const events: SessionEvent[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1
    const isRecoverableTail = index === lines.length - 1 && !endsWithNewline
    if (line.trim().length === 0) {
      if (isRecoverableTail) return recovered(events)
      throw new Error(`Invalid session JSONL line ${lineNumber}: blank lines are not allowed`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      if (isRecoverableTail) return recovered(events)
      throw new Error(`Invalid session JSONL line ${lineNumber}: invalid JSON`)
    }
    try {
      assertSessionEvent(parsed)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid session JSONL line ${lineNumber}: ${detail}`, { cause: error })
    }
    const expectedSeq = lineNumber
    if (parsed.seq !== expectedSeq) {
      throw new Error(`Invalid session JSONL line ${lineNumber}: expected seq ${expectedSeq}, received ${parsed.seq}`)
    }
    events.push(cloneSessionEvent(parsed))
  }
  return { events }
}

function recovered(events: ReadonlyArray<SessionEvent>): { events: SessionEvent[]; repairedText: string } {
  return {
    events: events.map(cloneSessionEvent),
    repairedText: events.length ? `${events.map(event => JSON.stringify(event)).join('\n')}\n` : '',
  }
}
