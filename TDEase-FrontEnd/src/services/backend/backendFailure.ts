/**
 * The transport half of a failed Backend HTTP response: reading the failure
 * envelope out of a `Response` and minting the domain `BackendFailure`.
 *
 * The Backend answers *every* failure with the envelope from
 * FAILURE-CONTRACT.md §1 — `{error:{code, domain, message, remedy, retryable,
 * details?, cause?}}` — and `app/` contains zero bare `raise HTTPException`
 * to make that true. The client used to read none of it: six `if (!response.ok)`
 * sites each threw `new Error(\`GET ${path}: ${status}\`)` without ever calling
 * `response.json()`, so `remedy` (what the user should do), `retryable`
 * (whether the Agent should try again) and `code` (what to branch on) were
 * discarded at the wire.
 *
 * That is how a real outage stayed invisible: the Backend rejected every Run
 * commit with `RUN_MODE_MISMATCH` and a remedy that named the exact fix, and
 * the UI showed `POST /api/v2/runs: 400`.
 *
 * `BackendFailure` itself (and the `CLIENT_` code vocabulary for responses
 * that carry no envelope) lives in `studio/domain/backend-failure.ts`, next to
 * the `StructuredError` it wraps — this module is the only place that
 * constructs it.
 */

import { BackendFailure, CLIENT_ERROR_CODES } from '@/studio/domain/backend-failure'
import { isStructuredError, type StructuredError } from '@/studio/domain/errors'

/**
 * Read a non-OK response and throw the failure it describes.
 *
 * `context` names the call in prose (`'GET /api/v2/runs'`) and is used only
 * when the response is unreadable, so the minted message can still say what
 * was being attempted.
 *
 * Never returns.
 */
export async function throwBackendFailure(response: Response, context: string): Promise<never> {
  throw await backendFailureFrom(response, context)
}

/** As `throwBackendFailure`, but hands the failure back instead of throwing it. */
export async function backendFailureFrom(response: Response, context: string): Promise<BackendFailure> {
  const envelope = await readEnvelope(response)
  if (envelope) return new BackendFailure(envelope, true, response.status)

  return new BackendFailure(
    {
      code: CLIENT_ERROR_CODES.responseNotAnEnvelope,
      // 'backend' is the honest domain: the Backend is the thing that did not
      // answer in contract. It is not a claim about which Backend code applies.
      domain: 'backend',
      message: `${context} failed with HTTP ${response.status} and no readable failure envelope.`,
      remedy:
        'Check that the Backend is running and that no proxy is rewriting its responses, then retry. '
        + 'The Backend log holds the real cause.',
      // A response we could not read tells us nothing about whether retrying
      // helps. `true` is the safer default here: the common causes -- a
      // Backend still starting, a transient proxy fault -- do clear.
      retryable: true,
      details: { status: response.status, context },
    },
    false,
    response.status,
  )
}

/**
 * Extract the envelope, or `undefined` if this response does not carry one.
 *
 * Deliberately total: a body that is empty, not JSON, already consumed, or
 * JSON of the wrong shape all mean the same thing to the caller — there is no
 * Backend account of this failure — and none of them should replace the
 * original failure with a parse error.
 */
async function readEnvelope(response: Response): Promise<StructuredError | undefined> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined
  const error = (payload as { error?: unknown }).error
  return isStructuredError(error) ? error : undefined
}
