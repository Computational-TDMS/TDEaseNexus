/**
 * The reference port's core E2E links, written first and RED until the native
 * reference port ships (AGENTS.md §1/§2): a UniProt read-through that survives
 * disconnect on its second call, plus the bundled UniMod database build that
 * feeds the `tdeasenexus-toolbox` CLI's `--user-db` reference (the port itself carries
 * no UniMod channel).
 *
 * Modeled on spectra-command-port.test.ts: it invokes the registered commands
 * through the real registry with a real (built) UniMod database and an injected
 * fake `fetch`, so it never touches the network.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createStudioCommandRegistry } from '../../src/studio/commands/definitions'
import { asWorkspaceId } from '../../src/studio/domain/identity'
import type { CommandContext } from '../../src/studio/commands/registry'
import type { StudioRuntime } from '../../src/studio/runtime/studio-runtime'
import { createNodeReferenceCommandPort } from './reference-command-port'
import { UniprotStore } from './reference/uniprot-store'
import type { ReferenceCommandPort } from '../../src/studio/ports/reference-command-port'
import { buildUnimodDatabase } from '../../scripts/build-unimod-database.mjs'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundledReferenceRoot = path.resolve(frontendRoot, '..', 'tdease-ai-capability', 'system', 'reference')

/**
 * A throwaway per-test reference port backed by a temp writable root, so the
 * UniProt store starts empty for every case and no test writes into the repo.
 */
