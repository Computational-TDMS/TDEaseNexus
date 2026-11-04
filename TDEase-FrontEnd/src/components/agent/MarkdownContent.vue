<script setup lang="ts">
/**
 * MarkdownContent — renders pre-rendered markdown HTML with streaming-safe
 * DOM reconciliation.
 *
 * First mount: write the whole HTML string into the root via innerHTML.
 * Subsequent updates (typical: streaming text append): run
 * reconcileTopLevelChildren, which diffs top-level child nodes by their
 * source outerHTML and only replaces the blocks whose HTML actually changed.
 * Already-stable paragraphs keep their DOM node identity, so a native text
 * selection the user has made inside them is NOT collapsed when the next
 * streaming chunk arrives.
 *
 * Before injection, every <pre> is wrapped in a .code-block-wrap with a
 * wrap/copy toolbar (see renderCodeBlockToolbarHtml). Toolbar clicks are
 * handled by a root-level event delegate — NOT per-button listeners —
 * because per-button listeners would be detached every time the streaming
 * reconcile touches innerHTML.
 *
 * Tail fade: the last N graphemes of the streaming tail are wrapped in
 * <span data-stream-tail-chunk> for a fade animation.
 *
 * Mermaid: post-render, lazily render every .mermaid-diagram shell. While the
 * message is streaming, both mermaid and KaTeX hydration are deferred until
 * the message settles (see flush() + the streaming watch).
 *
 * Ported from openhanako desktop/src/react/components/chat/MarkdownContent.tsx.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { renderCodeBlockToolbarHtml, codeBlockToolbarLabels, type CodeBlockToolbarLabels } from '@/utils/code-block-toolbar'
import { renderCodeHighlights } from '@/utils/code-highlighter'
import { renderMermaidDiagrams } from '@/utils/mermaid-renderer'
import { renderKatex } from '@/utils/katex-renderer'
import { useWorkspaceStore } from '@/stores/workspace'
import { getDesktopFileOps } from '@/services/workspace/desktopWorkspace'
import {
  applyTailFade,
  disconnectHydration,
  hydrateInlineFrames,
} from './markdown-hydration'
import MediaLightbox from '@/components/visualization/MediaLightbox.vue'

/** Card kinds markdown.ts can emit for a Workspace file reference. Visual
 *  kinds (image/svg/html) embed inline as the unified viz frame (lazy blob
 *  hydration: full width, auto-fitting height — html as an iframe with
 *  reported height, image/svg as a natural-height img); the data kinds
 *  table/json/text and the generic file fallback stay compact non-loaded
 *  cards the user opens on click (open-file routes it to the sidebar
 *  viewer). */
type FileCardKind = 'image' | 'svg' | 'html' | 'table' | 'json' | 'text' | 'file'

const props = withDefaults(defineProps<{
  /** Pre-rendered markdown HTML (output of renderMarkdown). */
  html: string
  /**
   * Optional per-block HTML (ProcessFold's cached block renders, in order —
   * the same blocks whose join is `html`). When present, streaming updates
   * take the append-only path: only blocks whose source string changed since
   * the previous flush are parsed into DOM (for a streaming append that is
   * exactly the tail block); finished blocks keep their nodes untouched.
   * Without it, the legacy whole-string reconcile below applies.
   */
  blockHtmls?: string[]
  /** Extra class on the root .md-content. */
  contentClass?: string
  /** Number of trailing graphemes to wrap in a fade span (streaming tail). */
  tailFadeCount?: number
  /** True while the owning message is still receiving streamed deltas
   *  (ProcessFold forwards the transcript's `message.id === streamingMessageId`).
   *  Mermaid/KaTeX hydration is deferred until this flips false — see flush(). */
  streaming?: boolean
}>(), {
  contentClass: '',
  tailFadeCount: 0,
  streaming: false,
  blockHtmls: undefined,
})

const emit = defineEmits<{
  /**
   * A Workspace file card (image / SVG / HTML / table / JSON / text produced
   * by the Agent) was clicked. The parent routes it to the inspector's Files
   * tab (primary) or the document area. MarkdownContent owns no document routing.
   */
  'open-file': [file: { path: string; kind: FileCardKind; name: string }]
}>()

const { t } = useI18n()
const root = ref<HTMLDivElement | null>(null)
const labels: CodeBlockToolbarLabels = codeBlockToolbarLabels({
  wrap: t('agent.codeBlock.wrap'),
  unwrap: t('agent.codeBlock.unwrap'),
  copy: t('agent.transcript.copy'),
  copied: t('agent.transcript.copied'),
})

// ── Reconcile ────────────────────────────────────────────────────────────────

