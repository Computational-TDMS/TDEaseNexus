/**
 * markdown-hydration — the three DOM passes MarkdownContent runs after each
 * streaming reconcile, as plain functions over an HTMLElement root:
 *
 *   applyTailFade       — the streaming tail's luminous pulse
 *   hydrateInlineMedia  — image/SVG figures, lazy blob loads per workspace path
 *   hydrateInlineFrames — embed-cited .html files (action bar + lazy iframe)
 *
 * Extracted from MarkdownContent.vue verbatim: none of them touch Vue
 * reactivity — they walk and mutate DOM, debounce through the shared
 * media-blob-cache, and are safe to call repeatedly on the same root. The
 * component keeps only the render/reconcile orchestration and the lightbox
 * state. IntersectionObservers are module-lifetime, keyed by target root in
 * a WeakMap (replaced roots release theirs with the DOM).
 */
import { i18n } from '@/locales'
import { useWorkspaceStore } from '@/stores/workspace'
import { readWorkspaceBlob } from '@/services/workspace/desktopWorkspace'
import { injectHtmlFit } from '@/utils/html-fit'
import {
  beginMediaLoad,
  cachedMediaBlob,
  cacheMediaBlob,
  endMediaLoad,
  mediaCacheKey,
  mediaLoadInFlight,
} from './media-blob-cache'
import { splitGraphemes } from '@/utils/grapheme'

// ── Tail fade ────────────────────────────────────────────────────────────────
//
// The streaming tail gets a luminous pulse so arriving text reads as "live".
// The old implementation walked the whole subtree every frame, cleared every
// tail span (replaceWith textNode + normalize), then re-wrapped the last N
// graphemes — a destroy→rebuild cycle that painted as flicker. This version
// updates the EXISTING tail span's text in place when the count hasn't changed
// structurally, and only does a full re-wrap when the grapheme boundary moves
// to a different text node. Net effect: zero DOM churn on the common
// per-token-append path.

function shouldSkipTailFadeNode(node: Text): boolean {
  const parent = node.parentElement
  return !parent || !!parent.closest('pre, code, table, .katex, .mermaid, svg, button')
}

function clearTailFade(target: HTMLElement): void {
  const tailSpans = Array.from(target.querySelectorAll<HTMLElement>(
    '[data-stream-tail-char="true"], [data-stream-tail-chunk="true"]',
  ))
  for (const span of tailSpans) {
    span.replaceWith(document.createTextNode(span.textContent || ''))
  }
  if (tailSpans.length > 0) target.normalize()
}

export function applyTailFade(target: HTMLElement, count: number): void {
  // Fast path: if the same tail span from last frame still exists and its
  // text node just grew, update the span boundary in place — no clear, no
  // re-wrap, no normalize. This is the common streaming case (append to the
  // last text node). Only applies when count > 0; count 0 must fall through
  // to the full clear.
  const existing = count > 0
    ? target.querySelector<HTMLElement>('[data-stream-tail-chunk="true"]')
    : null
  if (existing) {
    // Find the tail span's text node and the text node just before it. If the
    // previous sibling text node grew (streaming append), move the boundary.
    const parent = existing.parentNode
    if (parent) {
      const prevSibling = existing.previousSibling
      if (prevSibling && prevSibling.nodeType === Node.TEXT_NODE) {
        const prevText = prevSibling as Text
        const tailText = existing.textContent || ''
        // The tail span holds the last `count` graphemes of (prevText + tailText).
        // Recompute: the combined text grew by the delta; re-split so the span
        // keeps holding exactly `count` trailing graphemes.
        const combined = (prevText.nodeValue ?? '') + tailText
        const segments = splitGraphemes(combined)
        if (segments.length >= count) {
          const splitAt = segments.length - count
          const newBefore = segments.slice(0, splitAt).join('')
          const newTail = segments.slice(splitAt).join('')
          if (prevText.nodeValue !== newBefore || tailText !== newTail) {
            prevText.nodeValue = newBefore
            existing.textContent = newTail
          }
          return
        }
      }
    }
  }

  // Slow path: full clear + re-wrap (first frame, or boundary crossed nodes).
  clearTailFade(target)
  if (count <= 0) return

  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let current = walker.nextNode()
  while (current) {
    const text = current as Text
    if (text.nodeValue && text.nodeValue.trim() && !shouldSkipTailFadeNode(text)) {
      textNodes.push(text)
    }
    current = walker.nextNode()
  }

  const tailNodes: Array<{ node: Text; segments: string[]; take: number }> = []
  let remaining = count
  for (let i = textNodes.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const node = textNodes[i]
    const segments = splitGraphemes(node.nodeValue || '')
    if (segments.length === 0) continue
    const take = Math.min(remaining, segments.length)
    tailNodes.push({ node, segments, take })
    remaining -= take
  }

  for (const item of tailNodes.reverse()) {
    const splitAt = item.segments.length - item.take
    const before = item.segments.slice(0, splitAt).join('')
    const tail = item.segments.slice(splitAt).join('')
    const fragment = document.createDocumentFragment()
    if (before) fragment.appendChild(document.createTextNode(before))
    if (tail) {
      const span = document.createElement('span')
      span.className = 'stream-tail-chunk'
      span.dataset.streamTailChunk = 'true'
      span.textContent = tail
      fragment.appendChild(span)
    }
    item.node.parentNode?.replaceChild(fragment, item.node)
  }
}