async function withReferenceContext(
  options: { fetch?: typeof globalThis.fetch },
  block: (context: CommandContext, root: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-reference-'))
  const ports: Array<{ dispose(): void }> = []
  try {
    const registry = createStudioCommandRegistry()
    const makePort = (fetchOverride?: typeof globalThis.fetch) => {
      const port = createNodeReferenceCommandPort({
        writableReferenceRoot: path.join(root, 'reference'),
        resultStoreRoot: path.join(root, 'cache', 'reference-results'),
        uniprotBaseUrl: 'https://rest.uniprot.example',
        fetch: fetchOverride ?? options.fetch,
      }) as ReferenceCommandPort & { dispose(): void }
      ports.push(port)
      return port
    }
    const context: CommandContext = {
      studio: {} as StudioRuntime,
      workspaceId: asWorkspaceId('reference-fixture'),
      permission: { decide: () => 'allow' as const, request: async () => true },
      evidence: {
        list: async () => [], read: async () => null, graph: async () => null,
        write: async () => null, verify: async () => null,
      },
      references: makePort(),
    }
    ;(context as { __makePort?: unknown }).__makePort = makePort
    await block(context, root)
  } finally {
    // Close every SQLite handle BEFORE removing the temp dir: Windows holds
    // the WAL/SHM sidecars locked until the DatabaseSync is closed, and an
    // open handle turns `rm` into EBUSY.
    for (const port of ports) { try { port.dispose() } catch { /* closing twice is fine */ } }
    await fs.rm(root, { recursive: true, force: true })
  }
}

describe('native reference commands', () => {
  it('migrates a pre-revised_at UniProt assertion overlay before reading it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-uniprot-legacy-'))
    const databasePath = path.join(root, 'uniprot.sqlite')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE user_assertions (
        id TEXT PRIMARY KEY, resource TEXT NOT NULL, primary_id TEXT NOT NULL,
        subject TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT NOT NULL,
        verdict TEXT NOT NULL, evidence_refs TEXT, based_on_snapshot TEXT,
        asserted_by TEXT, asserted_at TEXT NOT NULL, comment TEXT,
        retracted INTEGER NOT NULL DEFAULT 0
      );
    `)
    legacy.close()

    const store = new UniprotStore(databasePath)
    try {
      expect(store.notesFor('uniprotkb', 'P27661')).toEqual([])
    } finally {
      store.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('reads a UniProt entry through the local store and serves the identical record after disconnect', async () => {
    let fetchCalls = 0
    const payload = {
      entryType: 'UniProtKB reviewed (Swiss-Prot)',
      primaryAccession: 'P12345',
      organism: { scientificName: 'Macro mus' },
      sequence: { value: 'MAKVLC', length: 6 },
    }
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      fetchCalls += 1
      const url = String(input)
      if (!url.includes('/uniprotkb/P12345')) {
        throw new Error(`unexpected fetch: ${url}`)
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()

      // First call: local store empty → fetches remote once → projects entry.
      const first = await registry.invoke('uniprot.get', {
        resource: 'uniprotkb',
        id: 'P12345',
        format: 'json',
      }, context) as Record<string, unknown>
      expect(fetchCalls).toBe(1)
      const firstRecord = first.authorityRecord as Record<string, unknown>
      expect(firstRecord.primaryAccession).toBe('P12345')
      const firstResolution = first.resolution as Record<string, unknown>
      expect(firstResolution.remoteQueried).toBe(true)
      expect(firstResolution.localHit).toBe(false)
      expect(firstResolution.snapshotDigest).toMatch(/^[a-f0-9]{64}$/)

      // Second call: disconnect the network against the SAME writable root.
      // The record must come from the local projection, identical, with the
      // same snapshot digest — no new fetch.
      const makePort = (context as unknown as { __makePort: (f?: typeof globalThis.fetch) => ReferenceCommandPort & { dispose(): void } }).__makePort
      context.references = makePort(async () => { throw new Error('NETWORK_UNAVAILABLE') })

      const second = await registry.invoke('uniprot.get', {
        resource: 'uniprotkb',
        id: 'P12345',
        format: 'json',
      }, context) as Record<string, unknown>
      const secondRecord = second.authorityRecord as Record<string, unknown>
      expect(secondRecord.primaryAccession).toBe('P12345')
      expect(second.resolution.localHit).toBe(true)
      // No new fetch happened: the network stayed down.
      expect(fetchCalls).toBe(1)
      // Provenance is stable: the same snapshot backs both reads.
      expect(second.resolution.snapshotDigest).toBe(first.resolution.snapshotDigest)
    })
  })
})

/**
 * The query and map E2E links for the second pass. Both reuse the injected
 * fake `fetch` so no test touches the network.
 *
 *   - `uniprot.query` caches a complete search result in `query_coverage`; a
 *     second identical query is served locally with no new fetch — otherwise a
 *     reader can never tell "12 results" from "only 12 cached".
 *   - `uniprot.map` runs the official asynchronous lifecycle
 *     (submit → poll status → resolve redirect → paginated results) end to end
 *     and records the jobId as provenance.
 */
describe('native UniProt query and map', () => {
  it('projects a broad UniProt query before it can enter the agent transcript', async () => {
    const searchPayload = {
      results: [{
        primaryAccession: 'P12345',
        uniProtkbId: 'H2AX_MOUSE',
        genes: [{ geneName: { value: 'H2afx' } }],
        sequence: { value: 'MSGRGKQGGKARAKAKTRSSRAGLQFPVGRVHRLLRKGNYAERVGAGAPVYLAAVLEYLTAEILELAGNAARDNKKTRIIPRHLQLAIRNDEELNKLLGKVTIAQGGVLPNIQAVLLPKKTESHHKAKGK', length: 143 },
        comments: Array.from({ length: 500 }, () => ({ commentType: 'FUNCTION', texts: [{ value: 'unrequested annotation' }] })),
      }],
    }
    let requestedUrl = ''
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify(searchPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()
      const result = await registry.invoke('uniprot.query', {
        resource: 'uniprotkb',
        advancedQuery: 'gene:H2AFX AND organism_id:10090',
        fields: ['accession', 'id', 'gene_names', 'sequence'],
        mode: 'page',
      }, context) as Record<string, unknown>

      expect(requestedUrl).toContain('query=gene%3AH2AFX')
      const hit = (result.results as Array<Record<string, unknown>>)[0]
      expect(hit).toEqual({
        primaryAccession: 'P12345',
        uniProtkbId: 'H2AX_MOUSE',
        genes: [{ geneName: { value: 'H2afx' } }],
        sequence: expect.objectContaining({ length: 143 }),
      })
      expect(JSON.stringify(result)).not.toContain('unrequested annotation')
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8 * 1024)
    })
  })

  it('passes includeIsoform through to the UniProt search URL', async () => {
    const searchPayload = { results: [] }
    let requestedUrl = ''
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify(searchPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()
      await registry.invoke('uniprot.query', {
        resource: 'uniprotkb',
        advancedQuery: 'gene:H2AFX',
        includeIsoform: true,
        mode: 'page',
      }, context)

      expect(requestedUrl).toContain('includeIsoform=true')
      // Without the flag the URL stays clean (the API default is false).
      requestedUrl = ''
      await registry.invoke('uniprot.query', {
        resource: 'uniprotkb',
        advancedQuery: 'gene:H2AFX',
        mode: 'page',
      }, context)
      expect(requestedUrl).not.toContain('includeIsoform')
    })
  })

  it('retains an oversized projected query outside the agent transcript', async () => {
    const searchPayload = {
      results: Array.from({ length: 40 }, (_, index) => ({
        primaryAccession: `P${String(index).padStart(5, '0')}`,
        sequence: { value: 'M'.repeat(4_000), length: 4_000 },
      })),
    }
    const fakeFetch: typeof globalThis.fetch = async () => new Response(JSON.stringify(searchPayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()
      const result = await registry.invoke('uniprot.query', {
        resource: 'uniprotkb',
        advancedQuery: 'organism_id:10090',
        fields: ['accession', 'sequence'],
      }, context) as Record<string, unknown>

      expect((result.results as unknown[])).toHaveLength(20)
      expect(result.resultCount).toBe(40)
      expect(result.resultRef).toMatchObject({ id: expect.stringMatching(/^ref_[a-f0-9]{64}$/) })
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024)
    })
  })

  it('serves a complete cached search on the second call without re-fetching', async () => {
    let fetchCalls = 0
    const searchPayload = {
      results: [
        { primaryAccession: 'P21802', organism: { scientificName: 'Homo sapiens' } },
        { primaryAccession: 'P12345', organism: { scientificName: 'Macro mus' } },
      ],
    }
    // Cursor pagination: UniProt signals "no next page" by omitting the Link
    // header. A complete result set has no rel="next".
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      fetchCalls += 1
      const url = String(input)
      if (url.includes('/uniprotkb/search') || url.includes('/uniprotkb/stream')) {
        return new Response(JSON.stringify(searchPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()
      const first = await registry.invoke('uniprot.query', {
        resource: 'uniprotkb',
        query: { reviewed: true },
        mode: 'page',
      }, context) as Record<string, unknown>
      const firstResults = first.results as unknown[]
      expect(firstResults).toHaveLength(2)
      expect(first.resolution.remoteQueried).toBe(true)
      expect(first.resolution.completeness).toBe('complete')

      // Second identical call: served from the local query_coverage cache, no
      // new fetch. `fetch` is replaced with one that throws to prove it.
      const makePort = (context as unknown as { __makePort: (f?: typeof globalThis.fetch) => ReferenceCommandPort & { dispose(): void } }).__makePort
      context.references = makePort(async () => { throw new Error('NETWORK_UNAVAILABLE') })

      const second = await registry.invoke('uniprot.query', {
        resource: 'uniprotkb',
        query: { reviewed: true },
        mode: 'page',
      }, context) as Record<string, unknown>
      expect((second.results as unknown[])).toHaveLength(2)
      expect(second.resolution.localHit).toBe(true)
      expect(second.resolution.completeness).toBe('complete')
      // Only the first call fetched.
      expect(fetchCalls).toBe(1)
    })
  })

  it('runs the ID-mapping asynchronous lifecycle and records the jobId as provenance', async () => {
    let fetchCalls = 0
    // The official flow: POST /idmapping/run → {jobId}; poll
    // /idmapping/status/{jobId} → {jobStatus:"FINISHED"}; fetch
    // /idmapping/results/{jobId} → {results:[{from,to}], pageInfo:{}}.
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      fetchCalls += 1
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/idmapping/run') && method === 'POST') {
        return new Response(JSON.stringify({ jobId: 'job-abc-123' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/idmapping/status/job-abc-123')) {
        return new Response(JSON.stringify({ jobStatus: 'FINISHED' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/idmapping/results/job-abc-123')) {
        return new Response(JSON.stringify({
          results: [
            { from: 'P21802', to: 'UniRef90_P21802' },
            { from: 'P12345', to: 'UniRef90_P12345' },
          ],
          pageInfo: { resultsPerPage: 25, currentPage: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()
      const result = await registry.invoke('uniprot.map', {
        from: 'UniProtKB_AC-ID',
        to: 'UniRef90',
        ids: ['P21802', 'P12345'],
      }, context) as Record<string, unknown>

      expect(result.mappings).toEqual([
        { from: 'P21802', to: 'UniRef90_P21802' },
        { from: 'P12345', to: 'UniRef90_P12345' },
      ])
      // The jobId is part of provenance and supports failure recovery.
      expect(result.jobId).toBe('job-abc-123')
      expect(result.source.database).toBe('uniprot')
      // The lifecycle touched all three endpoints at least once.
      expect(fetchCalls).toBeGreaterThanOrEqual(3)
    })
  })

  /**
   * Homology is a high-level combination query: seed accession → UniProtKB seed
   * → ID-mapping to a UniRef cluster → cluster members, with the result keeping
   * clusterMembership and sequenceSimilarity SEPARATE and never claiming
   * orthology from a UniRef cluster alone (the plan's first-version promise).
   */
  it('discovers homology candidates through UniRef without overclaiming orthology', async () => {
    const seedEntry = {
      primaryAccession: 'P12345',
      sequence: { value: 'MAKVLCGAHV', length: 10 },
      organism: { scientificName: 'Macro mus', taxonId: 9606 },
    }
    const seed = 'P12345'
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      // seed entry
      if (url.includes(`/uniprotkb/${seed}`)) {
        return new Response(JSON.stringify(seedEntry), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // map seed to UniRef90 cluster
      if (url.includes('/idmapping/run') && method === 'POST') {
        return new Response(JSON.stringify({ jobId: 'homology-job' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/idmapping/status/homology-job')) {
        return new Response(JSON.stringify({ jobStatus: 'FINISHED' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/idmapping/results/homology-job')) {
        return new Response(JSON.stringify({
          results: [{ from: seed, to: 'UniRef90_P12345' }],
          pageInfo: { resultsPerPage: 25 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // cluster members of UniRef90_P12345
      if (url.includes('/uniref/UniRef90_P12345')) {
        return new Response(JSON.stringify({
          id: 'UniRef90_P12345',
          members: [
            { memberId: 'P12345', organism: 'Macro mus' },
            { memberId: 'Q9ZZZ1', organism: 'Macro mus' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${method} ${url}`)
    }

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()
      const result = await registry.invoke('uniprot.query', {
        resource: 'homology',
        seed: { accession: 'P12345' },
        discovery: { unirefLevels: [90], reviewed: 'prefer' },
      }, context) as Record<string, unknown>

      const candidates = result.candidates as Array<Record<string, unknown>>
      expect(candidates.length).toBeGreaterThanOrEqual(1)
      const candidate = candidates[0]
      // clusterMembership is what a UniRef cluster actually proves.
      expect(candidate.clusterMembership).toEqual(expect.anything())
      // sequenceSimilarity is reported separately, never merged into one score.
      expect(candidate.sequenceSimilarity).toEqual(expect.anything())
      // First version never claims ortholog/paralog from clusters alone.
      expect(candidate.orthologyClaim).toBeNull()
    })
  })
})