/**
 * Parse the new HTML into a batch of top-level nodes, compare each one
 * against the root's current top-level child by index using its source
 * outerHTML; keep the existing node in place when the HTML matches (even if
 * it has been mutated in-place by mermaid / toolbar side-effects), replace
 * only when it differs. Trim surplus old nodes, append surplus new ones.
 *
 * Goal: streaming append should only re-mount DOM for the block currently
 * changing; paragraphs already finished keep their node identity so the
 * browser's native Selection does not collapse.
 *
 * Signatures are memoized per node in `signatureCache`. The HTML is produced
 * by our own deterministic renderer, so a node's SOURCE signature is fixed
 * for the node's lifetime: this reconcile only ever mutates the root by
 * whole-node replacement — a changed block arrives as a NEW node from the
 * template parse and the old one is swapped out — never by rewriting a kept
 * node's markup. In-place mutations that do happen (mermaid/KaTeX hydration,
 * tail-fade spans, wrap-toggle data attributes) are exactly what the "keep
 * even if mutated" rule above must IGNORE; re-serializing a hydrated node
 * flips its comparison against the fresh template node and tears the block
 * down again on every subsequent flush. Memoizing therefore keeps the
 * replacement decision identical for stable blocks while removing the
 * O(whole message) outerHTML serialization that used to run on every
 * streaming flush. The WeakMap is keyed on the node itself, so replaced
 * nodes are evicted with the DOM and keys never alias across message roots.
 */
const signatureCache = new WeakMap<Node, string>()

function nodeSignature(node: ChildNode): string {
  const cached = signatureCache.get(node)
  if (cached !== undefined) return cached
  const signature = node instanceof Element ? node.outerHTML : `#text:${node.textContent ?? ''}`
  signatureCache.set(node, signature)
  return signature
}

function reconcileTopLevelChildren(target: HTMLElement, html: string): void {
  const template = document.createElement('template')
  template.innerHTML = html
  const nextNodes = Array.from(template.content.childNodes)
  const prevNodes = Array.from(target.childNodes)
  const prevSignatures = prevNodes.map(nodeSignature)
  const length = Math.max(prevNodes.length, nextNodes.length)

  for (let i = 0; i < length; i += 1) {
    const prev = prevNodes[i] ?? null
    const next = nextNodes[i] ?? null

    if (next === null) {
      prev?.remove()
      continue
    }
    if (prev === null) {
      target.appendChild(next)
      // A GENUINELY NEW block just arrived mid-stream: play the one-shot
      // entrance (see .md-enter). Only appends animate — the replace branch
      // is the block currently being streamed into, and animating it would
      // strobe on every flush. The class is dropped on animationend; if the
      // animation never runs (reduced motion), a stale class is inert.
      if (next instanceof Element) {
        next.classList.add('md-enter')
        next.addEventListener('animationend', () => next.classList.remove('md-enter'), { once: true })
      }
      continue
    }
    if (prevSignatures[i] === nodeSignature(next)) {
      continue
    }
    target.replaceChild(next, prev)
  }
}

// ── Render + reconcile orchestration ─────────────────────────────────────────

const renderedHtml = ref('')

// ── Block mode (append-only reconcile) ───────────────────────────────────────
//
// When the parent can hand us the per-block rendered HTML (ProcessFold does —
// its cache is prefix-stable under streaming appends), the whole-message
// `template.innerHTML` parse disappears from the flush path: a block whose
// source string is identical to last flush keeps its DOM nodes as-is, and
// only a CHANGED block (the streaming tail) is parsed, by itself. The
// toolbar pass runs per changed block too, so a growing answer no longer
// re-scans the entire HTML string every frame.
//
// Block ownership: `blockNodes[i]` holds the consecutive top-level child
// nodes block i currently owns (a block may render to more than one node),
// and `domRawBlocks[i]` the source string that DOM content was built from.
// A block whose incoming string equals `domRawBlocks[i]` is KEPT — nodes
// untouched, in-place hydration mutations preserved (the same "keep even if
// mutated" rule as the legacy signature cache below); a changed block is
// parsed by itself and its nodes swapped; a new block is appended.
let domRawBlocks: string[] = []
let renderedBlocks: string[] = []
let blockNodes: ChildNode[][] = []

function parseBlock(html: string): ChildNode[] {
  const template = document.createElement('template')
  template.innerHTML = html
  return Array.from(template.content.childNodes)
}

function resetBlockMode(): void {
  domRawBlocks = []
  renderedBlocks = []
  blockNodes = []
}

/** Per-flush render: toolbar only the CHANGED blocks, keep the rest. */
function updateRenderedBlocks(rawBlocks: string[]): void {
  const next: string[] = []
  for (let i = 0; i < rawBlocks.length; i += 1) {
    const raw = rawBlocks[i]!
    next[i] = raw === domRawBlocks[i]
      ? renderedBlocks[i] ?? renderCodeBlockToolbarHtml(raw, labels)
      : renderCodeBlockToolbarHtml(raw, labels)
  }
  renderedBlocks = next
  renderedHtml.value = next.join('')
}

