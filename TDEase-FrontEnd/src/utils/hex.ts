/**
 * Hex-encode a digest (or any byte buffer).
 *
 * This is the one line every `crypto.subtle.digest('SHA-256', ...)` caller
 * in this codebase re-typed by hand (`src/agent/prompt/digest.ts`,
 * `src/studio/use-cases/prepare-analysis.ts`, `src/services/workspace/tree-hash.ts`).
 * Those call sites differ in signature and injectability on purpose
 * (one is an injectable port with a branded return type, others are plain
 * async functions, one takes bytes instead of a string) — this helper only
 * consolidates the byte-array-to-hex-string step they all share, not the
 * digest call or their surrounding shape.
 */
export function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
