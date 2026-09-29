/**
 * The domain face of a failed Backend HTTP call.
 *
 * The class and the client-minted code vocabulary live here — pure, next to
 * the `StructuredError` they wrap — so every layer (components, stores,
 * services, tests) can branch on `instanceof BackendFailure` without opening
 * a value import into the HTTP adapter layer (`services/backend/`). The
 * transport half (reading the envelope out of a `Response`) stays in
 * `services/backend/backendFailure.ts`, which is the only place that mints
 * instances.
 *
 * ## Authoritative vs. client-minted
 *
 * A failure reaching that module has one of two very different origins, and
 * collapsing them would lie:
 *
 * - The response carried a valid envelope. Then `code` is a member of the
 *   Backend's closed enum and the whole `StructuredError` is *its* statement.
 * - It did not — a proxy 502 page, a truncated body, HTML from a dev server,
 *   a network stack that never reached the Backend at all. Then nothing the
 *   Backend declares is available, and any code we produce is the client's own
 *   observation about the transport.
 *
 * The second case still gets a well-formed `StructuredError`, because every
 * consumer downstream is entitled to one — but its code is deliberately
 * prefixed `CLIENT_` so it can never be mistaken for, or collide with, a
 * member of the Backend enum. Minting a plausible-looking `BACKEND_INTERNAL`
 * would be exactly the kind of confident falsehood this contract exists to
 * prevent.
 */

import type { StructuredError } from '@/studio/domain/errors'

/**
 * Codes the transport side mints itself. Never sent by the Backend, never
 * members of its enum; the `CLIENT_` prefix is what guarantees the two
 * namespaces stay disjoint.
 */
export const CLIENT_ERROR_CODES = {
  /** The response was not the contract envelope, so the Backend's own account of the failure is unavailable. */
  responseNotAnEnvelope: 'CLIENT_BACKEND_RESPONSE_UNREADABLE',
} as const

export class BackendFailure extends Error {
  /** Always well-formed, whatever the response looked like. */
  readonly structured: StructuredError

  /**
   * `true` when `structured` is the Backend's own envelope. `false` when the
   * client minted it because the response could not be read as one — treat the
   * code as a transport observation, not a Backend verdict.
   */
  readonly fromEnvelope: boolean

  readonly status: number

  constructor(structured: StructuredError, fromEnvelope: boolean, status: number) {
    // Keep `.message` useful for the many call sites that still surface a bare
    // string (`stores/runs.ts` does `cause instanceof Error ? cause.message`).
    super(`[${structured.code}] ${structured.message}`)
    this.name = 'BackendFailure'
    this.structured = structured
    this.fromEnvelope = fromEnvelope
    this.status = status
  }
}
