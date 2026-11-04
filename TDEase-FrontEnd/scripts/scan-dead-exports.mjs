#!/usr/bin/env node
/**
 * Dead-export scanner (companion to check-reachability.mjs — that one gates
 * FILE-level reachability; this one reports EXPORT-level and i18n-key-level
 * candidates the file graph cannot see).
 *
 * Usage: node scripts/scan-dead-exports.mjs
 * Output: JSON-ish report of (1) exported symbols whose name appears in no
 * other production file, (2) symbols referenced ONLY by test files, (3) i18n
 * keys never referenced by any t('...') call.
 *
 * Deliberately conservative: a name found ANYWHERE in another file's text
 * (including templates and comments) counts as used. False "dead" results
 * should be near-zero; false "used" results are accepted.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === '__tests__' || name.startsWith('__')) continue
      walk(full, acc)
    } else if (/\.(ts|vue)$/.test(name)) acc.push(full)
  }
  return acc
}

const files = walk(SRC)
// Usage corpus: src + electron main/preload + tests — electron imports from
// src/contracts (bundled by esbuild), and test-only usage must be visible so
// it can be reported as "production-dead", not missed.
const CORPUS_DIRS = [join(ROOT, 'electron'), join(ROOT, 'tests')]
for (const dir of CORPUS_DIRS) {
  if (statSync(dir).isDirectory()) files.push(...walk(dir))
}
const byRel = files.map((f) => relative(ROOT, f).replace(/\\/g, '/'))
const contents = files.map((f) => readFileSync(f, 'utf8'))

const EXPORT_PATTERNS = [
  /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /export\s+(?:type|interface|enum|class|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g,
]

const exports = [] // { file, name }
files.forEach((file, index) => {
  const text = contents[index]
  const rel = byRel[index]
  const isTest = /\.test\.ts$/.test(rel)
  for (const pattern of EXPORT_PATTERNS) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(text)) !== null) exports.push({ file: rel, name: m[1], fromTest: isTest })
  }
  // named re-exports: export { a, b as c } (from './x' — include, usage is same)
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const asMatch = part.trim().match(/^[\w$]+\s+as\s+([\w$]+)$/)
      const name = (asMatch ? asMatch[1] : part.trim().split(/\s+/)[0])?.trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) exports.push({ file: rel, name, fromTest: isTest })
    }
  }
})

const wordCache = new Map()
function othersMention(name, exceptRel) {
  if (wordCache.has(name)) return wordCache.get(name)
  const hits = { prod: 0, test: 0 }
  const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`)
  byRel.forEach((rel, index) => {
    if (rel === exceptRel) return
    if (re.test(contents[index])) /\.test\.ts$/.test(rel) ? hits.test += 1 : hits.prod += 1
  })
  wordCache.set(name, hits)
  return hits
}

const dead = []
const testOnly = []
for (const { file, name, fromTest } of exports) {
  if (fromTest) continue
  const { prod, test } = othersMention(name, file)
  if (prod === 0 && test === 0) dead.push(`${file}: ${name}`)
  else if (prod === 0 && test > 0) testOnly.push(`${file}: ${name}`)
}

// ── i18n keys ────────────────────────────────────────────────────────────────
const LOCALES = join(SRC, 'locales', 'zh-CN')
const keys = []
function collectKeys(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') collectKeys(v, `${prefix}${k}.`)
    else keys.push(prefix + k)
  }
}
for (const name of readdirSync(LOCALES)) {
  if (!name.endsWith('.json')) continue
  const scope = name.replace('.json', '')
  collectKeys(JSON.parse(readFileSync(join(LOCALES, name), 'utf8')), `${scope}.`)
}
const allText = contents.join('\n')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const deadKeys = keys.filter((key) => {
  if (allText.includes(`'${key}'`) || allText.includes(`"${key}"`)) return false
  // Dynamic child access: t(`parent.${expr}`) keeps the whole parent branch
  // alive; only flag a key when no ancestor is dynamically interpolated.
  const parent = key.slice(0, key.lastIndexOf('.'))
  if (parent && new RegExp(escapeRe(parent) + '\\.\\$\\{').test(allText)) return false
  return true
})

console.log(`# dead exports (name appears nowhere else): ${dead.length}`)
for (const line of dead) console.log(`  ${line}`)
console.log(`# production-dead exports (referenced only by tests): ${testOnly.length}`)
for (const line of testOnly) console.log(`  ${line}`)
console.log(`# i18n keys never referenced: ${deadKeys.length}`)
for (const key of deadKeys) console.log(`  ${key}`)
