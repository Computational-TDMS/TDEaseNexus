/**
 * Wiki page front matter — the small flat `--- key: value ---` block.
 *
 * Deliberately NOT a YAML parser and NOT a schema: a wiki page is a plain
 * markdown file the user and the agent both hand-edit, so the parser reads the
 * flat block tolerantly, preserves what it does not understand, and never
 * rejects a page. What sections and fields a page SHOULD carry is prompt
 * policy (system/prompts/internal/wiki_policy.md), not code.
 */

export interface WikiFrontMatter {
  title?: string
  kind?: string
  status?: string
  updated?: string
  tags: string[]
  evidence: string[]
  /** Every other `key: value` line, order preserved. */
  extra: ReadonlyArray<{ key: string; value: string }>
}

const FRONT_MATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function parseValue(raw: string): string | string[] {
  const value = raw.trim()
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  }
  return value.replace(/^['"]|['"]$/g, '')
}

/** Parse the front-matter block. `hasFrontMatter` is false for a plain page. */
export function parseWikiFrontMatter(text: string): { front: WikiFrontMatter; body: string; hasFrontMatter: boolean } {
  const match = FRONT_MATTER.exec(text)
  if (!match) {
    return { front: { tags: [], evidence: [], extra: [] }, body: text, hasFrontMatter: false }
  }
  const front: WikiFrontMatter = { tags: [], evidence: [], extra: [] }
  const extra: Array<{ key: string; value: string }> = []
  const known = new Set(['title', 'kind', 'status', 'updated', 'tags', 'evidence'])
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = parseValue(line.slice(separator + 1))
    if (key === 'title' && typeof value === 'string') front.title = value
    else if (key === 'kind' && typeof value === 'string') front.kind = value
    else if (key === 'status' && typeof value === 'string') front.status = value
    else if (key === 'updated' && typeof value === 'string') front.updated = value
    else if (key === 'tags') front.tags = Array.isArray(value) ? value : value ? [value] : []
    else if (key === 'evidence') front.evidence = Array.isArray(value) ? value : value ? [value] : []
    else if (!known.has(key)) extra.push({ key, value: line.slice(separator + 1).trim() })
  }
  front.extra = extra
  return { front, body: text.slice(match[0].length), hasFrontMatter: true }
}

/**
 * The display title of a page: front-matter `title`, else the first `#`
 * heading, else the caller's filename-derived fallback.
 */
export function wikiPageTitle(text: string, filenameFallback: string): string {
  const { front, body } = parseWikiFrontMatter(text)
  if (front.title) return front.title
  const heading = body.match(/^#\s+(.+?)\s*$/m)
  if (heading) return heading[1].trim()
  return filenameFallback.replace(/\.md$/i, '')
}

/**
 * Render a new page's full text: a minimal front-matter block (only fields
 * with values) plus the body. Used by the "new page" flow; edits of existing
 * pages write the text the user had in the editor, verbatim.
 */
export function renderWikiPage(input: {
  title: string
  kind?: string
  tags?: ReadonlyArray<string>
  body: string
}): string {
  const lines = ['---', `title: ${input.title}`]
  if (input.kind) lines.push(`kind: ${input.kind}`)
  lines.push(`updated: ${new Date().toISOString().slice(0, 10)}`)
  if (input.tags?.length) lines.push(`tags: [${input.tags.join(', ')}]`)
  lines.push('---', '')
  return `${lines.join('\n')}${input.body.replace(/^\n+/, '')}\n`
}
