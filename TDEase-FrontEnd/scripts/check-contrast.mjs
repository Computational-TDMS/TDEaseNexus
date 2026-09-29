#!/usr/bin/env node
/**
 * VISUAL-SYSTEM.md §4.3 — Contrast is verified, not asserted.
 *
 * Parses src/styles/unified-design-tokens.css, builds the effective custom
 * -property table for each of the four themes (:root cascaded with
 * [data-theme="X"], in source order — the same rule the browser applies
 * since every selector here has equal specificity), resolves `var()` chains
 * and `color-mix(in srgb, A p%, B)` (recursively, where the operands are
 * themselves resolvable), and asserts WCAG AA contrast for a declared list
 * of foreground/background pairs across all four themes.
 *
 * Exit code is non-zero iff any `error`-severity pair fails in any theme.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseHex, mixSrgb, contrastRatio } from './color.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOKENS_PATH = path.resolve(__dirname, '../src/styles/unified-design-tokens.css')

const THEMES = ['celadon', 'latte', 'frappe', 'macchiato', 'mocha']

const TEXT_THRESHOLD = 4.5
const NON_TEXT_THRESHOLD = 3.0

/** @typedef {{ fg: string, bg: string, kind: 'text'|'non-text', severity: 'error'|'warn' }} Pair */

/** @type {Pair[]} */
const PAIRS = [
  { fg: '--color-text', bg: '--color-bg', kind: 'text', severity: 'error' },
  { fg: '--color-text', bg: '--color-bg-secondary', kind: 'text', severity: 'error' },
  { fg: '--color-text', bg: '--color-bg-card', kind: 'text', severity: 'error' },
  { fg: '--color-text-secondary', bg: '--color-bg', kind: 'text', severity: 'error' },
  { fg: '--color-text-secondary', bg: '--color-bg-card', kind: 'text', severity: 'error' },
  { fg: '--color-text-muted', bg: '--color-bg', kind: 'text', severity: 'error' },
  { fg: '--color-on-primary', bg: '--color-primary', kind: 'text', severity: 'error' },

  // Text-variant semantic colors (used as link/status text)
  { fg: '--color-interact-text', bg: '--color-bg', kind: 'text', severity: 'error' },
  { fg: '--color-interact-text', bg: '--color-bg-secondary', kind: 'text', severity: 'error' },
  { fg: '--color-success-text', bg: '--color-bg', kind: 'text', severity: 'error' },
  { fg: '--color-success-text', bg: '--color-bg-secondary', kind: 'text', severity: 'error' },
  { fg: '--color-error-text', bg: '--color-bg', kind: 'text', severity: 'error' },
  { fg: '--color-error-text', bg: '--color-bg-secondary', kind: 'text', severity: 'error' },
  { fg: '--color-warning-text', bg: '--color-bg', kind: 'text', severity: 'error' },
  { fg: '--color-warning-text', bg: '--color-bg-secondary', kind: 'text', severity: 'error' },

  { fg: '--status-queued', bg: '--color-bg', kind: 'non-text', severity: 'error' },
  { fg: '--status-queued', bg: '--color-bg-secondary', kind: 'non-text', severity: 'error' },
  { fg: '--status-running', bg: '--color-bg', kind: 'non-text', severity: 'error' },
  { fg: '--status-running', bg: '--color-bg-secondary', kind: 'non-text', severity: 'error' },
  { fg: '--status-succeeded', bg: '--color-bg', kind: 'non-text', severity: 'error' },
  { fg: '--status-succeeded', bg: '--color-bg-secondary', kind: 'non-text', severity: 'error' },
  { fg: '--status-failed', bg: '--color-bg', kind: 'non-text', severity: 'error' },
  { fg: '--status-failed', bg: '--color-bg-secondary', kind: 'non-text', severity: 'error' },
  { fg: '--status-cancelled', bg: '--color-bg', kind: 'non-text', severity: 'error' },
  { fg: '--status-cancelled', bg: '--color-bg-secondary', kind: 'non-text', severity: 'error' },

  { fg: '--color-ring', bg: '--color-bg', kind: 'non-text', severity: 'error' },
  { fg: '--color-border-panel', bg: '--color-bg-secondary', kind: 'non-text', severity: 'error' },

  { fg: '--chart-series-1', bg: '--chart-bg', kind: 'non-text', severity: 'error' },
  { fg: '--chart-series-2', bg: '--chart-bg', kind: 'non-text', severity: 'error' },
  { fg: '--chart-series-3', bg: '--chart-bg', kind: 'non-text', severity: 'error' },
  { fg: '--chart-series-4', bg: '--chart-bg', kind: 'non-text', severity: 'error' },
  { fg: '--chart-series-5', bg: '--chart-bg', kind: 'non-text', severity: 'error' },
  { fg: '--chart-series-6', bg: '--chart-bg', kind: 'non-text', severity: 'error' },

  // Known-exempt: WCAG does not require disabled controls to meet AA.
  { fg: '--color-text-disabled', bg: '--color-bg', kind: 'text', severity: 'warn' },
  { fg: '--color-text-disabled', bg: '--color-bg', kind: 'non-text', severity: 'warn' },
]

