import { describe, expect, it } from 'vitest'
import {
  extractWikiLinks, parseWikiLinkInner, wikiLinkScopePrefix, wikiTargetMatchesPage,
} from './wikilinks'
import { renderMarkdown } from '@/utils/markdown'

describe('wikilink syntax', () => {
  it('parses target, label and heading parts', () => {
    expect(parseWikiLinkInner('TopFD')).toEqual({ target: 'TopFD', heading: null, label: 'TopFD' })
    expect(parseWikiLinkInner('TopFD|the deconvolution step')).toEqual({
      target: 'TopFD', heading: null, label: 'the deconvolution step',
    })
    expect(parseWikiLinkInner('TopFD#Envelope fitting')).toEqual({
      target: 'TopFD', heading: 'Envelope fitting', label: 'TopFD',
    })
    expect(parseWikiLinkInner('system/pitfall/C13 ladder|see the pitfall')).toEqual({
      target: 'system/pitfall/C13 ladder', heading: null, label: 'see the pitfall',
    })
  })

  it('rejects empty targets', () => {
    expect(parseWikiLinkInner('')).toBeNull()
    expect(parseWikiLinkInner('|label only')).toBeNull()
    expect(parseWikiLinkInner('Target#')).toEqual({ target: 'Target', heading: null, label: 'Target' })
  })

  it('recognizes explicit scope prefixes only', () => {
    expect(wikiLinkScopePrefix('system/TopFD')).toBe('system')
    expect(wikiLinkScopePrefix('workspace/notes')).toBe('workspace')
    expect(wikiLinkScopePrefix('method/TopFD')).toBeNull()
    expect(wikiLinkScopePrefix('TopFD')).toBeNull()
  })

  it('matches bare targets by file name, path targets by suffix, case-insensitive', () => {
    expect(wikiTargetMatchesPage('TopFD', 'method/TopFD.md')).toBe(true)
    expect(wikiTargetMatchesPage('topfd', 'method/TopFD.md')).toBe(true)
    expect(wikiTargetMatchesPage('method/TopFD', 'method/TopFD.md')).toBe(true)
    expect(wikiTargetMatchesPage('pitfall/TopFD', 'method/pitfall/TopFD.md')).toBe(true)
    expect(wikiTargetMatchesPage('TopFD', 'method/TopFD-notes.md')).toBe(false)
    expect(wikiTargetMatchesPage('other/TopFD', 'method/TopFD.md')).toBe(false)
    // .txt pages are linkable targets too: extensions are stripped on both
    // sides, so a bare name (or any extension spelling) reaches the page.
    expect(wikiTargetMatchesPage('log', 'notes/log.txt')).toBe(true)
    expect(wikiTargetMatchesPage('log.txt', 'notes/log.txt')).toBe(true)
    expect(wikiTargetMatchesPage('log.md', 'notes/log.txt')).toBe(true)
  })

  it('extracts links with offsets and skips escapes and code-fence-looking newlines', () => {
    const text = 'see [[A]] and [[B|bee]] then \\[[C]] and [[D]]'
    const links = extractWikiLinks(text)
    expect(links.map((link) => link.target)).toEqual(['A', 'B', 'D'])
    expect(links[0]).toMatchObject({ start: 4, end: 9 })
  })
})

describe('markdown wikilink rendering', () => {
  it('renders [[...]] as a data-carrying anchor that survives sanitization', () => {
    const html = renderMarkdown('see [[TopFD|the step]] and [[Notes#Section two]]')
    expect(html).toContain('data-wikilink-target="TopFD"')
    expect(html).toContain('>the step</a>')
    expect(html).toContain('data-wikilink-heading="Section two"')
    expect(html).toContain('class="wikilink"')
  })

  it('leaves reference-style brackets and code spans alone', () => {
    const html = renderMarkdown('`[[not a link]]` and [text](https://example.com)')
    expect(html).not.toContain('data-wikilink-target')
    expect(html).toContain('[[not a link]]')
  })

  it('escapes markup inside the target attribute', () => {
    const html = renderMarkdown('[[<script>alert(1)</script>]]')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