function reconcileBlockChildren(target: HTMLElement, rawBlocks: string[]): void {
  if (target.childNodes.length === 0) {
    // First mount (or remount after virtualizer recycle): build the whole
    // message once. Per-block fragments, so ownership bookkeeping is exact.
    blockNodes = renderedBlocks.map((html) => parseBlock(html!))
    for (const nodes of blockNodes) for (const node of nodes) target.appendChild(node)
    domRawBlocks = rawBlocks.slice()
    return
  }
  const prevLength = domRawBlocks.length
  for (let i = 0; i < rawBlocks.length; i += 1) {
    const raw = rawBlocks[i]!
    const owned = blockNodes[i] ?? []
    if (i < prevLength && raw === domRawBlocks[i] && owned.length > 0) continue
    const nodes = parseBlock(renderedBlocks[i]!)
    if (owned.length > 0) {
      const first = owned[0]!
      for (const node of nodes) target.insertBefore(node, first)
      for (const node of owned) node.remove()
    } else {
      // Appended block (streaming appends only ever extend the tail): it
      // lands after everything the previous last block owns. Play the same
      // one-shot entrance the legacy path gives genuinely new blocks.
      const anchor = blockNodes[i - 1]
      const before = anchor && anchor.length > 0 ? anchor[anchor.length - 1]!.nextSibling : null
      for (const node of nodes) target.insertBefore(node, before)
      for (const node of nodes) {
        if (node instanceof Element) {
          node.classList.add('md-enter')
          node.addEventListener('animationend', () => node.classList.remove('md-enter'), { once: true })
        }
      }
    }
    blockNodes[i] = nodes
  }
  // A shrink (blocks disappeared) can only come from a wholesale content
  // swap; remove the surplus blocks' nodes and drop the bookkeeping.
  if (blockNodes.length > rawBlocks.length) {
    for (let i = rawBlocks.length; i < blockNodes.length; i += 1) {
      for (const node of blockNodes[i]!) node.remove()
    }
    blockNodes.length = rawBlocks.length
  }
  domRawBlocks = rawBlocks.slice()
}

// Mermaid shells only exist when the source HTML mentions them. Gate the
// render pass on that: streaming flushes reconcile the DOM every frame, and
// an unconditional querySelector + render scan per flush (plus one per
// MutationObserver batch) showed up as flicker whenever a mermaid fence
// passed through the stream.
const hasMermaid = computed(() => renderedHtml.value.includes('mermaid'))
// KaTeX is the same story: math only reaches the DOM as `.katex-shell` spans
// emitted by the markdown-it math rules (utils/markdown.ts), and renderKatex
// acts on nothing else — so this substring scan is an exact gate, and a false
// positive (the literal string in prose) costs one querySelectorAll walk. The
// unconditional renderKatex used to walk the whole message root on every
// streaming flush even for math-free answers.
const hasKatex = computed(() => renderedHtml.value.includes('katex-shell'))
// Workspace media renders as file cards (Phase C); no hydration gate.
const hasCode = computed(() => renderedHtml.value.includes('<pre'))

watch(() => props.blockHtmls, (blocks) => {
  // Block mode: the parent's per-block renders own the pipeline — no
  // whole-string toolbar pass, no whole-message template parse on flush.
  if (blocks) updateRenderedBlocks(blocks)
}, { immediate: true })

watch(() => props.html, (html) => {
  if (props.blockHtmls) return // block mode above owns renderedHtml
  resetBlockMode()
  renderedHtml.value = renderCodeBlockToolbarHtml(html, labels)
}, { immediate: true })

async function flush() {
  await nextTick()
  const target = root.value
  if (!target) return
  if (props.blockHtmls) {
    reconcileBlockChildren(target, props.blockHtmls)
  } else if (target.childNodes.length === 0) {
    target.innerHTML = renderedHtml.value
  } else {
    reconcileTopLevelChildren(target, renderedHtml.value)
  }
  applyTailFade(target, props.tailFadeCount)
  // While the message streams, defer both hydration passes. The reconcile
  // replaces the growing mermaid/math shells on every flush, so an
  // unterminated fence re-ran mermaid.render() (parse + layout, main thread)
  // per frame — and the renderer's `loading`+same-source skip (mermaid-
  // renderer.ts) can never hold while the source keeps growing. The raw
  // shells (fence source as a code block, raw TeX) stay visible meanwhile —
  // honest streaming text, no placeholder UI. The streaming watch below runs
  // both passes exactly once over the complete HTML when the message settles.
  if (!props.streaming) {
    if (hasMermaid.value) void renderMermaidDiagrams(target)
    if (hasKatex.value) void renderKatex(target)
    // Syntax highlighting joins the same settle-time hydration family: the
    // streaming reconcile would replace a growing fence's code node every
    // frame, so tokenizing live is per-frame work. Plain code IS honest
    // streaming text; color lands once, at settle (mermaid/KaTeX rule).
    if (hasCode.value) void renderCodeHighlights(target)
  }
  // Embed-cited visual assets (image/SVG/html) render as bare `<span
  // class="md-media-frame" data-workspace-src>` placeholders; build the bar
  // immediately and mount the body content (img / iframe) when the frame
  // scrolls into view (same lazy/cache discipline).
  hydrateInlineFrames(target)
}

// ── Inline media lightbox state ─────────────────────────────────────────────
// The hydration itself (lazy blob loads, frames) lives in markdown-hydration.ts;
// what stays here is the lightbox state the click delegation fills.
const lightboxSrc = ref<string | null>(null)
const lightboxAlt = ref<string>('')
/** The lightboxed image's absolute Workspace path, when it resolves inside the
 *  workspace root — enables the lightbox's "open with default app" action. */
const lightboxExternal = ref<string | null>(null)

watch(renderedHtml, () => { void flush() })

watch(() => props.tailFadeCount, () => { void flush() })
// The owning message just settled: run the hydration passes deferred during
// streaming (see flush()). A mount that is ALREADY settled (history restore,
// projection swap to the settled id) never sees a true→false flip — streaming
// is false from the first flush, which hydrates immediately as before.
watch(() => props.streaming, (streaming) => { if (!streaming) void flush() })

