/**
 * markdown-blocks — top-level block splitting for streamed markdown.
 *
 * The streaming fast path behind ProcessFold's per-block render cache:
 * instead of re-parsing the WHOLE message on every flush (O(n) per flush,
 * O(n²) over a turn — the 100ms+ main-thread stalls that read as full-screen
 * flicker while the model is emitting), the source is split into top-level
 * blocks and only the TAIL block is re-rendered per flush; every earlier
 * block's text is byte-identical to last frame, so its rendered HTML comes
 * from cache.
 *
 * Split rule: a block ends at a blank line OUTSIDE a fenced code block, and
 * the blank separator stays attached to the END of the preceding block. That
 * keeps the split PREFIX-STABLE under appends — the only mutation streaming
 * can make — which is the exact property the cache needs. An unterminated
 * fence (the normal state while a code block is arriving) holds everything
 * since the fence opener in one block, so partial fence content never
 * re-flows earlier output.
 *
 * Known, accepted approximations versus whole-document parsing (chat content,
 * where the streaming win dominates): a loose list interrupted by a blank
 * line renders as two adjacent lists, and reference-style link definitions
 * only resolve within their own block.
 */

/** A fenced-code opener at ≤3 spaces of indentation (CommonMark fence rule). */
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/

/** A blank line (spaces/tabs only). */
const BLANK = /^\s*$/

export function splitTopLevelBlocks(src: string): string[] {
  if (!src) return []
  const lines = src.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fenceMarker: string | null = null
  let afterBlank = false

  const flush = () => {
    if (current.length > 0) blocks.push(current.join('\n'))
    current = []
  }

  for (const line of lines) {
    if (fenceMarker) {
      current.push(line)
      const close = FENCE_OPEN.exec(line)
      if (close && close[1][0] === fenceMarker[0] && close[1].length >= fenceMarker.length) {
        fenceMarker = null
      }
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open) {
      // A fence opener right after a blank starts a new block, like any
      // other content line.
      if (afterBlank) {
        flush()
        afterBlank = false
      }
      fenceMarker = open[1]
      current.push(line)
      continue
    }
    if (BLANK.test(line)) {
      if (current.length > 0) current.push(line)
      afterBlank = true
      continue
    }
    if (afterBlank) {
      flush()
      afterBlank = false
    }
    current.push(line)
  }
  flush()
  return blocks
}

// ── Block render cache (module-level LRU) ───────────────────────────────────
//
// ProcessFold's per-block render memo. It MUST live here — true module scope —
// not inside the SFC: everything declared in `<script setup>` re-runs per
// component instance, so a per-instance Map died with every virtualizer
// recycle and forced a full-message markdown re-parse on each remount. The
// LRU is shared by every ProcessFold instance (and survives remounts), keyed
// by block id (unique per process: nextId / event seq). Entries carry the
// split source blocks and their rendered HTML, so a cache hit also gives
// MarkdownContent the per-block `blockHtmls` it needs for the append-only
// DOM reconcile. Eviction can only cost a re-parse, never a wrong hit: an
// id re-entering with different content re-renders (the block compare below).
import { renderMarkdown } from './markdown'

const BLOCK_RENDER_CACHE_LIMIT = 500
const blockRenderCache = new Map<string, { blocks: string[]; htmls: string[]; html: string }>()

export function renderBlockEntry(id: string, text: string): { blocks: string[]; htmls: string[]; html: string } {
  const blocks = splitTopLevelBlocks(text)
  const cached = blockRenderCache.get(id)
  if (cached
    && cached.blocks.length === blocks.length
    && cached.blocks.every((block, i) => block === blocks[i])) {
    // LRU refresh: move the hit to the back so recency tracks visibility.
    blockRenderCache.delete(id)
    blockRenderCache.set(id, cached)
    return cached
  }
  // Prefix-stable split: unchanged blocks reuse the cached per-block HTML,
  // only the changed (tail) block re-parses.
  const htmls = blocks.map((block, i) =>
    (cached && cached.blocks[i] === block ? cached.htmls[i]! : renderMarkdown(block)))
  const entry = { blocks, htmls, html: htmls.join('') }
  blockRenderCache.delete(id)
  blockRenderCache.set(id, entry)
  if (blockRenderCache.size > BLOCK_RENDER_CACHE_LIMIT) {
    const oldest = blockRenderCache.keys().next().value
    if (oldest !== undefined) blockRenderCache.delete(oldest)
  }
  return entry
}
