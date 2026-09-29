/**
 * Wiki double links — `[[target]]`, `[[target|label]]`, `[[target#heading]]`.
 *
 * The syntax follows the Obsidian convention (documented behavior, no code);
 * the resolution rules are TDEase's own, because a page name spans two scopes
 * (System wiki, Workspace wiki):
 *
 *   - A bare target resolves by FILE NAME (`.md` optional, case-insensitive),
 *     preferring the linking page's own scope, then the other scope, then the
 *     shortest path — so `[[TopFD]]` reaches `method/TopFD.md` without a path.
 *   - A target whose first segment is `system/` or `workspace/` is an explicit
 *     scope escape hatch; the rest is matched as a path suffix.
 *
 * Resolution itself lives in `wiki-library.ts` (it needs the page list); this
 * module owns the pure syntax: parse, and a scanner used for backlinks.
 */

export interface WikiLinkParts {
  /** Raw target as written (scope prefix included), heading stripped. */
  target: string
  /** `heading` when written `[[target#heading]]`, else null. */
  heading: string | null
  /** Display label: the part after `|`, else the target as written. */
  label: string
}

/** An explicit scope prefix on a link target, or null for a bare target. */
export function wikiLinkScopePrefix(target: string): 'system' | 'workspace' | null {
  const first = target.split('/')[0].toLowerCase()
  if (first === 'system' || first === 'workspace') return first
  return null
}

/**
 * Split a raw `[[...]]` inner into its parts. Null when there is no target
 * (an empty or label-only inner is not a link).
 */
export function parseWikiLinkInner(inner: string): WikiLinkParts | null {
  let rest = inner
  let label: string | null = null
  const pipe = lastUnescapedPipe(inner)
  if (pipe >= 0) {
    rest = inner.slice(0, pipe)
    label = inner.slice(pipe + 1).trim() || null
  }
  rest = rest.trim()
  if (!rest) return null
  const hash = rest.indexOf('#')
  let heading: string | null = null
  if (hash >= 0) {
    heading = rest.slice(hash + 1).trim() || null
    rest = rest.slice(0, hash).trim()
  }
  if (!rest) return null
  const fallbackLabel = inner.slice(0, pipe >= 0 ? pipe : inner.length).split('#')[0].trim() || rest
  return { target: rest, heading, label: label ?? fallbackLabel }
}

function lastUnescapedPipe(value: string): number {
  for (let i = value.length - 1; i >= 0; i -= 1) {
    if (value[i] !== '|') continue
    let backslashes = 0
    for (let j = i - 1; j >= 0 && value[j] === '\\'; j -= 1) backslashes += 1
    if (backslashes % 2 === 0) return i
  }
  return -1
}

export interface ParsedWikiLink extends WikiLinkParts {
  /** Offset of the `[[` in the source text. */
  start: number
  /** Offset one past the `]]`. */
  end: number
}

/**
 * Every `[[...]]` occurrence in a wiki page's text, escaped-`\[[`-aware.
 * Used for backlinks ("which pages link here") and by tests; the markdown-it
 * plugin has its own inline-rule implementation of the same grammar.
 */
export function extractWikiLinks(text: string): ReadonlyArray<ParsedWikiLink> {
  const out: ParsedWikiLink[] = []
  let at = text.indexOf('[[', 0)
  while (at >= 0) {
    let backslashes = 0
    for (let j = at - 1; j >= 0 && text[j] === '\\'; j -= 1) backslashes += 1
    const escaped = backslashes % 2 === 1
    const close = text.indexOf(']]', at + 2)
    if (escaped || close < 0 || text.slice(at + 2, close).includes('\n')) {
      at = text.indexOf('[[', at + (escaped ? 1 : 2))
      continue
    }
    const parts = parseWikiLinkInner(text.slice(at + 2, close))
    if (parts) out.push({ ...parts, start: at, end: close + 2 })
    at = text.indexOf('[[', close + 2)
  }
  return out
}

/**
 * Does `pagePath` (a wiki-root-relative page path, extension included) match
 * a link target under the suffix rules? A bare target matches the file NAME;
 * a target with `/` matches the path SUFFIX. Case-insensitive, `.md`/`.txt`
 * optional on either side.
 */
export function wikiTargetMatchesPage(target: string, pagePath: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\.(?:md|txt)$/i, '').toLowerCase()
  const wanted = normalize(target)
  const candidate = normalize(pagePath)
  if (!wanted) return false
  if (!wanted.includes('/')) {
    const slash = candidate.lastIndexOf('/')
    return slash >= 0 ? candidate.slice(slash + 1) === wanted : candidate === wanted
  }
  return candidate === wanted || candidate.endsWith(`/${wanted}`)
}
