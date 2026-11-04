// Real-filesystem locks for the workspace file-operation algorithms extracted
// from main.ts. Same shape as electron/atomic-write.test.ts: throwaway temp
// dirs, actual fs effects asserted — the registry gatekeeper is injected as a
// plain resolver, since membership/containment is workspaceRegistry.ts's
// concern (covered by the desktop e2e against the real app).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  copyIntoWorkspace,
  listWorkspaceFiles,
  moveWorkspaceEntries,
  readWorkspaceByteRange,
  sha256File,
  type WorkspacePathResolver,
} from './workspaceFs'

// Stands in for main.ts's registry-bound workspacePath(): same (root,
// relative?) shape, containment/membership aside.
const resolvePath: WorkspacePathResolver = (root, relative) => path.resolve(root, relative ?? '.')

describe('readWorkspaceByteRange', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-workspace-fs-'))
    writeFileSync(path.join(root, 'data.bin'), Buffer.from(Array.from({ length: 100 }, (_, i) => i)))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads exactly [start, end) without loading the whole file', async () => {
    const slice = await readWorkspaceByteRange(root, 'data.bin', 10, 20, resolvePath)
    expect(slice).toEqual(Buffer.from(Array.from({ length: 10 }, (_, i) => i + 10)))
  })

  it('clamps end to the file size and start to zero', async () => {
    expect(await readWorkspaceByteRange(root, 'data.bin', 90, 100_000, resolvePath))
      .toEqual(Buffer.from(Array.from({ length: 10 }, (_, i) => i + 90)))
    expect(await readWorkspaceByteRange(root, 'data.bin', -50, 5, resolvePath))
      .toEqual(Buffer.from([0, 1, 2, 3, 4]))
  })

  it('yields an empty buffer for a range entirely past EOF', async () => {
    expect(await readWorkspaceByteRange(root, 'data.bin', 500, 600, resolvePath)).toEqual(Buffer.alloc(0))
  })

  it('validates finite numbers BEFORE resolving the path (error order preserved)', async () => {
    const rejectingResolver: WorkspacePathResolver = () => {
      throw new Error('workspace root is not registered')
    }
    await expect(readWorkspaceByteRange(root, 'data.bin', 'NaN', 10, rejectingResolver))
      .rejects.toThrow('read-byte-range requires finite numeric start/end')
  })
})

describe('listWorkspaceFiles', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-workspace-fs-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('walks nested directories into sorted POSIX-relative paths', async () => {
    mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true })
    writeFileSync(path.join(root, 'b.txt'), 'b')
    writeFileSync(path.join(root, 'a.txt'), 'a')
    writeFileSync(path.join(root, 'sub', 'run.mzML'), 'x')
    writeFileSync(path.join(root, 'sub', 'deeper', 'leaf.txt'), 'leaf')

    expect(await listWorkspaceFiles(root, resolvePath)).toEqual([
      'a.txt',
      'b.txt',
      'sub/deeper/leaf.txt',
      'sub/run.mzML',
    ])
  })

  it('never surfaces infrastructure directories', async () => {
    for (const name of ['.git', 'node_modules', '.tdease', '.snakemake']) {
      mkdirSync(path.join(root, name), { recursive: true })
      writeFileSync(path.join(root, name, 'hidden.txt'), 'hidden')
    }
    writeFileSync(path.join(root, 'keep.txt'), 'keep')

    expect(await listWorkspaceFiles(root, resolvePath)).toEqual(['keep.txt'])
  })

  it('answers [] for an empty workspace', async () => {
    expect(await listWorkspaceFiles(root, resolvePath)).toEqual([])
  })
})

