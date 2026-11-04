/**
 * Renders resolved @-mentions into the frozen turn snapshot.
 *
 * This is the model-facing half of the @-mention feature, parallel to what
 * `composeTurnContext` was for focus — but the inputs are *explicit references
 * the user typed*, not a focus derived from the active document. That is the
 * whole point of the rewrite: the model reads what the user asked it to read,
 * nothing inferred.
 *
 * Like `composeTurnContext`, this returns `undefined` for an empty list so a
 * mention-less turn assembles exactly the snapshot it assembled before
 * @-mentions existed — the digest does not move for a no-op, and a replay
 * reads the same bytes.
 */

import type { ResolvedMention } from './mention-source'
import { tokenToText } from './mention-token'

/**
 * The heading the references section carries in the frozen snapshot. Exported
 * as the anchor a replay — or a human reading
 * `sessions/<id>/snapshots/<digest>.md` — greps for to see what the user
 * explicitly referenced.
 */
export const REFERENCED_SECTION_HEADING = '### Referenced'

/**
 * The section that lands verbatim in the per-turn prompt snapshot. Returns
 * `undefined` when there are no resolved references, so a turn with no
 * @-mentions is byte-identical to one before this feature existed.
 *
 * Each reference renders as a list item: the canonical token, a label, and —
 * when the resolver produced a body (a file's text, a skill's description) —
 * a fenced block underneath. Not-found references are stated plainly rather
 * than omitted, so the model is never left to guess why a `@token` in the
 * message has no corresponding context.
 */
export function composeReferencedContext(
  resolved: ReadonlyArray<ResolvedMention>,
): string | undefined {
  if (resolved.length === 0) return undefined
  const lines: string[] = [REFERENCED_SECTION_HEADING, '']
  for (const ref of resolved) {
    const token = tokenToText(ref.token)
    if (!ref.found) {
      lines.push(`- ${token} — ${ref.label}`)
      continue
    }
    if (ref.body && ref.body.trim()) {
      lines.push(`- ${token} — ${ref.label}`)
      lines.push('  ```')
      for (const bodyLine of ref.body.split('\n')) lines.push(`  ${bodyLine}`)
      lines.push('  ```')
    } else {
      lines.push(`- ${token} — ${ref.label}`)
    }
  }
  return lines.join('\n')
}
