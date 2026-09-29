import type { EventInput, SessionEvent } from '../events/vocabulary'

/** The single append-only truth for one Agent session. */
export interface SessionLog {
  append(input: EventInput): Promise<SessionEvent>
  read(): Promise<ReadonlyArray<SessionEvent>>
}

/**
 * Minimal text storage needed by the JSONL adapter. The composition root owns
 * path creation and filesystem policy; this port never imports node:fs.
 */
export interface SessionLogTextFile {
  readText(): Promise<string | null>
  appendText(text: string): Promise<void>
  replaceText(text: string): Promise<void>
}
