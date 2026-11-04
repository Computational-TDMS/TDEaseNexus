/**
 * Wiki library — the two knowledge scopes as plain markdown files.
 *
 *   - `system`   — the Client System wiki (`<System>/wiki/`): reusable,
 *     case-independent knowledge archived across workspaces. Reached through
 *     the `systemData` desktop bridge; the agent reads and writes the same
 *     tree through its `system-wiki/` path prefix.
 *   - `workspace` — this workspace's `wiki/` directory: case-specific working
 *     knowledge. Reached through the ordinary workspace filesystem adapter.
 *
 * Both scopes are user-owned files on disk; this module adds no format rules
 * (see `front-matter.ts`) and no governance — only scope-aware IO, listing
 * and wikilink resolution.
 */

import { wikiLinkScopePrefix, wikiTargetMatchesPage } from './wikilinks'
import { parseWikiFrontMatter, wikiPageTitle } from './front-matter'
import { getViewsFS } from '@/services/workspace/views-fs'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

export type WikiScope = 'system' | 'workspace'

/** Wiki-root-relative page path, `.md` included (`method/TopFD.md`). */
export type WikiPagePath = string

export interface WikiRef {
  scope: WikiScope
  page: WikiPagePath
}

export interface WikiPageEntry {
  ref: WikiRef
  /** File name without directories (`TopFD.md`). */
  name: string
  title: string
  kind?: string
  status?: string
  updated?: string
  tags: ReadonlyArray<string>
}

const WIKI_DIR = 'wiki'

/**
 * A wiki page is `.md` (markdown: rendered, front matter, wikilinks) or
 * `.txt` (plain text: shown verbatim, no front matter, no links parsed —
 * but listed, editable, and linkable-to like any page).
 */
const PAGE_EXTENSIONS = ['.md', '.txt'] as const

export function isWikiPagePath(page: string): boolean {
  const lower = page.toLowerCase()
  return PAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/** `.md` pages carry the wiki format (front matter, wikilinks); `.txt` do not. */
export function isMarkdownPage(page: string): boolean {
  return page.toLowerCase().endsWith('.md')
}

interface SystemDataBridge {
  listFiles(relative: string): Promise<ReadonlyArray<string>>
  readText(relative: string): Promise<string>
  writeTextAtomic(relative: string, content: string): Promise<void>
}

function systemDataBridge(): SystemDataBridge | undefined {
  return (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.systemData
}

/** False in a browser dev session: the System wiki is a desktop capability. */
export function hasSystemWiki(): boolean {
  return Boolean(systemDataBridge())
}

function normalizePage(page: string): WikiPagePath {
  return page.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\/+/, '')
}

function stripPageExtension(name: string): string {
  return name.replace(/\.(?:md|txt)$/i, '')
}

export function wikiPageName(page: WikiPagePath): string {
  const normalized = normalizePage(page)
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? normalized.slice(slash + 1) : normalized
}

// ── Workspace scope (ViewsFS; `root` comes from the attached Workspace) ──────

async function listWorkspacePages(root: string): Promise<ReadonlyArray<WikiPagePath>> {
  const fs = getViewsFS()
  const pages: WikiPagePath[] = []
  async function walk(relative: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fs.listDir>>
    try {
      entries = await fs.listDir(`${root}/${relative}`)
    } catch {
      return
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDir) await walk(child)
      else if (isWikiPagePath(entry.name)) pages.push(child)
    }
  }
  await walk(WIKI_DIR)
  return pages.map((page) => normalizePage(page.slice(WIKI_DIR.length + 1))).sort()
}

// ── Public surface ────────────────────────────────────────────────────────────

/** List a scope's pages with their parsed titles. Missing root → empty. */
export async function listWikiPages(scope: WikiScope, workspaceRoot: string | null): Promise<ReadonlyArray<WikiPageEntry>> {
  let paths: ReadonlyArray<WikiPagePath>
  if (scope === 'system') {
    const bridge = systemDataBridge()
    if (!bridge) return []
    paths = (await bridge.listFiles(WIKI_DIR))
      .filter((path) => isWikiPagePath(path))
      .map((path) => normalizePage(path.startsWith(`${WIKI_DIR}/`) ? path.slice(WIKI_DIR.length + 1) : path))
      .sort()
  } else {
    if (!workspaceRoot) return []
    paths = await listWorkspacePages(workspaceRoot)
  }
  return Promise.all(paths.map(async (page) => {
    const text = await readWikiPage({ scope, page }, workspaceRoot).catch(() => '')
    const { front } = parseWikiFrontMatter(text)
    return {
      ref: { scope, page },
      name: wikiPageName(page),
      title: isMarkdownPage(page) ? wikiPageTitle(text, wikiPageName(page)) : stripPageExtension(wikiPageName(page)),
      ...(front.kind ? { kind: front.kind } : {}),
      ...(front.status ? { status: front.status } : {}),
      ...(front.updated ? { updated: front.updated } : {}),
      tags: front.tags,
    }
  }))
}

