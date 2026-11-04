/**
 * Test-only PTY availability probe. Sandboxed shells (CI containers, DSH
 * file-sandboxes without /dev/ptmx, or a missing node-pty native build)
 * cannot allocate a pseudo-terminal, which makes every real-PTY test fail
 * for environmental — not behavioral — reasons. PTY-backed describes wrap
 * themselves in `describePty` so they run on real machines and skip with a
 * stated reason where no PTY can exist.
 */
import os from 'node:os'

import { describe } from 'vitest'

import { resolveBashPath } from './pty-bash-backend'

let cached: boolean | undefined

export function ptyAvailable(): boolean {
  if (cached === undefined) {
    try {
      // Same lazy CJS load the production spawn path uses (see pty-bash-backend).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pty = require('node-pty') as typeof import('node-pty')
      const shell = pty.spawn(resolveBashPath(), ['-c', 'exit 0'], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: os.tmpdir(), env: {},
      })
      try {
        shell.kill()
      } catch {
        // Already exited — allocation itself succeeded, which is all we probe.
      }
      cached = true
    } catch (error) {
      cached = false
      console.warn(
        `[pty-skip] node-pty unavailable in this environment (${(error as Error).message}); skipping PTY-backed tests`,
      )
    }
  }
  return cached
}

/** describe() that degrades to describe.skip when no PTY can be allocated. */
export function describePty(name: string, fn: () => void): void {
  if (ptyAvailable()) describe(name, fn)
  else describe.skip(`${name} [skipped: no PTY available in this environment]`, fn)
}