onMounted(() => { void flush() })

// ── Workspace file cards ─────────────────────────────────────────────────
//
// markdown.ts now emits a compact `<span class="file-card"
// data-workspace-src=... data-file-kind=...>` for Workspace-relative media
// (images / SVG / HTML) instead of an inline img/iframe placeholder. The old
// behavior auto-loaded the bytes and swapped in a full-size image/iframe —
// the surface that made large figures blow up the transcript. The card is a
// non-loaded anchor: it renders an icon + basename + kind badge and opens the
// file on click. The bytes are read only when the user chooses to preview.
//
// Opening is delegated through `emit('open-file', { path, kind })` to the
// parent (AgentPage), which routes it to the inspector's Files tab
// (primary) or the document area (secondary). MarkdownContent owns no document
// routing — that is `documents.ts`'s job.

// ── Event delegation ─────────────────────────────────────────────────────────

function handleCodeBlockToolbarClick(event: MouseEvent): boolean {
  const target = root.value
  const eventTarget = event.target
  if (!target || !(eventTarget instanceof Element)) return false

  const button = eventTarget.closest<HTMLButtonElement>('button[data-code-block-action]')
  if (!button || !target.contains(button)) return false

  const wrapper = button.closest<HTMLElement>('.code-block-wrap')
  if (!wrapper || !target.contains(wrapper)) return false

  event.preventDefault()
  event.stopPropagation()

  if (button.dataset.codeBlockAction === 'wrap') {
    const active = wrapper.dataset.wrap === 'true'
    wrapper.dataset.wrap = active ? 'false' : 'true'
    button.dataset.active = active ? 'false' : 'true'
    button.setAttribute('aria-pressed', active ? 'false' : 'true')
    return true
  }

  if (button.dataset.codeBlockAction === 'copy') {
    const pre = wrapper.querySelector('pre')
    const code = pre?.querySelector('code')
    const text = code ? code.textContent : pre?.textContent
    void navigator.clipboard?.writeText?.(text || '').then(() => {
      button.dataset.copied = 'true'
      button.title = labels.copied
      button.setAttribute('aria-label', labels.copied)
      setTimeout(() => {
        button.dataset.copied = 'false'
        button.title = labels.copy
        button.setAttribute('aria-label', labels.copy)
      }, 1500)
    })
    return true
  }

  return false
}

/**
 * Handle a click (or Enter/Space via onKeydown) on a file card emitted by
 * markdown.ts. The card is a non-loaded anchor for Workspace media; opening it
 * routes through the parent, which decides inspector-preview vs document-area.
 * Returns true when the event was on a card and should not fall through to
 * anchor/code handling.
 */
function fileCardFromEvent(event: Event): HTMLElement | null {
  const target = root.value
  const eventTarget = event.target
  if (!target || !(eventTarget instanceof Element)) return null
  const card = eventTarget.closest<HTMLElement>('.file-card[data-workspace-src]')
  if (!card || !target.contains(card)) return null
  return card
}

function emitFileOpen(card: HTMLElement): void {
  const path = card.getAttribute('data-workspace-src')
  const kind = card.getAttribute('data-file-kind')
  const name = card.getAttribute('data-file-name') ?? ''
  if (!path) return
  const normalized: FileCardKind =
    kind === 'svg' || kind === 'html' || kind === 'table' || kind === 'json' || kind === 'text' || kind === 'file'
      ? (kind as FileCardKind)
      : 'image'
  emit('open-file', { path, kind: normalized, name })
}

function handleFileCardClick(event: MouseEvent): boolean {
  const card = fileCardFromEvent(event)
  if (!card) return false
  event.preventDefault()
  emitFileOpen(card)
  return true
}

/**
 * Click on an inline HTML frame's action bar: the file name opens the sidebar
 * viewer (the same open-file route a card takes); the "default app"
 * button hands the file to the OS association, guarded by the same
 * in-workspace path check as anchor navigation. Returns true when the click
 * was inside a frame bar.
 */
function handleFrameBarClick(event: MouseEvent): boolean {
  const target = root.value
  const eventTarget = event.target
  if (!target || !(eventTarget instanceof Element)) return false
  const external = eventTarget.closest<HTMLElement>('.md-media-frame__external')
  if (external) {
    const frame = external.closest<HTMLElement>('.md-media-frame[data-workspace-src]')
    if (frame && target.contains(frame)) {
      event.preventDefault()
      openFrameExternally(frame)
      return true
    }
  }
  const name = eventTarget.closest<HTMLElement>('.md-media-frame__name')
  if (name) {
    const frame = name.closest<HTMLElement>('.md-media-frame[data-workspace-src]')
    if (frame && target.contains(frame)) {
      event.preventDefault()
      emitFileOpen(frame)
      return true
    }
  }
  return false
}

function openFrameExternally(frame: HTMLElement): void {
  const path = frame.getAttribute('data-workspace-src')
  if (!path) return
  let rootPath: string | undefined
  try { rootPath = useWorkspaceStore().workspacePath ?? undefined } catch { rootPath = undefined }
  const absolute = rootPath ? workspaceFileHref(rootPath, path) : null
  if (!absolute) return
  void getDesktopFileOps().openExternal(absolute).catch(() => undefined)
}