// ---------------------------------------------------------------------------
// CSS parsing: extract top-level rule blocks (selector list + declarations),
// ignoring @-rules (only `@media (prefers-reduced-motion...)` exists in this
// file and it declares no custom properties we need).
// ---------------------------------------------------------------------------

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * @param {string} css
 * @returns {{ selectors: string[], decls: Record<string,string> }[]}
 */
function parseBlocks(css) {
  const blocks = []
  const n = css.length
  let i = 0
  while (i < n) {
    const braceIdx = css.indexOf('{', i)
    if (braceIdx === -1) break
    const selectorText = css.slice(i, braceIdx).trim()

    // Find the matching closing brace, tracking nested depth.
    let depth = 1
    let j = braceIdx + 1
    while (depth > 0 && j < n) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    const body = css.slice(braceIdx + 1, j - 1)
    i = j

    if (!selectorText || selectorText.startsWith('@')) {
      // @media etc. — not a custom-property rule set relevant here.
      continue
    }

    const decls = {}
    for (const stmt of body.split(';')) {
      const trimmed = stmt.trim()
      if (!trimmed.startsWith('--')) continue
      const colonIdx = trimmed.indexOf(':')
      if (colonIdx === -1) continue
      const prop = trimmed.slice(0, colonIdx).trim()
      const value = trimmed.slice(colonIdx + 1).trim()
      if (prop) decls[prop] = value
    }

    const selectors = selectorText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    blocks.push({ selectors, decls })
  }
  return blocks
}

/**
 * Build the effective variable table for one theme by replaying every block
 * whose selector list matches `:root` or `[data-theme="theme"]`, in source
 * order (later declarations win — every matching selector here has equal
 * specificity, so this mirrors the real cascade).
 * @param {{selectors:string[], decls:Record<string,string>}[]} blocks
 * @param {string} theme
 */
function buildThemeVars(blocks, theme) {
  const themeSelector = `[data-theme="${theme}"]`
  /** @type {Record<string,string>} */
  const vars = {}
  for (const block of blocks) {
    const matches = block.selectors.some((s) => s === ':root' || s === themeSelector)
    if (!matches) continue
    Object.assign(vars, block.decls)
  }
  return vars
}

// ---------------------------------------------------------------------------
// Value resolution: var() chains and color-mix(in srgb, A p%, B), recursive.
// ---------------------------------------------------------------------------

/**
 * Split a color-mix() argument list at top-level commas (respecting nested
 * parens, so a nested color-mix(...) operand isn't split internally).
 * @param {string} s
 */
function splitTopLevel(s) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}

/**
 * Parse a color-mix() operand into { colorExpr, percent } (percent is
 * `null` when unspecified).
 * @param {string} operand
 */
function parseOperand(operand) {
  const s = operand.trim()
  let m = s.match(/^(\d+(?:\.\d+)?)%\s+(.+)$/)
  if (m) return { colorExpr: m[2].trim(), percent: Number(m[1]) }
  m = s.match(/^(.+?)\s+(\d+(?:\.\d+)?)%$/)
  if (m) return { colorExpr: m[1].trim(), percent: Number(m[2]) }
  return { colorExpr: s, percent: null }
}

/**
 * Resolve a single CSS value expression (a var() reference, a hex colour, a
 * color-mix(in srgb, ...) call, or 'transparent') to concrete sRGB.
 * Returns null when the expression cannot be resolved (unsupported syntax,
 * `transparent`, a missing variable, or a cycle).
 * @param {string} expr
 * @param {Record<string,string>} vars
 * @param {Map<string, {r:number,g:number,b:number}|null>} memo
 * @param {Set<string>} stack
 * @returns {{r:number,g:number,b:number}|null}
 */
function resolveExpr(expr, vars, memo, stack) {
  const s = expr.trim()

  if (s === 'transparent') return null

  if (s.startsWith('#')) {
    try {
      return parseHex(s)
    } catch {
      return null
    }
  }

  let m = s.match(/^var\(\s*(--[\w-]+)\s*\)$/)
  if (m) return resolveVar(m[1], vars, memo, stack)

  if (s.toLowerCase().startsWith('color-mix(')) {
    const inner = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'))
    const spaceMatch = inner.match(/^\s*in\s+srgb\s*,\s*([\s\S]+)$/i)
    if (!spaceMatch) return null // only `in srgb` is used/supported
    const operandParts = splitTopLevel(spaceMatch[1])
    if (operandParts.length !== 2) return null
    const a = parseOperand(operandParts[0])
    const b = parseOperand(operandParts[1])
    const colorA = resolveExpr(a.colorExpr, vars, memo, stack)
    const colorB = resolveExpr(b.colorExpr, vars, memo, stack)
    if (!colorA || !colorB) return null
    let percentA = a.percent
    if (percentA === null && b.percent !== null) percentA = 100 - b.percent
    if (percentA === null) percentA = 50
    return mixSrgb(colorA, colorB, percentA)
  }

  return null // unsupported form (rgb(), named colour, etc.) — not used by the required pairs
}

