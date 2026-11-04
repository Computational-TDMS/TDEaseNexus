#!/usr/bin/env node
/**
 * First-load budget gate — the entry chunk's static graph is a budgeted
 * surface, and this gate is what keeps it that way.
 *
 * WHY THIS EXISTS. The 2026-09-04 performance audit measured 2.27MB gzip of
 * plotly+mermaid riding the first load: a static import chain (FileDocument →
 * MsAlignDocument → SpectrumViewer → plotly) and a manualChunks rule that
 * claimed a dynamically-imported package, forcing Rollup to weld the whole
 * vendor chunk into the entry's static graph. Both were legitimate-looking
 * lines — the build stayed green, tests stayed green, and the regression was
 * invisible until someone measured. The fix landed as the modulepreload
 * whitelist below + a gzip budget, and this gate is what turns that one-off
 * fix into an invariant: any future import or chunking change that re-statics
 * a heavy vendor fails `pnpm run build` with a message naming the offender.
 *
 * METHOD. Two assertions over the written dist/:
 *
 *   1. modulepreload whitelist — `dist/index.html` may only modulepreload the
 *      two vendors the app shell statically needs (vendor-vue,
 *      vendor-element-plus). Vite modulepreloads every static import of the
 *      entry, so this list IS the entry's static vendor surface; plotly,
 *      mermaid, ag-grid, xlsx and katex are all dynamic-import chunks and
 *      must never appear here.
 *   2. first-load gzip budget — the sum of gzip sizes for the entry script,
 *      its modulepreloads, and the render-blocking stylesheets must stay
 *      under FIRST_LOAD_BUDGET_KB. Measured after the 2026-09-05 rework:
 *   ~490KB (entry 305 + vendor-vue 35 + vendor-element-plus 100 + CSS 49).
 *      The budget leaves headroom for growth but sits far below the
 *      cheapest re-static regression (~+830KB for vendor-mermaid alone).
 *
 * Failures print the offending file and the likely cause class (new static
 * import chain vs. manualChunks over-capture) so the next reader does not
 * have to re-derive the 2026-09 diagnosis from scratch.
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const indexPath = path.join(distDir, 'index.html')

/** Vendors the app shell legitimately imports statically. */
const MODULEPRELOAD_WHITELIST = [
  'vendor-vue-',
  'vendor-element-plus-',
  // Scoped-package styles referenced beside their vendor chunk.
  'vendor-element-plus',
]

/** First-load JS+CSS gzip budget (see header for the measured baseline). */
const FIRST_LOAD_BUDGET_KB = 700

if (!existsSync(indexPath)) {
  console.error('[check-bundle] dist/index.html not found — run vite build first.')
  process.exit(1)
}

const html = readFileSync(indexPath, 'utf8')

// ---- Assertion 1: modulepreload whitelist ----------------------------------

const preloadHrefs = [...html.matchAll(/<link rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1])

const offenders = preloadHrefs.filter(
  (href) => !MODULEPRELOAD_WHITELIST.some((prefix) => path.basename(href).startsWith(prefix)),
)

// ---- Assertion 2: first-load gzip budget ------------------------------------

const scriptSrcs = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1])
const stylesheets = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1])

const firstLoadFiles = [...new Set([...preloadHrefs, ...scriptSrcs, ...stylesheets])]
const sizes = []
for (const href of firstLoadFiles) {
  const file = path.join(distDir, href.replace(/^\.\//, ''))
  if (!existsSync(file)) {
    console.error(`[check-bundle] referenced file missing from dist: ${href}`)
    process.exit(1)
  }
  const gzip = gzipSync(readFileSync(file), { level: 6 }).length
  sizes.push({ file: path.basename(href), gzipKB: Math.round(gzip / 102.4) / 10 })
}
const totalKB = Math.round(sizes.reduce((sum, s) => sum + s.gzipKB, 0) * 10) / 10

// ---- Report -----------------------------------------------------------------

for (const s of [...sizes].sort((a, b) => b.gzipKB - a.gzipKB)) {
  console.log(`[check-bundle]   ${String(s.gzipKB).padStart(7)} KB gz  ${s.file}`)
}

if (offenders.length > 0) {
  console.error('\n[check-bundle] FAIL — modulepreload left the whitelist:')
  for (const href of offenders) console.error(`  ${href}`)
  console.error(
    '\n  The entry statically imports a vendor outside the app-shell set. Two known\n' +
    '  cause classes (2026-09-04 audit): a new STATIC import chain to a heavy\n' +
    "  library (mirror run-index: defineAsyncComponent), or a manualChunks rule\n" +
    '  claiming a package that is only dynamically imported (forces Rollup to\n' +
    '  facade shared modules into the entry).',
  )
  process.exit(1)
}

if (totalKB > FIRST_LOAD_BUDGET_KB) {
  console.error(`\n[check-bundle] FAIL — first-load JS+CSS is ${totalKB} KB gz, budget is ${FIRST_LOAD_BUDGET_KB} KB.`)
  console.error('  Either slim the new entry weight or raise the budget with a measured justification.')
  process.exit(1)
}

console.log(`[check-bundle] OK — modulepreload within whitelist, first-load ${totalKB} KB gz (budget ${FIRST_LOAD_BUDGET_KB} KB).`)
