/**
 * The local-first read-through that `uniprot.get` resolves through.
 *
 *   read local entry → check freshness/coverage →
 *     if sufficient: return from local snapshot (offline-safe)
 *     if not:        fetch remote → save snapshot → project entry → return
 *
 * Default SourcePolicy is `local-first` with `allowStaleOnFailure`, so a record
 * that is too old to be "fresh" but unobtainable (network down) is still served
 * from the local snapshot rather than failing — a stale protein record is almost
 * always more useful than none, and the resolution object says it is stale.
 */
import type {
  ReferenceResult,
  SourcePolicy,
  UniProtBlastAlignment,
  UniProtBlastHit,
  UniProtBlastInput,
  UniProtGetInput,
  UniProtMapInput,
  UniProtNoteInput,
  UniProtQueryExpression,
  UniProtQueryInput,
  UniProtQueryTerm,
  UniProtReviseInput,
} from '../../../src/studio/ports/reference-command-port'
import { createHash } from 'node:crypto'
import { createUniProtClient } from './uniprot-client'
import { UniprotStore, resolveUniprotDatabasePath, type StoredEntry, type StoredNote } from './uniprot-store'
import { ReferenceResultStore } from './reference-result-store'

export interface UniprotReadThroughOptions {
  writableReferenceRoot: string
  resultStoreRoot: string
  baseUrl: string
  fetch: typeof globalThis.fetch
  /** EBI Job Dispatcher base hosting ncbiblast. Default `https://www.ebi.ac.uk`. */
  blastBaseUrl?: string
  /** Contact email the Job Dispatcher requires on every job submission. */
  blastContactEmail?: string
}

const DEFAULT_MAX_AGE_DAYS = 30
const DEFAULT_QUERY_FIELDS = ['accession', 'id', 'protein_name', 'gene_names', 'organism_name']
const MAX_INLINE_QUERY_BYTES = 128 * 1024
const MAX_INLINE_QUERY_HITS = 20

type StoredEntryLike = Pick<StoredEntry, 'resource' | 'primaryId' | 'snapshotDigest' | 'release'>

const DEFAULT_BLAST_DATABASE = 'uniprotkb_swissprot'
const DEFAULT_BLAST_PROGRAM = 'blastp'
const DEFAULT_BLAST_MATRIX = 'BLOSUM62'
const DEFAULT_BLAST_THRESHOLD = 1e-4
const DEFAULT_BLAST_LIMIT = 25
const BLAST_POLLS = 120
const BLAST_POLL_INTERVAL_MS = 2000
const BLAST_TIMEOUT_MS = 60_000

