import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ELECTRON_MAIN = resolve(__dirname, '../../../electron/main.ts')
// The atomic-write helpers live in their own module since the settings-writer
// consolidation; main.ts imports them. The source-level guarantees below read
// the live text of whichever file owns the algorithm.
const ATOMIC_WRITE = resolve(__dirname, '../../../electron/atomic-write.ts')

/**
 * `electron/main.ts` is Electron's main-process entry: it imports `electron`
 * at module scope and runs app-lifecycle side effects (single-instance lock,
 * window creation, tray setup, ...) the moment it loads. That makes it
 * unimportable from plain Node/vitest -- there is no seam to load just its
 * `result-cache:*` handlers, the way `src/studio/domain/workspace-snapshot-policy.electron.test.ts`
 * already documents for the same file's chokidar watcher.
 *
 * This file follows that precedent's two-part shape instead of skipping
 * coverage:
 *
 * 1. Structural assertions that read `electron/main.ts`'s live source text,
 *    so the "Published Result cache" section (containment via
 *    `containedPath`, no ad-hoc second check, temp-then-rename atomicity)
 *    cannot silently drift without failing a test here.
 * 2. Behavioral tests of that exact algorithm, reproduced verbatim below
 *    (see each `// Mirrors electron/main.ts ...` comment) and run against a
 *    real temp directory -- so "no partial file on failure", "digest is
 *    undefined for a missing path", and "a path escaping the root is
 *    refused" are proven against real filesystem behavior, not just text
 *    matching.
 */

