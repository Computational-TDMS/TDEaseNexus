/**
 * The single transient-failure signature (review candidate #5, 2026-08-17).
 *
 * Two classification questions used to carry two private copies of the same
 * regex: agent-runtime's `isRetryable` (may the user re-submit this prompt?)
 * and tdease-extension's `isRetryableToolFailure` (may the model retry this
 * exact tool call within the turn?). Same vocabulary, different input shapes —
 * an Error message versus a tool result's serialized content.
 *
 * The signature set is closed on purpose: transport and infrastructure
 * transients (timeouts, network blips, provider busy responses). Anything not
 * matching it is deterministic — an identical retry cannot help, and the loop
 * guards in tdease-extension rely on that distinction to tell the model to
 * change approach instead of repeating the call.
 */

const TRANSIENT_SIGNATURE = /timeout|network|429|502|503|504|temporar/i

/** May a failed turn-level request be re-submitted as-is? */
export function isTransientError(error: unknown): boolean {
  return TRANSIENT_SIGNATURE.test(error instanceof Error ? error.message : String(error))
}

/**
 * May a failed tool call be retried with identical arguments? A transient
 * failure keeps the exact-call ledger permissive; a deterministic one directs
 * the model to change approach (tdease-extension.ts loop guards).
 */
export function isTransientToolOutput(content: unknown, details: unknown): boolean {
  return TRANSIENT_SIGNATURE.test(JSON.stringify({ content, details }))
}