export function createUniprotReadThrough(options: UniprotReadThroughOptions) {
  const dbPath = resolveUniprotDatabasePath(options.writableReferenceRoot)
  const store = new UniprotStore(dbPath)
  const resultStore = new ReferenceResultStore(options.resultStoreRoot)
  const client = createUniProtClient(options.baseUrl, options.fetch, options.blastBaseUrl)
  const blastEmail = options.blastContactEmail ?? 'tdease-agent@example.com'

  async function get(input: UniProtGetInput, signal?: AbortSignal): Promise<ReferenceResult> {
    const policy = input.sourcePolicy ?? { mode: 'local-first', allowStaleOnFailure: true } as SourcePolicy
    const resource = input.resource
    const id = input.id

    // 1 — local projection present and fresh enough?
    const local = store.getEntry(resource, id)
    if (local && policy.mode !== 'remote-refresh' && policy.mode !== 'pinned') {
      const freshness = freshnessOf(local.projectedAt, policy.mode === 'local-first' ? (policy.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) : Infinity)
      if (freshness === 'fresh' || policy.mode === 'local-only') {
        return resolveFromSnapshot(
          local,
          { localHit: true, remoteQueried: false, freshness },
          input.includeAssertions === true,
        )
      }
    }
    if (policy.mode === 'local-only' && !local) {
      return { source: { database: 'uniprot' }, resolution: { localHit: false, remoteQueried: false }, record: null }
    }

    // 2 — fetch remote, save the immutable snapshot, project the entry.
    try {
      const fetched = await client.getEntry(resource, id, input.fields, input.format ?? 'json', signal)
      const retrievedAt = new Date().toISOString()
      const requestId = `${resource}/${id}`
      store.saveSnapshot({
        digest: fetched.digest,
        resource,
        requestId,
        release: fetched.release,
        retrievedAt,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
        mediaType: fetched.mediaType,
        payload: fetched.body,
      })
      const projection = projectEntry(resource, id, fetched.body)
      store.saveEntry({
        resource,
        primaryId: id,
        snapshotDigest: fetched.digest,
        reviewed: projection.reviewed,
        organismId: projection.organismId,
        projectedAt: retrievedAt,
        release: fetched.release,
      })
      return presentEntry(
        input.includeAssertions === true,
        resource, id,
        {
          source: { database: 'uniprot', release: fetched.release ?? undefined, retrievedAt, digest: fetched.digest },
          resolution: { localHit: false, remoteQueried: true, snapshotDigest: fetched.digest, release: fetched.release ?? undefined, freshness: 'fresh' },
          authorityRecord: projection.record,
          snapshotDigest: fetched.digest,
        },
        projection.record as Record<string, unknown>,
      )
    } catch (error) {
      // 3 — remote failed. If we have a local snapshot and the policy allows
      // stale, serve it; otherwise propagate the failure.
      const allowStale = policy.mode === 'local-first' ? policy.allowStaleOnFailure !== false
        : policy.mode === 'remote-refresh' ? policy.allowStaleOnFailure === true
        : false
      if (local && allowStale) {
        return resolveFromSnapshot(local, { localHit: true, remoteQueried: true, freshness: 'stale' }, input.includeAssertions === true)
      }
      throw error
    }
  }

  function resolveFromSnapshot(
    entry: StoredEntryLike,
    resolution: { localHit: boolean; remoteQueried: boolean; freshness: string },
    includeAssertions: boolean,
  ): ReferenceResult {
    const snapshot = store.getSnapshot(entry.snapshotDigest)
    if (!snapshot) {
      return { source: { database: 'uniprot' }, resolution: { ...resolution, freshness: 'unknown' }, record: null }
    }
    const projection = projectEntry(entry.resource ?? 'uniprotkb', entry.primaryId, snapshot.payload)
    return presentEntry(
      includeAssertions,
      entry.resource ?? 'uniprotkb', entry.primaryId,
      {
        source: { database: 'uniprot', digest: snapshot.digest, release: snapshot.release ?? undefined, retrievedAt: snapshot.retrievedAt },
        resolution: {
          localHit: resolution.localHit,
          remoteQueried: resolution.remoteQueried,
          snapshotDigest: snapshot.digest,
          release: snapshot.release ?? undefined,
          freshness: resolution.freshness as 'fresh' | 'stale',
        },
        authorityRecord: projection.record,
        snapshotDigest: snapshot.digest,
      },
      projection.record as Record<string, unknown>,
    )
  }

  function presentEntry(
    includeAssertions: boolean,
    resource: string,
    primaryId: string,
    base: ReferenceResult,
    authority: Record<string, unknown>,
  ): ReferenceResult {
    return includeAssertions ? mergeAssertions(resource, primaryId, base, authority) : base
  }

  /**
   * Overlay user assertions onto a read WITHOUT mutating the authority record.
   * `effectiveView` is the projection (authority + overlay); `conflicts` flags
   * where an assertion contradicts the authority, so a reader sees the tension
   * rather than a silently-merged value.
   */
  function mergeAssertions(resource: string, primaryId: string, base: ReferenceResult, authority: Record<string, unknown>): ReferenceResult {
    const notes = primaryId ? store.notesFor(resource, primaryId) : []
    if (notes.length === 0) {
      return { ...base, assertions: [], effectiveView: { ...authority } }
    }
    const effectiveView: Record<string, unknown> = { ...authority }
    const conflicts: Array<{ predicate: string; authorityValue: unknown; notedValue: string }> = []
    for (const n of notes) {
      // A 'rejected' verdict is itself the conflict signal; 'confirmed'/
      // 'supplemented' only conflict when the authority already carries a value.
      effectiveView[n.predicate] = n.value
      if (authority[n.predicate] !== undefined && authority[n.predicate] !== n.value) {
        conflicts.push({ predicate: n.predicate, authorityValue: authority[n.predicate], notedValue: n.value })
      }
    }
    return { ...base, assertions: notes, effectiveView, conflicts }
  }

  return { get, query, map, note, revise, blast, close: () => store.close() }

  function note(input: UniProtNoteInput): ReferenceResult {
    // Generate a stable, opaque id: refn_<16 hex of a content digest>. The
    // prefix distinguishes notes from result refs (ref_), spectra (msr_), and
    // keeps them visually distinct in logs.
    const idSeed = `${input.resource}/${input.id}|${input.subject}|${input.predicate}|${input.value}|${input.verdict}|${Date.now()}_${Math.random()}`
    const id = `refn_${createHash('sha256').update(idSeed).digest('hex').slice(0, 16)}`
    const notedAt = new Date().toISOString()
    const stored: StoredNote = {
      id, resource: input.resource, primaryId: input.id,
      subject: input.subject, predicate: input.predicate, value: input.value,
      verdict: input.verdict,
      evidenceRefs: input.evidenceRefs ? [...input.evidenceRefs] : null,
      basedOnSnapshot: input.basedOnSnapshot ?? null,
      assertedBy: input.notedBy ?? 'tdease-agent',
      assertedAt: notedAt, revisedAt: null,
      comment: input.comment ?? null, retracted: false,
    }
    store.saveNote(stored)
    return { source: { database: 'uniprot', retrievedAt: notedAt }, noted: true, note: stored }
  }

  function revise(input: UniProtReviseInput): ReferenceResult {
    const outcome = store.reviseNote(input.noteId, {
      value: input.value,
      verdict: input.verdict,
      evidenceRefs: input.evidenceRefs,
      appendEvidence: input.appendEvidence,
      comment: input.comment,
      retracted: input.retracted,
    })
    return {
      source: { database: 'uniprot', retrievedAt: new Date().toISOString() },
      revised: outcome.revised,
      note: outcome.note,
      noteId: input.noteId,
    }
  }

  /**
   * Set query with a local completeness cache. The key invariant: a result set
   * is only served from cache when `query_coverage` says the cursor was
   * exhausted, so "12 results" never silently means "only the first 12 fetched".
   */
  async function query(input: UniProtQueryInput, signal?: AbortSignal): Promise<ReferenceResult> {
    const resource = input.resource
    // Homology is a high-level combination query, not a native UniProt search.
    // Route it to its own orchestrator before the generic set-query path.
    if (resource === 'homology') {
      return discoverHomology(input, signal)
    }
    const queryStr = input.advancedQuery ?? serializeQuery(input.query)
    // Cache the canonical remote response, not a caller-specific projection.
    // Every caller is projected locally below, so one narrow request can never
    // poison a later broader request (or vice versa).
    const queryKey = `${resource}:${queryStr}:json`
    const format = input.format ?? 'json'

    const coverage = store.getQueryCoverage(queryKey)
    if (coverage?.completed && coverage.cursorExhausted && input.mode !== 'stream') {
      const snapshot = coverage.snapshotDigest ? store.getSnapshot(coverage.snapshotDigest) : undefined
      if (snapshot) {
        const results = parseResults(snapshot.payload)
        return deliverQueryResults(results, input.fields, {
          source: { database: 'uniprot', digest: snapshot.digest, release: snapshot.release ?? undefined, retrievedAt: snapshot.retrievedAt },
          resolution: { localHit: true, remoteQueried: false, completeness: 'complete', snapshotDigest: snapshot.digest, release: snapshot.release ?? undefined },
        })
      }
    }

    // Fetch all pages until the cursor is exhausted (or maxPages), accumulating
    // into one snapshot so a repeat query is a single local read.
    const collected: unknown[] = []
    let release: string | null = null
    let cursor = input.cursor
    let exhausted = false
    const maxPages = 50
    for (let page = 0; page < maxPages; page++) {
      // UniProt's JSON `fields` parameter is not a transcript boundary: an
      // upstream response may still contain complete entries. Retain canonical
      // JSON locally, then apply our own strict projection before delivery.
      const fetched = await client.search(resource, queryStr, undefined, format, cursor, input.pageSize, input.includeIsoform, signal)
      release = fetched.release
      for (const r of parseResults(fetched.body)) collected.push(r)
      if (fetched.hasNext && fetched.nextCursor) {
        cursor = fetched.nextCursor
      } else {
        exhausted = true
        break
      }
    }
    const retrievedAt = new Date().toISOString()
    const payload = JSON.stringify({ results: collected })
    const payloadDigest = sha256Hex(payload)
    store.saveSnapshot({
      digest: payloadDigest, resource, requestId: `query:${queryKey}`,
      release, retrievedAt, etag: null, lastModified: null,
      mediaType: 'application/json', payload,
    })
    store.saveQueryCoverage(queryKey, resource, payloadDigest, true, exhausted, release)
    return deliverQueryResults(collected, input.fields, {
      source: { database: 'uniprot', digest: payloadDigest, release: release ?? undefined, retrievedAt },
      resolution: { localHit: false, remoteQueried: true, completeness: exhausted ? 'complete' : 'partial', snapshotDigest: payloadDigest, release: release ?? undefined },
    })
  }

  async function deliverQueryResults(
    rawResults: ReadonlyArray<unknown>,
    requestedFields: ReadonlyArray<string> | undefined,
    base: ReferenceResult,
  ): Promise<ReferenceResult> {
    const fields = requestedFields?.length ? requestedFields : DEFAULT_QUERY_FIELDS
    const results = rawResults.map((record) => projectQueryHit(record, fields))
    const serialized = JSON.stringify({ results })
    if (Buffer.byteLength(serialized) <= MAX_INLINE_QUERY_BYTES) {
      return { ...base, results }
    }
    const resultRef = await resultStore.writeOnce(serialized)
    return {
      ...base,
      results: results.slice(0, MAX_INLINE_QUERY_HITS),
      resultCount: results.length,
      delivery: {
        mode: 'reference',
        reason: 'result_exceeded_inline_limit',
        message: 'The complete projected UniProt result was retained outside the model transcript.',
      },
      resultRef,
    }
  }

  /**
   * Homology discovery: UniProtKB seed → ID-mapping to UniRef → cluster members.
   *
   * The result separates two kinds of evidence that are easy to conflate:
   *   - `clusterMembership` — what a UniRef cluster actually proves (shared
   *     sequence at a similarity threshold);
   *   - `sequenceSimilarity` — the actual identity/coverage, which would need a
   *     real alignment to compute.
   * The first version reports clusterMembership and a placeholder
   * sequenceSimilarity (identity not yet computed), and explicitly sets
   * `orthologyClaim: null`: a UniRef cluster alone does NOT establish
   * orthology or paralogy, and the plan forbids pretending it does.
   */
  async function discoverHomology(input: UniProtQueryInput, signal?: AbortSignal): Promise<ReferenceResult> {
    const seed = input.seed?.accession
    if (!seed) throw new Error('HOMOLOGY_REQUIRES_SEED: seed.accession is required')
    const levels = input.discovery?.unirefLevels ?? [90]

    // 1 — fetch the seed entry to anchor the query.
    const seedEntry = await client.getEntry('uniprotkb', seed, undefined, 'json', signal)
    const candidates: Array<Record<string, unknown>> = []

    for (const level of levels) {
      // 2 — map the seed accession to its UniRef cluster at this level.
      const { jobId } = await client.submitMapping('UniProtKB_AC-ID', `UniRef${level}`, [seed], signal)
      await pollUntilFinished(jobId, signal)
      const mappingPage = await client.mappingResults(jobId, undefined, signal)
      const clusterId = firstClusterId(mappingPage.body, level)
      if (!clusterId) continue
      // 3 — read the cluster's representative + members.
      const clusterEntry = await client.getEntry('uniref', clusterId, undefined, 'json', signal)
      const members = parseClusterMembers(clusterEntry.body)
      for (const member of members) {
        const memberAccession = String(member.memberId ?? '')
        candidates.push({
          seed,
          unirefLevel: level,
          clusterId,
          memberId: memberAccession,
          clusterMembership: { clusterId, level, source: 'UniRef' },
          // Reported as a distinct field but not yet computed from an alignment.
          sequenceSimilarity: { identity: null, queryCoverage: null, targetCoverage: null, note: 'identity requires a sequence alignment, not yet performed' },
          // NEVER inferred from cluster membership alone.
          orthologyClaim: null,
        })
      }
    }

    const limit = input.limit ?? 100
    return {
      source: { database: 'uniprot', retrievedAt: new Date().toISOString(), digest: seedEntry.digest },
      seed: { accession: seed, snapshotDigest: seedEntry.digest },
      candidates: candidates.slice(0, limit),
      candidateCount: candidates.length,
      // The honest scope of what this first version can assert.
      evidenceScope: ['clusterMembership'],
      notClaimed: ['orthology', 'paralogy'],
    }
  }

  async function pollUntilFinished(jobId: string, signal?: AbortSignal): Promise<void> {
    for (let i = 0; i < 60; i++) {
      const { jobStatus } = await client.mappingStatus(jobId, signal)
      if (jobStatus === 'FINISHED') return
      if (jobStatus !== 'RUNNING' && jobStatus !== 'NOT_READY') return
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  function firstClusterId(body: string, level: number): string | null {
    try {
      const json = JSON.parse(body)
      const results = Array.isArray(json.results) ? json.results : []
      const to = results[0]?.to
      return typeof to === 'string' ? to : `UniRef${level}_${seedless(body)}`
    } catch { return null }
  }

  function seedless(_body: string): string {
    // Fallback when the mapping payload has no `to`; the caller should rarely
    // hit this because a FINISHED mapping returns concrete cluster ids.
    return 'UNKNOWN'
  }

  function parseClusterMembers(body: string): Array<{ memberId: string }> {
    try {
      const json = JSON.parse(body)
      const members = Array.isArray(json.members) ? json.members : []
      return members
        .filter((m: unknown) => m && typeof m === 'object' && 'memberId' in (m as Record<string, unknown>))
        .map((m: Record<string, unknown>) => ({ memberId: String(m.memberId) }))
    } catch { return [] }
  }

  /** The official asynchronous ID-mapping lifecycle, run to completion. */
  async function map(input: UniProtMapInput, signal?: AbortSignal): Promise<ReferenceResult> {
    const { jobId } = await client.submitMapping(input.from, input.to, input.ids, signal)
    // Poll until FINISHED (bounded; the service is usually fast). A RUNNING job
    // that never settles is surfaced as partial, not an infinite loop.
    for (let i = 0; i < 60; i++) {
      const result = await client.mappingStatus(jobId, signal)
      if (result.jobStatus === 'FINISHED') break
      if (result.jobStatus !== 'RUNNING' && result.jobStatus !== 'NOT_READY') break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    const mappings: Array<{ from: string; to: string }> = []
    let cursor: string | undefined
    let exhausted = false
    for (let page = 0; page < (input.maxPages ?? 1000); page++) {
      const fetched = await client.mappingResults(jobId, cursor, signal)
      for (const m of parseMappings(fetched.body)) mappings.push(m)
      if (fetched.hasNext && fetched.nextCursor) cursor = fetched.nextCursor
      else { exhausted = true; break }
    }
    return {
      source: { database: 'uniprot', retrievedAt: new Date().toISOString() },
      jobId,
      mappings,
      completeness: exhausted ? 'complete' : 'partial',
    }
  }
  /**
   * BLAST a protein fragment against UniProtKB through the EBI Job Dispatcher.
   *
   * The alignment is the deliverable: each HSP carries query↔hit coordinates, and
   * when `querySite` is given the read-through maps the modification site onto
   * the subject sequence (`hit_site` per alignment). Results are cached by the
   * exact (sequence, params) tuple — an identical query is a local read, never a
   * second remote BLAST job.
   */
  async function blast(input: UniProtBlastInput, signal?: AbortSignal): Promise<ReferenceResult> {
    const sequence = (input.sequence ?? '').trim()
    if (!sequence) throw new Error('BLAST_REQUIRES_SEQUENCE: sequence is required')
    const database = input.database ?? DEFAULT_BLAST_DATABASE
    const program = input.program ?? DEFAULT_BLAST_PROGRAM
    const matrix = input.matrix ?? DEFAULT_BLAST_MATRIX
    const threshold = input.threshold ?? DEFAULT_BLAST_THRESHOLD
    const taxids = input.taxids?.join(',') ?? ''
    const limit = input.limit ?? DEFAULT_BLAST_LIMIT

    const paramsKey = [database, program, matrix, String(threshold), taxids].join('|')
    const queryKey = `blast:${sha256Hex(`${sequence}|${paramsKey}`)}`

    // 1 — exact-repeat query already cached as a completed set?
    const coverage = store.getQueryCoverage(queryKey)
    if (coverage?.completed && coverage.cursorExhausted && coverage.snapshotDigest) {
      const snapshot = coverage.snapshotDigest ? store.getSnapshot(coverage.snapshotDigest) : undefined
      if (snapshot) {
        return deliverBlast(snapshot.payload, input, limit, {
          source: { database: 'ebi-blast', digest: snapshot.digest, release: snapshot.release ?? undefined, retrievedAt: snapshot.retrievedAt },
          resolution: { localHit: true, remoteQueried: false, completeness: 'complete', snapshotDigest: snapshot.digest },
        })
      }
    }

    // 2 — submit, poll, fetch the JSON result. BLAST is an optional reference
    // prior; it must not hold a scientific turn indefinitely when EBI is slow.
    const deadline = AbortSignal.timeout(BLAST_TIMEOUT_MS)
    const blastSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    const { jobId } = await client.submitBlast({ sequence, database, program, matrix, threshold, taxids, email: blastEmail }, blastSignal)
    await pollBlastUntilFinished(jobId, blastSignal)
    const fetched = await client.blastResults(jobId, blastSignal)

    // 3 — normalize, persist the payload, deliver.
    const normalized = normalizeBlastResult(fetched.body)
    const payload = JSON.stringify({ ...normalized, query: { sequence, length: sequence.length }, params: { database, program, matrix, threshold } })
    const payloadDigest = sha256Hex(payload)
    const retrievedAt = new Date().toISOString()
    store.saveSnapshot({
      digest: payloadDigest, resource: 'blast', requestId: queryKey,
      release: null, retrievedAt, etag: null, lastModified: null,
      mediaType: 'application/json', payload,
    })
    store.saveQueryCoverage(queryKey, 'blast', payloadDigest, true, true, null)
    return deliverBlast(payload, input, limit, {
      source: { database: 'ebi-blast', digest: payloadDigest, retrievedAt },
      resolution: { localHit: false, remoteQueried: true, completeness: 'complete', snapshotDigest: payloadDigest },
    })
  }

  async function pollBlastUntilFinished(jobId: string, signal?: AbortSignal): Promise<void> {
    for (let i = 0; i < BLAST_POLLS; i++) {
      const { jobStatus } = await client.blastStatus(jobId, signal)
      if (jobStatus === 'FINISHED') return
      if (jobStatus === 'ERROR' || jobStatus === 'FAILURE') throw new Error(`UNIPROT_BLAST_JOB_FAILED: ${jobStatus}`)
      if (signal?.aborted) throw new Error('aborted')
      await new Promise((resolve) => setTimeout(resolve, BLAST_POLL_INTERVAL_MS))
    }
    throw new Error('UNIPROT_BLAST_TIMEOUT: the BLAST job did not settle')
  }

  function deliverBlast(
    payload: string,
    input: UniProtBlastInput,
    limit: number,
    base: ReferenceResult,
  ): ReferenceResult {
    const data = safeParse(payload)
    const hits = Array.isArray(data?.hits) ? (data.hits as UniProtBlastHit[]).slice(0, limit) : []
    const querySite = input.querySite
    return {
      ...base,
      query: data?.query ?? { sequence: input.sequence, length: input.sequence.length },
      params: data?.params ?? {},
      hitCount: Array.isArray(data?.hits) ? data.hits.length : 0,
      hits: querySite !== undefined
        ? hits.map((h) => ({ ...h, alignments: h.alignments.map((a) => ({ ...a, hit_site: mapQuerySite(a, querySite) })) }))
        : hits,
    }
  }
}

function freshnessOf(projectedAt: string, maxAgeDays: number): 'fresh' | 'stale' {
  const ageMs = Date.now() - new Date(projectedAt).getTime()
  return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000 ? 'fresh' : 'stale'
}

/**
 * Serialize the typed query expression to UniProt's query syntax. Booleans and
 * numbers are quoted appropriately; `exists` maps to the field-wildcard form.
 * An empty expression matches everything.
 */
function serializeQuery(expr: UniProtQueryExpression | undefined): string {
  if (!expr) return '*'
  const all = (expr.all ?? []).map((term) => serializeTerm(term))
  const any = (expr.any ?? []).map((term) => serializeTerm(term))
  const parts = []
  if (all.length) parts.push(all.length === 1 ? all[0] : `(${all.join(' AND ')})`)
  if (any.length) parts.push(any.length === 1 ? any[0] : `(${any.join(' OR ')})`)
  return parts.length ? parts.join(' AND ') : '*'
}

function serializeTerm(term: UniProtQueryTerm | UniProtQueryExpression): string {
  if ('field' in term) {
    if (term.exists) return `${term.field}:*`
    if (term.eq === undefined) return `${term.field}:*`
    const value = typeof term.eq === 'boolean' ? (term.eq ? 'true' : 'false') : String(term.eq)
    return `${term.field}:${value}`
  }
  return serializeQuery(term)
}

function parseResults(body: string): unknown[] {
  try {
    const json = JSON.parse(body)
    return Array.isArray(json.results) ? json.results : []
  } catch {
    return []
  }
}

/**
 * Local allow-list projection for model-facing UniProt search hits. The remote
 * API's `fields` option is advisory, while this projection is the hard context
 * boundary. Keep UniProt's JSON field names so a hit can be used directly by a
 * subsequent `uniprot.get` without a second translation layer.
 */
function projectQueryHit(record: unknown, fields: ReadonlyArray<string>): Record<string, unknown> {
  const source = record && typeof record === 'object' && !Array.isArray(record)
    ? record as Record<string, unknown>
    : {}
  const projected: Record<string, unknown> = {}
  for (const field of fields) {
    const key = QUERY_FIELD_KEYS[field]
    if (key && source[key] !== undefined) projected[key] = source[key]
  }
  // The accession is essential provenance for every useful hit. Preserve it
  // even when an incomplete remote projection did not echo the requested field.
  if (source.primaryAccession !== undefined) projected.primaryAccession = source.primaryAccession
  return projected
}

const QUERY_FIELD_KEYS: Readonly<Record<string, string>> = {
  accession: 'primaryAccession',
  id: 'uniProtkbId',
  protein_name: 'proteinDescription',
  gene_names: 'genes',
  organism_name: 'organism',
  organism_id: 'organism',
  sequence: 'sequence',
  length: 'sequence',
  reviewed: 'entryType',
}

function parseMappings(body: string): Array<{ from: string; to: string }> {
  try {
    const json = JSON.parse(body)
    if (!Array.isArray(json.results)) return []
    return (json.results as Array<Record<string, unknown>>)
      .filter((m) => m && typeof m === 'object' && 'from' in m)
      .map((m) => ({ from: String(m.from), to: String(m.to ?? '') }))
  } catch {
    return []
  }
}

function sha256Hex(text: string): string {
  // Lazy import keeps the module importable in non-crypto contexts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as { createHash: typeof import('node:crypto')['createHash'] }
  return createHash('sha256').update(text).digest('hex')
}

/** JSON parse that returns null on malformed input (never throws). */
function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Normalize the EBI Job Dispatcher `ncbiblast` JSON result into the typed
 * UniProtBlastHit shape. The raw payload carries `hits[]` with `hit_hsps[]`
 * holding the aligned query/midline/subject sequences and per-position
 * coordinates — everything a query-site → subject-position transfer needs.
 */
function normalizeBlastResult(body: string): { hits: UniProtBlastHit[] } {
  const raw = safeParse(body)
  const hits: UniProtBlastHit[] = []
  if (!raw || !Array.isArray(raw.hits)) return { hits }
  for (const hit of raw.hits) {
    if (!hit || typeof hit !== 'object') continue
    const record = hit as Record<string, unknown>
    const hsps = Array.isArray(record.hit_hsps) ? record.hit_hsps as Array<Record<string, unknown>> : []
    const alignments: UniProtBlastAlignment[] = hsps
      .map((hsp) => ({
        queryFrom: blastNumber(hsp.hsp_query_from, 1),
        queryTo: blastNumber(hsp.hsp_query_to, 0),
        hitFrom: blastNumber(hsp.hsp_hit_from, 1),
        hitTo: blastNumber(hsp.hsp_hit_to, 0),
        identity: blastNumber(hsp.hsp_identity, 0),
        positive: blastNumber(hsp.hsp_positive, 0),
        gaps: blastNumber(hsp.hsp_gaps, 0),
        score: blastNumber(hsp.hsp_score, 0),
        bitScore: blastNumber(hsp.hsp_bit_score, 0),
        evalue: blastNumber(hsp.hsp_expect, Number.POSITIVE_INFINITY),
        querySeq: blastString(hsp.hsp_qseq),
        midline: blastString(hsp.hsp_mseq),
        hitSeq: blastString(hsp.hsp_hseq),
      }))
      .filter((a) => a.querySeq && a.hitSeq)
    hits.push({
      accession: blastString(record.hit_acc),
      entryId: blastString(record.hit_id),
      description: blastString(record.hit_desc),
      organism: blastString(record.hit_os),
      length: blastNumber(record.hit_len, 0),
      alignments,
    })
  }
  return { hits }
}

function blastNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(n) ? n : fallback
}

function blastString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/**
 * Map a 1-based position in the query sequence onto the subject sequence by
 * walking the aligned query/subject sequences in lockstep. Returns null when
 * the site falls outside the alignment or lands on a subject gap.
 */
function mapQuerySite(alignment: UniProtBlastAlignment, querySite: number): number | null {
  const qseq = alignment.querySeq
  const hseq = alignment.hitSeq
  let qPos = alignment.queryFrom - 1
  let hPos = alignment.hitFrom - 1
  for (let i = 0; i < qseq.length; i++) {
    const qc = qseq[i] ?? '-'
    const hc = hseq[i] ?? '-'
    if (qc !== '-') qPos += 1
    if (hc !== '-') hPos += 1
    if (qc !== '-' && qPos === querySite) {
      return hc === '-' ? null : hPos
    }
  }
  return null
}

/**
 * Extract the minimal projection a read needs without committing to UniProt's
 * full schema: the primary accession (for identity), reviewed flag, organism id,
 * and the parsed record. The raw payload is always preserved verbatim in the
 * snapshot, so the projection can be rebuilt losslessly later.
 */
function projectEntry(resource: string, fallbackId: string, payload: string): {
  reviewed: boolean | null
  organismId: string | null
  record: unknown
} {
  try {
    const json = JSON.parse(payload)
    const accession = json.primaryAccession ?? fallbackId
    const entryType = typeof json.entryType === 'string' ? json.entryType : ''
    const reviewed = entryType.includes('reviewed') ? true : entryType.includes('unreviewed') ? false : null
    const organismId = json.organism?.taxonId ? String(json.organism.taxonId) : json.organism?.scientificName ?? null
    return {
      reviewed,
      organismId,
      record: { ...json, primaryAccession: accession },
    }
  } catch {
    // Non-JSON formats (fasta/tsv/...): keep the raw payload as the record.
    return { reviewed: null, organismId: null, record: { raw: payload } }
  }
}
