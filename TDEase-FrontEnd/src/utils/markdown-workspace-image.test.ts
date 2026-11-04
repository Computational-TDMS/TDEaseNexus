import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

/**
 * Workspace-relative visual assets (images / SVG / html the Agent produced)
 * render inline as the ONE unified viz frame: a bare
 * `<span class="md-media-frame" data-file-kind=…>` placeholder that
 * MarkdownContent hydrates lazily into a slim bar (name → sidebar, button →
 * OS default app) over a fixed-height body — an img (click → lightbox) for
 * image/svg bytes, a sandboxed iframe for html.
 *
 * Data files (table / JSON / text) render as a file card span the
 * renderer hydrates by file type. Browser-loadable URLs (http/data/blob) are
 * left as normal images.
 */
describe('renderMarkdown workspace-relative media', () => {
  it('renders a Workspace-relative SVG as a unified viz frame placeholder', () => {
    const html = renderMarkdown('![QC](results/figure.svg)')
    expect(html).toContain('class="md-media-frame"')
    expect(html).toContain('data-workspace-src="results/figure.svg"')
    expect(html).toContain('data-file-kind="svg"')
    expect(html).toContain('data-file-name="figure.svg"')
  })

  it('renders a Workspace-relative raster as a unified viz frame placeholder', () => {
    const html = renderMarkdown('![envelope](runs/r1/analysis/h4/spectrum.png)')
    expect(html).toContain('class="md-media-frame"')
    expect(html).toContain('data-workspace-src="runs/r1/analysis/h4/spectrum.png"')
    expect(html).toContain('data-file-kind="image"')
    // No img/iframe in the emitted HTML — MarkdownContent mounts the body lazily.
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<iframe')
  })

  it('leaves an absolute http URL as a normal image (browser-loadable)', () => {
    const html = renderMarkdown('![x](https://example.com/fig.png)')
    expect(html).toContain('src="https://example.com/fig.png"')
    expect(html).not.toContain('data-workspace-src')
    expect(html).not.toContain('file-card')
  })

  it('leaves data: and blob: URLs as normal images (browser-loadable)', () => {
    const data = renderMarkdown('![x](data:image/png;base64,iVBOR==)')
    expect(data).toContain('src="data:image/png;base64,iVBOR=="')
    expect(data).not.toContain('data-workspace-src')
    expect(data).not.toContain('file-card')

    const blob = renderMarkdown('![x](blob:https://example.com/abc)')
    expect(blob).toContain('src="blob:https://example.com/abc"')
    expect(blob).not.toContain('data-workspace-src')
    expect(blob).not.toContain('file-card')
  })
})

/**
 * The Obsidian image embed `![[...]]` remains a legacy alias for the same
 * workspace media — rendered inline like `![](path)`. The system prompt and
 * skills no longer teach it; the renderer keeps accepting it.
 */
describe('renderMarkdown Obsidian media embeds (legacy ![[...]] alias)', () => {
  it('renders a workspace-relative ![[...]] SVG embed as a viz frame placeholder', () => {
    const html = renderMarkdown('![[runs/r1/analysis/h4/census.svg]]')
    expect(html).toContain('class="md-media-frame"')
    expect(html).toContain('data-workspace-src="runs/r1/analysis/h4/census.svg"')
    expect(html).toContain('data-file-kind="svg"')
  })

  it('keeps an absolute http ![[...]] as a normal image', () => {
    const html = renderMarkdown('![[https://example.com/fig.png]]')
    expect(html).not.toContain('data-workspace-src')
    expect(html).not.toContain('file-card')
    expect(html).toContain('src="https://example.com/fig.png"')
  })
})

/**
 * Embed semantics are type-decided, syntax-agnostic: `![[*.html]]`, `![](x.html)`
 * and `[[x.html]]` all become the same viz frame placeholder. MarkdownContent
 * hydrates it lazily (bytes on intersect) into a sandboxed iframe in the
 * fixed-height box — the emitted HTML itself never carries an `<iframe>`, and
 * absolute http embeds stay plain anchors.
 */