describe('sha256File', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-workspace-fs-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('digests file content (known vectors)', async () => {
    const file = path.join(root, 'hello.txt')
    writeFileSync(file, 'hello')
    expect(await sha256File(file))
      .toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')

    const empty = path.join(root, 'empty.txt')
    writeFileSync(empty, '')
    expect(await sha256File(empty))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('streams a multi-chunk file to the same digest as its bytes', async () => {
    const buffer = randomBytes(5 * 1024 * 1024)
    const file = path.join(root, 'big.bin')
    writeFileSync(file, buffer)
    expect(await sha256File(file)).toBe(createHash('sha256').update(buffer).digest('hex'))
  })

  it('rejects on an unreadable path', async () => {
    await expect(sha256File(path.join(root, 'missing.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('moveWorkspaceEntries', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-workspace-fs-'))
    writeFileSync(path.join(root, 'one.txt'), '1')
    writeFileSync(path.join(root, 'two.txt'), '2')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('moves each source into the destination dir (created on demand), basename kept', async () => {
    await moveWorkspaceEntries(root, ['one.txt', 'two.txt'], 'dest/nested', resolvePath)

    expect(readFileSync(path.join(root, 'dest', 'nested', 'one.txt'), 'utf8')).toBe('1')
    expect(readFileSync(path.join(root, 'dest', 'nested', 'two.txt'), 'utf8')).toBe('2')
    expect(existsSync(path.join(root, 'one.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'two.txt'))).toBe(false)
  })

  it('an empty list is a no-op that does not even create the destination', async () => {
    await moveWorkspaceEntries(root, [], 'dest', resolvePath)
    expect(existsSync(path.join(root, 'dest'))).toBe(false)
  })

  it('fails lazily mid-loop: earlier renames stay applied (original semantics)', async () => {
    await expect(moveWorkspaceEntries(root, ['one.txt', 'missing.txt'], 'dest', resolvePath))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(existsSync(path.join(root, 'dest', 'one.txt'))).toBe(true)
    expect(existsSync(path.join(root, 'two.txt'))).toBe(true)
  })
})

describe('copyIntoWorkspace', () => {
  let root: string
  let outside: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-workspace-fs-'))
    outside = mkdtempSync(path.join(tmpdir(), 'tdease-workspace-src-'))
    writeFileSync(path.join(outside, 'sample.txt'), 'copied')
    mkdirSync(path.join(outside, 'tree', 'inner'), { recursive: true })
    writeFileSync(path.join(outside, 'tree', 'inner', 'leaf.txt'), 'leaf')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('copies files and nested trees recursively into the workspace', async () => {
    await copyIntoWorkspace(root, [path.join(outside, 'sample.txt'), path.join(outside, 'tree')], 'imports', resolvePath)

    expect(readFileSync(path.join(root, 'imports', 'sample.txt'), 'utf8')).toBe('copied')
    expect(readFileSync(path.join(root, 'imports', 'tree', 'inner', 'leaf.txt'), 'utf8')).toBe('leaf')
  })

  it('rejects a relative source path with the exact inline-handler error', async () => {
    await expect(copyIntoWorkspace(root, ['relative.txt'], 'imports', resolvePath))
      .rejects.toThrow('copy-into requires absolute source path')
  })

  it('an empty list is a no-op', async () => {
    await copyIntoWorkspace(root, [], 'imports', resolvePath)
    expect(existsSync(path.join(root, 'imports'))).toBe(false)
  })
})

// ── IPC backpressure guards (whole-read + range caps) ────────────────────────
// A whole-file read that crosses the IPC boundary is stat-guarded, and a
// single byte-range read is capped, so a pathological request refuses with a
// typed error instead of cloning a giant buffer into the renderer.

import { FileTooLargeError, readWorkspaceFileBounded } from './workspaceFs'

describe('readWorkspaceFileBounded', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-workspace-fs-'))
    writeFileSync(path.join(root, 'data.bin'), Buffer.from(Array.from({ length: 100 }, (_, i) => i)))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads a file under the limit', async () => {
    const buffer = await readWorkspaceFileBounded(path.join(root, 'data.bin'), 256)
    expect(buffer.byteLength).toBe(100)
  })

  it('refuses a file over the limit with a typed error naming the streaming alternative', async () => {
    await expect(readWorkspaceFileBounded(path.join(root, 'data.bin'), 10))
      .rejects.toMatchObject({ name: 'FileTooLargeError', size: 100, limit: 10 })
    await expect(readWorkspaceFileBounded(path.join(root, 'data.bin'), 10))
      .rejects.toThrow('workspace:read-byte-range')
  })

  it('a file exactly at the limit passes (the limit is inclusive)', async () => {
    const buffer = await readWorkspaceFileBounded(path.join(root, 'data.bin'), 100)
    expect(buffer.byteLength).toBe(100)
  })
})

describe('readWorkspaceByteRange range cap', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'tdease-workspace-fs-'))
    writeFileSync(path.join(root, 'data.bin'), Buffer.from(Array.from({ length: 100 }, (_, i) => i)))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a single range wider than the cap with the typed error', async () => {
    try {
      await readWorkspaceByteRange(root, 'data.bin', 0, 100, resolvePath, 10)
      expect.unreachable('range over the cap must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(FileTooLargeError)
      expect((error as FileTooLargeError).size).toBe(100)
    }
  })

  it('a range exactly at the cap still reads', async () => {
    const slice = await readWorkspaceByteRange(root, 'data.bin', 0, 100, resolvePath, 100)
    expect(slice.byteLength).toBe(100)
  })
})
