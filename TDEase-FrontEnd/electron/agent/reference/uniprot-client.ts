/**
 * Thin client for the official UniProt REST API. It builds the canonical URL
 * for a resource/id and returns the body plus the provenance headers that the
 * read-through store records (release via `x-total-length`/`link`, etag,
 * last-modified). `fetch` is injected so the port is network-free in tests.
 *
 * Constraints (the plan's "controlled escape hatch"): host is fixed to the
 * injected baseUrl, GET only, AbortSignal honored, response size bounded.
 */
import type { UniProtFormat, UniProtResource } from '../../../src/studio/ports/reference-command-port'

export interface UniProtFetchedEntry {
  status: number
  mediaType: string
  body: string
  etag: string | null
  lastModified: string | null
  release: string | null
  digest: string
}

export interface UniProtClient {
  getEntry(
    resource: UniProtResource,
    id: string,
    fields: ReadonlyArray<string> | undefined,
    format: UniProtFormat | undefined,
    signal?: AbortSignal,
  ): Promise<UniProtFetchedEntry>
  search(
    resource: UniProtResource,
    query: string,
    fields: ReadonlyArray<string> | undefined,
    format: UniProtFormat | undefined,
    cursor: string | undefined,
    pageSize: number | undefined,
    includeIsoform: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<UniProtSearchPage>
  /** The official ID-mapping lifecycle. */
  submitMapping(from: string, to: string, ids: ReadonlyArray<string>, signal?: AbortSignal): Promise<{ jobId: string }>
  mappingStatus(jobId: string, signal?: AbortSignal): Promise<{ jobStatus: string }>
  mappingResults(jobId: string, cursor: string | undefined, signal?: AbortSignal): Promise<UniProtSearchPage>
  /** The EBI Job Dispatcher ncbiblast lifecycle (BLAST against UniProtKB). */
  submitBlast(params: BlastSubmitParams, signal?: AbortSignal): Promise<{ jobId: string }>
  blastStatus(jobId: string, signal?: AbortSignal): Promise<{ jobStatus: string }>
  blastResults(jobId: string, signal?: AbortSignal): Promise<{ body: string; digest: string }>
}

/** Form parameters the Job Dispatcher `ncbiblast/run` accepts. */
export interface BlastSubmitParams {
  sequence: string
  database: string
  program: string
  matrix: string
  /** E-value threshold (expect). */
  threshold: number
  /** Comma-separated NCBI taxonomy ids restricting the search (empty = none). */
  taxids: string
  /** Contact email required by the Job Dispatcher. */
  email: string
}

export interface UniProtSearchPage {
  body: string
  digest: string
  mediaType: string
  /** The next cursor, parsed from the Link header's rel="next". Null = exhausted. */
  nextCursor: string | null
  release: string | null
  /** Whether the Link header advertised another page. */
  hasNext: boolean
}

const FORMAT_MEDIA: Record<UniProtFormat, string> = {
  json: 'application/json',
  tsv: 'text/tab-separated-values',
  fasta: 'text/x-fasta',
  xml: 'application/xml',
  txt: 'text/plain',
  gff: 'text/x-gff',
  rdf: 'application/rdf+xml',
  normalized: 'application/json',
}

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
/** Cap the Retry-After wait so a hostile/misconfigured server can't stall a read indefinitely. */
const MAX_RETRY_AFTER_MS = 30_000

export function createUniProtClient(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch,
  /** EBI Job Dispatcher base (hosts the ncbiblast service UniProt BLAST uses). */
  blastBaseUrl: string = 'https://www.ebi.ac.uk',
): UniProtClient {
  /**
   * Wrap fetch with HTTP 429 handling: UniProt throttles transiently and tells
   * the client how long to wait via Retry-After (seconds or an HTTP-date). We
   * honour it once, bounded, then retry — a throttle is not a data error and
   * must not fail a read that would otherwise succeed a second later.
   */
  const guardedFetch: typeof fetchImpl = async (input, init) => {
    const first = await fetchImpl(input, init)
    if (first.status !== 429) return first
    const waitMs = parseRetryAfter(first.headers.get('retry-after'))
    if (waitMs === null) {
      throw Object.assign(new Error('UNIPROT_RATE_LIMITED: 429 with no Retry-After'), { status: 429 })
    }
    await sleep(Math.min(waitMs, MAX_RETRY_AFTER_MS), init?.signal ?? undefined)
    const retried = await fetchImpl(input, init)
    if (retried.status === 429) {
      throw Object.assign(new Error('UNIPROT_RATE_LIMITED: still throttled after retry'), { status: 429 })
    }
    return retried
  }

  return {
    async getEntry(resource, id, fields, format, signal): Promise<UniProtFetchedEntry> {
      const fmt = format ?? 'json'
      const url = buildEntryUrl(baseUrl, resource, id, fields, fmt)
      const response = await guardedFetch(url, {
        method: 'GET',
        signal,
        headers: { accept: FORMAT_MEDIA[fmt] },
      })
      if (response.status === 404) {
        throw Object.assign(new Error(`UNIPROT_NOT_FOUND: ${resource}/${id}`), { status: 404 })
      }
      if (!response.ok) {
        throw Object.assign(new Error(`UNIPROT_HTTP_${response.status}: ${resource}/${id}`), { status: response.status })
      }
      const body = await response.text()
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
        throw new Error(`UNIPROT_RESPONSE_TOO_LARGE: ${resource}/${id}`)
      }
      const etag = response.headers.get('etag')
      const lastModified = response.headers.get('last-modified')
      const release = extractRelease(response)
      const { createHash } = await import('node:crypto')
      const digest = createHash('sha256').update(body).digest('hex')
      return {
        status: response.status,
        mediaType: response.headers.get('content-type') ?? FORMAT_MEDIA[fmt],
        body,
        etag,
        lastModified,
        release,
        digest,
      }
    },

    async search(resource, query, fields, format, cursor, pageSize, includeIsoform, signal): Promise<UniProtSearchPage> {
      const fmt = format ?? 'json'
      const url = buildSearchUrl(baseUrl, resource, query, fields, fmt, cursor, pageSize, includeIsoform)
      return fetchPage(guardedFetch, url, fmt, signal)
    },

    async submitMapping(from, to, ids, signal): Promise<{ jobId: string }> {
      const url = `${baseUrl.replace(/\/$/, '')}/idmapping/run`
      // The official service takes form-encoded from/to/ids.
      const body = new URLSearchParams({ from, to, ids: ids.join(',') })
      const response = await guardedFetch(url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      })
      if (!response.ok) {
        throw Object.assign(new Error(`UNIPROT_MAPPING_SUBMIT_${response.status}`), { status: response.status })
      }
      const json = JSON.parse(await response.text()) as { jobId?: string }
      if (!json.jobId) throw new Error('UNIPROT_MAPPING_NO_JOB_ID')
      return { jobId: json.jobId }
    },