describe('renderMarkdown HTML embed frames (the html citation path)', () => {
  it('renders a workspace-relative ![[*.html]] embed as an inline frame placeholder', () => {
    const html = renderMarkdown('![[runs/r1/analysis/h4/isoforma.html]]')
    expect(html).toContain('class="md-media-frame"')
    expect(html).toContain('data-workspace-src="runs/r1/analysis/h4/isoforma.html"')
    expect(html).toContain('data-file-kind="html"')
    expect(html).toContain('data-file-name="isoforma.html"')
    // No iframe in the emitted HTML — MarkdownContent mounts it lazily.
    expect(html).not.toContain('<iframe')
  })

  it('renders a workspace-relative ![](x.html) embed as the same frame placeholder', () => {
    const html = renderMarkdown('![](runs/r1/report/summary.html)')
    expect(html).toContain('class="md-media-frame"')
    expect(html).toContain('data-workspace-src="runs/r1/report/summary.html"')
    expect(html).toContain('data-file-kind="html"')
  })

  it('renders a workspace-relative [[x.html]] wiki target as the same frame placeholder', () => {
    const html = renderMarkdown('[[runs/r1/report/summary.html]]')
    expect(html).toContain('class="md-media-frame"')
    expect(html).toContain('data-workspace-src="runs/r1/report/summary.html"')
  })

  it('keeps an absolute http ![[*.html]] embed as a plain anchor (no iframes in the pipeline)', () => {
    const html = renderMarkdown('![[https://example.com/plot.html]]')
    expect(html).toContain('<a href="https://example.com/plot.html">')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('data-workspace-src')
  })

  it('keeps the frame class through the sanitizer when the source carries raw markup', () => {
    // The sanitizer walk only runs when the source contains a `<`; without the
    // frame class on the allowlist it was stripped exactly then, leaving a
    // dead placeholder that never hydrated.
    const html = renderMarkdown('![](runs/r1/report/summary.html)\n\n<b>raw</b>')
    expect(html).toContain('class="md-media-frame"')
    expect(html).toContain('data-workspace-src="runs/r1/report/summary.html"')
  })
})

/**
 * Data files the Agent cites as evidence — a table (CSV/TSV/TopFD `.feature`),
 * JSON, or plain text — render as a file card regardless of whether
 * they were cited as `![](path)` or `[](path)`. HTML reports card the same way:
 * the anchor fallback handed them to the OS's `.html` association, which for a
 * text editor dumped the markup as text instead of the in-app preview. The card
 * carries the kind in `data-file-kind` and is hydrated by MarkdownContent
 * (real table, pretty JSON, capped code). This is the evidence-presentation
 * contract: the agent writes an ordinary markdown link and the frontend
 * recognizes the type.
 */
describe('renderMarkdown workspace data-file cards', () => {
  it('renders a Workspace-relative table cited as ![](path) as a table card', () => {
    const html = renderMarkdown('![](runs/r1/analysis/h4/envelope.csv)')
    expect(html).toContain('class="file-card"')
    expect(html).toContain('data-workspace-src="runs/r1/analysis/h4/envelope.csv"')
    expect(html).toContain('data-file-kind="table"')
    expect(html).toContain('data-file-name="envelope.csv"')
    // A table is not an image — no inline <img>.
    expect(html).not.toContain('<img')
  })

  it('renders a Workspace-relative table cited as [](path) as a table card', () => {
    const html = renderMarkdown('[full table](runs/soybean/analysis/p317/features.tsv)')
    expect(html).toContain('data-workspace-src="runs/soybean/analysis/p317/features.tsv"')
    expect(html).toContain('data-file-kind="table"')
    expect(html).toContain('data-file-name="features.tsv"')
    // The label text is preserved as the card's accessible name.
    expect(html).toContain('aria-label="full table"')
  })

  it('renders a Workspace-relative JSON file as a json card', () => {
    const html = renderMarkdown('[candidates](results/mass-shift-candidates.json)')
    expect(html).toContain('data-workspace-src="results/mass-shift-candidates.json"')
    expect(html).toContain('data-file-kind="json"')
    expect(html).toContain('data-file-name="mass-shift-candidates.json"')
  })

  it('renders a Workspace-relative text file as a text card', () => {
    const html = renderMarkdown('[run log](runs/r1/logs/worker.log)')
    expect(html).toContain('data-workspace-src="runs/r1/logs/worker.log"')
    expect(html).toContain('data-file-kind="text"')
    expect(html).toContain('data-file-name="worker.log"')
  })

  it('renders a Workspace-relative HTML report cited as [](path) as an html card', () => {
    const html = renderMarkdown('[交互报告](runs/r1/report/summary.html)')
    expect(html).toContain('data-workspace-src="runs/r1/report/summary.html"')
    expect(html).toContain('data-file-kind="html"')
    expect(html).toContain('data-file-name="summary.html"')
    // Not an anchor — an anchor click hands the file to the OS's .html
    // association (a text editor dumps markup as text).
    expect(html).not.toContain('<a href="runs/r1/report/summary.html"')
  })

  it('cards an unknown-extension file link like every other file link', () => {
    // The old anchor surface is gone on purpose: the sanitizer strips a
    // workspace-relative href (no explicit protocol), so the anchor rendered
    // as dead text or a live link depending on whether the rest of the
    // message contained raw HTML. A card is stable under both paths.
    const html = renderMarkdown('[archive](results/data.zip)')
    expect(html).toContain('class="file-card"')
    expect(html).toContain('data-workspace-src="results/data.zip"')
    expect(html).toContain('data-file-kind="file"')
    expect(html).not.toContain('<a href="results/data.zip"')
  })

  it('cards an image link as the image file (no inline expansion)', () => {
    // A labelled link in prose must not expand into the figure mid-paragraph —
    // that is the embed forms' job (`![](path)`). It must not stay an anchor
    // either: cards are the one clickable, collected surface.
    const html = renderMarkdown('[png](runs/r1/analysis/h4/spectrum.png)')
    expect(html).toContain('class="file-card"')
    expect(html).toContain('data-workspace-src="runs/r1/analysis/h4/spectrum.png"')
    expect(html).toContain('data-file-kind="image"')
    expect(html).toContain('aria-label="png"')
    expect(html).not.toContain('<a href="runs/r1/analysis/h4/spectrum.png"')
  })

  it('cards an empty-label image link the same, labelled with the basename', () => {
    const html = renderMarkdown('[](runs/r1/analysis/h4/spectrum.png)')
    expect(html).toContain('data-workspace-src="runs/r1/analysis/h4/spectrum.png"')
    expect(html).toContain('data-file-kind="image"')
    expect(html).toContain('data-file-name="spectrum.png"')
    expect(html).not.toContain('<a href="runs/r1/analysis/h4/spectrum.png"')
  })

  it('cards an empty-label data-file link the same as a labelled one', () => {
    const html = renderMarkdown('[](runs/r1/analysis/h4/envelope.csv)')
    expect(html).toContain('data-workspace-src="runs/r1/analysis/h4/envelope.csv"')
    expect(html).toContain('data-file-name="envelope.csv"')
    expect(html).not.toContain('<a href="runs/r1/analysis/h4/envelope.csv"')
  })

  it('leaves an absolute http file link as a plain anchor', () => {
    const html = renderMarkdown('[x](https://example.com/data.csv)')
    expect(html).toContain('<a href="https://example.com/data.csv"')
    expect(html).not.toContain('file-card')
  })

  it('renders an extensionless link target as the wikilink page anchor', () => {
    // `[](TopFD)` names a wiki page, not a file: the same inert anchor
    // `[[TopFD]]` renders — no workspace-relative href survives anywhere.
    const html = renderMarkdown('[the deconvolution step](method/TopFD)')
    expect(html).toContain('class="wikilink"')
    expect(html).toContain('data-wikilink-target="method/TopFD"')
    expect(html).toContain('>the deconvolution step</a>')
    expect(html).not.toContain('<a href="method/TopFD"')
    expect(html).not.toContain('data-workspace-src')
  })
})

