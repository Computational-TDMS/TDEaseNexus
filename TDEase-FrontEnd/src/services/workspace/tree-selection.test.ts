import { describe, expect, it } from 'vitest'
import type { FileTreeNode } from '@/types/workspace-data'
import {
  buildTreeRows,
  collectVisibleTreeEntries,
  type CreateEdit,
  type VisibleTreeEntry,
} from './tree-selection'

function dir(name: string, children: FileTreeNode[] = []): FileTreeNode {
  return { name, path: name, type: 'directory', status: 'local', children, loaded: true }
}

function file(name: string): FileTreeNode {
  return { name, path: name, type: 'file', status: 'local', loaded: true }
}

/** Two-level tree: src/{a.ts,b.ts}, results/<run1>/out.csv, notes.md */
function seedTree(): FileTreeNode[] {
  return [
    dir('src', [file('a.ts'), file('b.ts')]),
    dir('results', [dir('<run1>', [file('out.csv')])]),
    file('notes.md'),
  ]
}

function visible(expanded: string[]): VisibleTreeEntry[] {
  return collectVisibleTreeEntries(
    seedTree(),
    '',
    0,
    new Set(expanded),
    () => undefined, // no lazy cache — fall back to seed children
  )
}

const createEdit = (parentPath: string, kind: 'file' | 'folder' = 'file'): { mode: 'create'; edit: CreateEdit } => ({
  mode: 'create',
  edit: { parentPath, kind, draftName: 'draft', phase: 'editing' },
})

describe('collectVisibleTreeEntries', () => {
  it('lists only top-level entries when nothing is expanded', () => {
    const entries = visible([])
    expect(entries.map(e => e.path)).toEqual(['src', 'results', 'notes.md'])
    expect(entries.every(e => e.depth === 0 && e.parent === '')).toBe(true)
  })

  it('recurses only into expanded directories, computing path/parent/depth', () => {
    const entries = visible(['src', 'results', 'results/<run1>'])
    expect(entries.map(e => e.path)).toEqual([
      'src',
      'src/a.ts',
      'src/b.ts',
      'results',
      'results/<run1>',
      'results/<run1>/out.csv',
      'notes.md',
    ])
    const deep = entries.find(e => e.path === 'results/<run1>/out.csv')!
    expect(deep.depth).toBe(2)
    expect(deep.parent).toBe('results/<run1>')
  })

  it('flattens a huge directory without blowing the spread argument limit', () => {
    const big: FileTreeNode[] = Array.from({ length: 200_000 }, (_, i) => file(`f${i}.txt`))
    const entries = collectVisibleTreeEntries(big, '', 0, new Set(), () => undefined)
    expect(entries).toHaveLength(200_000)
    expect(entries[199_999]!.path).toBe('f199999.txt')
  })
})

describe('buildTreeRows — flat virtualized row list', () => {
  it('produces one node row per visible entry, keyed by path', () => {
    const rows = buildTreeRows(visible(['src']), null, new Map(), new Set(['src']))
    expect(rows.map(r => r.kind)).toEqual(['node', 'node', 'node', 'node', 'node'])
    expect(rows.map(r => (r.kind === 'node' ? r.entry.path : r.key))).toEqual([
      'src', 'src/a.ts', 'src/b.ts', 'results', 'notes.md',
    ])
  })

  it('puts the root pending-create pseudo-row above every root entry', () => {
    const rows = buildTreeRows(visible([]), createEdit(''), new Map(), new Set())
    expect(rows[0]).toMatchObject({ kind: 'pending-create', depth: 0 })
    expect(rows[0]!.kind === 'pending-create' && rows[0].edit.parentPath).toBe('')
    expect(rows[1]).toMatchObject({ kind: 'node' })
  })

  it('puts a dir pending-create row immediately before the target dir row', () => {
    const rows = buildTreeRows(visible([]), createEdit('results'), new Map(), new Set())
    const i = rows.findIndex(r => r.kind === 'node' && r.entry.path === 'results')
    const prev = rows[i - 1]!
    expect(prev).toMatchObject({ kind: 'pending-create', depth: 1 })
    expect(prev.kind === 'pending-create' && prev.edit.parentPath).toBe('results')
  })

  it('puts a load-error row after the whole failed subtree', () => {
    const expanded = new Set(['results'])
    const rows = buildTreeRows(
      visible(['results']),
      null,
      new Map([['results', 'boom']]),
      expanded,
    )
    const kindsAfterResults = rows.slice(rows.findIndex(r => r.kind === 'node' && r.entry.path === 'results') + 1)
    expect(kindsAfterResults.map(r => (r.kind === 'node' ? r.entry.path : r.kind))).toEqual([
      'results/<run1>',
      'load-error',
      'notes.md',
    ])
    const err = rows.find(r => r.kind === 'load-error')!
    expect(err.kind === 'load-error' && err.path).toBe('results')
    expect(err.kind === 'load-error' && err.depth).toBe(1)
  })

  it('shows no load-error row for a failed dir that is collapsed', () => {
    const rows = buildTreeRows(visible([]), null, new Map([['results', 'boom']]), new Set())
    expect(rows.some(r => r.kind === 'load-error')).toBe(false)
  })

  it('nests the load-error row inside a deeper failed subtree ordering', () => {
    // results expanded with a failed child dir: error for the child sits
    // between the child's subtree end and the next sibling.
    const expanded = new Set(['results', 'results/<run1>'])
    const rows = buildTreeRows(
      visible(['results', 'results/<run1>']),
      null,
      new Map([['results/<run1>', 'boom']]),
      expanded,
    )
    expect(rows.map(r => (r.kind === 'node' ? r.entry.path : r.kind))).toEqual([
      'src',
      'results',
      'results/<run1>',
      'results/<run1>/out.csv',
      'load-error',
      'notes.md',
    ])
  })
})