export async function readWikiPage(ref: WikiRef, workspaceRoot: string | null): Promise<string> {
  const page = normalizePage(ref.page)
  if (ref.scope === 'system') {
    const bridge = systemDataBridge()
    if (!bridge) throw new Error('The System wiki is only available in the desktop app')
    return bridge.readText(`${WIKI_DIR}/${page}`)
  }
  if (!workspaceRoot) throw new Error('No Workspace is attached')
  return getViewsFS().readFile(`${workspaceRoot}/${WIKI_DIR}/${page}`)
}

export async function writeWikiPage(ref: WikiRef, content: string, workspaceRoot: string | null): Promise<void> {
  const page = normalizePage(ref.page)
  if (!isWikiPagePath(page)) throw new Error('Wiki pages are .md or .txt files')
  if (ref.scope === 'system') {
    const bridge = systemDataBridge()
    if (!bridge) throw new Error('The System wiki is only available in the desktop app')
    return bridge.writeTextAtomic(`${WIKI_DIR}/${page}`, content)
  }
  if (!workspaceRoot) throw new Error('No Workspace is attached')
  const fs = getViewsFS()
  const target = `${workspaceRoot}/${WIKI_DIR}/${page}`
  const slash = target.lastIndexOf('/')
  await fs.mkdir(target.slice(0, slash))
  return fs.writeFile(target, content)
}

/**
 * Resolve a wikilink target from a linking page. Bare targets prefer the
 * linking scope (same-scope file names win), then the other scope, then the
 * shortest path; `system/`/`workspace/` prefixes pin the scope. Null when no
 * listed page matches — the caller offers to create it.
 */
export async function resolveWikiTarget(
  target: string,
  fromScope: WikiScope,
  workspaceRoot: string | null,
): Promise<WikiRef | null> {
  const pinned = wikiLinkScopePrefix(target)
  const effective = pinned ? target.slice(target.indexOf('/') + 1) : target
  const scopes: WikiScope[] = pinned
    ? [pinned]
    : fromScope === 'system' ? ['system', 'workspace'] : ['workspace', 'system']
  const candidates: Array<{ ref: WikiRef; path: string }> = []
  for (const scope of scopes) {
    const pages = await listWikiPages(scope, workspaceRoot)
    for (const entry of pages) {
      if (wikiTargetMatchesPage(effective, entry.ref.page)) candidates.push({ ref: entry.ref, path: entry.ref.page })
    }
    if (candidates.length) break
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
  return candidates[0].ref
}

export interface WikiBacklink {
  ref: WikiRef
  title: string
  /** One line containing the link, for context. */
  excerpt: string
}

/**
 * Pages in either scope whose text links to `page` by file name. The wiki is
 * plain files at human scale, so the scan is a straight read of both scopes —
 * no derived index to rebuild or go stale.
 */
export async function findWikiBacklinks(ref: WikiRef, workspaceRoot: string | null): Promise<ReadonlyArray<WikiBacklink>> {
  const { extractWikiLinks } = await import('./wikilinks')
  const name = wikiPageName(ref.page)
  const out: WikiBacklink[] = []
  for (const scope of ['system', 'workspace'] as const) {
    for (const entry of await listWikiPages(scope, workspaceRoot)) {
      // A page is not its own backlink.
      if (entry.ref.scope === ref.scope && entry.ref.page === normalizePage(ref.page)) continue
      if (!isMarkdownPage(entry.ref.page)) continue
      let text: string
      try {
        text = await readWikiPage(entry.ref, workspaceRoot)
      } catch {
        continue
      }
      const links = extractWikiLinks(text)
      if (!links.some((link) => wikiTargetMatchesPage(link.target, name))) continue
      const line = text.split(/\r?\n/).find((candidate) => candidate.includes(`[[${name}`)) ?? entry.title
      out.push({ ref: entry.ref, title: entry.title, excerpt: line.trim().slice(0, 200) })
    }
  }
  return out
}
