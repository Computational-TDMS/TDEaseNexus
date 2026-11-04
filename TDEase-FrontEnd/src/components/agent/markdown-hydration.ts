/**
 * markdown-hydration — the DOM passes MarkdownContent runs after each
 * streaming reconcile, as plain functions over an HTMLElement root:
 *
 *   applyTailFade       — the streaming tail's luminous pulse
 *   hydrateInlineFrames — the unified viz frame: embed-cited image/SVG/html
 *                         assets, lazy bytes on scroll-in, one presentation
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
import { injectHtmlFit, FRAME_HEIGHT_MESSAGE } from '@/utils/html-fit'
import { collectThemeVars, isHtmlFragment, wrapHtmlFragment } from '@/utils/fragment-wrap'
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

// ── The unified viz frame (embed-cited image / SVG / html) ─────────────────
//
// markdown.ts emits ONE inline placeholder for every embed-cited visual
// asset: `<span class="md-media-frame" data-workspace-src=… data-file-kind=
// image|svg|html>`. Hydration is lazy (IntersectionObserver on scroll-in)
// and blob-deduped per path in media-blob-cache; the bar builds immediately
// — the file name opens the sidebar viewer, the button hands the file to
// the OS's default app. The body mounts when the bytes are in:
//
//   image/svg → `<img>` (click → MediaLightbox zoom/pan) at FULL WIDTH with
//               NATURAL height (width 100%, height auto) — the figure reads
//               at the transcript's own measure, nothing letterboxed away.
//               The intrinsic aspect ratio is remembered per path and
//               re-applied on rebuild, so a remounted frame is born the
//               right height.
//   html      → sandboxed iframe (interactive) that AUTO-FITS its content:
//               the fit runtime inside posts the settled height
//               (utils/html-fit) and the parent sizes the iframe to it —
//               a report is never hidden behind a scroll. FRAGMENT bytes
//               (no doctype/<html>) serve wrapped — themed, offline-CSP'd
//               (utils/fragment-wrap); full documents serve width-fitted.
//
// The flicker that once killed height-following is not the following — it
// is the remount reset→grow cycle: the transcript virtualizer unmounts and
// remounts rows on scroll, and a frame whose height restarts unknown every
// remount re-shifts the whole list. Every reported height is therefore
// CACHED per path (module-lifetime, the same discipline as the blob cache)
// and reserved on the frame's BODY at chrome-build time — the same
// synchronous pass that creates the bar, before the virtualizer measures —
// so a rebuilt row is born at its final height and the lazy iframe mount
// that follows lands at the same value (zero box change). Only the very
// first load grows once (like image bytes arriving). Internal scrolling
// stays as the clamp fallback.

const frameObservers = new WeakMap<HTMLElement, IntersectionObserver>()

/** Settled frame heights keyed by mediaCacheKey — see the block comment. */
const frameHeightCache = new Map<string, number>()

/** Intrinsic aspect ratios ("w/h") for image/svg frames, same key and
 *  discipline: once known, a rebuilt frame is born with the right box. */
const frameAspectCache = new Map<string, string>()

function rememberImageAspect(key: string, img: HTMLImageElement): void {
  const capture = () => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      frameAspectCache.set(key, `${img.naturalWidth}/${img.naturalHeight}`)
    }
  }
  if (img.complete) capture()
  else img.addEventListener('load', capture, { once: true })
}

let frameHeightListenerInstalled = false

/** Window event fired whenever an embedded frame's box actually changes
 *  (body mounts, settled height lands). The transcript treats scrolls within
 *  a short grace after it as virtualizer compensation, not reader intent —
 *  the compensation must not unpin a following tail (markdown-hydration and
 *  Transcript stay coupled to this one literal, FRAME_HEIGHT_MESSAGE-style). */
export const FRAME_LAYOUT_SHIFT_EVENT = 'tdz:frame-layout-shift'

function notifyFrameLayoutShift(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(FRAME_LAYOUT_SHIFT_EVENT))
}

function installFrameHeightListener(): void {
  if (frameHeightListenerInstalled || typeof window === 'undefined') return
  frameHeightListenerInstalled = true
  window.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; h?: unknown } | null
    if (!data || data.type !== FRAME_HEIGHT_MESSAGE) return
    const h = Number(data.h)
    if (!Number.isFinite(h) || h <= 0) return
    const clamped = Math.min(Math.max(Math.round(h), 140), 10_000)
    for (const iframe of document.querySelectorAll<HTMLIFrameElement>('iframe.md-media-frame__doc')) {
      if (iframe.contentWindow !== event.source) continue
      const px = `${clamped}px`
      // Repeated reports of the same settled height are no-ops: no style
      // write, no shift event, nothing for the virtualizer to compensate.
      if (iframe.style.height === px) continue
      iframe.style.height = px
      const frameEl = iframe.closest<HTMLElement>('.md-media-frame')
      frameEl?.setAttribute('data-frame-live', 'true')
      const path = frameEl?.getAttribute('data-workspace-src')
      if (path) {
        let rootPath: string | undefined
        try { rootPath = useWorkspaceStore().workspacePath ?? undefined } catch { rootPath = undefined }
        if (rootPath) frameHeightCache.set(mediaCacheKey(rootPath, path), clamped)
      }
      notifyFrameLayoutShift()
    }
  })
}

/** Build the action bar + body shell once per frame; the body fills lazily. */
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
  reserveCachedFrameHeight(frame, body)
}

