#!/usr/bin/env node
/**
 * i18n integrity gate — two mechanical assertions over `src/locales/`.
 *
 * WHY THIS EXISTS. The permissions settings panel shipped with its decision
 * labels resolving at runtime through a dynamically-built key
 * (`decision${...}`), and the three keys were missing from ALL THREE locales
 * — every table cell rendered the raw key path. Cross-locale parity cannot
 * catch that shape (all locales miss the same key together), so this gate
 * audits from the USAGE side too: every literal `t('...')` key in src/ must
 * resolve in the en-US tree (the fallback truth).
 *
 * WHAT IT CANNOT CATCH, BY DESIGN: fully dynamic keys (`t(\`prefix.${x}\`)`)
 * have no literal to audit — those must stay visible to grep, which is why
 * PermissionsSettings builds its labels from a static typed map instead of
 * concatenation. This gate is the safety net, not the substitute.
 *
 *   1. Cross-locale parity — zh-CN and de-DE must have EXACTLY the en-US key
 *      tree (missing AND extra both fail): a lazy-loaded locale drifting
 *      silently renders fallbacks or raw keys for its speakers.
 *   2. Literal-key resolution — every static `t('...')` / `tc('...')` string
 *      in src/** must exist in en-US (vue-i18n's fallback locale).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = join(ROOT, 'src', 'locales')
const TRUTH = 'en-US'
const FOLLOWERS = ['zh-CN', 'de-DE']

function flatten(dict, prefix = '', out = new Set()) {
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out)
    else out.add(path)
  }
  return out
}

function localeTree(locale) {
  const leaves = new Set()
  for (const entry of readdirSync(join(LOCALES, locale))) {
    if (extname(entry) !== '.json') continue
    const namespace = basename(entry, '.json')
    const parsed = JSON.parse(readFileSync(join(LOCALES, locale, entry), 'utf8'))
    for (const path of flatten(parsed)) leaves.add(`${namespace}.${path}`)
  }
  return leaves
}

function* walkSources(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry.startsWith('locale')) continue
      yield* walkSources(path)
    } else if (/\.(vue|ts)$/.test(entry) && !entry.endsWith('.test.ts')) {
      yield path
    }
  }
}

// ── 1. Parity ────────────────────────────────────────────────────────────────
const truth = localeTree(TRUTH)
let failed = false
for (const follower of FOLLOWERS) {
  const tree = localeTree(follower)
  const missing = [...truth].filter((key) => !tree.has(key))
  const extra = [...tree].filter((key) => !truth.has(key))
  if (missing.length || extra.length) {
    failed = true
    console.error(`[check-i18n] ${follower} drifted from ${TRUTH}:`)
    for (const key of missing.slice(0, 20)) console.error(`  missing: ${key}`)
    for (const key of extra.slice(0, 20)) console.error(`  extra:   ${key}`)
    if (missing.length > 20 || extra.length > 20) console.error('  …')
  }
}

// ── 2. Literal-key resolution ───────────────────────────────────────────────
const USE_RE = /\b(?:t|tc)\(\s*['"]([a-zA-Z][\w.-]*)['"]/
const used = new Map()
for (const source of walkSources(join(ROOT, 'src'))) {
  const text = readFileSync(source, 'utf8')
  for (const match of text.matchAll(new RegExp(USE_RE.source, 'g'))) {
    const key = match[1]
    if (!used.has(key)) used.set(key, [])
    used.get(key).push(source)
  }
}
const unresolved = [...used.entries()]
  .filter(([key]) => !key.includes('${') && !truth.has(key))
  .map(([key, files]) => [key, files])
if (unresolved.length) {
  failed = true
  console.error(`[check-i18n] ${unresolved.length} literal t() keys missing from ${TRUTH}:`)
  for (const [key, files] of unresolved.slice(0, 30)) {
    console.error(`  ${key}    <- ${basename(files[0])}`)
  }
  if (unresolved.length > 30) console.error('  …')
}

if (failed) process.exit(1)
console.error(`[check-i18n] OK — ${TRUTH} ${truth.size} leaf keys, parity with ${FOLLOWERS.join(', ')}, ${used.size} literal t() keys resolve.`)
