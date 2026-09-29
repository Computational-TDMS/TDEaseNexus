import { describe, expect, it } from 'vitest'
import { parseWikiFrontMatter, renderWikiPage, wikiPageTitle } from './front-matter'

describe('wiki front matter', () => {
  it('parses the flat block and preserves unknown keys', () => {
    const text = [
      '---',
      'title: TopFD',
      'kind: method',
      'updated: 2026-08-31',
      'tags: [topfd, deconvolution]',
      'generated_by: agent',
      '---',
      '',
      '# TopFD',
    ].join('\n')
    const { front, body, hasFrontMatter } = parseWikiFrontMatter(text)
    expect(hasFrontMatter).toBe(true)
    expect(front.title).toBe('TopFD')
    expect(front.kind).toBe('method')
    expect(front.updated).toBe('2026-08-31')
    expect(front.tags).toEqual(['topfd', 'deconvolution'])
    expect(front.extra).toEqual([{ key: 'generated_by', value: 'agent' }])
    expect(body).toContain('# TopFD')
  })

  it('tolerates a page with no front matter', () => {
    const { front, body, hasFrontMatter } = parseWikiFrontMatter('# Just a note\n')
    expect(hasFrontMatter).toBe(false)
    expect(front.tags).toEqual([])
    expect(body).toContain('Just a note')
  })

  it('derives the title from front matter, first heading, or the filename', () => {
    expect(wikiPageTitle('---\ntitle: Named\n---\nbody', 'fallback.md')).toBe('Named')
    expect(wikiPageTitle('# Heading title\nbody', 'fallback.md')).toBe('Heading title')
    expect(wikiPageTitle('plain text', 'fallback.md')).toBe('fallback')
  })

  it('renders a minimal stub for a new page', () => {
    const page = renderWikiPage({ title: 'New page', kind: 'pitfall', tags: ['one'], body: 'Body text.' })
    expect(page).toContain('title: New page')
    expect(page).toContain('kind: pitfall')
    expect(page).toMatch(/updated: \d{4}-\d{2}-\d{2}/)
    expect(page).toContain('tags: [one]')
    expect(page.trimEnd().endsWith('Body text.')).toBe(true)
    const round = parseWikiFrontMatter(page)
    expect(round.front.title).toBe('New page')
  })
})
