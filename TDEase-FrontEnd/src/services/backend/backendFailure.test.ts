import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackendFailure, CLIENT_ERROR_CODES } from '@/studio/domain/backend-failure'
import { backendFailureFrom } from './backendFailure'
import { TDEaseClient } from './backend'

function respond(body: BodyInit | null, status = 400, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

const envelope = {
  error: {
    code: 'RUN_MODE_MISMATCH',
    domain: 'run',
    message: "the Run commit no longer accepts a caller-declared 'mode' field",
    remedy: "Remove 'mode' from the commit. The Backend selects the materialization strategy itself.",
    retryable: false,
  },
}

describe('reading the Backend failure envelope', () => {
  it('carries the Backend’s own code, remedy and retryability through', async () => {
    const failure = await backendFailureFrom(respond(JSON.stringify(envelope)), 'POST /api/v2/runs')
    expect(failure.fromEnvelope).toBe(true)
    expect(failure.structured.code).toBe('RUN_MODE_MISMATCH')
    expect(failure.structured.domain).toBe('run')
    expect(failure.structured.remedy).toContain("Remove 'mode'")
    expect(failure.structured.retryable).toBe(false)
    expect(failure.status).toBe(400)
  })

  it('stays an Error, with a message worth showing', async () => {
    const failure = await backendFailureFrom(respond(JSON.stringify(envelope)), 'POST /api/v2/runs')
    // Call sites that still surface a bare string (`stores/runs.ts`) get the
    // code and the sentence instead of the old `POST /api/v2/runs: 400`.
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toContain('RUN_MODE_MISMATCH')
    expect(failure.message).toContain('no longer accepts')
  })

  /**
   * Every branch below must produce a well-formed StructuredError *and* say it
   * did not come from the Backend. Passing off a client guess as a Backend
   * verdict is the failure mode this contract exists to prevent.
   */
  describe('when the response is not a contract envelope', () => {
    const cases: Array<[string, Response]> = [
      ['an HTML proxy page', respond('<html>502 Bad Gateway</html>', 502, 'text/html')],
      ['an empty body', respond(null, 503)],
      ['JSON without an error key', respond(JSON.stringify({ detail: 'nope' }), 400)],
      ['an envelope missing remedy', respond(JSON.stringify({ error: { code: 'X', domain: 'run', message: 'm', retryable: false } }), 400)],
      ['an envelope with an unknown domain', respond(JSON.stringify({ error: { ...envelope.error, domain: 'wat' } }), 400)],
    ]

    for (const [name, response] of cases) {
      it(`mints a client-side failure for ${name}`, async () => {
        const failure = await backendFailureFrom(response, 'POST /api/v2/runs')
        expect(failure.fromEnvelope).toBe(false)
        expect(failure.structured.code).toBe(CLIENT_ERROR_CODES.responseNotAnEnvelope)
        expect(failure.structured.code.startsWith('CLIENT_')).toBe(true)
        expect(failure.structured.remedy.length).toBeGreaterThan(0)
        expect(failure.structured.message).toContain('POST /api/v2/runs')
      })
    }

    it('records the status it could not interpret', async () => {
      const failure = await backendFailureFrom(respond(null, 503), 'GET /api/v2/runs')
      expect(failure.status).toBe(503)
      expect(failure.structured.details).toMatchObject({ status: 503 })
    })
  })
})

describe('the client surfaces a real Backend rejection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(JSON.stringify(envelope), 400)))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * The regression this whole module exists for. The Backend rejected every
   * Run commit with `RUN_MODE_MISMATCH` and a remedy naming the exact fix; the
   * client turned that into `POST /api/v2/runs: 400` and the outage was
   * invisible. This asserts the remedy now reaches the caller.
   */
  it('gives the caller the code and the remedy, not just a status', async () => {
    const client = new TDEaseClient('http://backend')
    const failure = await client
      .submitPlan({
        runId: 'run_abc',
        idempotencyKey: 'ik_abc',
        workspaceId: 'ws',
        workspaceTreeHash: 'sha256:t',
        workspaceFiles: [],
        excludedFiles: [],
        snakefile: 'rule all:\n    input: []\n',
        materializationStrategy: 'local_workspace_hardlink',
        targets: [],
        cores: 4,
      })
      .then(() => undefined)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BackendFailure)
    const backendFailure = failure as BackendFailure
    expect(backendFailure.fromEnvelope).toBe(true)
    expect(backendFailure.structured.code).toBe('RUN_MODE_MISMATCH')
    expect(backendFailure.structured.remedy).toContain("Remove 'mode'")
  })
})
