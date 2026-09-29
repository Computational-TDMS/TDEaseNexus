/**
 * code-highlighter — lazy Shiki syntax highlighting for conversation code
 * blocks.
 *
 * Design (PI-Desktop parity, streaming-safe):
 *  - The highlighter is a lazily imported singleton using the JavaScript regex
 *    engine (no WASM download) with ZERO languages loaded at boot; each
 *    language grammar is loaded on first use. A page with no code blocks never
 *    pays for any of this.
 *  - `renderCodeHighlights(root)` is a post-flush hydration pass, exactly like
 *    mermaid/KaTeX: MarkdownContent calls it only when the message is NOT
 *    streaming, so each code block is tokenized once at settle time — never
 *    per streaming frame.
 *  - Only the `code` element's children are swapped; the surrounding
 *    `.code-block-wrap` DOM (head bar, toolbar, pre) is untouched, so toolbar
 *    event delegation and the wrap toggle keep working.
 *  - Colors are emitted as dual-theme CSS variables (`defaultColor: false`,
 *    catppuccin-latte / catppuccin-mocha) — the active `[data-theme]` picks
 *    the set in CSS. The highlighter itself stays theme-agnostic.
 *
 * Per-block state rides `data-code-highlighted` on the code element:
 *  absent → pending, "true" → done, "unsupported" → no grammar for the
 *  language (never retried, never an error surface).
 */
import type { Highlighter, BuiltinLanguage } from 'shiki'

type ShikiModule = typeof import('shiki')

let highlighterPromise: Promise<Highlighter | null> | null = null
const loadedLangs = new Set<string>()

/** Fences whose body is not a programming language — never tokenized. */
const PLAIN_LANGS = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'mermaid', 'console', 'output'])

async function getHighlighter(): Promise<Highlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const [shiki, engine]: [ShikiModule, typeof import('shiki/engine/javascript')] = await Promise.all([
          import('shiki'),
          import('shiki/engine/javascript'),
        ])
        return await shiki.createHighlighter({
          themes: ['catppuccin-latte', 'catppuccin-mocha'],
          langs: [],
          engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
        })
      } catch (error) {
        // A failed dynamic import (missing chunk, CSP) must not retry per
        // block — degrade to plain code forever, like a build without shiki.
        console.warn('[code-highlighter] shiki unavailable:', error)
        return null
      }
    })()
  }
  return highlighterPromise
}

/** `language-ts` / `lang-py` / bare `ts` → a shiki language id, or null. */
function langOf(code: Element): string | null {
  const match = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(code.className)
  const raw = (match?.[1] ?? '').toLowerCase()
  if (PLAIN_LANGS.has(raw)) return null
  return raw || null
}

/** The dual-theme variable names shiki emits when `defaultColor: false`. */
function highlightOptions(lang: string) {
  return {
    lang: lang as BuiltinLanguage,
    themes: { light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
    defaultColor: false as const,
  }
}

/**
 * Hydrate every not-yet-highlighted fenced code block under `root`. Safe to
 * call repeatedly (idempotent per block) and on detached subtrees (no-ops
 * that simply mark them). Returns once every pending block is settled.
 */
export async function renderCodeHighlights(root: HTMLElement): Promise<void> {
  // Tests stay hermetic: a jsdom mount of MarkdownContent must not pull the
  // shiki core + grammar graph just because its fixture HTML has a fence.
  if (import.meta.env?.MODE === 'test') return
  const codes = Array.from(root.querySelectorAll<HTMLElement>('pre code'))
  const pending = codes.filter((code) => {
    if (code.closest('.mermaid-source')) return false
    if (code.dataset.codeHighlighted) return false
    // An not-yet-loaded shiki must not spin per empty block.
    return (code.textContent ?? '').length > 0
  })
  if (pending.length === 0) return

  const highlighter = await getHighlighter()
  if (!highlighter) {
    for (const code of pending) code.dataset.codeHighlighted = 'unsupported'
    return
  }

  // Yield to the event loop every few blocks: a long answer settles with
  // dozens of fences at once, and tokenizing them all in one synchronous loop
  // forms a single 100ms+ long task — the "one hitch when the answer
  // finishes". A macro-task boundary per slice keeps every task well under
  // the longtask budget while the whole pass still completes in one flush.
  const YIELD_EVERY = 6
  let sinceYield = 0
  for (const code of pending) {
    if (sinceYield >= YIELD_EVERY) {
      sinceYield = 0
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const lang = langOf(code)
    if (!lang) {
      code.dataset.codeHighlighted = 'unsupported'
      continue
    }
    if (!loadedLangs.has(lang)) {
      try {
        await highlighter.loadLanguage(lang as BuiltinLanguage)
        loadedLangs.add(lang)
      } catch {
        code.dataset.codeHighlighted = 'unsupported'
        continue
      }
    }
    try {
      const html = highlighter.codeToHtml(code.textContent ?? '', highlightOptions(lang))
      const template = document.createElement('template')
      template.innerHTML = html
      const highlighted = template.content.querySelector('code')
      if (highlighted) {
        code.replaceChildren(...Array.from(highlighted.childNodes))
        code.classList.add('code-highlighted')
        code.dataset.codeHighlighted = 'true'
      } else {
        code.dataset.codeHighlighted = 'unsupported'
      }
    } catch (error) {
      console.warn(`[code-highlighter] highlight failed for ${lang}:`, error)
      code.dataset.codeHighlighted = 'unsupported'
    }
    sinceYield += 1
  }
}