/**
 * Click on a viz frame's image opens the fullscreen lightbox (zoom/pan). The
 * img only exists once the frame hydrated (its bytes are in — the src is
 * always set), so this never needs an on-demand load path. Returns true when
 * the click was on a frame image and was handled.
 */
function handleInlineMediaClick(event: MouseEvent): boolean {
  const target = root.value
  const eventTarget = event.target
  if (!target || !(eventTarget instanceof Element)) return false
  const img = eventTarget.closest<HTMLImageElement>('img.md-media-frame__img[data-workspace-src]')
  if (!img || !target.contains(img)) return false
  event.preventDefault()
  lightboxAlt.value = img.getAttribute('alt') ?? ''
  const path = img.getAttribute('data-workspace-src')
  let rootPath: string | undefined
  try { rootPath = useWorkspaceStore().workspacePath ?? undefined } catch { rootPath = undefined }
  lightboxExternal.value = path && rootPath ? workspaceFileHref(rootPath, path) : null
  const src = img.getAttribute('src')
  if (src) lightboxSrc.value = src
  return true
}

function onKeydown(event: KeyboardEvent): void {
  // Activate file cards and frame names from the keyboard
  // (role="button", tabindex="0").
  if (event.key !== 'Enter' && event.key !== ' ') return
  const card = fileCardFromEvent(event)
  if (card) {
    event.preventDefault()
    emitFileOpen(card)
    return
  }
  const frameName = event.target instanceof Element
    ? event.target.closest<HTMLElement>('.md-media-frame__name')
    : null
  if (frameName) {
    event.preventDefault()
    const frame = frameName.closest<HTMLElement>('.md-media-frame[data-workspace-src]')
    if (frame) emitFileOpen(frame)
  }
}

function findAnchor(event: MouseEvent): HTMLAnchorElement | null {
  const target = root.value
  const eventTarget = event.target
  if (!target || !(eventTarget instanceof Element)) return null
  const anchor = eventTarget.closest<HTMLAnchorElement>('a[href]')
  if (!anchor || !target.contains(anchor)) return null
  return anchor
}

/**
 * A Workspace-relative href may reach the host's file opener only when every
 * segment resolves INSIDE the workspace root — the opener runs whatever the
 * OS shell associates with the path, so a traversal (`../../..`) or an
 * absolute-looking href must never get there. Returns the joined path, or
 * null when the href escapes (caller then refuses the open).
 */
function workspaceFileHref(rootPath: string, href: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(href) } catch { return null }
  const segments = decoded.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return null
  return `${rootPath.replace(/[\\/]+$/, '')}/${segments.join('/')}`
}

function onClick(event: MouseEvent): void {
  if (handleCodeBlockToolbarClick(event)) return
  if (handleInlineMediaClick(event)) return
  if (handleFrameBarClick(event)) return
  if (handleFileCardClick(event)) return
  const anchor = findAnchor(event)
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''
  // In-page anchors (footnotes, heading links) use default browser navigation.
  if (href.startsWith('#')) return
  // Every anchor that reaches here carries a protocol URL (http/https/mailto/
  // tel — the sanitizer's href allowlist). The renderer cards Workspace file
  // links and wikis page links, so no workspace-relative href exists to route.
  event.preventDefault()
  try {
    if (typeof window !== 'undefined' && window.open) {
      window.open(href, '_blank', 'noopener,noreferrer')
    }
  } catch {
    /* ignore */
  }
}

function onContextMenu(event: MouseEvent): void {
  // No custom context menu in this port; let the browser show its default.
  void event
}

// ── Lifecycle: mermaid mutation observer ─────────────────────────────────────

let observer: MutationObserver | null = null

function isMermaidRenderMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element
    ? record.target
    : record.target.parentNode instanceof Element
      ? record.target.parentNode
      : null
  if (!target) return false
  if (target.closest('.mermaid-source code')) return false
  return !!target.closest('.mermaid-rendered, .mermaid-source-toolbar')
}

onMounted(() => {
  const target = root.value
  if (!target || typeof MutationObserver === 'undefined') return
  observer = new MutationObserver(records => {
    if (!hasMermaid.value) return
    // Streaming reconcile mutations must not re-arm the render pass — every
    // flush replaces nodes, so an ungated observer would re-run
    // mermaid.render() per frame and defeat the flush() deferral entirely.
    if (props.streaming) return
    if (records.length && records.every(isMermaidRenderMutation)) return
    if (hasMermaid.value) void renderMermaidDiagrams(target)
  })
  observer.observe(target, { childList: true, subtree: true, characterData: true })
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  if (root.value) disconnectHydration(root.value)
  // NOTE: no blob revocation here. The URLs live in the module-lifetime
  // media-blob-cache; revoking per-instance (the old behavior) forced every
  // virtualized remount to re-read the bytes and repaint the image from
  // scratch. The cache owns eviction.
})
</script>

<template>
  <div
    ref="root"
    class="md-content"
    :class="contentClass"
    @click="onClick"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
  />
  <MediaLightbox
    v-if="lightboxSrc"
    :src="lightboxSrc"
    :alt="lightboxAlt"
    :external-path="lightboxExternal ?? undefined"
    @close="lightboxSrc = null"
  />
</template>

