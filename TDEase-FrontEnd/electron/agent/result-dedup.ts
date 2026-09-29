/**
 * ResultDeduplicator — keeps byte-identical tool results out of the model
 * context twice within one agent session.
 *
 * Why: session audits showed large static payloads (node capability cards,
 * skill bodies, engine logs) re-read across turns; every repeat rides the
 * context until compaction and is re-billed on each subsequent request. An
 * exact-content hash never fires on "similar" output — only on bytes the
 * conversation already contains verbatim, so the placeholder is always
 * truthful: the full text is still in context above.
 *
 * Escape hatch: pass `force` when the model explicitly asked to see the
 * result again (`refresh: true` in tool args); the gateway strips the flag
 * before the underlying tool sees it.
 */

import { createHash } from 'node:crypto'

// Below this size a repeat is cheaper than the placeholder explaining it.
const MIN_DEDUP_CHARS = 400
const SNIPPET_CHARS = 120

export class ResultDeduplicator {
  private readonly seen = new Map<string, { tool: string; chars: number }>()

  /**
   * The text to inject — the placeholder when the exact same text was already
   * injected once in this session, the text itself otherwise.
   */
  filter(text: string, tool: string, force = false): string {
    if (force || text.length < MIN_DEDUP_CHARS) return text
    const hash = createHash('sha256').update(text, 'utf8').digest('hex')
    const first = this.seen.get(hash)
    if (!first) {
      this.seen.set(hash, { tool, chars: text.length })
      return text
    }
    const snippet = text.slice(0, SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
    return (
      `[duplicate suppressed] Byte-identical to the ${first.chars}-character result of \`${first.tool}\` ` +
      `earlier in this conversation; it was not injected again. That earlier copy is still in context — ` +
      `it starts with: "${snippet}…". Call again with {"refresh": true} to receive the full text.`
    )
  }
}