/**
 * Resolve a `--custom-property` name to sRGB within one theme's variable
 * table, memoized and cycle-guarded.
 * @param {string} name
 * @param {Record<string,string>} vars
 * @param {Map<string, {r:number,g:number,b:number}|null>} memo
 * @param {Set<string>} stack
 */
function resolveVar(name, vars, memo, stack) {
  if (memo.has(name)) return memo.get(name)
  if (stack.has(name)) {
    memo.set(name, null)
    return null
  }
  const raw = vars[name]
  if (raw === undefined) {
    memo.set(name, null)
    return null
  }
  stack.add(name)
  const result = resolveExpr(raw, vars, memo, stack)
  stack.delete(name)
  memo.set(name, result)
  return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const css = stripComments(readFileSync(TOKENS_PATH, 'utf8'))
  const blocks = parseBlocks(css)

  /** @type {{ theme: string, fg: string, bg: string, ratio: number|null, threshold: number, severity: string, pass: boolean }[]} */
  const rows = []

  for (const theme of THEMES) {
    const vars = buildThemeVars(blocks, theme)
    const memo = new Map()

    for (const pair of PAIRS) {
      const stackFg = new Set()
      const stackBg = new Set()
      const fgColor = resolveVar(pair.fg, vars, memo, stackFg)
      const bgColor = resolveVar(pair.bg, vars, memo, stackBg)
      const threshold = pair.kind === 'text' ? TEXT_THRESHOLD : NON_TEXT_THRESHOLD
      let ratio = null
      let pass = false
      if (fgColor && bgColor) {
        ratio = contrastRatio(fgColor, bgColor)
        pass = ratio >= threshold
      }
      rows.push({ theme, fg: pair.fg, bg: pair.bg, ratio, threshold, severity: pair.severity, pass })
    }
  }

  // ---- Report ----
  const colWidth = (key, header) => Math.max(header.length, ...rows.map((r) => String(r[key] ?? '').length))
  const fgW = Math.max(...PAIRS.map((p) => p.fg.length), 'foreground'.length)
  const bgW = Math.max(...PAIRS.map((p) => p.bg.length), 'background'.length)

  let hadErrorFailure = false
  let hadWarnFailure = false

  for (const theme of THEMES) {
    console.log(`\n=== theme: ${theme} ===`)
    console.log(
      `${'foreground'.padEnd(fgW)}  ${'background'.padEnd(bgW)}  ratio   threshold  severity  result`
    )
    for (const row of rows.filter((r) => r.theme === theme)) {
      const ratioStr = row.ratio === null ? 'n/a' : row.ratio.toFixed(2)
      const status = row.ratio === null ? 'UNRESOLVED' : row.pass ? 'PASS' : 'FAIL'
      console.log(
        `${row.fg.padEnd(fgW)}  ${row.bg.padEnd(bgW)}  ${ratioStr.padEnd(6)}  ${String(row.threshold).padEnd(9)}  ${row.severity.padEnd(8)}  ${status}`
      )
      if (!row.pass) {
        if (row.severity === 'error') hadErrorFailure = true
        else hadWarnFailure = true
      }
    }
  }

  console.log('')
  if (hadWarnFailure) {
    console.log('warn-severity pairs below threshold (non-fatal, WCAG-exempt disabled state):')
    for (const row of rows.filter((r) => r.severity === 'warn' && !r.pass)) {
      console.log(`  [warn] ${row.theme}: ${row.fg} on ${row.bg} = ${row.ratio === null ? 'n/a' : row.ratio.toFixed(2)} (< ${row.threshold})`)
    }
  }

  if (hadErrorFailure) {
    console.error('\nFAILED: one or more required pairs are below the WCAG AA threshold.')
    for (const row of rows.filter((r) => r.severity === 'error' && !r.pass)) {
      console.error(`  [error] ${row.theme}: ${row.fg} on ${row.bg} = ${row.ratio === null ? 'n/a' : row.ratio.toFixed(2)} (< ${row.threshold})`)
    }
    process.exitCode = 1
  } else {
    console.log('All required contrast pairs pass WCAG AA in all five themes.')
  }
}

main()