// ── Inline media hydration (image / SVG) ─────────────────────────────────────
//
// markdown.ts emits `<img class="md-media-inline" data-workspace-src="…">`
// (no src — the browser cannot load a relative workspace path). Each such img
// is loaded lazily: when it scrolls into view, the bytes are read once and a
// blob URL is swapped in. Object URLs are deduped per path (the model often
// re-cites the same figure across turns; one blob serves every occurrence) in
// the module-lifetime `media-blob-cache`, so virtualized remounts hydrate
// synchronously instead of re-reading bytes.

const mediaObservers = new WeakMap<HTMLElement, IntersectionObserver>()

/** Set the blob URL on every not-yet-hydrated img in this root that cites the
 *  path. The element the load started from may since have been replaced by the
 *  streaming reconcile, and sibling citations of the same figure hydrate
 *  together — one disk read, every occurrence. */
function applyMediaSrc(target: HTMLElement, path: string, url: string): void {
  for (const img of target.querySelectorAll<HTMLImageElement>('img.md-media-inline[data-workspace-src]')) {
    if (img.getAttribute('data-workspace-src') === path && !img.getAttribute('src')) img.src = url
  }
}

function markMediaFailed(target: HTMLElement, path: string): void {
  for (const img of target.querySelectorAll<HTMLImageElement>('img.md-media-inline[data-workspace-src]')) {
    if (img.getAttribute('data-workspace-src') === path) img.dataset.mediaFailed = 'true'
  }
}

async function loadMediaEl(target: HTMLElement, img: HTMLImageElement): Promise<void> {
  const path = img.getAttribute('data-workspace-src')
  if (!path || img.getAttribute('src')) return
  let rootPath: string | undefined
  try { rootPath = useWorkspaceStore().workspacePath ?? undefined } catch { rootPath = undefined }
  if (!rootPath) return
  const key = mediaCacheKey(rootPath, path)
  // Synchronous cache hit — the common path for a virtualized remount: the
  // img gets its bytes in the same frame it mounts, before the item is
  // measured, so the placeholder never paints as an empty box.
  const cached = cachedMediaBlob(key)
  if (cached) { img.src = cached; return }
  if (mediaLoadInFlight(key)) return
  beginMediaLoad(key)
  try {
    const blob = await readWorkspaceBlob(rootPath, path)
    const url = URL.createObjectURL(blob)
    cacheMediaBlob(key, url)
    applyMediaSrc(target, path, url)
  } catch {
    markMediaFailed(target, path)
  } finally {
    endMediaLoad(key)
  }
}

/** On-demand load for the lightbox path: a keyboard click can reach an img
 *  the lazy observer has not hydrated yet — load, then let the caller open. */
export function ensureMediaLoaded(target: HTMLElement, img: HTMLImageElement): Promise<void> {
  return loadMediaEl(target, img)
}

/** Release the observers bound to this root (the component's unmount). The
 *  blob cache is deliberately NOT revoked — it is module-lifetime so
 *  virtualized remounts repaint without re-reading bytes. */
export function disconnectHydration(target: HTMLElement): void {
  mediaObservers.get(target)?.disconnect()
  mediaObservers.delete(target)
  frameObservers.get(target)?.disconnect()
  frameObservers.delete(target)
}

/** Observe every not-yet-hydrated inline media img; load on intersect. */
export function hydrateInlineMedia(target: HTMLElement): void {
  const imgs = target.querySelectorAll<HTMLImageElement>('img.md-media-inline[data-workspace-src]:not([src])')
  if (imgs.length === 0) return
  if (typeof IntersectionObserver === 'undefined') {
    imgs.forEach((img) => { void loadMediaEl(target, img) })
    return
  }
  let observer = mediaObservers.get(target) ?? null
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const img = entry.target as HTMLImageElement
          observer?.unobserve(img)
          void loadMediaEl(target, img)
        }
      }
    }, { rootMargin: '120px' })
    mediaObservers.set(target, observer)
  }
  imgs.forEach((img) => observer!.observe(img))
}

