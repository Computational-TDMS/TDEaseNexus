import { describe, expect, it, vi } from 'vitest'
import {
  buildEvidenceGraph,
  createWorkspaceEvidence,
  type EvidenceRelationType,
  type EvidenceWriteInput,
} from './workspaceEvidence'

function harness(ids: string[] = ['claim-a', 'claim-b', 'claim-c', 'claim-d']) {
  const files = new Map<string, string>([
    ['runs/r1/result.csv', 'result'],
    ['runs/r1/figure.svg', '<svg/>'],
  ])
  const digests = new Map([
    ['runs/r1/result.csv', { sha256: 'a'.repeat(64), size: 6 }],
    ['runs/r1/figure.svg', { sha256: 'b'.repeat(64), size: 6 }],
  ])
  const writes: string[] = []
  let idIndex = 0
  const evidence = createWorkspaceEvidence({
    listFiles: async () => [...files.keys()],
    readText: async (path) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`missing: ${path}`)
      return value
    },
    writeTextAtomic: async (path, content) => {
      if (files.has(path)) throw new Error(`exists: ${path}`)
      writes.push(path)
      files.set(path, content)
    },
    digest: async (path) => digests.get(path) ?? null,
  }, {
    now: () => new Date('2026-07-27T12:34:56.000Z'),
    randomId: () => ids[idIndex++] ?? `claim-${idIndex}`,
  })
  return { evidence, files, digests, writes }
}

const proposed: EvidenceWriteInput = {
  scope: { kind: 'workspace' },
  statement: 'A signal is present',
  status: 'proposed',
  activity: { type: 'observation', label: 'Inspect result' },
  entities: [{ path: 'runs/r1/result.csv', role: 'support' }],
  notes: 'Signal identity remains unresolved.',
}