/**
 * Syntax-agnostic presentation: `![[path]]`, `[[path]]`, `![](path)` all route
 * into the same by-type router (`presentInlineHtml`). No extension allowlist
 * gates the embed forms — an unknown extension still produces a generic file
 * card, never literal text.
 */
describe('renderMarkdown embed syntax equivalence', () => {
  it('renders [[figure.png]] inline as a viz frame, the Obsidian embed semantics for media targets', () => {
    const html = renderMarkdown('[[runs/r1/analysis/h4/spectrum.png]]')
    expect(html).toContain('class="md-media-frame"')
    expect(html).toContain('data-workspace-src="runs/r1/analysis/h4/spectrum.png"')
  })

  it('keeps a bare page target as a wikilink anchor', () => {
    const html = renderMarkdown('[[TopFD|the deconvolution step]]')
    expect(html).toContain('class="wikilink"')
    expect(html).toContain('data-wikilink-target="TopFD"')
    expect(html).toContain('>the deconvolution step</a>')
    expect(html).not.toContain('data-workspace-src')
  })

  it('renders an unknown-extension ![[...]] as a generic file card, not literal text', () => {
    const html = renderMarkdown('![[results/archive.xyz]]')
    expect(html).toContain('class="file-card"')
    expect(html).toContain('data-workspace-src="results/archive.xyz"')
    expect(html).toContain('data-file-kind="file"')
    expect(html).not.toContain('![[results/archive.xyz]]')
  })
})

/**
 * The agent attachment marker `[attached_image: path]` — composed into sent
 * messages by the Composer's attach flow and resolved to model-visible pixels
 * by image-attachment.ts — renders in the transcript as the same workspace
 * embed the user-facing syntaxes get: the user sees the image they sent, not
 * the wire format.
 */
describe('renderMarkdown agent attachment markers ([attached_image: path])', () => {
  it('renders a workspace-relative marker as a viz frame placeholder', () => {
    const html = renderMarkdown('before\n[attached_image: .tdease/attachments/shot.png]\nafter')
    expect(html).toContain('class="md-media-frame"')
    expect(html).toContain('data-workspace-src=".tdease/attachments/shot.png"')
    expect(html).toContain('data-file-kind="image"')
    expect(html).not.toContain('[attached_image:')
  })

  it('renders two markers on separate lines as two embeds', () => {
    const html = renderMarkdown('[attached_image: a.png]\n[attached_image: b.png]')
    expect(html.match(/data-workspace-src=/g)).toHaveLength(2)
  })

  it('leaves a non-image marker target to the by-type router (card, not text)', () => {
    const html = renderMarkdown('[attached_image: runs/r1/results.csv]')
    expect(html).toContain('data-workspace-src="runs/r1/results.csv"')
    expect(html).not.toContain('[attached_image:')
  })

  it('keeps a bracketed text that only looks similar as plain text', () => {
    const html = renderMarkdown('[attached_image] and [attached imagex: a.png]')
    expect(html).toContain('[attached_image]')
    expect(html).not.toContain('data-workspace-src')
  })
})