// ── Inline HTML frame hydration (embed-cited .html files) ────────────────
//
// markdown.ts emits `<span class="md-media-frame" data-workspace-src=…>` for
// an embed-cited `.html` file. Hydration mirrors the image path — lazy via
// IntersectionObserver, blob deduped per path in media-blob-cache — but the
// action bar builds immediately: the file name opens the sidebar viewer and a
// button hands the file to the OS's default app. The iframe mounts into the
// body on scroll-in. It renders as HTML because the workspace byte reader
// stamps the blob's MIME from the extension.
//
// The served bytes pass through injectHtmlFit (utils/html-fit): the iframe is
// sandboxed with an opaque origin, so scale-to-width cannot be driven from
// this page — the fit script must ship inside the document. The cache holds
// the fitted blob, and every .html path is only ever consumed as a frame, so
// no raw-bytes consumer of this cache is affected.

const frameObservers = new WeakMap<HTMLElement, IntersectionObserver>()

/** Build the action bar + body once per frame; the iframe itself loads lazily. */
function buildFrameChrome(frame: HTMLElement): void {
  const t = i18n.global.t
  const name = frame.getAttribute('data-file-name') || ''
  const bar = document.createElement('span')
  bar.className = 'md-media-frame__bar'
  const title = document.createElement('span')
  title.className = 'md-media-frame__name'
  title.textContent = name
  title.setAttribute('role', 'button')
  title.setAttribute('tabindex', '0')
  title.title = t('agent.files.openInDocument')
  const external = document.createElement('button')
  external.type = 'button'
  external.className = 'md-media-frame__external'
  external.textContent = t('workbench.fileDocument.openExternalAction')
  const body = document.createElement('span')
  body.className = 'md-media-frame__body'
  bar.append(title, external)
  frame.append(bar, body)
}

function frameIframe(frame: HTMLElement, url: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.className = 'md-media-frame__doc'
  // The one sandbox policy for every embedded HTML document (MediaViewer's).
  // No allow-same-origin: the blob URL inherits this app's origin, so a framed
  // file could reach parent DOM and strip its own sandbox. Opaque origin
  // still runs the inline scripts the files ship with (data is embedded).
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.title = frame.getAttribute('data-file-name') || ''
  iframe.src = url
  return iframe
}

function applyFrameSrc(target: HTMLElement, path: string, url: string): void {
  for (const frame of target.querySelectorAll<HTMLElement>('span.md-media-frame[data-workspace-src]')) {
    if (frame.getAttribute('data-workspace-src') !== path) continue
    const body = frame.querySelector<HTMLElement>('.md-media-frame__body')
    if (body && !body.firstElementChild) body.replaceChildren(frameIframe(frame, url))
  }
}

function markFrameFailed(target: HTMLElement, path: string): void {
  for (const frame of target.querySelectorAll<HTMLElement>('span.md-media-frame[data-workspace-src]')) {
    if (frame.getAttribute('data-workspace-src') === path) frame.dataset.frameFailed = 'true'
  }
}

async function loadFrameBody(target: HTMLElement, frame: HTMLElement): Promise<void> {
  const path = frame.getAttribute('data-workspace-src')
  const body = frame.querySelector<HTMLElement>('.md-media-frame__body')
  if (!path || !body || body.firstElementChild) return
  let rootPath: string | undefined
  try { rootPath = useWorkspaceStore().workspacePath ?? undefined } catch { rootPath = undefined }
  if (!rootPath) return
  const key = mediaCacheKey(rootPath, path)
  const cached = cachedMediaBlob(key)
  if (cached) { applyFrameSrc(target, path, cached); return }
  if (mediaLoadInFlight(key)) return
  beginMediaLoad(key)
  try {
    const blob = await readWorkspaceBlob(rootPath, path)
    // Frame documents serve fitted: wide content scales to the frame width.
    const fitted = new Blob([injectHtmlFit(await blob.text())], { type: blob.type || 'text/html' })
    const url = URL.createObjectURL(fitted)
    cacheMediaBlob(key, url)
    applyFrameSrc(target, path, url)
  } catch {
    markFrameFailed(target, path)
  } finally {
    endMediaLoad(key)
  }
}

/** Build chrome for new frames and observe their bodies — the iframe mounts
 *  when the frame scrolls into view. */
export function hydrateInlineFrames(target: HTMLElement): void {
  const frames = Array.from(
    target.querySelectorAll<HTMLElement>('span.md-media-frame[data-workspace-src]:not([data-frame-hydrated])'),
  )
  if (frames.length === 0) return
  for (const frame of frames) {
    frame.dataset.frameHydrated = 'true'
    buildFrameChrome(frame)
  }
  if (typeof IntersectionObserver === 'undefined') {
    frames.forEach((frame) => { void loadFrameBody(target, frame) })
    return
  }
  let observer = frameObservers.get(target) ?? null
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const frame = entry.target as HTMLElement
          observer?.unobserve(frame)
          void loadFrameBody(target, frame)
        }
      }
    }, { rootMargin: '160px' })
    frameObservers.set(target, observer)
  }
  frames.forEach((frame) => observer!.observe(frame))
}