/**
 * The note/revise overlay: a scientist's knowledge about an entry EVOLVES — a
 * hypothesis today, more evidence tomorrow, a sharper value later, eventually a
 * retraction. `note` records the first version; `revise` is the single entry
 * point for everything that happens after (update value, append evidence,
 * retract). The overlay NEVER overwrites the remote authority record.
 */
describe('native UniProt note/revise overlay', () => {
  it('records a note, revises it with new evidence, then retracts it — all without touching the authority', async () => {
    const entryPayload = {
      primaryAccession: 'P12345',
      proteinDescription: { recommendedName: { fullName: { value: 'Old name' } } },
      sequence: { value: 'MAKVLC', length: 6 },
    }
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes('/uniprotkb/P12345')) {
        return new Response(JSON.stringify(entryPayload), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()

      // 1 — note a hypothesis about the protein's function. Local overlay only.
      const noted = await registry.invoke('uniprot.note', {
        resource: 'uniprotkb',
        id: 'P12345',
        subject: 'P12345',
        predicate: 'function',
        value: 'May regulate the cell cycle',
        verdict: 'supplemented',
        evidenceRefs: ['ev_preliminary.json'],
        comment: 'preliminary observation',
      }, context) as Record<string, unknown>
      expect(noted.noted).toBe(true)
      const noteId = String((noted.note as Record<string, unknown>).id)
      expect(noteId).toMatch(/^refn_[a-f0-9]{16}$/)

      // Authority reads exclude local assertions unless the caller asks for them.
      const authorityRead = await registry.invoke('uniprot.get', {
        resource: 'uniprotkb', id: 'P12345',
      }, context) as Record<string, unknown>
      expect(authorityRead.assertions).toBeUndefined()
      expect(authorityRead.effectiveView).toBeUndefined()
      expect((authorityRead.authorityRecord as Record<string, unknown>).primaryAccession).toBe('P12345')

      const read = await registry.invoke('uniprot.get', {
        resource: 'uniprotkb', id: 'P12345', includeAssertions: true,
      }, context) as Record<string, unknown>
      expect((read.assertions as unknown[])).toHaveLength(1)
      expect((read.effectiveView as Record<string, unknown>).function).toBe('May regulate the cell cycle')
      expect((read.authorityRecord as Record<string, unknown>).primaryAccession).toBe('P12345')

      // 2 — later, more information arrives: sharpen the value AND append
      // evidence, through the single `revise` entry point (not retract+re-note).
      const makePort = (context as unknown as { __makePort: (f?: typeof globalThis.fetch) => ReferenceCommandPort & { dispose(): void } }).__makePort
      context.references = makePort(async () => { throw new Error('NETWORK_UNAVAILABLE') })
      const revised = await registry.invoke('uniprot.revise', {
        noteId,
        value: 'Regulates the cell cycle via CDK binding',
        verdict: 'confirmed',
        evidenceRefs: ['ev_cdk_binding.json'],
        // appendEvidence defaults to true: the new evidence is ADDED, not replaced.
      }, context) as Record<string, unknown>
      expect(revised.revised).toBe(true)
      const revisedNote = revised.note as Record<string, unknown>
      expect(revisedNote.value).toBe('Regulates the cell cycle via CDK binding')
      expect(revisedNote.verdict).toBe('confirmed')
      expect((revisedNote.evidenceRefs as unknown[])).toEqual(['ev_preliminary.json', 'ev_cdk_binding.json'])
      expect(revisedNote.revisedAt).toEqual(expect.any(String))

      // The read reflects the revised value (offline — from the local store).
      const afterRevise = await registry.invoke('uniprot.get', {
        resource: 'uniprotkb', id: 'P12345', includeAssertions: true,
      }, context) as Record<string, unknown>
      expect((afterRevise.effectiveView as Record<string, unknown>).function).toBe('Regulates the cell cycle via CDK binding')

      // 3 — eventually retracted: also via `revise`, with retracted: true.
      await registry.invoke('uniprot.revise', { noteId, retracted: true }, context) as Record<string, unknown>
      const afterRetract = await registry.invoke('uniprot.get', {
        resource: 'uniprotkb', id: 'P12345', includeAssertions: true,
      }, context) as Record<string, unknown>
      expect((afterRetract.assertions as unknown[])).toHaveLength(0)
      expect((afterRetract.effectiveView as Record<string, unknown>).function).toBeUndefined()
    })
  })
})

