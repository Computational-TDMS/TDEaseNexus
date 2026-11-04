/**
 * Conversation export — serialize the active session's projected messages
 * into ONE standalone HTML file for sharing.
 *
 * The input is the store's `messages` (the log projection — the same shape
 * the transcript renders), never a second transcript state. Assistant text
 * and user text go through the app's `renderMarkdown` (sanitized at its
 * single exit), so code/callouts/tables render as they do in-app. Math is
 * rendered for real: when any message carries a formula, the same katex
 * package the app hydrates with renders it here, and the stylesheet ships
 * inline with its fonts as data URIs (export-katex.ts) — a share renders
 * identically offline, with zero network and no CDN link. Thinking blocks
 * collapse into <details>; tool groups render as one status line per call;
 * interactive-only surfaces (permission cards, approval buttons) have
 * nothing to say in a static share and are skipped.
 *
 * Pure and headless: no DOM, no bridge, no i18n. Labels that reach the file
 * are supplied by the caller; everything interpolated is escaped.
 */

import { renderMarkdown } from '@/utils/markdown'
import type { AgentChatMessage, ContentBlock } from '@/stores/chat-types'

export interface ConversationExportInput {
  /** Session title as shown in the session list ('' → caller picks a label). */
  title: string
  /** Provider/model display label, e.g. "DeepSeek / deepseek-v4-flash". */
  modelLabel?: string
  /** Workspace folder name the conversation happened in. */
  workspaceName?: string
  /** Epoch ms stamped into the header and the suggested filename. */
  exportedAt: number
  messages: ReadonlyArray<AgentChatMessage>
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** `20260907-1425-<slug>.html` — sortable, collision-safe to the minute. */
export function exportConversationFileName(title: string, at: number): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const stamp = new Date(at).toISOString().slice(0, 16).replace(/[-:T]/g, '')
  return `${stamp}-${slug || 'session'}.html`
}

const TOOL_GLYPHS: Record<string, string> = {
  running: '…',
  succeeded: '✓',
  failed: '✗',
  cancelled: '○',
  unknown: '·',
}

function renderBlock(block: ContentBlock): string {
  if (block.type === 'text') return `<div class="md">${renderMarkdown(block.text)}</div>`
  if (block.type === 'thinking') {
    const minutes = block.durationMs ? ` · ${Math.round(block.durationMs / 1000)}s` : ''
    return [
      '<details class="thinking"><summary>Thinking', escapeHtml(minutes), '</summary>',
      `<div class="md">${renderMarkdown(block.text)}</div>`,
      '</details>',
    ].join('')
  }
  if (block.type === 'tool_group') {
    const rows = block.tools.map((tool) => {
      const glyph = TOOL_GLYPHS[tool.status] ?? TOOL_GLYPHS.unknown
      const detail = tool.detail?.text ? `<span class="tool-detail">${escapeHtml(tool.detail.text)}</span>` : ''
      const error = tool.status === 'failed' && tool.error
        ? `<span class="tool-error">${escapeHtml(tool.error)}</span>`
        : ''
      return `<li><span class="tool-glyph" data-status="${escapeHtml(tool.status)}">${glyph}</span><code>${escapeHtml(tool.name)}</code>${detail}${error}</li>`
    })
    return `<ul class="tools">${rows.join('')}</ul>`
  }
  if (block.type === 'compaction') {
    return `<div class="compaction">— context compacted (${escapeHtml(block.reason)}) —</div>`
  }
  // permission blocks are live-approval UI; replays fold approvals into the
  // tool rows, so a static export never needs them.
  return ''
}

function renderMessage(message: AgentChatMessage): string {
  if (message.role === 'user') {
    return `<article class="msg msg--user"><div class="md">${renderMarkdown(message.content ?? '')}</div></article>`
  }
  const body = (message.blocks ?? []).map(renderBlock).join('')
  return `<article class="msg msg--assistant">${body}</article>`
}

const DOCUMENT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f6f6f4; color: #1f2328;
         font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 20px 64px; }
  header.doc { max-width: 820px; margin: 0 auto; padding: 32px 20px 8px; }
  header.doc h1 { font-size: 22px; margin: 0 0 4px; }
  header.doc .meta { color: #6b7280; font-size: 13px; }
  .msg { margin: 14px 0; padding: 12px 16px; border-radius: 10px; background: #fff;
         box-shadow: 0 1px 2px rgb(0 0 0 / 6%); overflow-wrap: anywhere; }
  .msg--user { background: #e8f0fe; }
  .msg--assistant { background: #fff; }
  .msg > .md > :first-child { margin-top: 0; }
  .msg > .md > :last-child { margin-bottom: 0; }
  .thinking { color: #6b7280; font-size: 14px; }
  .thinking summary { cursor: pointer; user-select: none; }
  .thinking[open] summary { margin-bottom: 6px; }
  .tools { list-style: none; margin: 6px 0; padding: 0; font-size: 13.5px; color: #444; }
  .tools li { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
  .tools code { background: #f2f2f0; padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
  .tool-glyph[data-status="succeeded"] { color: #1a7f37; }
  .tool-glyph[data-status="failed"] { color: #cf222e; }
  .tool-detail, .tool-error { color: #6b7280; overflow: hidden; text-overflow: ellipsis;
                              white-space: nowrap; }
  .tool-error { color: #cf222e; }
  .compaction { text-align: center; color: #9ca3af; font-size: 12.5px; margin: 18px 0; }
  /* Rendered markdown basics (renderMarkdown carries its own sanitization). */
  .md pre { background: #f2f2f0; padding: 12px; border-radius: 8px; overflow: auto; }
  .md code:not(pre code) { background: #f2f2f0; padding: 1px 5px; border-radius: 4px; }
  .md table { border-collapse: collapse; }
  .md th, .md td { border: 1px solid #d1d5db; padding: 4px 10px; }
`

export async function conversationExportHtml(input: ConversationExportInput): Promise<string> {
  const { title, modelLabel, workspaceName, exportedAt, messages } = input
  const metaParts = [
    new Date(exportedAt).toLocaleString(),
    ...(workspaceName ? [escapeHtml(workspaceName)] : []),
    ...(modelLabel ? [escapeHtml(modelLabel)] : []),
    `${messages.length} messages`,
  ]
  const safeTitle = escapeHtml(title || 'Conversation')
  const body = messages.map(renderMessage).join('')
  // Math assets only ride along when there is math to render — a plain
  // conversation must not pay the ~470 KB font payload, and the lazy import
  // keeps both katex and the fonts out of the entry chunk.
  let mathStyles = ''
  let renderedBody = body
  if (body.includes('katex-shell')) {
    const { renderExportMath, inlineKatexCss } = await import('./export-katex')
    renderedBody = await renderExportMath(body)
    mathStyles = `<style>${inlineKatexCss()}</style>`
  }
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${safeTitle}</title>`,
    mathStyles,
    `<style>${DOCUMENT_CSS}</style>`,
    '</head><body>',
    `<header class="doc"><h1>${safeTitle}</h1><div class="meta">${metaParts.map((p) => `<span>${p}</span>`).join(' · ')}</div></header>`,
    `<main>${renderedBody}</main>`,
    '</body></html>',
  ].join('')
}