<style scoped>
.md-content {
  font-size: var(--text-md);
  line-height: 1.65;
  color: var(--color-text);
  word-break: break-word;
}

/* Streaming flow: a block that APPENDED while the message was live eases in
   once (fade + short rise, transform/opacity only — the virtualizer's height
   measurement is untouched). Replaced blocks never get the class, so the
   block under active streaming cannot strobe. Reduced motion: no entrance,
   the block is simply there. */
.md-content :deep(.md-enter) {
  animation: md-block-in 240ms var(--ease-out, ease-out) both;
}
@keyframes md-block-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .md-content :deep(.md-enter) { animation: none; }
}

.md-content :deep(img) {
  max-width: 100%;
}

/* The unified viz frame — the ONE inline surface for embed-cited visual
   assets (image / SVG / html; markdown.ts emits the same placeholder for
   all three). A slim bar — the name opens the sidebar viewer, the button
   hands the file to the OS default app — over a body that ALWAYS auto-fits
   its content (full width, natural height — nothing hidden):

   image/svg → `<img>` at width:100%, height:auto. The intrinsic aspect
   ratio is cached per path and re-applied on virtualized remounts, so a
   rebuilt frame is born the right height (the remount discipline below);
   the very first load grows once when the bytes arrive.

   html → the fit runtime inside the sandboxed frame posts its settled
   height, the parent sizes the iframe to it and CACHES the value per path
   so virtualized remounts restore it synchronously — the remount
   reset→grow cycle was the flicker; a born-right box cannot cycle. Until
   the first report the 360px reserve stands. Internal scrolling remains
   only as the clamp fallback for pathological heights. */
.md-content :deep(.md-media-frame) {
  display: block;
  margin: var(--space-2, 8px) 0;
  border: var(--line-w) solid var(--line-seam);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary, #f5f5f5);
  overflow: hidden;
}
.md-content :deep(.md-media-frame__bar) {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  padding: var(--space-1, 4px) var(--space-2, 8px);
  border-bottom: var(--line-w) solid var(--line-seam);
  background: var(--color-bg-hover, #ececec);
}
.md-content :deep(.md-media-frame__name) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  color: var(--color-text);
  cursor: pointer;
}
.md-content :deep(.md-media-frame__name:hover) { color: var(--color-interact-text); }
.md-content :deep(.md-media-frame__name:focus-visible) {
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
  border-radius: var(--radius-xs);
}
.md-content :deep(.md-media-frame__external) {
  margin-left: auto;
  flex: none;
  border: none;
  background: none;
  cursor: pointer;
  font-size: var(--text-label);
  font-family: var(--font-body);
  color: var(--color-text-muted);
  padding: var(--space-1, 4px) var(--space-2, 8px);
  border-radius: var(--radius-xs);
}
.md-content :deep(.md-media-frame__external:hover) {
  color: var(--color-text);
  background: var(--color-border);
}
.md-content :deep(.md-media-frame__body) {
  display: block;
  /* Every kind auto-fits: the body wraps its content's height instead of
     cropping it behind a scroll. */
  height: auto;
}
.md-content :deep(.md-media-frame__doc) {
  display: block;
  width: 100%;
  /* Reserve until the first height report; the reported or cached height
     lands as an inline style that overrides this. */
  height: 360px;
  border: 0;
  /* Embedded docs may assume a page canvas; use the neutral panel surface. */
  background: var(--color-bg-secondary, #f5f5f5);
}
.md-content :deep(.md-media-frame__img) {
  display: block;
  /* Full width, natural height — the figure reads at the transcript's own
     measure. A cached aspect-ratio (inline style, markdown-hydration)
     reserves the right height on virtualized remounts before the bytes
     repaint. */
  width: 100%;
  height: auto;
  border-radius: 0;
  cursor: zoom-in;
}
.md-content :deep(.md-media-frame[data-frame-failed='true'] .md-media-frame__body) {
  /* Read failed (missing file) — collapse the reserved body; the bar with its
     two actions remains. */
  display: none;
}

/* Headings */
.md-content :deep(h1) { font-size: 1.5em; font-weight: 600; margin: 0.8em 0 0.4em; }
.md-content :deep(h2) { font-size: 1.3em; font-weight: 600; margin: 0.7em 0 0.35em; }
.md-content :deep(h3) { font-size: 1.15em; font-weight: 600; margin: 0.6em 0 0.3em; }
.md-content :deep(h4),
.md-content :deep(h5),
.md-content :deep(h6) { font-size: 1em; font-weight: 600; margin: 0.5em 0 0.25em; }

/* Paragraphs */
.md-content :deep(p) { margin: 0 0 var(--space-2); }
.md-content :deep(p:last-child) { margin-bottom: 0; }
.md-content :deep(strong) { font-weight: 600; }
.md-content :deep(em) { font-style: italic; }
.md-content :deep(mark) { background: var(--color-warning-soft); padding: 0 var(--space-1-5); border-radius: var(--radius-xs); }

/* Links */
.md-content :deep(a) { color: var(--color-interact-text); text-decoration: none; }
.md-content :deep(a:hover) { text-decoration: underline; }

/* Lists */
.md-content :deep(ul),
.md-content :deep(ol) { margin: 0 0 var(--space-2); padding-left: 1.5em; }
.md-content :deep(li) { margin: var(--space-1-5) 0; }
.md-content :deep(li > ul),
.md-content :deep(li > ol) { margin: var(--space-1-5) 0; }

/* Task lists */
.md-content :deep(.contains-task-list) { list-style: none; padding-left: 0.5em; }
.md-content :deep(.task-list-item) { display: flex; align-items: flex-start; gap: var(--space-1-5); }
.md-content :deep(.task-list-item-checkbox) { margin-top: 3px; }

/* Inline code */
.md-content :deep(code) {
  background: var(--color-bg);
  /* tde-amber already passes AA per-color across all four themes; use semantic warning directly */
  color: var(--color-warning-text);
  padding: 1px var(--space-1);
  border-radius: var(--radius-xs);
  font-family: var(--font-mono);
  font-size: var(--text-base);
}

/* Code block wrap + toolbar */
.md-content :deep(.code-block-wrap) {
  position: relative;
  margin: var(--space-2) 0;
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  overflow: hidden;
}
.md-content :deep(.code-block-wrap pre) {
  margin: 0;
  padding: var(--space-3);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--color-text);
}
.md-content :deep(.code-block-wrap[data-wrap="true"] pre) {
  white-space: pre-wrap;
  word-break: break-word;
}
.md-content :deep(.code-block-wrap pre code) {
  background: none;
  color: inherit;
  padding: 0;
  font-size: inherit;
}
/* Code block head bar (VSCode/PI-Desktop convention): the language names the
   block on the left; wrap/copy sit on the right. Buttons stay in the head so
   the pre's scroll area is all code. */