describe('workspace Evidence', () => {
  it('generates one native PROV claim with trusted identity, Plan, digest and compressed projection', async () => {
    const { evidence, files, writes } = harness()
    const result = await evidence.write(proposed, 'session-a-agent')

    expect(result.path).toBe('evidence/20260727123456000-claim-a.prov.json')
    expect(writes).toEqual([result.path])
    const document = JSON.parse(files.get(result.path)!)
    expect(document.prefix).toEqual(expect.objectContaining({
      prov: 'http://www.w3.org/ns/prov#',
      tdease: 'https://tdease.dev/ns/evidence#',
    }))
    expect(JSON.stringify(document)).toContain('prov:Plan')
    expect(JSON.stringify(document)).toContain('a'.repeat(64))
    expect(result.projection).toMatchObject({
      path: result.path,
      claim: { statement: proposed.statement, status: 'proposed', notes: proposed.notes },
      activity: { type: 'observation', label: 'Inspect result' },
      verification: { state: 'unchecked' },
    })
    expect(result.projection.entities).toEqual([
      expect.objectContaining({ path: 'runs/r1/result.csv', role: 'support', verification: 'unchecked' }),
    ])
    expect(result.projection.mermaid).toContain('graph LR')
  })

  it('requires independent adjudication for verdicts and projects it separately', async () => {
    const { evidence } = harness()
    await expect(evidence.write({ ...proposed, status: 'supported' })).rejects.toThrow('requires adjudication')
    await expect(evidence.write({
      ...proposed,
      adjudication: { by: 'user', basis: 'reviewed' },
    })).rejects.toThrow('Only supported/refuted')

    const result = await evidence.write({
      ...proposed,
      status: 'supported',
      adjudication: { by: 'deterministic-check', basis: 'two charge states agree' },
    })
    expect(result.projection.adjudication).toEqual({
      by: 'deterministic-check',
      basis: 'two charge states agree',
    })
  })

  it('lets a later session extend the same immutable logical chain', async () => {
    const { evidence, files } = harness()
    const first = await evidence.write(proposed, 'session-a-agent')
    const originalBytes = files.get(first.path)

    const second = await evidence.write({
      ...proposed,
      statement: 'The signal is consistent with an acetylated proteoform',
      status: 'inconclusive',
      relations: [{ claimPath: first.path, type: 'wasDerivedFrom' }],
    }, 'session-b-agent')

    expect(files.get(first.path)).toBe(originalBytes)
    expect(second.path).not.toBe(first.path)
    expect(second.projection.relations).toEqual([{
      type: 'wasDerivedFrom',
      claimPath: first.path,
      currentClaimRef: second.claimRef,
      relatedClaimRef: first.claimRef,
    }])
    expect(second.projection.relatedClaims).toEqual([
      expect.objectContaining({ ref: first.claimRef, path: first.path, statement: proposed.statement }),
    ])
  })

  it.each<EvidenceRelationType>(['wasDerivedFrom', 'wasRevisionOf', 'wasInvalidatedBy'])(
    'round-trips the %s claim relation',
    async (type) => {
      const { evidence } = harness()
      const first = await evidence.write(proposed)
      const second = await evidence.write({
        ...proposed,
        statement: `${type} statement`,
        relations: [{ claimPath: first.path, type }],
      })
      await expect(evidence.read(second.path)).resolves.toMatchObject({
        relations: [{ type, claimPath: first.path, relatedClaimRef: first.claimRef }],
      })
    },
  )

  it('keeps relation-free writes as separate roots', async () => {
    const { evidence } = harness()
    const first = await evidence.write(proposed)
    const second = await evidence.write({ ...proposed, statement: 'Independent observation' })
    expect(first.projection.relations).toEqual([])
    expect(second.projection.relations).toEqual([])
    expect(first.claimRef).not.toBe(second.claimRef)
  })

  it('rejects missing entities, escaping paths, cross-directory relations and overwrites', async () => {
    const { evidence } = harness(['same-id', 'same-id', 'third-id'])
    await expect(evidence.write({
      ...proposed,
      entities: [{ path: 'missing.csv', role: 'support' }],
    })).rejects.toThrow('not found')
    await expect(evidence.write({
      ...proposed,
      entities: [{ path: '../outside.csv', role: 'support' }],
    })).rejects.toThrow()

    const first = await evidence.write(proposed)
    await expect(evidence.write({ ...proposed })).rejects.toThrow('already exists')
    await expect(evidence.write({
      ...proposed,
      scope: { kind: 'run', runPath: 'runs/r1' },
      relations: [{ claimPath: first.path, type: 'wasRevisionOf' }],
    })).rejects.toThrow('same Evidence directory')
  })

  it('writes Run-scoped claims only below one Run Evidence directory', async () => {
    const { evidence } = harness()
    const result = await evidence.write({ ...proposed, scope: { kind: 'run', runPath: 'runs/r1' } })
    expect(result.path).toMatch(/^runs\/r1\/evidence\/.+\.prov\.json$/)
    await expect(evidence.write({ ...proposed, scope: { kind: 'run', runPath: 'runs/r1/nested' } }))
      .rejects.toThrow('runs/<run>')
  })

  it('verifies current bytes without changing scientific status or writing', async () => {
    const { evidence, digests, writes } = harness()
    const result = await evidence.write(proposed)
    const writeCount = writes.length

    const valid = await evidence.verify(result.path)
    expect(valid).toMatchObject({
      valid: true,
      projection: {
        claim: { status: 'proposed' },
        verification: { state: 'verified', valid: true },
        entities: [{ verification: 'match' }],
      },
    })

    digests.set('runs/r1/result.csv', { sha256: 'c'.repeat(64), size: 6 })
    const changed = await evidence.verify(result.path)
    expect(changed).toMatchObject({
      valid: false,
      projection: {
        claim: { status: 'proposed' },
        verification: { state: 'drifted', valid: false },
        entities: [{ verification: 'changed' }],
      },
    })
    expect(writes).toHaveLength(writeCount)
  })

  it('does not infer session ownership or chain relations', async () => {
    const { evidence } = harness()
    const write = vi.spyOn(evidence, 'write')
    const result = await evidence.write(proposed, 'session-a-agent')
    expect(result.projection.relations).toEqual([])
    expect(JSON.stringify(result.projection)).not.toContain('session-a')
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('adds a trusted AgentTurn anchor and content-addressed Plan without changing tool-authored semantics', async () => {
    const { evidence, files } = harness()
    const provenance = {
      sessionId: 'session_1',
      turnId: 'turn_2',
      callId: 'call_3',
      promptSnapshotDigest: 'c'.repeat(64),
      model: 'provider/model',
    }
    const result = await evidence.write(proposed, { agentId: 'tdease-agent', provenance })
    const document = JSON.parse(files.get(result.path)!)

    expect(result.projection.turn).toEqual({
      ref: 'tdease:turn-session_1-turn_2',
      ...provenance,
      sessionLogPath: '.tdease/sessions/session_1/events.jsonl',
      promptSnapshotPath: `.tdease/sessions/session_1/snapshots/${provenance.promptSnapshotDigest}.md`,
    })
    expect(document.wasInformedBy).toEqual({
      'tdease:turn-context': {
        'prov:informed': result.projection.activity.ref,
        'prov:informant': result.projection.turn.ref,
      },
    })
    expect(document.entity[`tdease:prompt-${provenance.promptSnapshotDigest}`]).toMatchObject({
      'prov:type': 'prov:Plan',
      'tdease:sha256': provenance.promptSnapshotDigest,
    })
    expect(result.projection.claim.statement).toBe(proposed.statement)
  })

  it('accepts namespaced call ids without treating them as a new Run', async () => {
    const { evidence } = harness()
    const result = await evidence.write(proposed, {
      provenance: {
        sessionId: 'session_1', turnId: 'turn_1', callId: 'task-abc:call_4',
        promptSnapshotDigest: 'd'.repeat(64), model: 'provider/model',
      },
    })
    expect(result.projection.turn?.callId).toBe('task-abc:call_4')
    expect(result.projection.activity.type).toBe('observation')
  })

  it('lists claims as path, status and truncated summary, and projects entities without digests', async () => {
    const { evidence } = harness()
    const longStatement = `A signal is present. ${'It holds across every replicate. '.repeat(10)}`
    const result = await evidence.write({ ...proposed, statement: longStatement })

    const listed = await evidence.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].path).toBe(result.path)
    expect(listed[0].status).toBe('proposed')
    expect(listed[0].summary.length).toBeLessThanOrEqual(120)
    expect(listed[0].summary).toContain('A signal is present.')

    const projection = await evidence.read(result.path)
    expect(projection.entities[0]).toEqual({
      ref: expect.any(String),
      path: 'runs/r1/result.csv',
      role: 'support',
      size: 6,
      verification: 'unchecked',
    })
    expect(projection.entities[0]).not.toHaveProperty('sha256')
  })

  it('rejects a bundle whose agent is not a prov:SoftwareAgent', async () => {
    const { evidence, files } = harness()
    const result = await evidence.write(proposed)
    const document = JSON.parse(files.get(result.path)!)
    for (const agent of Object.values(document.agent) as Array<Record<string, unknown>>) {
      agent['prov:type'] = 'prov:Person'
    }
    files.set(result.path, JSON.stringify(document))
    await expect(evidence.read(result.path)).rejects.toThrow('prov:SoftwareAgent')
  })

  it('projects a cross-file claim DAG with truncated summaries and no digests', async () => {
    const { evidence } = harness()
    const first = await evidence.write(proposed)
    const second = await evidence.write({
      ...proposed, statement: 'Derived statement',
      relations: [{ claimPath: first.path, type: 'wasDerivedFrom' }],
    })
    const third = await evidence.write({
      ...proposed, statement: 'Revised statement',
      relations: [{ claimPath: second.path, type: 'wasRevisionOf' }],
    })

    const graph = await evidence.graph()
    expect(graph.issues).toEqual([])
    expect(graph.nodes.map((node) => node.path)).toEqual([first.path, second.path, third.path])
    expect(graph.nodes[0]).toMatchObject({ ref: first.claimRef, status: 'proposed', summary: proposed.statement })
    expect(JSON.stringify(graph)).not.toContain('a'.repeat(64))
    expect(graph.edges).toEqual([
      { fromPath: second.path, fromRef: second.claimRef, toPath: first.path, toRef: first.claimRef, type: 'wasDerivedFrom' },
      { fromPath: third.path, fromRef: third.claimRef, toPath: second.path, toRef: second.claimRef, type: 'wasRevisionOf' },
    ])
  })

  it('reports dangling, unreadable and cyclic graph issues without dropping the graph', async () => {
    const { evidence, files } = harness()
    const first = await evidence.write(proposed)
    const second = await evidence.write({
      ...proposed, relations: [{ claimPath: first.path, type: 'wasDerivedFrom' }],
    })

    // Dangling: point the second claim at a document outside the graph.
    const dangling = JSON.parse(files.get(second.path)!)
    dangling.wasDerivedFrom['tdease:relation-0']['tdease:claimPath'] = 'evidence/missing.prov.json'
    files.set(second.path, JSON.stringify(dangling))

    // Unreadable: one broken bundle must not blank the rest.
    files.set('evidence/broken.prov.json', '{ not json')

    const graph = await evidence.graph()
    expect(graph.nodes.map((node) => node.path)).toEqual([first.path, second.path])
    expect(graph.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'dangling', paths: [second.path, 'evidence/missing.prov.json'] }),
      expect.objectContaining({ kind: 'unreadable', paths: ['evidence/broken.prov.json'] }),
    ]))

    // Cycle: restore the intact edge, then make the first revise the second.
    const restored = JSON.parse(files.get(second.path)!)
    restored.wasDerivedFrom['tdease:relation-0']['tdease:claimPath'] = first.path
    files.set(second.path, JSON.stringify(restored))
    const cyclic = JSON.parse(files.get(first.path)!)
    cyclic.wasRevisionOf = {
      'tdease:relation-0': {
        'prov:generatedEntity': first.claimRef,
        'prov:usedEntity': second.claimRef,
        'tdease:claimPath': second.path,
      },
    }
    files.set(first.path, JSON.stringify(cyclic))
    const looped = await evidence.graph()
    expect(looped.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cycle', paths: expect.arrayContaining([first.path, second.path]) }),
    ]))
    expect(looped.nodes).toHaveLength(2)
  })

  it('refuses to extend a relation chain that already contains a cycle', async () => {
    const { evidence, files } = harness()
    const first = await evidence.write(proposed)
    const second = await evidence.write({
      ...proposed, relations: [{ claimPath: first.path, type: 'wasDerivedFrom' }],
    })
    const cyclic = JSON.parse(files.get(first.path)!)
    cyclic.wasRevisionOf = {
      'tdease:relation-0': {
        'prov:generatedEntity': first.claimRef,
        'prov:usedEntity': second.claimRef,
        'tdease:claimPath': second.path,
      },
    }
    files.set(first.path, JSON.stringify(cyclic))

    await expect(evidence.write({
      ...proposed, relations: [{ claimPath: second.path, type: 'wasRevisionOf' }],
    })).rejects.toThrow('cycle')
  })

  it('builds the same graph from raw documents the caller read', async () => {
    const { evidence, files } = harness()
    const first = await evidence.write(proposed)
    const second = await evidence.write({
      ...proposed, relations: [{ claimPath: first.path, type: 'wasRevisionOf' }],
    })
    const graph = buildEvidenceGraph([
      { path: first.path, document: JSON.parse(files.get(first.path)!) },
      { path: second.path, document: JSON.parse(files.get(second.path)!) },
      { path: 'evidence/garbage.prov.json', document: null },
    ])
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges).toHaveLength(1)
    expect(graph.issues).toEqual([
      expect.objectContaining({ kind: 'unreadable', paths: ['evidence/garbage.prov.json'] }),
    ])
  })
})