describe('electron/main.ts Published Result cache handlers (source)', () => {
  const source = readFileSync(ELECTRON_MAIN, 'utf8')

  it('resolves every result-cache path through containedPath, not a new traversal check', () => {
    const fn = source.match(/function resultCachePath\(relative: string\): string \{[\s\S]*?\n\}/)
    expect(fn, 'electron/main.ts: could not find resultCachePath — has it moved?').not.toBeNull()
    expect(fn![0]).toMatch(/containedPath\(resultCacheRoot\(\), relative,/)
    // The one and only containment mechanism for this root: no second,
    // ad-hoc check (e.g. a raw `.includes('..')`) sitting next to it.
    expect(fn![0]).not.toMatch(/\.includes\(['"]\.\.['"]\)/)
  })

  it('writes atomically: temp file in the same directory, then atomicReplace, with cleanup', () => {
    const handler = source.match(/ipcMain\.handle\("result-cache:write-bytes-atomic".*?\n\}\);/s)
    expect(handler, 'electron/main.ts: could not find the result-cache write-bytes-atomic handler').not.toBeNull()
    expect(handler![0]).toMatch(/const temp = `\$\{target\}\.tdease-\$\{crypto\.randomUUID\(\)\}\.tmp`/)
    // The handler delegates the rename to `atomicReplace` (which performs the
    // real rename(temp, target) with a Windows-EPERM retry loop), rather than
    // calling rename inline.
    expect(handler![0]).toMatch(/atomicReplace\(temp, target\)/)
    expect(handler![0]).toMatch(/finally \{ await fsp\.rm\(temp, \{ force: true \}\)/)
    // The atomicity guarantee itself is enforced once in the shared helper
    // (electron/atomic-write.ts since it left main.ts): it must perform an
    // actual rename of the temp file onto the target.
    const helper = readFileSync(ATOMIC_WRITE, 'utf8')
      .match(/export async function atomicReplace\(temp: string, target: string\): Promise<void> \{[\s\S]*?\n\}/)
    expect(helper, 'electron/atomic-write.ts: could not find the atomicReplace helper').not.toBeNull()
    expect(helper![0]).toMatch(/await rename\(temp, target\)/)
    expect(helper![0]).not.toMatch(/copyFile\(temp, target\)/)
  })

  it('serializes atomic Workspace text writes per target', () => {
    const handler = source.match(/ipcMain\.handle\("workspace:write-text-atomic".*?\n\}\);/s)
    expect(handler, 'electron/main.ts: could not find the Workspace atomic-write handler').not.toBeNull()
    expect(handler![0]).toMatch(/writeTextAtomicQueued\(target, content\)/)

    // The queue itself lives in the buffer twin — writeTextAtomicQueued is a
    // thin Buffer.from wrapper over it.
    const helper = readFileSync(ATOMIC_WRITE, 'utf8')
      .match(/export function writeBufferAtomicQueued\(target: string, content: Buffer\): Promise<void> \{[\s\S]*?\n\}/)
    expect(helper, 'electron/atomic-write.ts: could not find the per-target write queue').not.toBeNull()
    expect(helper![0]).toMatch(/queuedAtomicWrites\.get\(target\)/)
    expect(helper![0]).toMatch(/queuedAtomicWrites\.set\(target, tracked\)/)
  })

  it('roots the cache outside any registered Workspace (Electron userData, not workspacePath)', () => {
    const fn = source.match(/function resultCacheRoot\(\): string \{[\s\S]*?\n\}/)
    expect(fn, 'electron/main.ts: could not find resultCacheRoot — has it moved?').not.toBeNull()
    expect(fn![0]).toMatch(/runtimePaths\.resultCacheRoot/)
    expect(fn![0]).not.toMatch(/workspacePath/)
  })
})

// Mirrors electron/main.ts's `containedPath` (see the "Published Result
// cache" section) verbatim. Duplicated, not imported, for the module-scope
// reason explained in this file's header comment.
function containedPath(root: string, relative: string, denial: string): string {
  const target = path.resolve(root, relative)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(denial)
  return target
}

// Mirrors the core of electron/main.ts's `result-cache:write-bytes-atomic`
// handler: temp-in-same-dir, then rename, then cleanup. The real handler
// additionally wraps the rename in `atomicReplace` (a Windows-EPERM
// retry/fallback); that retry is orthogonal to the atomicity contract these
// behavioral tests check, so the mirror keeps the plain rename for clarity.
async function writeBytesAtomic(target: string, content: Buffer, failBeforeRename = false): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.tdease-${crypto.randomUUID()}.tmp`
  try {
    await fsp.writeFile(temp, content)
    if (failBeforeRename) throw new Error('simulated failure before rename')
    await fsp.rename(temp, target)
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined)
  }
}

// Mirrors electron/main.ts's `result-cache:exists` + `result-cache:sha256`,
// composed the same way `digestVia` in resultCacheStorage.ts composes them
// on the renderer side.
async function digestOrUndefined(target: string): Promise<string | undefined> {
  try {
    await fsp.access(target)
  } catch {
    return undefined
  }
  return new Promise((resolvePromise, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(target)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

describe('the Published Result cache algorithm (behavioral, real filesystem)', () => {
  let root: string

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tdease-result-cache-'))
  })

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true })
  })

  describe('containedPath', () => {
    it('resolves a plain relative path inside the root', () => {
      expect(containedPath(root, 'ws/run/result/deadbeef', 'denied')).toBe(path.join(root, 'ws/run/result/deadbeef'))
    })

    it('refuses a `..` traversal that escapes the root', () => {
      expect(() => containedPath(root, '../../etc/passwd', 'result cache path traversal denied'))
        .toThrow('result cache path traversal denied')
    })

    it('refuses an absolute path that ignores the root entirely', () => {
      const outside = path.join(os.tmpdir(), 'definitely-outside')
      expect(() => containedPath(root, outside, 'result cache path traversal denied'))
        .toThrow('result cache path traversal denied')
    })
  })

  describe('writeBytesAtomic', () => {
    it('writes the target with the given content and leaves no temp file behind', async () => {
      const target = path.join(root, 'ws/run/result/abc123')
      await writeBytesAtomic(target, Buffer.from('published result bytes'))

      await expect(fsp.readFile(target, 'utf8')).resolves.toBe('published result bytes')
      const leftoverTemps = (await fsp.readdir(path.dirname(target))).filter((name) => name.endsWith('.tmp'))
      expect(leftoverTemps).toEqual([])
    })

    it('leaves no partial or half-written target file when the write fails before rename', async () => {
      const target = path.join(root, 'ws/run/result/broken')
      await expect(writeBytesAtomic(target, Buffer.from('never committed'), true))
        .rejects.toThrow('simulated failure before rename')

      await expect(fsp.access(target)).rejects.toThrow()
      const leftoverTemps = (await fsp.readdir(path.dirname(target))).filter((name) => name.endsWith('.tmp'))
      expect(leftoverTemps).toEqual([])
    })

    it('a digest taken after a failed write still reports the path as missing', async () => {
      const target = path.join(root, 'ws/run/result/broken')
      await expect(writeBytesAtomic(target, Buffer.from('never committed'), true)).rejects.toThrow()

      await expect(digestOrUndefined(target)).resolves.toBeUndefined()
    })
  })

  describe('digestOrUndefined', () => {
    it('resolves undefined for a path that was never written', async () => {
      await expect(digestOrUndefined(path.join(root, 'never/written'))).resolves.toBeUndefined()
    })

    it('resolves the real sha256 of a written file, matching Node\'s own hash', async () => {
      const target = path.join(root, 'ws/run/result/feedface')
      const content = Buffer.from('published result bytes')
      await writeBytesAtomic(target, content)

      const expected = crypto.createHash('sha256').update(content).digest('hex')
      await expect(digestOrUndefined(target)).resolves.toBe(expected)
    })
  })
})
