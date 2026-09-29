/**
 * The persistent-bash wire protocol — everything said to and read from the
 * PTY, as pure string logic with no node-pty, fs or timer imports.
 *
 * Two modules speak it: pty-bash-backend.ts spawns the shell and sanitizes
 * the stream (TerminalSanitizer, BoundedTextBuffer, the controlled prompt);
 * persistent-bash-tool.ts frames each command with unique markers and parses
 * completion from scrollback. Extracted from both so the protocol is
 * unit-testable without a terminal — and so quoteForBash exists exactly once
 * (review candidate #7, 2026-08-17).
 *
 * Protocol elements:
 *  - CONTROLLED_PROMPT: the spawn-time PS1 the backend owns, re-asserted
 *    after `stty -echo` at session init.
 *  - SHELL_PROMPT: the tool's own private PS1, set on its first send.
 *    Deliberately distinct from CONTROLLED_PROMPT — one prompt per speaker.
 *  - OSC 133 `;D;` readiness marker (VSCode shell-integration format)
 *    emitted by PROMPT_COMMAND and detected by TerminalSanitizer.
 *  - Unique per-command start/end markers framing an `eval` with its status.
 */

import { randomUUID } from 'node:crypto'

// ── Prompts and model-facing messages ────────────────────────────────────────

/** The private printable prompt emitted after the OSC 133 marker. */
export const CONTROLLED_PROMPT = 'dsh> '

/** The persistent-bash tool's private PS1 (set after shell init). */
export const SHELL_PROMPT = '__TDEASE_BASH_PROMPT__ '

const TRUNCATED_MESSAGE = '\n[output truncated; narrow the command or inspect the saved file]'
const LOST_PREFIX_MESSAGE = '[scrollback truncated; narrow the command or inspect the saved file]\n'

// ── Stream sanitizing and bounded buffers (backend side) ─────────────────────

/**
 * Remove CSI/OSC/short escape sequences while preserving split-sequence carry,
 * and report completion of the private OSC 133 `;D;` prompt marker (VSCode
 * shell-integration format) with the following PS1 tail. Ported from DSH's
 * TerminalSanitizer; full terminal emulation is deliberately deferred.
 */
export class TerminalSanitizer {
  private maxPendingBytes: number
  private pending = ''
  private discardMode?: 'csi' | 'osc'
  private discardOscEscape = false
  private trailingCarriageReturn = false
  private trackingPromptTail = false

  constructor(maxPendingBytes: number) {
    this.maxPendingBytes = maxPendingBytes
  }

  /** Consume one decoded node-pty data chunk. */
  push(chunk: string): { text: string; prompt: boolean; promptTail?: string } {
    this.pending += this.discardPrefix(chunk)
    let text = ''
    let prompt = false
    let includePromptTail = this.trackingPromptTail
    let promptTail = ''
    let index = 0
    const appendText = (value: string): void => {
      text += value
      if (this.trackingPromptTail) promptTail += value
    }
    while (index < this.pending.length) {
      const escape = this.pending.indexOf('\x1B', index)
      if (escape < 0) {
        appendText(this.pending.slice(index))
        index = this.pending.length
        break
      }
      appendText(this.pending.slice(index, escape))
      if (escape + 1 >= this.pending.length) {
        index = escape
        break
      }
      const kind = this.pending[escape + 1]
      if (kind === ']') {
        const bel = this.pending.indexOf('\x07', escape + 2)
        const stringTerminator = this.pending.indexOf('\x1B\\', escape + 2)
        let end = -1
        if (bel >= 0 && stringTerminator >= 0) end = Math.min(bel + 1, stringTerminator + 2)
        else if (bel >= 0) end = bel + 1
        else if (stringTerminator >= 0) end = stringTerminator + 2
        if (end < 0) {
          index = escape
          break
        }
        const terminatorBytes = this.pending[end - 1] === '\x07' ? 1 : 2
        if (this.pending.slice(escape + 2, end - terminatorBytes).startsWith('133;D;')) {
          prompt = true
          this.trackingPromptTail = true
          includePromptTail = true
          promptTail = ''
        }
        index = end
        continue
      }
      if (kind === '[') {
        let end = escape + 2
        while (end < this.pending.length) {
          const code = this.pending.charCodeAt(end)
          if (code >= 64 && code <= 126) break
          end += 1
        }
        if (end >= this.pending.length) {
          index = escape
          break
        }
        index = end + 1
        continue
      }
      index = escape + 2
    }
    this.pending = this.pending.slice(index)
    this.enforcePendingBound()
    return {
      text: this.normalizeText(text),
      prompt,
      ...(includePromptTail ? { promptTail } : {}),
    }
  }

  /** Flush a trailing printable fragment when the PTY exits. */
  flush(): string {
    const text = this.pending.startsWith('\x1B') ? '' : this.pending
    this.pending = ''
    this.discardMode = undefined
    this.discardOscEscape = false
    this.trackingPromptTail = false
    const normalized = this.normalizeText(text)
    if (!this.trailingCarriageReturn) return normalized
    this.trailingCarriageReturn = false
    return `${normalized}\n`
  }

  private normalizeText(text: string): string {
    let complete = this.trailingCarriageReturn ? `\r${text}` : text
    this.trailingCarriageReturn = false
    if (complete.endsWith('\r')) {
      complete = complete.slice(0, -1)
      this.trailingCarriageReturn = true
    }
    return complete.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\x07', '')
  }

  private enforcePendingBound(): void {
    if (Buffer.byteLength(this.pending) <= this.maxPendingBytes) return
    this.discardMode = this.pending[1] === ']' ? 'osc' : 'csi'
    this.pending = ''
  }