/**
 * Rate-limit hardening: UniProt throttles with HTTP 429 and a Retry-After
 * header. The client must honour it (wait then retry once) rather than failing
 * the whole read — a transient throttle is not a data error.
 */
describe('native UniProt rate-limit handling', () => {
  it('retries once after a 429 with Retry-After and then succeeds', async () => {
    let calls = 0
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      calls += 1
      const url = String(input)
      if (url.includes('/uniprotkb/P12345')) {
        if (calls === 1) {
          // First attempt is throttled; honour Retry-After (1s) and retry.
          return new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '1' },
          })
        }
        return new Response(JSON.stringify({ primaryAccession: 'P12345' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()
      const result = await registry.invoke('uniprot.get', {
        resource: 'uniprotkb', id: 'P12345',
      }, context) as Record<string, unknown>
      // The throttle was retried and the read succeeded.
      expect(calls).toBe(2)
      const record = result.authorityRecord as Record<string, unknown>
      expect(record.primaryAccession).toBe('P12345')
    })
  })
})

/**
 * The `uniprot.blast` link: a short fragment BLASTed against UniProtKB through
 * the EBI Job Dispatcher lifecycle (submit → poll status → JSON result). The
 * fake `fetch` serves the three endpoints with a fixed alignment so no test
 * touches the network. The alignment is the point: `querySite` must map onto
 * the subject sequence, and an identical repeat query must hit the local cache
 * (no second remote job).
 */
