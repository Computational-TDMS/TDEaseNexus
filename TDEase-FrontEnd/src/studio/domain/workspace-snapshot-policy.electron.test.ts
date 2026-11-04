import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SUBMISSION_EXCLUDED_PATHS,
  WATCHER_ONLY_IGNORED_PATHS,
  workspaceWatchIgnoreGlobs,
} from './workspace-snapshot-policy'

const ELECTRON_MAIN = resolve(__dirname, '../../../electron/main.ts')
const ELECTRON_PRELOAD = resolve(__dirname, '../../../electron/preload.cjs')

/**
 * docs/STATUS.md named two lists that had to agree but were kept in
 * agreement by hand: `SUBMISSION_EXCLUDED_PATHS` (used by `prepare-analysis.ts`)
 * and the Electron file watcher's chokidar `ignored` array in `electron/main.ts`.
 *
 * That is now fixed by construction, not by inspection. `workspaceWatchIgnoreGlobs()`
 * derives the watcher's globs from the contract, `electron/main.ts` imports it
 * (esbuild bundles main from TS, so main may import from `src/`), and
 * `electron/preload.cjs` forwards the renderer's options through
 * `workspace:watch-start` — where main *adds* them to the derived list rather
 * than substituting them, keeping the contract a floor the renderer cannot lower.
 *
 * This test remains as the backstop for the one thing derivation cannot enforce
 * on its own: that `electron/**` keeps consuming the derived list. The first two
 * groups assert the real derived value; the third reads the live Electron source
 * and fails if either file goes back to restating or discarding the policy.
 */
describe('the Electron watcher ignore list derived from the snapshot exclusion contract', () => {
  it('turns every contract exclusion into a chokidar glob', () => {
    const globs = workspaceWatchIgnoreGlobs()
    for (const excluded of SUBMISSION_EXCLUDED_PATHS) {
      // Directories match their whole subtree; the lone file entry matches itself.
      // Nested segments matter: the contract excludes `views/assets/`, which a
      // single-segment pattern could not express.
      const expected = excluded.endsWith('/') ? `**/${excluded}**` : `**/${excluded}`
      expect(globs, `the watcher does not ignore the contract exclusion ${excluded}`).toContain(expected)
    }
  })

  it('adds nothing beyond the contract except the named watcher-only entries', () => {
    // Containment, not equality, is what the watcher owes the contract -- it may
    // ignore *more* (`__pycache__` is pure churn no UI wants events for) but never
    // less. Those extras still have to be declared, so an entry can never sneak in
    // as an indistinguishable literal the way the old hardcoded array allowed.
    expect(workspaceWatchIgnoreGlobs()).toHaveLength(
      SUBMISSION_EXCLUDED_PATHS.length + WATCHER_ONLY_IGNORED_PATHS.length,
    )
    expect(workspaceWatchIgnoreGlobs()).toContain('**/__pycache__/**')
    const contract = new Set<string>(SUBMISSION_EXCLUDED_PATHS)
    const misfiled = WATCHER_ONLY_IGNORED_PATHS.filter((extra) => contract.has(extra))
    expect(misfiled, `these belong to the contract, not to watcher-only extras: ${misfiled.join(', ')}`).toEqual([])
  })

  it('excludes Agent control-plane churn without hiding all .tdease state', () => {
    const globs = workspaceWatchIgnoreGlobs()
    expect(globs).toContain('**/.tdease/events.jsonl')
    expect(globs).toContain('**/.tdease/sessions/**')
    expect(globs).not.toContain('**/.tdease/**')
  })
})

describe('electron/ consumes the derived list rather than restating it', () => {
  it('electron/main.ts derives its chokidar ignore array', () => {
    const source = readFileSync(ELECTRON_MAIN, 'utf8')
    expect(
      source,
      'electron/main.ts no longer imports workspaceWatchIgnoreGlobs — has the watcher moved?',
    ).toMatch(/import\s*\{[^}]*workspaceWatchIgnoreGlobs[^}]*\}\s*from\s*["'][^"']*workspace-snapshot-policy["']/)
    expect(source).toMatch(/workspaceWatchIgnoreGlobs\(\)/)
    expect(
      source,
      'electron/main.ts restates a literal chokidar `ignored` array; derive it from workspaceWatchIgnoreGlobs() instead',
    ).not.toMatch(/ignored:\s*\[/)
  })

  it('electron/preload.cjs forwards the renderer watch options to main', () => {
    // Without this the bridge would accept an options object and drop it, so no
    // value derived from the contract could reach the watcher at all.
    const source = readFileSync(ELECTRON_PRELOAD, 'utf8')
    expect(source).toMatch(/__tdease_fs_watch\s*=\s*\(\s*root\s*,\s*opts\s*\)/)
    expect(
      source,
      'electron/preload.cjs drops the watch options instead of forwarding them over IPC',
    ).toMatch(/invoke\(\s*["']workspace:watch-start["']\s*,\s*root\s*,\s*opts\s*\)/)
  })
})