  private discardPrefix(chunk: string): string {
    if (this.discardMode === undefined) return chunk
    if (this.discardMode === 'csi') {
      for (let index = 0; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index)
        if (code >= 64 && code <= 126) {
          this.discardMode = undefined
          return chunk.slice(index + 1)
        }
      }
      return ''
    }
    let index = 0
    if (this.discardOscEscape) {
      this.discardOscEscape = false
      if (chunk.startsWith('\\')) {
        this.discardMode = undefined
        return chunk.slice(1)
      }
    }
    while (index < chunk.length) {
      if (chunk[index] === '\x07') {
        this.discardMode = undefined
        return chunk.slice(index + 1)
      }
      if (chunk[index] === '\x1B') {
        if (chunk[index + 1] === '\\') {
          this.discardMode = undefined
          return chunk.slice(index + 2)
        }
        if (index + 1 === chunk.length) this.discardOscEscape = true
      }
      index += 1
    }
    return ''
  }
}

// ── Bounded buffers ──────────────────────────────────────────────────────────

export function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1])
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

export class BoundedTextBuffer {
  private value = ''
  private dropped = false
  constructor(private readonly maxBytes: number, private readonly maxLines?: number) {}

  append(text: string): void {
    if (text.length === 0) return
    this.value += text
    if (this.maxLines !== undefined) {
      const lines = this.value.split('\n')
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join('\n')
        this.dropped = true
      }
    }
    const tail = utf8Tail(this.value, this.maxBytes)
    this.value = tail.text
    this.dropped ||= tail.truncated
  }

  consume(): { delta: string; truncated: boolean } {
    const delta = this.value
    const truncated = this.dropped
    this.value = ''
    this.dropped = false
    return { delta, truncated }
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.dropped }
  }
}

// ── Marker protocol (tool side) ──────────────────────────────────────────────

export function markers(): { start: string; end: string } {
  const nonce = randomUUID()
  return {
    start: `__TDEASE_BASH_START_${nonce}__`,
    end: `__TDEASE_BASH_END_${nonce}:`,
  }
}

export function quoteForBash(value: string): string {
  return `$'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\r', '\\r').replaceAll('\n', '\\n')}'`
}

export function wrapCommand(command: string, marker: { start: string; end: string }): string {
  return `printf '%s\\n' ${quoteForBash(marker.start)}; eval -- ${quoteForBash(command)}; __tdease_bash_status=$?; printf '%s%s\\n' ${quoteForBash(marker.end)} "$__tdease_bash_status"`
}

function stripPrompt(text: string): string {
  let result = text.replace(/\r?\n$/, '')
  while (result.endsWith(SHELL_PROMPT)) result = result.slice(0, -SHELL_PROMPT.length)
  return result.endsWith('\n') ? result.slice(0, -1) : result
}

export function commandOutput(snapshot: { text: string }, marker: { start: string; end: string }): { text: string; incomplete: boolean; exitCode: number } | undefined {
  const text = snapshot.text
  const end = text.lastIndexOf(marker.end)
  const status = /^(\d+)\r?\n/.exec(text.slice(end + marker.end.length))?.[1]
  if (status === undefined) return undefined
  const startMarker = text.lastIndexOf(marker.start, end)
  const start = startMarker < 0 ? 0 : startMarker + marker.start.length
  return {
    text: stripPrompt(text.slice(start, end).replace(/^\r?\n/, '')),
    incomplete: startMarker < 0,
    exitCode: Number(status),
  }
}

export function promptCompleted(result: { viewport: string }): boolean {
  return result.viewport.endsWith(SHELL_PROMPT)
    || result.viewport.endsWith(`${SHELL_PROMPT}\r\n`)
    || result.viewport.endsWith(`${SHELL_PROMPT}\n`)
}

export function partialOutput(
  snapshot: { text: string },
  marker: { start: string; end: string },
  fallback: string,
  fallbackTruncated = false,
): { text: string; incomplete: boolean } {
  const startMarker = snapshot.text.lastIndexOf(marker.start)
  if (startMarker >= 0) {
    return {
      text: stripPrompt(snapshot.text.slice(startMarker + marker.start.length).replace(/^\r?\n/, '')),
      incomplete: false,
    }
  }
  const fallbackStart = fallback.lastIndexOf(marker.start)
  const afterStart = fallbackStart < 0 ? fallback : fallback.slice(fallbackStart + marker.start.length).replace(/^\r?\n/, '')
  const fallbackEnd = afterStart.lastIndexOf(marker.end)
  return {
    text: stripPrompt((fallbackEnd < 0 ? afterStart : afterStart.slice(0, fallbackEnd)).replaceAll(SHELL_PROMPT, '')),
    incomplete: fallbackTruncated || fallbackStart < 0,
  }
}

function maybeTruncate(content: string, maxOutputChars: number, incomplete = false): string {
  if (content.length <= maxOutputChars && !incomplete) return content
  return content.length <= maxOutputChars
    ? content + TRUNCATED_MESSAGE
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE
}

function appendStatusMarker(content: string, marker: string | undefined): string {
  if (marker === undefined) return content
  return content.length === 0 ? marker : `${content}\n${marker}`
}

export function renderCaptured(output: { text: string; incomplete: boolean }, exitCode: number | undefined, maxOutputChars: number): string {
  const rendered = maybeTruncate(output.text, maxOutputChars, output.incomplete)
  const body = output.incomplete && output.text.length > 0 ? LOST_PREFIX_MESSAGE + rendered : rendered
  const status = exitCode !== undefined && exitCode !== 0 ? `[exit code: ${exitCode}]` : undefined
  const withStatus = appendStatusMarker(body, status)
  return withStatus.length === 0 ? '(no output)' : withStatus
}