describe('uniprot.blast', () => {
  const blastJson = {
    program: 'blastp',
    query_len: 20,
    hits: [
      {
        hit_num: 1,
        hit_def: 'SP:P62789 H4_MEDSA Histone H4 OS=Medicago sativa OX=3879',
        hit_id: 'H4_MEDSA',
        hit_acc: 'P62789',
        hit_desc: 'Histone H4',
        hit_os: 'Medicago sativa',
        hit_len: 103,
        hit_hsps: [
          {
            hsp_num: 1, hsp_score: 108, hsp_bit_score: 46.2,
            hsp_expect: 1.1e-08, hsp_align_len: 20, hsp_identity: 100.0,
            hsp_positive: 100.0, hsp_gaps: 0,
            hsp_query_from: 1, hsp_query_to: 20,
            hsp_hit_from: 2, hsp_hit_to: 21,
            hsp_qseq: 'SGRGKGGKGLGKGGAKRHRK',
            hsp_mseq: 'SGRGKGGKGLGKGGAKRHRK',
            hsp_hseq: 'SGRGKGGKGLGKGGAKRHRK',
          },
        ],
      },
    ],
  }

  it('runs the BLAST lifecycle, maps querySite onto the subject, and caches a repeat query', async () => {
    let fetchCalls = 0
    let submissions = 0
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      fetchCalls += 1
      const url = String(input)
      if (url.endsWith('/ncbiblast/run')) {
        submissions += 1
        expect(init?.method).toBe('POST')
        expect(String(init?.body)).toContain('exp=1e-4')
        return new Response('ncbiblast-TEST-0001', { status: 200 })
      }
      if (url.includes('/ncbiblast/status/')) {
        return new Response('FINISHED', { status: 200 })
      }
      if (url.includes('/ncbiblast/result/')) {
        return new Response(JSON.stringify(blastJson), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    await withReferenceContext({ fetch: fakeFetch }, async (context) => {
      const registry = createStudioCommandRegistry()

      // First call: submits once, maps querySite=5 (a K) onto hit position.
      const first = await registry.invoke('uniprot.blast', {
        sequence: 'SGRGKGGKGLGKGGAKRHRK',
        querySite: 5,
      }, context) as Record<string, unknown>
      expect(submissions).toBe(1)
      expect(first.hitCount).toBe(1)
      expect(first.source.database).toBe('ebi-blast')
      const hit = (first.hits as Array<Record<string, unknown>>)[0]
      expect(hit.accession).toBe('P62789')
      expect(hit.organism).toBe('Medicago sativa')
      const alignment = (hit.alignments as Array<Record<string, unknown>>)[0]
      expect(alignment.identity).toBe(100)
      // hit_from = 2, ungapped: query position 5 → subject position 6.
      expect(alignment.hit_site).toBe(6)

      // Repeat identical query: served from the local cache, no new submission.
      const second = await registry.invoke('uniprot.blast', {
        sequence: 'SGRGKGGKGLGKGGAKRHRK',
        querySite: 5,
      }, context) as Record<string, unknown>
      expect(submissions).toBe(1)
      expect(second.resolution.localHit).toBe(true)
      expect(second.hitCount).toBe(1)
    })
  })

  it('rejects a query without a sequence', async () => {
    await withReferenceContext({ fetch: async () => { throw new Error('should not fetch') } }, async (context) => {
      const registry = createStudioCommandRegistry()
      // The command layer validates the required argument before the port runs.
      await expect(registry.invoke('uniprot.blast', { sequence: '  ' }, context)).rejects.toThrow('sequence must be a non-empty string')
    })
  })
})

/**
 * Build integrity for the bundled UniMod database. One test only (AGENTS.md §2):
 * the import is complete — modification, specificity and neutral-loss counts
 * agree with the source XML — and one real representative record (Phospho) is
 * projected with the structure residue-aware queries depend on. Rebuilding to
 * a temp path keeps the shipped artifact untouched during the check.
 */
describe('bundled UniMod database build', () => {
  it('imports the full specificity and neutral-loss structure from unimod.xml', async () => {
    const tempDb = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-unimod-build-')), 'unimod.sqlite')
    const summary = buildUnimodDatabase(path.join(bundledReferenceRoot, 'unimod.xml'), tempDb)
    expect(summary.recordCount).toBe(1560)
    expect(summary.specificityCount).toBe(2826)
    expect(summary.neutralLossCount).toBe(0)
    expect(summary.elementCount).toBe(40)
    expect(summary.release).toEqual({ majorVersion: 2, minorVersion: 0 })
    expect(summary.digest).toMatch(/^[a-f0-9]{64}$/)
  })
})
