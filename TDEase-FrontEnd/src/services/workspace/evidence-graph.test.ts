import { describe, expect, it } from 'vitest'

import { projectWorkspaceEvidenceGraph } from './evidence-graph'
import type { EvidenceGraphProjection } from './workspaceEvidence'

const graph: EvidenceGraphProjection = {
  nodes: [
    { ref: 'tdease:claim-1', path: 'evidence/c1.prov.json', status: 'supported', summary: 'First claim' },
    { ref: 'tdease:claim-2', path: 'evidence/c2.prov.json', status: 'challenged', summary: 'Second claim' },
    { ref: 'tdease:claim-3', path: 'runs/r1/evidence/c3.prov.json', status: 'proposed', summary: 'Third claim' },
  ],
  edges: [
    { fromPath: 'evidence/c2.prov.json', fromRef: 'tdease:claim-2', toPath: 'evidence/c1.prov.json', toRef: 'tdease:claim-1', type: 'wasRevisionOf' },
    { fromPath: 'runs/r1/evidence/c3.prov.json', fromRef: 'tdease:claim-3', toPath: 'evidence/c2.prov.json', toRef: 'tdease:claim-2', type: 'wasDerivedFrom' },
  ],
  issues: [
    { kind: 'dangling', detail: 'x wasRevisionOf missing.prov.json', paths: ['evidence/c1.prov.json', 'evidence/missing.prov.json'] },
  ],
}

describe('projectWorkspaceEvidenceGraph', () => {
  it('projects graph nodes and edges into EvidenceGraphViewer datasets', () => {
    const { datasets } = projectWorkspaceEvidenceGraph(graph)
    const nodes = datasets.find((dataset) => dataset.id === 'nodes')
    const edges = datasets.find((dataset) => dataset.id === 'edges')

    expect(nodes?.rows).toEqual([
      expect.objectContaining({ id: 'tdease:claim-1', kind: 'claim', statement: 'First claim', status: 'supported', path: 'evidence/c1.prov.json', column: 0 }),
      expect.objectContaining({ id: 'tdease:claim-2', kind: 'claim', status: 'challenged', column: 1 }),
      expect.objectContaining({ id: 'tdease:claim-3', kind: 'claim', status: 'proposed', column: 2 }),
    ])
    expect(edges?.rows).toEqual([
      { from: 'tdease:claim-2', to: 'tdease:claim-1', kind: 'wasRevisionOf' },
      { from: 'tdease:claim-3', to: 'tdease:claim-2', kind: 'wasDerivedFrom' },
    ])
  })

  it('projects one table row per claim with its relation count', () => {
    const { rows } = projectWorkspaceEvidenceGraph(graph)
    expect(rows).toEqual([
      { ref: 'tdease:claim-1', status: 'supported', summary: 'First claim', path: 'evidence/c1.prov.json', relations: 1 },
      { ref: 'tdease:claim-2', status: 'challenged', summary: 'Second claim', path: 'evidence/c2.prov.json', relations: 2 },
      { ref: 'tdease:claim-3', status: 'proposed', summary: 'Third claim', path: 'runs/r1/evidence/c3.prov.json', relations: 1 },
    ])
  })

  it('passes graph issues through as badges', () => {
    const { issueBadges } = projectWorkspaceEvidenceGraph(graph)
    expect(issueBadges).toEqual([
      { kind: 'dangling', detail: 'x wasRevisionOf missing.prov.json', paths: ['evidence/c1.prov.json', 'evidence/missing.prov.json'] },
    ])
  })
})
