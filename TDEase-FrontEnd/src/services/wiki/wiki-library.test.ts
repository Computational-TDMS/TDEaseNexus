import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The workspace filesystem adapter is mocked to an in-memory tree so the
 * scope-aware listing and resolution logic runs without Electron or a real
 * workspace. The system wiki goes through the `systemData` desktop bridge,
 * stubbed on globalThis the same way preload installs it.
 */
vi.mock('@/services/workspace/views-fs', () => {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const norm = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/, '')
  return {
    getViewsFS: () => ({
      readFile: async (absolute: string) => {
        const value = files.get(norm(absolute))
        if (value === undefined) throw new Error(`missing: ${absolute}`)
        return value
      },
      writeFile: async (absolute: string, content: string) => {
        files.set(norm(absolute), content)
      },
      mkdir: async (absolute: string) => {
        dirs.add(norm(absolute))
      },
      listDir: async (absolute: string) => {
        const base = norm(absolute)
        const entries = new Map<string, { name: string; isDir: boolean; size: number; mtime: number }>()
        for (const key of [...files.keys(), ...dirs]) {
          if (base && !key.startsWith(`${base}/`)) continue
          const rest = base ? key.slice(base.length + 1) : key
          const segment = rest.split('/')[0]
          if (!segment) continue
          // Merge: a directory listed by an earlier key must not lose isDir
          // when a later key (e.g. the mkdir'd directory itself) names it too.
          const isDir = rest.includes('/') || (entries.get(segment)?.isDir ?? false)
          entries.set(segment, { name: segment, isDir, size: 0, mtime: 0 })
        }
        return [...entries.values()]
      },
    }),
  }
})

import {
  findWikiBacklinks, listWikiPages, readWikiPage, resolveWikiTarget, writeWikiPage,
} from './wiki-library'

const ROOT = 'Z:/workspaces/lab'

let systemFiles: Map<string, string>

beforeEach(() => {
  systemFiles = new Map()
  ;(globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop = {
    systemData: {
      listFiles: async (relative: string) =>
        [...systemFiles.keys()].filter((key) => key.startsWith(`${relative}/`)).sort(),
      readText: async (relative: string) => {
        const value = systemFiles.get(relative)
        if (value === undefined) throw new Error(`missing: ${relative}`)
        return value
      },
      writeTextAtomic: async (relative: string, content: string) => {
        systemFiles.set(relative, content)
      },
      sha256: async () => 'x',
    },
  }
})

afterEach(() => {
  delete (globalThis as { tdeaseDesktop?: unknown }).tdeaseDesktop
})

async function seedWorkspace(): Promise<void> {
  await writeWikiPage({ scope: 'workspace', page: 'TopFD.md' }, '# TopFD\nsee [[C13 ladder]]\n', ROOT)
  await writeWikiPage({ scope: 'workspace', page: 'pitfall/C13 ladder.md' }, '---\ntitle: The C13 ladder\nkind: pitfall\nupdated: 2026-08-31\ntags: [c13]\n---\nliteral [[TopFD]] mention\n', ROOT)
  await writeWikiPage({ scope: 'workspace', page: 'notes/deep.md' }, '# Deep\n', ROOT)
}

async function seedSystem(): Promise<void> {
  systemFiles.set('wiki/method/TopFD.md', '---\ntitle: System TopFD\n---\narchive copy\n')
  systemFiles.set('wiki/pitfall/C13 ladder.md', '# System ladder\n')
}

describe('wiki library', () => {
  it('lists workspace pages recursively with parsed titles and tags', async () => {
    await seedWorkspace()
    const pages = await listWikiPages('workspace', ROOT)
    expect(pages.map((page) => page.ref.page)).toEqual([
      'TopFD.md', 'notes/deep.md', 'pitfall/C13 ladder.md',
    ])
    const ladder = pages.find((page) => page.ref.page === 'pitfall/C13 ladder.md')
    expect(ladder?.title).toBe('The C13 ladder')
    expect(ladder?.tags).toEqual(['c13'])
    expect(ladder?.kind).toBe('pitfall')
  })

  it('resolves a bare target: linking scope first, then the other scope, shortest path', async () => {
    await seedWorkspace()
    await seedSystem()
    // Linking from a workspace page: the workspace file name wins.
    expect(await resolveWikiTarget('TopFD', 'workspace', ROOT))
      .toEqual({ scope: 'workspace', page: 'TopFD.md' })
    // Linking from a system page: the system file name wins.
    expect(await resolveWikiTarget('TopFD', 'system', ROOT))
      .toEqual({ scope: 'system', page: 'method/TopFD.md' })
    // No file-name match anywhere in the first scope with a hit: falls through.
    expect(await resolveWikiTarget('deep', 'system', ROOT))
      .toEqual({ scope: 'workspace', page: 'notes/deep.md' })
  })

  it('pins the scope with an explicit prefix and returns null when nothing matches', async () => {
    await seedWorkspace()
    await seedSystem()
    expect(await resolveWikiTarget('system/TopFD', 'workspace', ROOT))
      .toEqual({ scope: 'system', page: 'method/TopFD.md' })
    expect(await resolveWikiTarget('missing', 'workspace', ROOT)).toBeNull()
  })

  it('finds backlinks by name across scopes and excludes the page itself', async () => {
    await seedWorkspace()
    const backlinks = await findWikiBacklinks({ scope: 'workspace', page: 'TopFD.md' }, ROOT)
    expect(backlinks.map((link) => link.ref.page)).toEqual(['pitfall/C13 ladder.md'])
    const ladder = await findWikiBacklinks({ scope: 'workspace', page: 'pitfall/C13 ladder.md' }, ROOT)
    expect(ladder.map((link) => link.ref.page)).toEqual(['TopFD.md'])
  })

  it('round-trips a write through both scopes', async () => {
    await writeWikiPage({ scope: 'system', page: 'method/new.md' }, '# new', ROOT)
    expect(systemFiles.get('wiki/method/new.md')).toBe('# new')
    expect(await readWikiPage({ scope: 'system', page: 'method/new.md' }, ROOT)).toBe('# new')
    await expect(writeWikiPage({ scope: 'workspace', page: 'new.rst' }, 'x', ROOT))
      .rejects.toThrow('.md or .txt')
  })

  it('treats .txt pages as first-class: listed, filename-titled, resolvable, but never a link SOURCE', async () => {
    await seedWorkspace()
    await writeWikiPage({ scope: 'workspace', page: 'notes/log.txt' }, 'plain notes mentioning [[TopFD]] inline\n', ROOT)
    const pages = await listWikiPages('workspace', ROOT)
    const log = pages.find((page) => page.ref.page === 'notes/log.txt')
    expect(log?.title).toBe('log')
    // A bare link resolves to the txt page by file name...
    expect(await resolveWikiTarget('log', 'workspace', ROOT))
      .toEqual({ scope: 'workspace', page: 'notes/log.txt' })
    // ...but the txt page's own [[TopFD]] text is NOT a backlink source.
    const topfdBacklinks = await findWikiBacklinks({ scope: 'workspace', page: 'TopFD.md' }, ROOT)
    expect(topfdBacklinks.map((link) => link.ref.page)).not.toContain('notes/log.txt')
    // And an explicit extension target matches too.
    expect(await resolveWikiTarget('log.txt', 'workspace', ROOT))
      .toEqual({ scope: 'workspace', page: 'notes/log.txt' })
  })
})
