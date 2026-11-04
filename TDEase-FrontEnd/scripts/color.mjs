/**
 * Pure colour-math primitives for the contrast checker (VISUAL-SYSTEM.md
 * §4.3). No dependencies — this is deliberately a small, auditable module
 * shared by scripts/check-contrast.mjs and its own test suite.
 */

/**
 * Parse a `#rgb`, `#rrggbb` or `#rrggbbaa` hex colour string.
 * @param {string} s
 * @returns {{ r: number, g: number, b: number }}
 */
export function parseHex(s) {
  const hex = s.trim().replace(/^#/, '')
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16)
    const g = parseInt(hex[1] + hex[1], 16)
    const b = parseInt(hex[2] + hex[2], 16)
    return { r, g, b }
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return { r, g, b }
  }
  throw new Error(`parseHex: unsupported hex colour "${s}"`)
}

/**
 * Clamp a number into [lo, hi].
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Model `color-mix(in srgb, A p%, B)`: linear-blend two sRGB colours in the
 * (non-linear, gamma-encoded) sRGB channel space, which is what the CSS
 * `color-mix()` function does for the `srgb` colour space keyword.
 * @param {{r:number,g:number,b:number}} a
 * @param {{r:number,g:number,b:number}} b
 * @param {number} percentA 0..100, the weight given to `a`
 * @returns {{ r: number, g: number, b: number }}
 */
export function mixSrgb(a, b, percentA) {
  const p = clamp(percentA, 0, 100) / 100
  const mix = (ca, cb) => Math.round(ca * p + cb * (1 - p))
  return { r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b) }
}

/**
 * WCAG 2.1 relative luminance of an sRGB colour.
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 * @param {{r:number,g:number,b:number}} rgb
 * @returns {number}
 */
export function relativeLuminance({ r, g, b }) {
  const linearize = (c) => {
    const cs = c / 255
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
  }
  const R = linearize(r)
  const G = linearize(g)
  const B = linearize(b)
  return 0.2126 * R + 0.7152 * G + 0.0722 * B
}

/**
 * WCAG 2.1 contrast ratio between two sRGB colours, in [1, 21].
 * @param {{r:number,g:number,b:number}} fg
 * @param {{r:number,g:number,b:number}} bg
 * @returns {number}
 */
export function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg)
  const l2 = relativeLuminance(bg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}
