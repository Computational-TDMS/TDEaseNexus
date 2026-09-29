import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generateIndexes, parseOkfFrontMatter } from './okf-index.mjs'

/**
 * OKF progressive-disclosure index generator (KNOWLEDGE-WIKI-OKF.md §6 +
 * OKF v0.2 §12). Progressive disclosure means the ROOT index lists only
 * subdirectories; each subdirectory's own index groups its concepts. Verifies
 * that shape plus: grouped bullets with front-matter descriptions, reserved
 * filename handling (index.md/log.md), no-front-matter fallback, idempotency.
 */

function fixture() {
  const root = path.join(os.tmpdir(), `tdease-okf-index-${Math.random().toString(36).slice(2)}`)
  return { root }
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

const SPEC = [
  '---', 'type: contract', 'title: File Layout', 'description: Directory layout and ownership.',
  '---', '', '# File Layout', 'Every path and owner lives here.',
].join('\n')
const DESIGN = [
  '---', 'type: design', 'title: Core Architecture', 'description: Event/projection model.',
  '---', '', '# Core', 'The event model.',
].join('\n')
const NO_FRONT = ['# Untitled Note', 'First sentence about things. More prose here.'].join('\n')

describe('parseOkfFrontMatter', () => {
  it('parses flat key: value and list fields', () => {
    const data = parseOkfFrontMatter([
      '---', 'type: contract', 'title: A B', 'tags: [x, y]', '---', '# Body',
    ].join('\n'))
    expect(data).toEqual({ type: 'contract', title: 'A B', tags: ['x', 'y'] })
  })

  it('returns {} when there is no front matter block', () => {
    expect(parseOkfFrontMatter('# Just a heading')).toEqual({})
  })
})

describe('okf-index generator', () => {
  let root
  beforeEach(() => { root = fixture().root })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('groups root-level concepts by type with descriptions from front matter', async () => {
    await writeTree(root, {
      'file-layout.md': SPEC,
      'core.md': DESIGN,
    })
    await generateIndexes(root)
    const index = await readFile(path.join(root, 'index.md'), 'utf8')
    expect(index).toContain('# contract')
    expect(index).toContain('* [File Layout](file-layout.md) - Directory layout and ownership.')
    expect(index).toContain('# design')
    expect(index).toContain('* [Core Architecture](core.md) - Event/projection model.')
  })

  it('falls back to first heading and first sentence for front-matter-less docs', async () => {
    await writeTree(root, { 'note.md': NO_FRONT })
    await generateIndexes(root)
    const index = await readFile(path.join(root, 'index.md'), 'utf8')
    expect(index).toContain('# Concepts')
    expect(index).toContain('* [Untitled Note](note.md) - First sentence about things.')
  })

  it('progressive disclosure: root lists subdirs, each subdir index groups its concepts', async () => {
    await writeTree(root, {
      'spec/file-layout.md': SPEC,
      'spec/sub/deep.md': [
        '---', 'type: contract', 'title: Deep', 'description: Deep contract.', '---', '# Deep', 'x',
      ].join('\n'),
    })
    await generateIndexes(root)
    // Root index: only Subdirectories — never the concepts inside them.
    const rootIndex = await readFile(path.join(root, 'index.md'), 'utf8')
    expect(rootIndex).toContain('# Subdirectories')
    expect(rootIndex).toContain('* [spec](spec/)')
    expect(rootIndex).not.toContain('file-layout.md')
    // spec index: its own concepts + a nested Subdirectories.
    const specIndex = await readFile(path.join(root, 'spec', 'index.md'), 'utf8')
    expect(specIndex).toContain('* [File Layout](file-layout.md) - Directory layout and ownership.')
    expect(specIndex).toContain('* [sub](sub/)')
    // The deepest dir gets its own index.
    const subIndex = await readFile(path.join(root, 'spec', 'sub', 'index.md'), 'utf8')
    expect(subIndex).toContain('* [Deep](deep.md) - Deep contract.')
  })

  it('preserves log.md and never lists it as a concept', async () => {
    await writeTree(root, {
      'spec/file-layout.md': SPEC,
      'spec/log.md': '# Update Log\n\n## 2026-08-02\n* Added a page.\n',
    })
    await generateIndexes(root)
    const specIndex = await readFile(path.join(root, 'spec', 'index.md'), 'utf8')
    expect(specIndex).not.toContain('log.md')
    const log = await readFile(path.join(root, 'spec', 'log.md'), 'utf8')
    expect(log).toContain('# Update Log')
  })

  it('is idempotent: a second run makes no change', async () => {
    await writeTree(root, { 'spec/file-layout.md': SPEC })
    const first = await generateIndexes(root)
    expect(first.sort()).toEqual(['index.md', 'spec/index.md'])
    const indexAfterFirst = await readFile(path.join(root, 'index.md'), 'utf8')
    const specAfterFirst = await readFile(path.join(root, 'spec', 'index.md'), 'utf8')
    const second = await generateIndexes(root)
    expect(second).toEqual([])
    expect(await readFile(path.join(root, 'index.md'), 'utf8')).toBe(indexAfterFirst)
    expect(await readFile(path.join(root, 'spec', 'index.md'), 'utf8')).toBe(specAfterFirst)
  })
})