    async mappingStatus(jobId, signal): Promise<{ jobStatus: string }> {
      const url = `${baseUrl.replace(/\/$/, '')}/idmapping/status/${encodeURIComponent(jobId)}`
      const response = await guardedFetch(url, { method: 'GET', signal, headers: { accept: 'application/json' } })
      if (!response.ok) {
        throw Object.assign(new Error(`UNIPROT_MAPPING_STATUS_${response.status}`), { status: response.status })
      }
      const json = JSON.parse(await response.text()) as { jobStatus?: string }
      return { jobStatus: json.jobStatus ?? 'UNKNOWN' }
    },

    async mappingResults(jobId, cursor, signal): Promise<UniProtSearchPage> {
      // After FINISHED the results endpoint serves paginated {results, pageInfo}
      // and advertises the next cursor in the Link header, exactly like search.
      const url = `${baseUrl.replace(/\/$/, '')}/idmapping/results/${encodeURIComponent(jobId)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
      return fetchPage(guardedFetch, url, 'json', signal)
    },

    async submitBlast(params, signal): Promise<{ jobId: string }> {
      const base = blastBaseUrl.replace(/\/$/, '')
      const url = `${base}/Tools/services/rest/ncbiblast/run`
      const body = new URLSearchParams({
        email: params.email,
        title: 'tdease-proteoform-blast',
        stype: 'protein',
        program: params.program,
        matrix: params.matrix,
        // EBI exposes this as a restricted enum (for example `1e-4`) and
        // rejects the numerically equivalent decimal spelling `0.0001`.
        exp: formatBlastThreshold(params.threshold),
        database: params.database,
        sequence: params.sequence,
      })
      if (params.taxids) body.set('taxids', params.taxids)
      const response = await guardedFetch(url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/plain' },
        body,
      })
      if (!response.ok) {
        const detail = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 500)
        throw Object.assign(new Error(`UNIPROT_BLAST_SUBMIT_${response.status}${detail ? `: ${detail}` : ''}`), { status: response.status })
      }
      const jobId = (await response.text()).trim()
      if (!jobId || jobId.startsWith('<')) {
        throw new Error('UNIPROT_BLAST_NO_JOB_ID: the Job Dispatcher did not return a job id')
      }
      return { jobId }
    },

    async blastStatus(jobId, signal): Promise<{ jobStatus: string }> {
      const base = blastBaseUrl.replace(/\/$/, '')
      const url = `${base}/Tools/services/rest/ncbiblast/status/${encodeURIComponent(jobId)}`
      const response = await guardedFetch(url, { method: 'GET', signal, headers: { accept: 'text/plain' } })
      if (!response.ok) {
        throw Object.assign(new Error(`UNIPROT_BLAST_STATUS_${response.status}`), { status: response.status })
      }
      return { jobStatus: (await response.text()).trim() || 'UNKNOWN' }
    },

    async blastResults(jobId, signal): Promise<{ body: string; digest: string }> {
      const base = blastBaseUrl.replace(/\/$/, '')
      const url = `${base}/Tools/services/rest/ncbiblast/result/${encodeURIComponent(jobId)}/json`
      const response = await guardedFetch(url, { method: 'GET', signal, headers: { accept: 'application/json' } })
      if (!response.ok) {
        throw Object.assign(new Error(`UNIPROT_BLAST_RESULTS_${response.status}`), { status: response.status })
      }
      const body = await response.text()
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
        throw new Error('UNIPROT_BLAST_RESPONSE_TOO_LARGE')
      }
      const { createHash } = await import('node:crypto')
      return { body, digest: createHash('sha256').update(body).digest('hex') }
    },
  }
}

function formatBlastThreshold(value: number): string {
  if (value > 0 && value < 1) return value.toExponential().replace('e+', 'e')
  return String(value)
}

/** Shared GET-to-page for search and mapping results: body, digest, next cursor. */
async function fetchPage(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  fmt: UniProtFormat,
  signal?: AbortSignal,
): Promise<UniProtSearchPage> {
  const response = await fetchImpl(url, { method: 'GET', signal, headers: { accept: FORMAT_MEDIA[fmt] } })
  if (!response.ok) {
    throw Object.assign(new Error(`UNIPROT_HTTP_${response.status}: ${url}`), { status: response.status })
  }
  const body = await response.text()
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    throw new Error(`UNIPROT_RESPONSE_TOO_LARGE: ${url}`)
  }
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(body).digest('hex')
  const nextCursor = nextCursorFromLink(response.headers.get('link'))
  return {
    body,
    digest,
    mediaType: response.headers.get('content-type') ?? FORMAT_MEDIA[fmt],
    nextCursor,
    hasNext: nextCursor !== null,
    release: extractRelease(response),
  }
}

/**
 * UniProt cursor pagination: the next page's cursor lives in the Link header's
 * rel="next" URL as the `cursor=` query param. Absent → the set is exhausted.
 */
function nextCursorFromLink(link: string | null): string | null {
  if (!link) return null
  // The header may contain multiple links separated by commas; find rel="next".
  const nextMatch = /<([^>]+)>;\s*rel="next"/i.exec(link)
  if (!nextMatch) return null
  const cursor = /[?&]cursor=([^&]+)/.exec(nextMatch[1])
  return cursor ? decodeURIComponent(cursor[1]) : null
}

function buildEntryUrl(
  baseUrl: string,
  resource: UniProtResource,
  id: string,
  fields: ReadonlyArray<string> | undefined,
  format: UniProtFormat,
): string {
  const base = baseUrl.replace(/\/$/, '')
  const ext = formatExtension(format)
  const url = `${base}/${resource}/${encodeURIComponent(id)}.${ext}`
  if (fields?.length && format === 'json') {
    return `${url}?fields=${encodeURIComponent(fields.join(','))}`
  }
  return url
}

function buildSearchUrl(
  baseUrl: string,
  resource: UniProtResource,
  query: string,
  fields: ReadonlyArray<string> | undefined,
  format: UniProtFormat,
  cursor: string | undefined,
  pageSize: number | undefined,
  includeIsoform: boolean | undefined,
): string {
  const base = baseUrl.replace(/\/$/, '')
  const ext = formatExtension(format)
  const params = new URLSearchParams({ query })
  if (fields?.length && format === 'json') params.set('fields', fields.join(','))
  if (pageSize) params.set('size', String(pageSize))
  if (cursor) params.set('cursor', cursor)
  // `includeIsoform` is a UniProtKB search option; the API default is false, so
  // only send it when the caller explicitly asks (true).
  if (includeIsoform) params.set('includeIsoform', 'true')
  return `${base}/${resource}/search.${ext}?${params.toString()}`
}

function formatExtension(format: UniProtFormat): string {
  if (format === 'normalized') return 'json'
  return format
}

function extractRelease(response: Response): string | null {
  // UniProt advertises the release via the Link header's title or a dedicated
  // header; fall back to null when absent (the snapshot still has the digest).
  const link = response.headers.get('link')
  if (link) {
    const match = /released=([^;&"]+)/i.exec(link)
    if (match) return match[1]
  }
  return response.headers.get('x-uniprot-release')
    ?? response.headers.get('x-release')
    ?? null
}

/**
 * Parse a Retry-After header. It is either a number of seconds ("5") or an
 * HTTP-date. Returns the wait in milliseconds, or null when absent/unparseable
 * (in which case a 429 cannot be safely retried and is surfaced as an error).
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) {
    const wait = date - Date.now()
    return wait > 0 ? wait : 0
  }
  return null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}
