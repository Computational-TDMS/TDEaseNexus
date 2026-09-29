/**
 * @-mention tokens — the explicit-reference model that replaced the implicit
 * "bounded focus" axis (`AGENT-CONTRACT.md` §3, rewritten).
 *
 * The difference that matters is in the word *explicit*. A user types
 * `@run:abc123` into the message; the token survives in the text the model
 * reads, editable and deletable like any other word; only the entities the
 * user actually named are resolved. Nothing is derived from the active
 * document, so nothing can be injected the user never asked for. That keeps
 * the model's context on the right side of the hard rule "constraint in the
 * prompt layer, not the framework layer".
 *
 * This module is headless like the rest of `src/agent/` — no Vue, no Pinia,
 * no Electron — so a replayed turn parses the identical tokens from the
 * identical text, and the snapshot a replay reads names exactly what the
 * user typed.
 *
 * Grammar: `@<kind>:<refId>`.
 *   - kind ∈ {run, file, skill}
 *   - refId is path/id-shaped `[A-Za-z0-9_./-]+`, with one extension: skill ids
 *     are `<scope>:<rest>` (e.g. `workspace:qc`), because a workspace and a
 *     system skill can share a name and the picker disambiguates with a `scope`
 *     half. So a skill refId may contain a single extra `:` segment. Allowing
 *     `:` for every kind would let `@run:a:b` parse ambiguously; instead the
 *     scoped case is matched by its own alternation, so `:` is legal only where
 *     it is meaningful. Everything outside the char class terminates the token,
 *     so `@file:a/b.txt,` parses to `a/b.txt`.
 */

/** The entity kinds a user may @-mention. */
export type MentionKind = 'run' | 'file' | 'skill'

/** A single parsed @-mention. `refId` is the raw, untyped identifier. */
export interface MentionToken {
  readonly kind: MentionKind
  readonly refId: string
}

const KINDS: ReadonlySet<MentionKind> = new Set(['run', 'file', 'skill'])
const REF_ID_CHARS = '[A-Za-z0-9_./-]+'

/**
 * Two alternations, not one:
 *   1. `@skill:<scope>:<rest>` — the refId shape that legitimately contains a
 *      `:`. Skill uses a `scope` half (`system`|`workspace`) because a
 *      workspace and a system skill can share a name, so the picker emits
 *      `scope:name` and the grammar must carry the colon through.
 *   2. `@<kind>:<refId>` — the common path/id form (run/file, and bare skill
 *      ids without a scope).
 *
 * The scoped alternation is tried first so `@skill:workspace:qc` matches the
 * whole thing rather than stopping at `workspace`. `g` so the loop finds every
 * token, not just the first; anchored on `@` + a known kind + `:`, so an email
 * or a bare `@someone` never matches.
 */
export const MENTION_REGEX = new RegExp(
  `@skill:([A-Za-z0-9_-]+):([A-Za-z0-9_.-]+)` // @skill:<scope>:<rest>
  + `|@(run|file|skill):(${REF_ID_CHARS})`, // @<kind>:<refId>
  'g',
)

export function isMentionKind(value: string): value is MentionKind {
  return KINDS.has(value as MentionKind)
}

/** All @-mentions in `text`, in order of appearance, de-duplicated. */
export function parseMentions(text: string): MentionToken[] {
  if (!text || !text.includes('@')) return []
  const seen = new Set<string>()
  const out: MentionToken[] = []
  // Reset lastIndex because MENTION_REGEX is /g and reused across calls.
  MENTION_REGEX.lastIndex = 0
  for (const match of text.matchAll(MENTION_REGEX)) {
    // Alternation 1: @skill:<scope>:<rest> → refId is `<scope>:<rest>`.
    if (match[1] !== undefined && match[2] !== undefined) {
      const kind = 'skill' as MentionKind
      const refId = `${match[1]}:${match[2]}`
      const key = `${kind}:${refId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind, refId })
      continue
    }
    // Alternation 2: @<kind>:<refId>
    const kind = match[3] as MentionKind | undefined
    const refId = match[4]
    if (!kind || refId === undefined) continue
    const key = `${kind}:${refId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, refId })
  }
  return out
}

/** The canonical text form a token takes inside a message: `@kind:refId`. */
export function tokenToText(token: MentionToken): string {
  return `@${token.kind}:${token.refId}`
}

/**
 * Replace the in-progress `@`-mention fragment a user is typing with the
 * canonical token text, returning the new full string and the caret position
 * to land after the inserted token.
 *
 * `fragment` is the text from the triggering `@` up to (not including) the
 * caret — e.g. `@run` or `@fi`. We replace it (and only it) so an existing
 * partial word never doubles up. A trailing space is appended and the caret
 * follows it, so the user can keep typing their question without a manual
 * space, exactly as the `/`-command completion already does.
 */
export function insertMentionToken(input: {
  text: string
  fragmentStart: number
  fragmentEnd: number
  token: MentionToken
}): { text: string; caret: number } {
  const before = input.text.slice(0, input.fragmentStart)
  const after = input.text.slice(input.fragmentEnd)
  const inserted = `${tokenToText(input.token)} `
  const text = `${before}${inserted}${after}`
  return { text, caret: input.fragmentStart + inserted.length }
}

/**
 * Locate the @-mention fragment the caret is currently inside, if any.
 *
 * A fragment starts at the most recent `@` before the caret (with no
 * intervening whitespace — a space closes the mention) and runs to the caret.
 * Returns the half-open range `[start, end]` where `start` is the `@` index
 * and `end` is the caret, plus the text after the `@` for filtering. Used by
 * the picker to know what to replace on confirm.
 */
export function mentionFragmentAtCaret(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  return fragmentAtCaret(text, caret, '@')
}

/**
 * Locate the `$`-skill-picker fragment the caret is currently inside, if any.
 * `$` is the skill-only trigger (parallel to `@` for run/file). The
 * persisted token is still `@skill:<name>` — `$` only opens the picker, so
 * this function mirrors `mentionFragmentAtCaret` keyed on `$` instead of `@`.
 */
export function skillFragmentAtCaret(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  return fragmentAtCaret(text, caret, '$')
}

/**
 * Shared caret-fragment lookup for a single-character picker trigger. Walks
 * back from the caret to the most recent `trigger`, stopping at whitespace; a
 * space (or a second trigger char) inside the fragment closes it. Returns the
 * half-open range `[start, end]` plus the text after the trigger for ranking.
 */
function fragmentAtCaret(
  text: string,
  caret: number,
  trigger: string,
): { start: number; end: number; query: string } | null {
  if (caret <= 0) return null
  let i = caret
  while (i > 0) {
    const ch = text[i - 1]
    if (ch === trigger) {
      const start = i - 1
      // The trigger must not itself be preceded by a word char, or it is
      // mid-token (e.g. an email `a@b`), not a picker trigger.
      if (start > 0 && /\S/.test(text[start - 1]) && !/\s/.test(text[start - 1])) {
        // allow if preceding char is itself whitespace-free but not a letter/digit
        // — be permissive: only reject when clearly mid-identifier
      }
      const query = text.slice(start + 1, caret)
      // A space or another trigger char inside the fragment means it was closed.
      if (/\s/.test(query) || query.includes(trigger)) return null
      return { start, end: caret, query }
    }
    if (/\s/.test(ch)) return null
    i -= 1
  }
  return null
}