/** A rebuilt html frame is born the right height: the cached settled height
 *  becomes the body's inline reserve in the SAME synchronous pass that builds
 *  the chrome — before the virtualizer's ResizeObserver can measure — so a
 *  virtualized remount never cycles collapsed→grown (the shrink then grow was
 *  twice-compensated scroll jump). The lazy mount that follows swaps the
 *  reserve for an iframe at the same height: zero box change. Images need no
 *  reserve; their cached aspect-ratio applies at img creation (the same
 *  born-right discipline). */
function reserveCachedFrameHeight(frame: HTMLElement, body: HTMLElement): void {
  if (frame.getAttribute('data-file-kind') !== 'html') return
  const path = frame.getAttribute('data-workspace-src')
  if (!path) return
  let rootPath: string | undefined
  try { rootPath = useWorkspaceStore().workspacePath ?? undefined } catch { rootPath = undefined }
  if (!rootPath) return
  const cached = frameHeightCache.get(mediaCacheKey(rootPath, path))
  if (cached === undefined) return
  body.style.height = `${cached}px`
  frame.setAttribute('data-frame-live', 'true')
}

function frameIframe(frame: HTMLElement, url: string, height?: number): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.className = 'md-media-frame__doc'
  // The one sandbox policy for every embedded HTML document (MediaViewer's).
  // No allow-same-origin: the blob URL inherits this app's origin, so a framed
  // file could reach parent DOM and strip its own sandbox. Opaque origin
  // still runs the inline scripts the files ship with (data is embedded).
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.title = frame.getAttribute('data-file-name') || ''
  iframe.src = url
  // Cached settled height: the box is born the right size, before the
  // virtualizer measures — the remount flicker fix.
  if (height !== undefined) {
    iframe.style.height = `${height}px`
    frame.setAttribute('data-frame-live', 'true')
  }
  return iframe
}

function frameImage(frame: HTMLElement, url: string, aspect?: string): HTMLImageElement {
  const img = document.createElement('img')
  img.className = 'md-media-frame__img'
  img.dataset.workspaceSrc = frame.getAttribute('data-workspace-src') || ''
  img.alt = frame.getAttribute('aria-label') || ''
  // Full width, natural height. A cached aspect-ratio makes the box right at
  // creation (the remount discipline); without one the height settles when
  // the bytes arrive — one growth, then remembered.
  if (aspect) img.style.aspectRatio = aspect
  img.src = url
  return img
}

function applyFrameSrc(
  target: HTMLElement,
  path: string,
  kind: string,
  url: string,
  key: string,
  height?: number,
  aspect?: string,
): void {
  for (const frame of target.querySelectorAll<HTMLElement>('span.md-media-frame[data-workspace-src]')) {
    if (frame.getAttribute('data-workspace-src') !== path) continue
    const body = frame.querySelector<HTMLElement>('.md-media-frame__body')
    if (!body || body.firstElementChild) continue
    if (kind === 'html') {
      body.replaceChildren(frameIframe(frame, url, height))
    } else {
      const img = frameImage(frame, url, aspect)
      body.replaceChildren(img)
      rememberImageAspect(key, img)
    }
    // The mounted content owns the box now: drop the chrome-time height
    // reserve, and let the transcript know the frame's box just changed
    // (first-reveal growth — the one growth a never-seen frame still has).
    body.style.height = ''
    notifyFrameLayoutShift()
  }
}

function markFrameFailed(target: HTMLElement, path: string): void {
  for (const frame of target.querySelectorAll<HTMLElement>('span.md-media-frame[data-workspace-src]')) {
    if (frame.getAttribute('data-workspace-src') === path) frame.dataset.frameFailed = 'true'
  }
}

async function loadFrameBody(target: HTMLElement, frame: HTMLElement): Promise<void> {
  const path = frame.getAttribute('data-workspace-src')
  const kind = frame.getAttribute('data-file-kind') || 'image'
  const body = frame.querySelector<HTMLElement>('.md-media-frame__body')
  if (!path || !body || body.firstElementChild) return
  let rootPath: string | undefined
  try { rootPath = useWorkspaceStore().workspacePath ?? undefined } catch { rootPath = undefined }
  if (!rootPath) return
  const key = mediaCacheKey(rootPath, path)
  const cachedHeight = frameHeightCache.get(key)
  const cachedAspect = frameAspectCache.get(key)
  const cached = cachedMediaBlob(key)
  if (cached) { applyFrameSrc(target, path, kind, cached, key, cachedHeight, cachedAspect); return }
  if (mediaLoadInFlight(key)) return
  beginMediaLoad(key)
  try {
    const blob = await readWorkspaceBlob(rootPath, path)
    let url: string
    if (kind === 'html') {
      // Documents serve width-fitted; fragments serve wrapped — theme
      // snapshot, offline CSP. Both ship the height-reporting runtime.
      const text = await blob.text()
      const served = isHtmlFragment(text)
        ? wrapHtmlFragment(text, collectThemeVars())
        : injectHtmlFit(text)
      url = URL.createObjectURL(new Blob([served], { type: blob.type || 'text/html' }))
    } else {
      url = URL.createObjectURL(blob)
    }
    cacheMediaBlob(key, url)
    applyFrameSrc(target, path, kind, url, key, cachedHeight, cachedAspect)
  } catch {
    markFrameFailed(target, path)
  } finally {
    endMediaLoad(key)
  }
}

/** Build chrome for new frames and observe their bodies — the body content
 *  mounts when the frame scrolls into view. */
export function hydrateInlineFrames(target: HTMLElement): void {
  installFrameHeightListener()
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

/** Release the observers bound to this root (the component's unmount). The
 *  blob cache is deliberately NOT revoked — it is module-lifetime so
 *  virtualized remounts repaint without re-reading bytes. */
export function disconnectHydration(target: HTMLElement): void {
  frameObservers.get(target)?.disconnect()
  frameObservers.delete(target)
}
