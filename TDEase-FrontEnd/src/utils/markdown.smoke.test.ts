/**
 * Smoke test for the ported markdown renderer — verifies the plugin chain
 * (KaTeX, task-lists, mermaid fences, callouts, highlights, footnotes,
 * heading anchors, table scroll, code-block toolbar) produces expected
 * HTML structure. Not exhaustive — just guards against the renderer
 * throwing or silently dropping features.
 */
import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders headings with anchor ids', () => {
    const html = renderMarkdown('# Hello World')
    expect(html).toMatch(/<h1 id="hello-world">/)
  })

  it('renders fenced code with toolbar wrapper', () => {
    const html = renderMarkdown('```python\nprint("x")\n```')
    expect(html).toContain('code-block-wrap')
    expect(html).toContain('data-code-block-action="copy"')
    expect(html).toContain('data-code-block-action="wrap"')
    expect(html).toContain('language-python')
  })

  it('renders lists, bold, italic, inline code', () => {
    const html = renderMarkdown('- **a** *b* `c`')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>')
    expect(html).toContain('<strong>a</strong>')
    expect(html).toContain('<em>b</em>')
    expect(html).toContain('<code>c</code>')
  })

  it('wraps tables in scroll div', () => {
    const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('markdown-table-scroll')
    expect(html).toContain('<table>')
  })

  it('renders mermaid fence as diagram shell', () => {
    const html = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```')
    expect(html).toContain('mermaid-diagram')
    expect(html).toContain('mermaid-source')
    expect(html).toContain('mermaid-rendered')
  })

  it('renders obsidian callout as callout div', () => {
    const html = renderMarkdown('> [!warning] Careful\n> body text')
    expect(html).toContain('markdown-callout')
    expect(html).toContain('markdown-callout-warning')
    expect(html).toContain('markdown-callout-title')
  })

  it('renders foldable callout as details', () => {
    const html = renderMarkdown('> [!note]- Collapsed\n> body')
    expect(html).toContain('<details')
    expect(html).toContain('markdown-callout-note')
  })

  it('renders ==highlight== as mark', () => {
    const html = renderMarkdown('some ==highlighted== text')
    expect(html).toContain('<mark>highlighted</mark>')
  })

  it('renders inline and block math', () => {
    const html = renderMarkdown('Inline \\(E=mc^2\\)\n\nBlock:\n\n\\[\\int_0^1 x\\,dx\\]\n')
    expect(html).toContain('katex')
  })

  it('renders task list with checkboxes', () => {
    const html = renderMarkdown('- [x] done\n- [ ] todo')
    expect(html).toContain('task-list-item')
  })

  it('renders footnote ref + definition', () => {
    const html = renderMarkdown('See[^1].\n\n[^1]: def here.')
    expect(html).toContain('footnote-ref')
    expect(html).toContain('footnote-backref')
    expect(html).toContain('class="footnotes"')
  })

  it('autolinks urls', () => {
    const html = renderMarkdown('visit https://example.com today')
    expect(html).toContain('href="https://example.com"')
  })
})

/**
 * html:true + single-exit sanitization: the model may write raw HTML, the
 * allowlist scrubber keeps benign markup and strips the dangerous parts. The
 * sanitizer must also preserve the markup our own plugins emit when a source
 * containing `<` triggers the scrub (cards, media, wikilinks, katex shells).
 */
describe('renderMarkdown raw HTML + sanitizer', () => {
  it('renders benign raw HTML', () => {
    const html = renderMarkdown('a <b>bold</b> and <span style="color: red">red</span> word')
    expect(html).toContain('<b>bold</b>')
    expect(html).toContain('color: red')
  })

  it('strips scripts and event handlers', () => {
    const html = renderMarkdown('hello <script>alert(1)</script><img src="https://x/y.png" onerror="alert(1)">')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).toContain('hello')
  })

  it('keeps plugin markup alive when the sanitizer runs (source contains `<`)', () => {
    const html = renderMarkdown('<div>intro</div>\n\n![](runs/r1/envelope.csv) and [[TopFD]]')
    expect(html).toContain('data-workspace-src="runs/r1/envelope.csv"')
    expect(html).toContain('data-file-kind="table"')
    expect(html).toContain('class="wikilink"')
    expect(html).toContain('data-wikilink-target="TopFD"')
  })

  it('keeps a katex shell hydrated (data-formula survives the scrub)', () => {
    const html = renderMarkdown('<i>x</i>\n\n$E=mc^2$')
    expect(html).toContain('data-formula="E=mc^2"')
  })
})
