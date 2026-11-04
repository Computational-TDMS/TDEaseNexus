import { describe, expect, it } from 'vitest'
import { conversationExportHtml } from './conversation-export'
import type { AgentChatMessage } from '@/stores/chat-types'

function assistantMessage(text: string): AgentChatMessage {
  return { id: 'm1', role: 'assistant', blocks: [{ type: 'text', text }] } as unknown as AgentChatMessage
}

describe('conversationExportHtml math', () => {
  it('renders formulas with inline katex (rendered markup + embedded fonts, no CDN link)', async () => {
    const html = await conversationExportHtml({
      title: 'Math session',
      exportedAt: Date.UTC(2026, 8, 14, 12, 0),
      messages: [assistantMessage('Euler: $e^{i\\pi} + 1 = 0$')],
    })

    // Real rendered katex markup, not the inert TeX shell.
    expect(html).toContain('class="katex"')
    // The stylesheet ships inline with its fonts as data URIs — the share
    // renders identically offline.
    expect(html).toContain('.katex')
    expect(html).toContain('data:font/woff2;base64,')
    // No external fetch of any kind: no stylesheet links, and every font
    // URL became a data URI (the vendored CSS's own license comments may
    // still mention URLs — comments never fetch).
    expect(html).not.toContain('jsdelivr')
    expect(html).not.toContain('<link')
    expect(html).not.toContain('url(fonts/')
    expect(html).not.toMatch(/src:url\(https?:/g)
    // The woff/ttf fallbacks were stripped — woff2 data URIs are the only src.
    expect(html).not.toMatch(/format\("(woff|truetype)"\)/g)
  })

  it('leaves the font payload out of math-free conversations', async () => {
    const html = await conversationExportHtml({
      title: 'Plain session',
      exportedAt: Date.UTC(2026, 8, 14, 12, 0),
      messages: [assistantMessage('Just words, no formulas.')],
    })

    expect(html).not.toContain('data:font/woff2')
    expect(html).not.toContain('katex-shell')
  })

  it('keeps the raw TeX visible for an unrenderable formula instead of failing', async () => {
    const html = await conversationExportHtml({
      title: 'Broken math',
      exportedAt: Date.UTC(2026, 8, 14, 12, 0),
      messages: [assistantMessage('Bad: $\\notacommand{$')],
    })

    expect(html).toContain('katex-shell')
    expect(html).toContain('notacommand')
  })
})
