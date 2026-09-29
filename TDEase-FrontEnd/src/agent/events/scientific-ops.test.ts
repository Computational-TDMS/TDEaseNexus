import { describe, expect, it } from 'vitest'
import { createWorkspaceEvidence, type EvidenceWriteInput } from '@/services/workspace/workspaceEvidence'
import { createSessionEvent, type EventInput, type SessionEvent } from './vocabulary'
import { projectScientificOps, type RunFileFact, type ScientificOpsInput } from './scientific-ops'

async function scientificFixture() {
  const files = new Map<string, string>([['runs/chlamy-h4/envelope.csv', 'offset,pearson\n0,0.938\n']])
  const digests = new Map([['runs/chlamy-h4/envelope.csv', { sha256: 'a'.repeat(64), size: 25 }]])
  const writes: string[] = []
  const ids = ['session-a-claim', 'session-b-claim']
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
    now: () => new Date('2026-07-27T10:00:00.000Z'),
    randomId: () => ids[idIndex++],
  })
  const base: EvidenceWriteInput = {
    scope: { kind: 'workspace' },
    statement: 'The RT 67 envelope supports a proteoform near the expected mass.',
    status: 'proposed',
    activity: { type: 'observation', label: 'Inspect the RT 67 envelope' },
    entities: [{ path: 'runs/chlamy-h4/envelope.csv', role: 'support' }],
  }
  const first = await evidence.write(base, 'session-a-agent')
  const second = await evidence.write({
    ...base,
    statement: 'The zero-offset envelope is consistent, but acetylation localization remains unresolved.',
    status: 'inconclusive',
    activity: { type: 'analysis', label: 'Compare envelope and localization evidence' },
    relations: [{ claimPath: first.path, type: 'wasRevisionOf' }],
    notes: 'The envelope supports proteoform mass, not site localization.',
  }, {
    agentId: 'tdease-agent',
    provenance: {
      sessionId: 'session_b',
      turnId: 'turn_1',
      callId: 'call_2',
      promptSnapshotDigest: 'a'.repeat(64),
      model: 'fixture-model',
    },
  })

  const events = recordedExplorerEvents(second.path, second.claimRef)
  const runFiles: RunFileFact[] = [
    {
      path: 'runs/chlamy-h4/envelope.csv',
      runPath: 'runs/chlamy-h4',
      role: 'output',
      sha256: 'a'.repeat(64),
      size: 25,
    },
    {
      path: 'runs/chlamy-h4/unrelated.txt',
      runPath: 'runs/chlamy-h4',
      role: 'unknown',
    },
  ]
  return {
    writes,
    input: {
      sessionId: 'session_b',
      events,
      evidence: [await evidence.read(first.path), await evidence.read(second.path)],
      runFiles,
    } satisfies ScientificOpsInput,
    first,
    second,
  }
}

function recordedExplorerEvents(evidencePath: string, claimRef: string): SessionEvent[] {
  const entries: EventInput[] = [
    {
      type: 'turn.started',
      turn_id: 'turn_1',
      user_message: 'Check whether RT 67 proves acetylation localization.',
      prompt_snapshot_digest: 'a'.repeat(64),
      model: 'fixture-model',
      mindset: 'explorer',
      authority: 'ask',
    },
    { type: 'thinking.recorded', turn_id: 'turn_1', content: 'private chain of thought must not appear' },
    { type: 'tool.requested', turn_id: 'turn_1', call_id: 'call_1', name: 'tdease.spectra.query', args: {} },
    { type: 'tool.completed', turn_id: 'turn_1', call_id: 'call_1', ok: true, result: { rows: 1 } },
    {
      type: 'message.completed',
      turn_id: 'turn_1',
      role: 'assistant',
      content: 'The envelope supports mass consistency, but it cannot localize the acetylation site.',
    },
    { type: 'tool.requested', turn_id: 'turn_1', call_id: 'call_2', name: 'tdease.evidence.write', args: {} },
    { type: 'tool.completed', turn_id: 'turn_1', call_id: 'call_2', ok: true, result: { path: evidencePath, claimRef } },
    {
      type: 'message.completed',
      turn_id: 'turn_1',
      role: 'assistant',
      content: 'Recorded the bounded conclusion as an inconclusive Evidence claim.',
    },
    {
      type: 'turn.completed',
      turn_id: 'turn_1',
      outcome: 'resolved',
      usage: { input_tokens: 100, output_tokens: 40, tool_calls: 2, wall_clock_ms: 1234 },
    },
  ]
  return entries.map((entry, index) => createSessionEvent(entry, index + 1))
}

