/**
 * side-chat-drafts — the one-shot handoff of a seeded composer draft from the
 * selection flow to the side-chat panel.
 *
 * The selection pill (Transcript) creates the side session and opens its tab;
 * the panel component mounts later in the same tick chain. Tab keys carry
 * identity, not payloads, so the quoted selection travels here: a Map the
 * panel TAKES from exactly once on mount (consume-once semantics — re-opening
 * a side chat must never resurrect an old quote).
 */
const pending = new Map<string, string>()

export function setSideChatDraft(sessionId: string, text: string): void {
  pending.set(sessionId, text)
}

export function takeSideChatDraft(sessionId: string): string | undefined {
  const text = pending.get(sessionId)
  pending.delete(sessionId)
  return text
}
