import { describe, expect, it } from 'vitest'
import {
  EXPORT_FRAGMENT_THEME,
  collectThemeVars,
  isHtmlFragment,
  wrapHtmlFragment,
} from './fragment-wrap'

/**
 * The fragment route's pure-string contracts: what counts as a fragment
 * (content sniff — the same decision the transcript and the export both
 * make), and what the host wrapper must carry (offline CSP, theme block,
 * fit/height runtime). Runtime behavior lives in the browser (Electron e2e),
 * not in jsdom.
 */
describe('isHtmlFragment', () => {
  it('treats bare markup as a fragment', () => {
    expect(isHtmlFragment('<div class="cmp"><p>a</p><p>b</p></div>')).toBe(true)
    expect(isHtmlFragment('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>')).toBe(true)
    expect(isHtmlFragment('')).toBe(true)
  })

  it('recognizes full documents wherever their <html> sits', () => {
    expect(isHtmlFragment('<!DOCTYPE html><html><body>x</body></html>')).toBe(false)
    expect(isHtmlFragment('  \n<!doctype HTML><html lang="en"><body>x</body></html>')).toBe(false)
    expect(isHtmlFragment('<html><body>no doctype</body></html>')).toBe(false)
    expect(isHtmlFragment('<!-- note --><html><body>behind a comment</body></html>')).toBe(false)
  })

  it('does not confuse an <html> mention in prose with a document tag', () => {
    expect(isHtmlFragment('<p>write &lt;html&gt; like this</p><p>long tail of markup</p>')).toBe(true)
  })
})

describe('wrapHtmlFragment', () => {
  const fragment = '<div class="idea">charge ladder</div>'

  it('wraps into a full document with the fragment as body', () => {
    const out = wrapHtmlFragment(fragment)
    expect(out).toMatch(/^<!DOCTYPE html>/i)
    expect(out).toContain('<body><div class="idea">charge ladder</div></body>')
  })

  it('enforces the offline CSP and charset', () => {
    const out = wrapHtmlFragment(fragment)
    expect(out).toContain('<meta charset="utf-8">')
    expect(out).toContain("default-src 'none'")
    expect(out).not.toMatch(/src="http/)
  })

  it('embeds the theme block and base fragment styles', () => {
    const out = wrapHtmlFragment(fragment, ':root{--color-text:#abc}body{font-family:x}')
    expect(out).toContain(':root{--color-text:#abc}body{font-family:x}')
    expect(out).toContain('background:transparent')
    expect(out).toContain('var(--color-text,#1f2328)')
  })

  it('ships the fit/height runtime exactly once', () => {
    const once = wrapHtmlFragment(fragment)
    expect(once).toContain('data-tdz-html-fit')
    expect(once.match(/data-tdz-html-fit/g)).toHaveLength(1)
  })

  it('exposes a static export theme consistent with the light export page', () => {
    expect(EXPORT_FRAGMENT_THEME).toContain('--color-text:#1f2328')
    expect(EXPORT_FRAGMENT_THEME).toContain('--color-primary:#1F7E8C')
  })
})

describe('collectThemeVars', () => {
  it('returns a string, empty or populated, without throwing outside a live theme', () => {
    const css = collectThemeVars()
    expect(typeof css).toBe('string')
    if (css.includes(':root{')) expect(css).toMatch(/^:root\{--color-[a-z-]+:/)
  })
})