.md-content :deep(.code-block-head) {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  border-bottom: var(--line-w) solid var(--line-hairline);
  background: var(--color-bg-hover);
}
.md-content :deep(.code-block-lang) {
  margin-right: auto;
  font-family: var(--font-mono);
  font-size: var(--text-label);
  text-transform: lowercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  user-select: none;
}
.md-content :deep(.code-block-action) {
  border: none;
  background: none;
  cursor: pointer;
  font-size: var(--text-label);
  font-family: var(--font-body);
  color: var(--color-text-muted);
  padding: var(--space-1) var(--space-1-5);
  border-radius: var(--radius-xs);
}
.md-content :deep(.code-block-action:hover) { color: var(--color-text); background: var(--color-border); }
.md-content :deep(.code-block-action[data-active="true"]) { color: var(--color-interact-text); }
.md-content :deep(.code-block-action[data-copied="true"]) { color: var(--color-success-text); }

/* Blockquote + callouts */
/* A quote rule is a typographic convention, not a brand moment: 1px neutral,
   not 3px primary. Quoting someone is not an accent colour. */
.md-content :deep(blockquote) {
  /* Typographic type-marker stripe: contract width, seam color. */
  border-left: var(--line-stripe-w) solid var(--line-seam);
  margin: var(--space-2) 0;
  padding: var(--space-1) var(--space-3);
  color: var(--color-text-secondary);
}
/* A callout IS a card, so it gets a card's full border and a tinted surface —
   the side stripe it used to carry is the generated-interface tell. */
.md-content :deep(.markdown-callout) {
  margin: var(--space-2) 0;
  padding: var(--space-2) var(--space-3);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}
.md-content :deep(.markdown-callout-title) {
  font-weight: 600;
  margin-bottom: var(--space-1);
}
.md-content :deep(.markdown-callout-note)     { border-left-color: var(--color-primary); }
.md-content :deep(.markdown-callout-info)     { border-left-color: var(--color-primary); }
.md-content :deep(.markdown-callout-tip)      { border-left-color: var(--color-success-text); }
.md-content :deep(.markdown-callout-success)  { border-left-color: var(--color-success-text); }
.md-content :deep(.markdown-callout-warning)  { border-left-color: var(--color-warning-text); }
.md-content :deep(.markdown-callout-caution)  { border-left-color: var(--color-warning-text); }
.md-content :deep(.markdown-callout-danger)   { border-left-color: var(--color-error-text); }
.md-content :deep(.markdown-callout-error)    { border-left-color: var(--color-error-text); }
.md-content :deep(.markdown-callout-question) { border-left-color: var(--color-warning-text); }
.md-content :deep(.markdown-callout-failure)  { border-left-color: var(--color-error-text); }
.md-content :deep(.markdown-callout-bug)      { border-left-color: var(--color-error-text); }
.md-content :deep(.markdown-callout-example)  { border-left-color: var(--color-primary); }
.md-content :deep(.markdown-callout-quote)    { border-left-color: var(--line-hairline); }
.md-content :deep(.markdown-callout-abstract) { border-left-color: var(--color-primary); }

/* Table */
.md-content :deep(.markdown-table-scroll) {
  overflow-x: auto;
  margin: var(--space-2) 0;
}
.md-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--text-sm);
}
.md-content :deep(th),
.md-content :deep(td) {
  border: var(--line-w) solid var(--line-hairline);
  padding: var(--space-1) var(--space-2);
  text-align: left;
}
.md-content :deep(th) { background: var(--color-bg); font-weight: 600; }

/* Horizontal rule */
.md-content :deep(hr) {
  border: none;
  border-top: var(--line-w) solid var(--line-hairline);
  margin: var(--space-3) 0;
}

