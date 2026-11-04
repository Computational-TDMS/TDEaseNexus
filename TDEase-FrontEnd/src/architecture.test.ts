/**
 * Architecture gate test.
 *
 * The shell principle (§1) and the dependency direction (§10.3,
 * `components/ → stores/ → services/ → contracts/ports`) forbid the shell
 * layers (`components/`, `stores/`, `composables/`) from holding truth,
 * opening a data stream, touching Electron IPC directly, or popping native
 * browser dialogs. §10.4 promised a test that asserts exactly that, but it
 * was never implemented — which is how the six `window.tdeaseDesktop` /
 * `globalThis.tdeaseDesktop` bypasses (now routed through
 * `services/desktopBridge.ts`) and the `window.confirm` in `stores/runs.ts`
 * (now an injected `setRunSurfacePrompt`) crept in undetected.
 *
 * This is that test. It scans the on-disk source of every non-test file under
 * the shell layers for the shapes that would mean a second data path has
 * opened or a truth-holding layer has reached into the browser chrome, and
 * fails loudly with the offending file:line if one appears.
 *
 * Scope rules (per §10.3):
 * - `components/`, `stores/`, `composables/` all ban IPC / fetch / EventSource
 *   / native dialogs (`window.confirm|alert|prompt`) — those belong in a
 *   service or an injected callback.
 * - `components/` additionally bans value imports from `@/services/backend`:
 *   the HTTP client, its adapter, the connection supervisor and the
 *   composition root (`studioInfrastructure`) all open a Backend data path,
 *   and the arrow points `components/ → stores/ → services/`. A Run surface
 *   belongs in `stores/runs.ts`. `import type` (and inline `type` specifiers)
 *   stays allowed — §10.3 permits "studio/domain (types only)" and a type
 *   import erases at compile time, so it opens no data path.
 *   `BackendFailure` (the class components branch on with `instanceof`) lives
 *   in `studio/domain/backend-failure.ts` so this ban needs no exception.
 *   The first version of this ban was a dead pattern: it required the import
 *   path to end at `@/services/backend` while every real import was
 *   `@/services/backend/backend` — it never matched anything. The scan below
 *   parses whole import statements (multi-line named imports included) and
 *   checks for a surviving value specifier, so `import { type X }` and
 *   `import type` are exempt by construction, not by luck.
 * - `stores/` and `composables/` MAY value-import from services — that is the
 *   allowed direction. Value imports from other service families
 *   (workspace/blocks/visualization/desktop) inside `components/` are a
 *   recorded, not-yet-enforced migration (see STATUS.md); extend
 *   `BANNED_IMPORT_PREFIXES_IN_COMPONENTS` domain by domain as each falls
 *   behind its store seam.
 */

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = __dirname

