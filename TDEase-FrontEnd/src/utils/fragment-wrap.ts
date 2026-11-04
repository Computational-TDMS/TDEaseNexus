/**
 * fragment-wrap — the host half of the in-conversation HTML fragment route.
 *
 * The agent may hand-write an HTML FRAGMENT (no doctype/head/body — just
 * markup, inline SVG, inline styles/scripts) to explain its reasoning: a
 * comparison, a plan, a flow. Such bytes are not a document; the browser
 * would render them unstyled against the wrong font and colors. The host
 * wraps them into the document they imply: app theme tokens serialized from
 * the LIVE document (an opaque-origin iframe cannot inherit CSS variables
 * across the frame boundary, so computed values are snapshotted at load),
 * an offline CSP, base fragment styles, and the html-fit runtime (width fit
 * + height report — html frames auto-fit, with the parent caching the
 * reported height per path). Whether bytes are a fragment is decided by
 * content, not path — the same sniff serves the transcript
 * (markdown-hydration) and the static conversation export, so a fragment
 * exports themed, not broken.
 */
import { injectHtmlFit } from './html-fit'

/** A full HTML document announces itself; anything else is a fragment. The
 *  doctype must lead (leading whitespace tolerated); an <html> tag may hide
 *  behind a comment, so the first KB is scanned for it. */
export function isHtmlFragment(text: string): boolean {
  if (/^\s*<!doctype/i.test(text)) return false
  return !/<html[\s>]/i.test(text.slice(0, 1024))
}

/** No network at all: fragments are offline by contract (the CSP of the
 *  ChartForge invariants, enforced here by the host instead of trust). */
const FRAGMENT_CSP = 'default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data: blob:; font-src data:'

/** Theme + font variables worth carrying across the frame boundary. Values
 *  are read from the live document root; anything the theme did not define
 *  serializes as empty and falls back to the literal in FRAGMENT_BASE_CSS. */
const THEME_VAR_NAMES = [
  '--color-text', '--color-text-secondary', '--color-text-muted', '--color-text-inverse',
  '--color-bg', '--color-bg-secondary', '--color-bg-tertiary', '--color-bg-hover', '--color-bg-active', '--color-bg-card',
  '--color-border', '--color-border-hover', '--color-border-active', '--color-border-panel', '--color-border-panel-strong',
  '--color-primary', '--color-on-primary', '--color-ring',
  '--color-success', '--color-success-text', '--color-warning-text', '--color-error-text', '--color-info-text', '--color-interact-text',
  '--chart-series-1', '--chart-series-2', '--chart-series-3', '--chart-series-4', '--chart-series-5', '--chart-series-6',
] as const

const FRAGMENT_BASE_CSS = `html,body{margin:0;padding:0;background:transparent;color:var(--color-text,#1f2328)}
*{box-sizing:border-box}
body{font-size:14px;line-height:1.6}
svg,img,video,canvas{display:block;max-width:100%}
a{color:var(--color-primary,#1F7E8C)}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}`

/** Serialize the app's current theme (tokens + prose metrics) into a
 *  `:root{}` + `body{}` block for embedding inside a wrapped fragment. The
 *  prose font-family/size/line-height ride along so text inside the frame
 *  sets at the same metrics as the surrounding markdown — one of the
 *  boundary-ablation invariants for inline viz. Falls back to an empty
 *  string outside a DOM (tests, export headless). */
export function collectThemeVars(doc: Document = document): string {
  try {
    const rootStyle = getComputedStyle(doc.documentElement)
    const vars = THEME_VAR_NAMES
      .map((name) => [name, rootStyle.getPropertyValue(name).trim()] as const)
      .filter(([, value]) => value !== '')
      .map(([name, value]) => `${name}:${value}`)
      .join(';')
    const body = getComputedStyle(doc.body)
    const bodyRules = [
      body.fontFamily ? `font-family:${body.fontFamily}` : '',
      body.fontSize ? `font-size:${body.fontSize}` : '',
      // "normal" computes for line-height until content sets it; only a real
      // length/number survives, otherwise the base CSS fallback stands.
      body.lineHeight !== 'normal' ? `line-height:${body.lineHeight}` : '',
    ].filter(Boolean).join(';')
    const bodyRule = bodyRules ? `body{${bodyRules}}` : ''
    return vars ? `:root{${vars}}${bodyRule}` : bodyRule
  } catch {
    return ''
  }
}

/** The static light theme for fragments riding inside a conversation EXPORT
 *  (no live document to snapshot; the export page is light-only by design). */
export const EXPORT_FRAGMENT_THEME = `:root{--color-text:#1f2328;--color-text-secondary:#444;--color-text-muted:#6b7280;
--color-bg:#f6f6f4;--color-bg-secondary:#f2f2f0;--color-border:#d1d5db;
--color-primary:#1F7E8C;--color-success:#1a7f37;--color-error-text:#cf222e}
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}`

/** Wrap a fragment into the full document the host renders: charset, offline
 *  CSP, theme + base styles, then the fragment as the body. The html-fit
 *  runtime (width fit + height report) ships inside — idempotent if the
 *  fragment happened to carry it already. */
export function wrapHtmlFragment(fragment: string, themeCss = ''): string {
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${FRAGMENT_CSP}">` +
    // Base first, snapshot second: the live prose metrics must WIN over the
    // hardcoded fallbacks, not lose to them.
    `<style>${FRAGMENT_BASE_CSS}${themeCss}</style></head><body>${fragment}</body></html>`
  return injectHtmlFit(doc)
}