describe('Scientific Ops projection', () => {
  it('projects one real-shaped Explorer session and cross-session Evidence chain deterministically', async () => {
    const fixture = await scientificFixture()
    const inputBefore = JSON.stringify(fixture.input)
    const writesBefore = fixture.writes.length

    const firstProjection = projectScientificOps(fixture.input)
    const replayProjection = projectScientificOps(fixture.input)

    expect(replayProjection).toEqual(firstProjection)
    expect(JSON.stringify(fixture.input)).toBe(inputBefore)
    expect(fixture.writes).toHaveLength(writesBefore)
    expect(Object.isFrozen(firstProjection)).toBe(true)
    expect(firstProjection).toMatchObject({
      sessionId: 'session_b',
      status: 'resolved',
      metrics: { toolCalls: 2, claimTransitions: 1, wallClockMs: 1234 },
    })
    expect(firstProjection.evidence).toHaveLength(2)
    expect(firstProjection.evidence.find((item) => item.projection.path === fixture.first.path)?.observedInSession).toBe(false)
    expect(firstProjection.evidence.find((item) => item.projection.path === fixture.second.path)?.observedInSession).toBe(true)
    expect(firstProjection.provenance.find((item) => item.path === fixture.second.path)?.turn).toMatchObject({
      sessionId: 'session_b', turnId: 'turn_1', callId: 'call_2', model: 'fixture-model',
    })
    expect(firstProjection.reasoning).toContainEqual(expect.objectContaining({
      kind: 'claim-transition',
      relatedClaimPresent: true,
      relation: expect.objectContaining({ claimPath: fixture.first.path, type: 'wasRevisionOf' }),
    }))
  })

  it('keeps questions, operational activity, interpretation, Run facts and Evidence visibly distinct', async () => {
    const { input } = await scientificFixture()
    const projection = projectScientificOps(input)

    expect(projection.exploration[0]).toMatchObject({
      kind: 'question',
      mindset: 'explorer',
      source: { kind: 'session-event', sessionId: 'session_b', seq: 1 },
    })
    expect(projection.exploration.filter((item) => item.kind === 'activity')).toHaveLength(2)
    expect(projection.reasoning.filter((item) => item.kind === 'interpretation')).toHaveLength(2)
    expect(projection.evidence.every((item) => item.source.kind === 'evidence')).toBe(true)
    expect(projection.runFiles[0]).toMatchObject({
      source: { kind: 'run-file', path: 'runs/chlamy-h4/envelope.csv' },
      citedBy: expect.any(Array),
    })
    expect(projection.runFiles[0].citedBy).toHaveLength(2)
    expect(projection.runFiles[1].citedBy).toEqual([])
  })

  it('excludes private thinking and never upgrades visible interpretation into Evidence', async () => {
    const { input } = await scientificFixture()
    const projection = projectScientificOps(input)
    const serialized = JSON.stringify(projection)

    expect(serialized).not.toContain('private chain of thought')
    expect(projection.reasoning).toContainEqual(expect.objectContaining({
      kind: 'interpretation',
      text: expect.stringContaining('cannot localize'),
    }))
    expect(projection.evidence.map((item) => item.projection.claim.statement))
      .not.toContain('The envelope supports mass consistency, but it cannot localize the acetylation site.')
  })

  it('derives blocked, active and resolved settlement only from canonical terminal events', () => {
    const started = createSessionEvent({
      type: 'turn.started', turn_id: 'turn_1', user_message: 'Need input?',
      prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture', mindset: 'explorer', authority: 'ask',
    }, 1)
    expect(projectScientificOps({ sessionId: 's1', events: [started], evidence: [], runFiles: [] }))
      .toMatchObject({ status: 'exploring', activeTurnId: 'turn_1' })

    const blocked = createSessionEvent({
      type: 'turn.completed', turn_id: 'turn_1', outcome: 'blocked',
      usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0, wall_clock_ms: 10 },
    }, 2)
    expect(projectScientificOps({ sessionId: 's1', events: [started, blocked], evidence: [], runFiles: [] }))
      .toMatchObject({ status: 'blocked', metrics: { wallClockMs: 10 } })

    const resolved = createSessionEvent({
      type: 'turn.completed', turn_id: 'turn_1', outcome: 'resolved',
      usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0, wall_clock_ms: 20 },
    }, 2)
    expect(projectScientificOps({ sessionId: 's1', events: [started, resolved], evidence: [], runFiles: [] }))
      .toMatchObject({ status: 'resolved', metrics: { wallClockMs: 20 } })
  })

  it('keeps missing or unrelated supplied sources explicit instead of inventing links', async () => {
    const { input } = await scientificFixture()
    const [root, revised] = input.evidence
    const missingPath = 'evidence/missing.prov.json'
    const projection = projectScientificOps({
      ...input,
      evidence: [root, {
        ...revised,
        relations: revised.relations.map((relation) => ({ ...relation, claimPath: missingPath })),
      }],
    })
    expect(projection.reasoning).toContainEqual(expect.objectContaining({
      kind: 'claim-transition',
      relatedClaimPresent: false,
      relation: expect.objectContaining({ claimPath: missingPath }),
    }))
    expect(projection.runFiles.find((file) => file.path.endsWith('unrelated.txt'))?.citedBy).toEqual([])
  })

  it('rejects non-contiguous event input rather than repairing the record', () => {
    const event = createSessionEvent({
      type: 'turn.started', turn_id: 'turn_1', user_message: 'Question',
      prompt_snapshot_digest: 'a'.repeat(64), model: 'fixture', mindset: 'explorer', authority: 'ask',
    }, 2)
    expect(() => projectScientificOps({ sessionId: 's1', events: [event], evidence: [], runFiles: [] }))
      .toThrow('contiguous')
  })
})
