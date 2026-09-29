import type { Column, Dataset } from '@/types/visualization'
import type { EvidenceGraphIssue, EvidenceGraphProjection } from './workspaceEvidence'

const NODE_COLUMNS: Column[] = [
  { name: 'id', type: 'string' },
  { name: 'kind', type: 'string' },
  { name: 'statement', type: 'string' },
  { name: 'status', type: 'string' },
  { name: 'path', type: 'string' },
  { name: 'column', type: 'integer' },
]
const EDGE_COLUMNS: Column[] = [
  { name: 'from', type: 'string' },
  { name: 'to', type: 'string' },
  { name: 'kind', type: 'string' },
]

/** One row of the workspace Evidence table view: one claim, its home file, its degree. */
export interface WorkspaceEvidenceRow {
  ref: string
  status: string
  summary: string
  path: string
  relations: number
}

export interface WorkspaceEvidenceGraphView {
  datasets: Dataset[]
  rows: WorkspaceEvidenceRow[]
  issueBadges: EvidenceGraphIssue[]
}

/**
 * Projects the cross-file `buildEvidenceGraph` result into the two shapes the
 * workbench surface renders: `EvidenceGraphViewer` datasets (claims carry
 * their status for coloring) and one flat table row per claim.
 */
export function projectWorkspaceEvidenceGraph(graph: EvidenceGraphProjection): WorkspaceEvidenceGraphView {
  const relationCount = new Map<string, number>()
  for (const edge of graph.edges) {
    relationCount.set(edge.fromPath, (relationCount.get(edge.fromPath) ?? 0) + 1)
    relationCount.set(edge.toPath, (relationCount.get(edge.toPath) ?? 0) + 1)
  }
  const columns = layerColumns(graph)
  return {
    datasets: [
      {
        id: 'nodes',
        kind: 'evidence_nodes',
        columns: NODE_COLUMNS,
        rows: graph.nodes.map((node) => ({
          id: node.ref,
          kind: 'claim',
          statement: node.summary,
          status: node.status,
          path: node.path,
          column: columns.get(node.path) ?? 0,
          reviews: [],
        })),
      },
      {
        id: 'edges',
        kind: 'evidence_edges',
        columns: EDGE_COLUMNS,
        rows: graph.edges.map((edge) => ({ from: edge.fromRef, to: edge.toRef, kind: edge.type })),
      },
    ],
    rows: graph.nodes.map((node) => ({
      ref: node.ref,
      status: node.status,
      summary: node.summary,
      path: node.path,
      relations: relationCount.get(node.path) ?? 0,
    })),
    issueBadges: graph.issues.map((issue) => ({ ...issue, paths: [...issue.paths] })),
  }
}

export function projectEvidenceGraph(document: Record<string, unknown>): { datasets: Dataset[]; viewSpec: Record<string, unknown> } {
  const entities = asRecord(document.entity)
  const nodes = Object.entries(entities).map(([id, raw]) => {
    const value = asRecord(raw)
    return { id, kind: evidenceKind(value['prov:type']), statement: String(value['prov:value'] ?? value['prov:location'] ?? id), reviews: [] }
  })
  const edges: Array<Record<string, unknown>> = []
  relationEdges(document, 'wasDerivedFrom', 'prov:usedEntity', 'prov:generatedEntity', edges)
  relationEdges(document, 'wasRevisionOf', 'prov:usedEntity', 'prov:generatedEntity', edges)
  relationEdges(document, 'wasInvalidatedBy', 'prov:entity', 'prov:activity', edges)
  return {
    datasets: [
      { id: 'nodes', kind: 'evidence_nodes', columns: NODE_COLUMNS, rows: nodes },
      { id: 'edges', kind: 'evidence_edges', columns: EDGE_COLUMNS, rows: edges },
    ],
    viewSpec: { type: 'evidence_graph', options: {} },
  }
}
function relationEdges(document: Record<string, unknown>, section: string, from: string, to: string, output: Array<Record<string, unknown>>): void {
  for (const value of Object.values(asRecord(document[section]))) {
    const relation = asRecord(value)
    if (typeof relation[from] === 'string' && typeof relation[to] === 'string') output.push({ from: relation[from], to: relation[to], kind: section })
  }
}
function evidenceKind(value: unknown): string {
  const type = String(value ?? '').toLowerCase()
  return type.includes('claim') ? 'claim' : type.includes('activity') ? 'inference' : 'entity'
}
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

/**
 * Longest-path layering over derivation/revision edges so a claim chain lays
 * out left-to-right (older claims left, revisions right) instead of stacking
 * in one column. `wasInvalidatedBy` is excluded, mirroring the cycle walk in
 * `buildEvidenceGraph`; cycles fall back to column 0 rather than recursing.
 */
function layerColumns(graph: EvidenceGraphProjection): Map<string, number> {
  const known = new Set(graph.nodes.map((node) => node.path))
  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (edge.type === 'wasInvalidatedBy' || !known.has(edge.toPath)) continue
    outgoing.set(edge.fromPath, [...(outgoing.get(edge.fromPath) ?? []), edge.toPath])
  }
  const columns = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (path: string): number => {
    const cached = columns.get(path)
    if (cached !== undefined) return cached
    if (visiting.has(path)) return 0
    visiting.add(path)
    let column = 0
    for (const next of outgoing.get(path) ?? []) column = Math.max(column, depth(next) + 1)
    visiting.delete(path)
    columns.set(path, column)
    return column
  }
  for (const node of graph.nodes) depth(node.path)
  return columns
}
