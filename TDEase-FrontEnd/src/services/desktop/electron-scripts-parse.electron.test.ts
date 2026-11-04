/**
 * Every script the Electron runtime loads directly must at least parse.
 *
 * `electron/preload.cjs` sat in `HEAD` with a hard `SyntaxError` -- a `const`
 * shadowing the parameter it forwarded to. A preload script that does not parse
 * exposes nothing, so `window.tdeaseDesktop` was simply absent and every bridge
 * in that file was unreachable from the renderer: Workspace file operations,
 * the Pi runtime, skill execution, the Backend connection handshake.
 *
 * The last one is the reason this went unnoticed. `initializeTDEaseClient()`
 * begins `if (!bridge) return`, so a missing bridge is indistinguishable from
 * "running in a browser" -- the app silently falls back to the default base URL
 * with no access token instead of failing loudly.
 *
 * These files are not importable from vitest -- they call `require("electron")`
 * and run side effects at module scope -- so this uses `node --check`, which
 * parses without executing and, unlike `vm.Script`, picks CommonJS or ESM from
 * the file extension so `.cjs` and `.mjs` are both handled correctly.
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const electronDir = resolve(__dirname, '../../../electron')

/** Runtime-loaded plain-JS scripts. `.ts` sources go through the bundler, which type-checks them. */
const scripts = readdirSync(electronDir)
  .filter((name) => /\.(cjs|mjs)$/.test(name))
  .filter((name) => !name.includes('.test.'))

describe('Electron runtime scripts', () => {
  it('finds the scripts it is supposed to guard', () => {
    // A silently-empty glob would make every assertion below vacuously true.
    expect(scripts).toContain('preload.cjs')
    expect(scripts.length).toBeGreaterThan(1)
  })

  for (const name of scripts) {
    it(`${name} parses`, () => {
      // Parses only; nothing in the file runs.
      expect(() => execFileSync(process.execPath, ['--check', join(electronDir, name)], { stdio: 'pipe' }))
        .not.toThrow()
    })
  }
})
