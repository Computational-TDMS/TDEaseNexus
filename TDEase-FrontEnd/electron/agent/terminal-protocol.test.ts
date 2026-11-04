import { describe, expect, it } from 'vitest'

import {
  BoundedTextBuffer,
  commandOutput,
  CONTROLLED_PROMPT,
  markers,
  partialOutput,
  promptCompleted,
  quoteForBash,
  renderCaptured,
  SHELL_PROMPT,
  TerminalSanitizer,
  utf8Tail,
  wrapCommand,
} from './terminal-protocol'

// The wire protocol is pure by construction — these tests exercise it without
// a PTY; end-to-end shell behaviour stays in persistent-bash.e2e.test.ts.

describe('quoteForBash', () => {
  it('single-quotes with escapes for quotes, backslashes and newlines', () => {
    expect(quoteForBash(`it's`)).toBe(`$'it\\'s'`)
    expect(quoteForBash('a\\b')).toBe(`$'a\\\\b'`)
    expect(quoteForBash('a\r\nb')).toBe(`$'a\\r\\nb'`)
    expect(quoteForBash('dsh> ')).toBe(`$'dsh> '`)
  })
})

describe('marker framing', () => {
  it('wrapCommand frames eval between unique start/end markers with the status printf', () => {
    const marker = markers()
    const wrapped = wrapCommand('echo hi', marker)
    expect(wrapped).toContain(`printf '%s\\n' ${quoteForBash(marker.start)}`)
    expect(wrapped).toContain(`eval -- ${quoteForBash('echo hi')}`)
    expect(wrapped.endsWith(`printf '%s%s\\n' ${quoteForBash(marker.end)} "$__tdease_bash_status"`)).toBe(true)
  })

  it('markers are unique per call and never collide', () => {
    const one = markers()
    const two = markers()
    expect(one.start).not.toBe(two.start)
    expect(one.end).not.toBe(two.end)
  })
})

describe('TerminalSanitizer', () => {
  it('strips CSI sequences and keeps plain text', () => {
    const sanitizer = new TerminalSanitizer(4096)
    expect(sanitizer.push('\x1b[31mred\x1b[0m plain').text).toBe('red plain')
  })

  it('reports the OSC 133 prompt marker with the following prompt tail', () => {
    const sanitizer = new TerminalSanitizer(4096)
    const first = sanitizer.push(`out\r\n\x1b]133;D;0\x07${CONTROLLED_PROMPT}`)
    expect(first.prompt).toBe(true)
    expect(first.promptTail).toBe(CONTROLLED_PROMPT)
    // The prompt tail is a parallel extraction: the printable stream keeps it.
    expect(first.text).toBe(`out\n${CONTROLLED_PROMPT}`)
  })

  it('detects a marker split across chunks', () => {
    const sanitizer = new TerminalSanitizer(4096)
    expect(sanitizer.push('\x1b]133;D;').prompt).toBe(false)
    const second = sanitizer.push(`0\x07${CONTROLLED_PROMPT}`)
    expect(second.prompt).toBe(true)
    expect(second.promptTail).toBe(CONTROLLED_PROMPT)
  })

  it('flush settles what push deferred: a held carriage return, never a dangling escape', () => {
    const held = new TerminalSanitizer(4096)
    held.push('tail\r')
    expect(held.flush()).toBe('\n')

    const dangling = new TerminalSanitizer(4096)
    dangling.push('out\x1b')
    expect(dangling.flush()).toBe('')
    expect(dangling.flush()).toBe('')
  })
})

describe('BoundedTextBuffer / utf8Tail', () => {
  it('keeps only the last N lines and flags the drop', () => {
    const buffer = new BoundedTextBuffer(4096, 2)
    buffer.append('one\ntwo\nthree\nfour')
    const read = buffer.consume()
    expect(read.delta).toBe('three\nfour')
    expect(read.truncated).toBe(true)
  })

  it('utf8Tail cuts on whole characters', () => {
    // 'α' is 2 bytes: a 3-byte cap keeps one whole 'α', never a replacement char.
    const tail = utf8Tail('ααα', 3)
    expect(tail.text).toBe('α')
    expect(tail.truncated).toBe(true)
  })
})

describe('completion parsing', () => {
  it('commandOutput extracts body, exit code and completeness', () => {
    const marker = { start: '__TDEASE_BASH_START_x__', end: '__TDEASE_BASH_END_x__:' }
    const scrollback = { text: `noise before\n${marker.start}\nhello\n${marker.end}0\n${SHELL_PROMPT}` }
    expect(commandOutput(scrollback, marker)).toEqual({ text: 'hello', incomplete: false, exitCode: 0 })

    const failed = { text: `${marker.start}\nboom\n${marker.end}2\n` }
    expect(commandOutput(failed, marker)).toEqual({ text: 'boom', incomplete: false, exitCode: 2 })

    const lostStart = { text: `dropped earlier\nhello\n${marker.end}0\n` }
    expect(commandOutput(lostStart, marker)?.incomplete).toBe(true)

    expect(commandOutput({ text: 'still running\n' }, marker)).toBeUndefined()
  })

  it('partialOutput prefers live scrollback, falls back to the send buffer', () => {
    const marker = { start: '__TDEASE_BASH_START_x__', end: '__TDEASE_BASH_END_x__:' }
    const live = partialOutput({ text: `${marker.start}\npartial\n` }, marker, 'fallback')
    expect(live).toEqual({ text: 'partial', incomplete: false })

    const fromFallback = partialOutput({ text: '' }, marker, `lost\n${marker.start}\nkept\n`)
    expect(fromFallback).toEqual({ text: 'kept', incomplete: false })

    const nowhere = partialOutput({ text: '' }, marker, 'only fallback text', true)
    expect(nowhere.incomplete).toBe(true)
  })

  it('promptCompleted accepts the private prompt with or without a trailing newline', () => {
    expect(promptCompleted({ viewport: `${SHELL_PROMPT}` })).toBe(true)
    expect(promptCompleted({ viewport: `${SHELL_PROMPT}\n` })).toBe(true)
    expect(promptCompleted({ viewport: `echo hi\nout\n` })).toBe(false)
  })
})

describe('renderCaptured', () => {
  it('appends the exit-code marker only for non-zero exits', () => {
    expect(renderCaptured({ text: 'ok', incomplete: false }, 0, 100)).toBe('ok')
    expect(renderCaptured({ text: 'boom', incomplete: false }, 3, 100)).toBe('boom\n[exit code: 3]')
  })

  it('reports empty output and scrollback loss only when a bound is hit', () => {
    expect(renderCaptured({ text: '', incomplete: false }, undefined, 100)).toBe('(no output)')
    const clipped = renderCaptured({ text: 'abc', incomplete: true }, undefined, 100)
    expect(clipped.startsWith('[scrollback truncated;')).toBe(true)
    expect(clipped).toContain('abc')
    expect(clipped).toContain('output truncated')
    expect(renderCaptured({ text: 'abc', incomplete: false }, undefined, 100)).toBe('abc')
  })

  it('over-long output keeps head and tail with an omission marker', () => {
    const text = `HEAD${'x'.repeat(500)}TAIL`
    const rendered = renderCaptured({ text, incomplete: false }, 0, 200)
    expect(rendered.startsWith('HEAD')).toBe(true)
    expect(rendered.endsWith('TAIL')).toBe(true)
    expect(rendered).toContain('chars omitted — head and tail kept')
  })
})
