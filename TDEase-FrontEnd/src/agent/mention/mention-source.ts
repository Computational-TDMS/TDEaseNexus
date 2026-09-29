/**
 * @-mention resolution — turns a parsed `MentionToken` into the
 * model-facing `ResolvedMention` that `mention-context.ts` renders into the
 * frozen snapshot.
 *
 * Headless: the resolver takes a `MentionSources` interface, not the stores
 * themselves, so a turn replayed from a snapshot resolves the identical text
 * from identical inputs and the renderer-side wiring (`useMentionCandidates`,
 * `useAgentTurn`) is the only place that knows about Pinia/Electron.
 *
 * Resolution is best-effort and never throws. A token that names something the
 * Workspace no longer has (a deleted file, a trashed Run) resolves to a
 * `not found` placeholder rather than failing the turn — the message still
 * sends, the `@token` still appears in the text, and the `### Referenced`
 * section says plainly that the entity could not be found. Lying to the model
 * (silently dropping the reference, or pretending it resolved) is worse than
 * telling it the truth.
 */

import type { MentionKind, MentionToken } from './mention-token'

/** One resolved @-mention, ready to render into the snapshot. */
export interface ResolvedMention {
  readonly token: MentionToken
  /** A short, human-readable label for the entity (a Run title, a filename). */
  readonly label: string
  /** Optional longer body — file contents, a Run summary, a skill description. */
  readonly body?: string
  /** `false` when the named entity could not be found. */
  readonly found: boolean
}

/**
 * The resolvers, one per kind. Each returns `null` on not-found so the
 * caller can substitute a `found: false` placeholder uniformly; throwing here
 * would make a missing file a turn-level failure, which it must not be.
 */
export interface MentionSources {
  resolveRun(refId: string): Promise<ResolvedMention | null>
  resolveFile(refId: string): Promise<ResolvedMention | null>
  resolveSkill(refId: string): Promise<ResolvedMention | null>
}

/** Cap on how much of a referenced file's text lands in the snapshot. */
export const FILE_BODY_BYTE_CAP = 8 * 1024

/** Resolve one token, never throwing; unknown/missing → `found: false`. */
export async function resolveMention(
  token: MentionToken,
  sources: MentionSources,
): Promise<ResolvedMention> {
  const resolved = await dispatch(token, sources).catch(() => null)
  if (resolved) return resolved
  return {
    token,
    label: notFoundLabel(token.kind, token.refId),
    found: false,
  }
}

async function dispatch(
  token: MentionToken,
  sources: MentionSources,
): Promise<ResolvedMention | null> {
  switch (token.kind) {
    case 'run': return sources.resolveRun(token.refId)
    case 'file': return sources.resolveFile(token.refId)
    case 'skill': return sources.resolveSkill(token.refId)
  }
}

/** Resolve every token, preserving order and de-duplication from the parser. */
export async function resolveMentions(
  tokens: ReadonlyArray<MentionToken>,
  sources: MentionSources,
): Promise<ResolvedMention[]> {
  return Promise.all(tokens.map((token) => resolveMention(token, sources)))
}

export function notFoundLabel(kind: MentionKind, refId: string): string {
  return `${kind} ${refId} (not found)`
}

/**
 * Truncate file text to `cap` bytes, marking the cut so the model can tell a
 * partial file from a complete one. Exported so the file resolver and its test
 * agree on the truncation marker.
 */
export function capFileBody(text: string, cap: number = FILE_BODY_BYTE_CAP): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n\n… (truncated at ${cap} bytes)`
}
