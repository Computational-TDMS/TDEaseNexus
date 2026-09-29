/**
 * Offline KaTeX assets for the conversation export — the lazy-loaded twin of
 * `utils/katex-renderer.ts` (which hydrates math in the live transcript).
 *
 * A standalone export must render EXACTLY like the app with ZERO network:
 * formulas are rendered with the same katex package the app uses, and the
 * stylesheet ships inline with every woff2 font as a data URI. This module
 * exists separately from conversation-export.ts for one reason — chunk
 * discipline: katex (~280 KB JS) plus ~470 KB of base64 fonts must never
 * enter the entry bundle, so it is only ever reached through dynamic import
 * and only when an export actually contains math.
 *
 * Keep the font list in step with node_modules/katex/dist/fonts/*.woff2 (a
 * katex version bump that adds/renames a font would leave that one font
 * falling back to system glyphs — visible, not broken).
 */

// virtual:katex-css-text (vite-plugins.ts) serves the literal stylesheet text
// in tests AND production — Vite's CSS pipeline stubs .css ids to '' under
// Vitest, so this must not be a .css import of any flavor.
import katexCss from 'virtual:katex-css-text'

// `?inline` returns each font as a base64 data-URI string at build time.
import KaTeX_AMS_Regular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline'
import KaTeX_Caligraphic_Bold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline'
import KaTeX_Caligraphic_Regular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline'
import KaTeX_Fraktur_Bold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline'
import KaTeX_Fraktur_Regular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline'
import KaTeX_Main_Bold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?inline'
import KaTeX_Main_BoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline'
import KaTeX_Main_Italic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?inline'
import KaTeX_Main_Regular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?inline'
import KaTeX_Math_BoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline'
import KaTeX_Math_Italic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?inline'
import KaTeX_SansSerif_Bold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline'
import KaTeX_SansSerif_Italic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline'
import KaTeX_SansSerif_Regular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline'
import KaTeX_Script_Regular from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?inline'
import KaTeX_Size1_Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline'
import KaTeX_Size2_Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline'
import KaTeX_Size3_Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline'
import KaTeX_Size4_Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline'
import KaTeX_Typewriter_Regular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline'

const FONT_DATA_URIS: Record<string, string> = {
  'KaTeX_AMS-Regular.woff2': KaTeX_AMS_Regular,
  'KaTeX_Caligraphic-Bold.woff2': KaTeX_Caligraphic_Bold,
  'KaTeX_Caligraphic-Regular.woff2': KaTeX_Caligraphic_Regular,
  'KaTeX_Fraktur-Bold.woff2': KaTeX_Fraktur_Bold,
  'KaTeX_Fraktur-Regular.woff2': KaTeX_Fraktur_Regular,
  'KaTeX_Main-Bold.woff2': KaTeX_Main_Bold,
  'KaTeX_Main-BoldItalic.woff2': KaTeX_Main_BoldItalic,
  'KaTeX_Main-Italic.woff2': KaTeX_Main_Italic,
  'KaTeX_Main-Regular.woff2': KaTeX_Main_Regular,
  'KaTeX_Math-BoldItalic.woff2': KaTeX_Math_BoldItalic,
  'KaTeX_Math-Italic.woff2': KaTeX_Math_Italic,
  'KaTeX_SansSerif-Bold.woff2': KaTeX_SansSerif_Bold,
  'KaTeX_SansSerif-Italic.woff2': KaTeX_SansSerif_Italic,
  'KaTeX_SansSerif-Regular.woff2': KaTeX_SansSerif_Regular,
  'KaTeX_Script-Regular.woff2': KaTeX_Script_Regular,
  'KaTeX_Size1-Regular.woff2': KaTeX_Size1_Regular,
  'KaTeX_Size2-Regular.woff2': KaTeX_Size2_Regular,
  'KaTeX_Size3-Regular.woff2': KaTeX_Size3_Regular,
  'KaTeX_Size4-Regular.woff2': KaTeX_Size4_Regular,
  'KaTeX_Typewriter-Regular.woff2': KaTeX_Typewriter_Regular,
}

let cachedInlineCss: string | null = null

/** The katex stylesheet with every font embedded as a data URI — computed
 *  once per process; the ~470 KB of base64 never touches the entry chunk. */
export function inlineKatexCss(): string {
  if (cachedInlineCss !== null) return cachedInlineCss
  let css = katexCss
  // woff2 is universally supported by every target platform; the woff/ttf
  // fallbacks are dead weight once the first src entry is a data URI.
  css = css.replace(/,?url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, '')
  css = css.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (_match, name: string) => {
    const uri = FONT_DATA_URIS[name]
    return uri ? `url(${uri})` : _match
  })
  cachedInlineCss = css
  return css
}

/**
 * Replace every `katex-shell` span (markdown.ts's deterministic markup) with
 * server-side-rendered katex HTML. The escaped attribute never contains a
 * raw `"` and the escaped inner text never a raw `<`, so the first `</span>`
 * after the opening tag is always the shell's own close. Unrenderable
 * formulas keep their shell — the raw TeX stays visible, the export never
 * fails over one bad formula.
 */
export async function renderExportMath(html: string): Promise<string> {
  const shellPattern = /<span class="katex-shell katex-shell--(inline|block)" data-formula="([^"]*)" data-display="[^"]*">[^<]*<\/span>/g
  if (!shellPattern.test(html)) return html
  shellPattern.lastIndex = 0
  const { default: katex } = await import('katex')
  return html.replace(shellPattern, (match, mode: string, escapedFormula: string) => {
    const formula = escapedFormula
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    try {
      // displayMode emits the self-centering .katex-display wrapper that
      // katex.min.css already styles — no extra shell needed.
      return katex.renderToString(formula, { displayMode: mode === 'block', throwOnError: true, strict: false })
    } catch {
      return match
    }
  })
}