/* Images */
.md-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-sm);
}
/*
  Workspace file cards (Phase C of the palot migration).
  A compact, non-loaded anchor for Workspace media the Agent produced: icon +
  basename + kind badge. The bytes are NOT loaded at render time — the card
  opens the file on click (inspector Files preview or document area). This
  replaces the old auto-inline img/iframe hydration that blew up large figures
  inside the transcript flow.
*/
.md-content :deep(.file-card) {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  max-width: 100%;
  margin: var(--space-1) 0;
  padding: var(--space-1-5) var(--space-2);
  border: var(--line-w) solid var(--line-seam);
  border-left: var(--line-stripe-w) solid var(--domain-file);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: var(--text-sm);
  cursor: pointer;
  user-select: none;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.md-content :deep(.file-card:hover),
.md-content :deep(.file-card:focus-visible) {
  background: var(--color-bg-hover);
  border-color: var(--color-border-control-hover);
  outline: none;
}
.md-content :deep(.file-card:focus-visible) {
  box-shadow: var(--shadow-focus);
}
/* Kind badge colors the left border so the type reads without the label. */
.md-content :deep(.file-card[data-file-kind="svg"]) { border-left-color: var(--domain-ptm); }
.md-content :deep(.file-card[data-file-kind="html"]) { border-left-color: var(--domain-protein); }
.md-content :deep(.file-card__icon) {
  width: var(--space-4);
  height: var(--space-4);
  flex-shrink: 0;
  background: var(--color-text-muted);
  -webkit-mask: radial-gradient(circle, currentColor 18%, transparent 22%) center / 10px 10px no-repeat;
  mask: radial-gradient(circle, currentColor 18%, transparent 22%) center / 10px 10px no-repeat;
}
.md-content :deep(.file-card__name) {
  font-family: var(--font-mono);
  font-size: var(--text-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 32ch;
}
.md-content :deep(.file-card__kind) {
  flex-shrink: 0;
  margin-left: auto;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text-muted);
  font-size: var(--text-label);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
/* Kind badge colors for the data-file cards so the type reads without the label. */
.md-content :deep(.file-card[data-file-kind="table"]) { border-left-color: var(--domain-table); }
.md-content :deep(.file-card[data-file-kind="json"])  { border-left-color: var(--domain-json); }
.md-content :deep(.file-card[data-file-kind="text"])  { border-left-color: var(--domain-text); }

/* Workspace data-file cards (table / JSON / text). Always compact: markdown.ts
   emits a `.file-card` span (styling above), and the card never expands in
   flow — clicking it routes to the sidebar viewer, where the file renders as a
   real table / pretty JSON / capped text. */

/* Footnotes */
.md-content :deep(.footnotes) {
  margin-top: var(--space-4);
  padding-top: var(--space-2);
  border-top: var(--line-w) solid var(--line-hairline);
  font-size: var(--text-label);
  color: var(--color-text-muted);
}
.md-content :deep(.footnote-ref a),
.md-content :deep(.footnote-backref) { color: var(--color-interact-text); }

/* Mermaid */
.md-content :deep(.mermaid-diagram) {
  margin: var(--space-2) 0;
  padding: var(--space-2);
  border: var(--line-w) solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  text-align: center;
}
.md-content :deep(.mermaid-diagram svg) { max-width: 100%; height: auto; }
.md-content :deep(.mermaid-source) {
  margin: 0;
  text-align: left;
  font-family: var(--font-mono);
  font-size: var(--text-label);
}
.md-content :deep(.mermaid-source-toolbar) {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}
.md-content :deep(.mermaid-source-toggle),
.md-content :deep(.mermaid-source-copy) {
  border: none;
  background: none;
  cursor: pointer;
  font-size: var(--text-label);
  color: var(--color-text-muted);
}
.md-content :deep(.mermaid-source-toggle:hover),
.md-content :deep(.mermaid-source-copy:hover) { color: var(--color-interact-hover); }
.md-content :deep(.mermaid-diagram.is-error) { border-color: var(--color-error-text); }
.md-content :deep(.mermaid-rendered) { color: var(--color-error-text); font-size: var(--text-label); }

/* Streaming tail fade. The tail is a live channel, so its pulse is tinted
   with --color-live (The Living Channel Rule): the arriving text reads as the
   same luminous teal as the running StatusMark and the page edge indicator. */
.md-content :deep(.stream-tail-chunk) {
  color: var(--color-live);
  opacity: 0.55;
  /* No filter: blur() here — even 0.3px rasterizes the live text off the
     pixel grid and reads as low-quality rendering; the pulse animation below
     already carries the "live channel" signal via opacity. */
  animation: stream-tail-pulse 1.2s ease-in-out infinite;
}
@keyframes stream-tail-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 0.85; }
}
/* Reduced motion: stop the pulse at a legible opacity instead of letting the
   global `*` rule (animation-duration: 0.01ms) freeze the tail chunk at the
   0% keyframe's 0.55 — which on its own reads as "half-faded forever". Hold
   it at the midpoint opacity so the streaming tail stays visible. */
@media (prefers-reduced-motion: reduce) {
  .md-content :deep(.stream-tail-chunk) {
    animation: none;
    opacity: 0.85;
    filter: none;
  }
}

/* KaTeX */
.md-content :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
  padding: var(--space-1) 0;
}
</style>