const BANNED_EVERYWHERE: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // Electron preload bridge — must go through services/desktopBridge.ts.
  { name: 'window.tdeaseDesktop', pattern: /\btdeaseDesktop\b/ },
  // Direct HTTP — must go through services/backend.ts.
  { name: 'fetch(', pattern: /\bfetch\s*\(/ },
  // Server-sent events — must go through the typed event subscriber.
  { name: 'new EventSource', pattern: /\bnew\s+EventSource\b/ },
  // Native browser dialogs — use the confirmDialog store (an injected
  // callback also qualifies). Stores/composables hold truth, they do not
  // render UI chrome.
  { name: 'window.confirm/alert/prompt', pattern: /\bwindow\.(confirm|alert|prompt)\s*\(/ },
]

// Backend data-path modules: the client, the adapter, the supervisor, the
// composition root, and the DTO contracts. Any value import from this tree in
// `components/` is a second Backend path next to the stores.
const BANNED_IMPORT_PREFIXES_IN_COMPONENTS: ReadonlyArray<RegExp> = [
  /^@\/services\/backend(\/|$)/,
]

interface ScanScope {
  dir: string
  label: string
  banned: ReadonlyArray<{ name: string; pattern: RegExp }>
  bannedImports?: boolean
}

const SCOPES: ReadonlyArray<ScanScope> = [
  { dir: 'components', label: 'components/', banned: [...BANNED_EVERYWHERE], bannedImports: true },
  { dir: 'stores', label: 'stores/', banned: BANNED_EVERYWHERE },
  { dir: 'composables', label: 'composables/', banned: BANNED_EVERYWHERE },
]

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, acc)
    } else if (/\.(vue|ts)$/.test(entry) && !/\.test\./.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

/**
 * Import specifiers that survive removing `type`-prefixed ones — i.e. the
 * value specifiers. `import type { A }` → '', `import { type A }` → '',
 * `import { A, type B }` → 'A', `import client from …` → 'client'.
 */
function valueSpecifiers(clause: string): string {
  if (/^type\b/.test(clause)) return ''
  return clause.replace(/\btype\s+[\w$]+/g, '').replace(/[{}*,\s]/g, '')
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/**
 * Whole-statement import scan (the old line-by-line regex never saw real
 * module paths, and multi-line named imports put `from` on its own line).
 * Static imports keep only their value specifiers; a dynamic `import('…')` is
 * a value by definition. Type-only imports open no data path and pass.
 */
function findBannedValueImports(text: string): string[] {
  const offenders: string[] = []
  const staticImport = /^import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/gm
  for (const match of text.matchAll(staticImport)) {
    const path = match[2]
    if (!BANNED_IMPORT_PREFIXES_IN_COMPONENTS.some((prefix) => prefix.test(path))) continue
    if (valueSpecifiers(match[1])) offenders.push(`${path} (line ${lineNumberAt(text, match.index ?? 0)})`)
  }
  const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of text.matchAll(dynamicImport)) {
    const path = match[1]
    if (BANNED_IMPORT_PREFIXES_IN_COMPONENTS.some((prefix) => prefix.test(path))) {
      offenders.push(`${path} (dynamic, line ${lineNumberAt(text, match.index ?? 0)})`)
    }
  }
  return offenders
}

describe('architecture gate', () => {
  for (const { dir, label, banned, bannedImports } of SCOPES) {
    it(`${label} holds no Electron IPC, fetch, EventSource, native dialog${bannedImports ? ', or backend value import' : ''}`, () => {
      const offenders: string[] = []
      for (const file of listSourceFiles(join(SRC, dir))) {
        const text = readFileSync(file, 'utf8')
        const lines = text.split('\n')
        for (let i = 0; i < lines.length; i++) {
          for (const { name, pattern } of banned) {
            if (pattern.test(lines[i])) {
              offenders.push(`${relative(SRC, file)}:${i + 1} → ${name}`)
            }
          }
        }
        if (bannedImports) {
          for (const offender of findBannedValueImports(text)) {
            offenders.push(`${relative(SRC, file)} → value import from ${offender}`)
          }
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([])
    })
  }
})

// ── Command-family seam isolation ──────────────────────────────────────────
//
// `studio/commands/families/*` are the capability seams behind the command
// surface: each family binds one port to its command contract and owns its
// family-local schemas and input builders. Composition happens only in
// `definitions.ts`, the assembly manifest — a family that imports a sibling
// family (or the manifest itself) recreates exactly the single-file coupling
// the split removed, so both import shapes fail here.

describe('command families are isolated seams', () => {
  it('no family imports a sibling family or the assembly manifest', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(join(SRC, 'studio/commands/families'))) {
      const text = readFileSync(file, 'utf8')
      const importPaths = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
      for (const match of importPaths) {
        const path = match[1]
        if (path.startsWith('./')) offenders.push(`${relative(SRC, file)} → sibling family ${path}`)
        if (path === '../definitions') offenders.push(`${relative(SRC, file)} → assembly manifest`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
