import { describe, expect, it } from 'vitest'
import {
  insertMentionToken,
  isMentionKind,
  mentionFragmentAtCaret,
  parseMentions,
  skillFragmentAtCaret,
  tokenToText,
} from './mention-token'

describe('mention-token', () => {
  describe('tokenToText / parseMentions round-trip', () => {
    it('serializes a token to @kind:refId', () => {
      expect(tokenToText({ kind: 'run', refId: 'abc123' })).toBe('@run:abc123')
      expect(tokenToText({ kind: 'file', refId: 'views/report.md' })).toBe('@file:views/report.md')
    })

    it('parses a single mention', () => {
      expect(parseMentions('analyze @run:abc123 please')).toEqual([{ kind: 'run', refId: 'abc123' }])
    })

    it('parses every supported kind', () => {
      const text = '@run:r @file:a/b.txt @skill:workspace:qc'
      expect(parseMentions(text)).toEqual([
        { kind: 'run', refId: 'r' },
        { kind: 'file', refId: 'a/b.txt' },
        // skill ids are <scope>:<name>; the skill alternation keeps the colon.
        { kind: 'skill', refId: 'workspace:qc' },
      ])
    })

    it('parses a scoped skill ref (origin:name) keeping the colon', () => {
      expect(parseMentions('use @skill:workspace:qc')).toEqual([
        { kind: 'skill', refId: 'workspace:qc' },
      ])
    })

    it('parses a bare-name skill ref as well (no scope)', () => {
      expect(parseMentions('use @skill:qc')).toEqual([{ kind: 'skill', refId: 'qc' }])
    })

    it('does not let a colon leak into run/file refIds', () => {
      // @run:a:b — the second ':' terminates; only 'a' is the refId. run/file
      // never carry an origin, so a colon there is genuinely a terminator.
      expect(parseMentions('@run:a:b')).toEqual([{ kind: 'run', refId: 'a' }])
    })

    it('de-duplicates repeated mentions, preserving first order', () => {
      expect(parseMentions('@run:r @file:f @run:r')).toEqual([
        { kind: 'run', refId: 'r' },
        { kind: 'file', refId: 'f' },
      ])
    })

    it('ignores unknown kinds (email-like and bare @handles)', () => {
      expect(parseMentions('email me@a.b or @someone')).toEqual([])
      expect(parseMentions('@project:x')).toEqual([])
    })

    it('terminates refId at a comma or paren', () => {
      expect(parseMentions('see @run:abc123, then')).toEqual([{ kind: 'run', refId: 'abc123' }])
      expect(parseMentions('(@file:a.txt)')).toEqual([{ kind: 'file', refId: 'a.txt' }])
    })

    it('returns [] for empty / @-less text', () => {
      expect(parseMentions('')).toEqual([])
      expect(parseMentions('no mentions here')).toEqual([])
    })
  })

  describe('isMentionKind', () => {
    it('narrows to the four kinds', () => {
      expect(isMentionKind('run')).toBe(true)
      expect(isMentionKind('file')).toBe(true)
      expect(isMentionKind('skill')).toBe(true)
      expect(isMentionKind('canvas')).toBe(false)
      expect(isMentionKind('project')).toBe(false)
    })
  })

  describe('insertMentionToken', () => {
    it('replaces the fragment and places the caret after a trailing space', () => {
      const text = 'analyze @ru for me'
      // caret right after '@ru' (index 11), fragment start at '@' (index 8)
      const result = insertMentionToken({ text, fragmentStart: 8, fragmentEnd: 11, token: { kind: 'run', refId: 'r1' } })
      expect(result.text).toBe('analyze @run:r1  for me')
      expect(result.caret).toBe(8 + '@run:r1 '.length)
    })
  })

  describe('mentionFragmentAtCaret', () => {
    it('finds a fragment at the caret', () => {
      const text = 'look at @ru'  // '@' at index 8, 'ru' at 9-10
      expect(mentionFragmentAtCaret(text, 11)).toEqual({ start: 8, end: 11, query: 'ru' })
    })

    it('returns null when no @ precedes the caret', () => {
      expect(mentionFragmentAtCaret('hello there', 5)).toBeNull()
    })

    it('returns null when a space closed the mention', () => {
      const text = '@run:r1 then'
      // caret after 'then' — a space broke the fragment
      expect(mentionFragmentAtCaret(text, text.length)).toBeNull()
    })

    it('returns null at the start of text', () => {
      expect(mentionFragmentAtCaret('anything', 0)).toBeNull()
    })
  })

  describe('skillFragmentAtCaret', () => {
    // `$` is the skill-only picker trigger (parallel to `@` for run/file).
    // It never lands in the persisted message — the picker confirms
    // by inserting an `@skill:<name>` token — so this function only needs to
    // locate the in-progress `$`-fragment the caret is inside, like the `@`
    // version but keyed on `$`.

    it('finds a $ fragment at the caret', () => {
      // 'use $qc' — '$' at index 4, 'qc' at 5-6
      expect(skillFragmentAtCaret('use $qc', 7)).toEqual({ start: 4, end: 7, query: 'qc' })
    })

    it('returns the empty query for a bare $', () => {
      expect(skillFragmentAtCaret('use $', 5)).toEqual({ start: 4, end: 5, query: '' })
    })

    it('returns null when no $ precedes the caret', () => {
      expect(skillFragmentAtCaret('hello there', 5)).toBeNull()
    })

    it('returns null when a space closed the fragment', () => {
      const text = '$qc then'
      // caret after 'then' — a space broke the fragment
      expect(skillFragmentAtCaret(text, text.length)).toBeNull()
    })

    it('ignores @ triggers (only $ opens the skill picker)', () => {
      // An @ is not a $ — the @ picker handles run/file, not skills.
      expect(skillFragmentAtCaret('look at @sk', 11)).toBeNull()
    })
  })
})
