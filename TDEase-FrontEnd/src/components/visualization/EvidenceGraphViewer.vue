<template>
  <div class="evidence-graph" :class="{ 'evidence-graph--unframed': unframed }" data-testid="evidence-graph-viewer">
    <div class="evidence-graph__canvas">
      <svg
        :viewBox="`0 0 ${canvasWidth} ${canvasHeight}`"
        role="img"
        :aria-label="$t('visualization.viewer.evidenceGraph')"
      >
        <defs>
          <marker
            id="evidence-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>

        <line
          v-for="edge in renderedEdges"
          :key="edge.id"
          data-evidence-edge
          :x1="edge.x1"
          :y1="edge.y1"
          :x2="edge.x2"
          :y2="edge.y2"
          :class="['evidence-graph__edge', `evidence-graph__edge--${edge.kind}`]"
          marker-end="url(#evidence-arrow)"
        />

        <text
          v-for="edge in renderedEdges"
          :key="`${edge.id}:label`"
          data-evidence-edge-label
          :x="(edge.x1 + edge.x2) / 2"
          :y="(edge.y1 + edge.y2) / 2 - 5"
          class="evidence-graph__edge-label"
          text-anchor="middle"
        >{{ edge.kind }}</text>

        <g
          v-for="node in positionedNodes"
          :key="node.id"
          data-evidence-node
          :data-node-id="node.id"
          :transform="`translate(${node.x}, ${node.y})`"
          :class="['evidence-graph__node', `evidence-graph__node--${node.kind}`, node.status ? `evidence-graph__node--status-${node.status}` : '', { 'is-selected': selectedId === node.id }]"
          role="button"
          tabindex="0"
          @click="selectedId = node.id"
          @keydown.enter="selectedId = node.id"
        >
          <rect :width="nodeWidth" :height="nodeHeight" rx="6" />
          <text x="12" y="20" class="evidence-graph__kind">{{ node.kind }}</text>
          <text
            v-if="node.status"
            :x="nodeWidth - 12"
            y="20"
            text-anchor="end"
            :class="['evidence-graph__status', `evidence-graph__status--${node.status}`]"
          >{{ statusLabel(node.status) }}</text>
          <text x="12" y="40" class="evidence-graph__label">{{ node.label }}</text>
        </g>
      </svg>
    </div>

    <aside
      v-if="selectedNode"
      class="evidence-graph__detail"
      data-testid="evidence-node-detail"
    >
      <div class="evidence-graph__detail-kind">{{ selectedNode.kind }}</div>
      <div
        v-if="selectedNode.status"
        class="evidence-graph__detail-status"
      >
        <span class="evidence-graph__detail-label">{{ $t('workbench.evidenceGraph.status') }}</span>
        <span :class="['evidence-graph__status', `evidence-graph__status--${selectedNode.status}`]">{{ statusLabel(selectedNode.status) }}</span>
      </div>
      <div class="evidence-graph__detail-title">{{ selectedNode.statement || selectedNode.id }}</div>
      <div v-if="selectedNode.rationale" class="evidence-graph__detail-copy">
        {{ selectedNode.rationale }}
      </div>
      <div
        v-for="(review, index) in selectedNode.reviews"
        :key="`${review.verdict}:${index}`"
        class="evidence-graph__review"
      >
        <div class="evidence-graph__review-status">
          {{ review.verdict }} / {{ review.status }}
        </div>
        <div v-if="review.rationale" class="evidence-graph__detail-copy">
          {{ review.rationale }}
        </div>
      </div>
      <div class="evidence-graph__detail-ref">{{ selectedNode.id }}</div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'

import type { Dataset } from '@/types/visualization'

/**
 * The claim verdict vocabulary — the evidence.write contract's five statuses
 * (`evidence/*.prov.json`), the paradigm's own words. Labels localize through
 * `workbench.evidenceGraph.statusValue.*`; anything outside the closed set
 * renders verbatim rather than pretending it is known.
 */
const STATUS_KEYS = ['proposed', 'challenged', 'inconclusive', 'supported', 'refuted'] as const

type EvidenceNode = Record<string, unknown> & {
  id: string
  kind: string
  statement?: string
  rationale?: string
  status?: string
  /** Explicit layout column (e.g. topological depth from evidence.graph). */
  column?: number
  reviews: Array<{ verdict: string; status: string; rationale?: string }>
}

type EvidenceEdge = {
  from: string
  to: string
  kind: string
}

const props = withDefaults(defineProps<{
  datasets: Dataset[]
  viewSpec?: Record<string, unknown>
  unframed?: boolean
}>(), {
  datasets: () => [],
  viewSpec: () => ({}),
  unframed: false,
})

const { t } = useI18n()

function statusLabel(status: string): string {
  return STATUS_KEYS.includes(status as typeof STATUS_KEYS[number])
    ? t(`workbench.evidenceGraph.statusValue.${status}`)
    : status
}

const nodeWidth = 196
const nodeHeight = 54
const columnGap = 82
const rowGap = 28

const nodes = computed<EvidenceNode[]>(() => {
  const dataset = props.datasets.find((item) => item.id === 'nodes' || item.kind === 'evidence_nodes')
  return (dataset?.rows ?? [])
    .filter((row) => typeof row.id === 'string' && row.id.trim())
    .map((row) => ({
      ...row,
      id: String(row.id),
      kind: String(row.kind || 'unknown'),
      statement: typeof row.statement === 'string' ? row.statement : undefined,
      rationale: typeof row.rationale === 'string' ? row.rationale : undefined,
      status: typeof row.status === 'string' ? row.status : undefined,
      column: typeof row.column === 'number' && Number.isInteger(row.column) && row.column >= 0 ? row.column : undefined,
      reviews: Array.isArray(row.reviews)
        ? row.reviews.flatMap((review) => {
          if (!review || typeof review !== 'object') return []
          const value = review as Record<string, unknown>
          if (typeof value.verdict !== 'string' || typeof value.status !== 'string') return []
          return [{
            verdict: value.verdict,
            status: value.status,
            rationale: typeof value.rationale === 'string' ? value.rationale : undefined,
          }]
        })
        : [],
    }))
})

const edges = computed<EvidenceEdge[]>(() => {
  const dataset = props.datasets.find((item) => item.id === 'edges' || item.kind === 'evidence_edges')
  return (dataset?.rows ?? [])
    .filter((row) => typeof row.from === 'string' && typeof row.to === 'string')
    .map((row) => ({ from: String(row.from), to: String(row.to), kind: String(row.kind || 'related') }))
})

function nodeColumn(kind: string): number {
  if (kind === 'inference') return 1
  if (['claim', 'hypothesis', 'conclusion'].includes(kind)) return 2
  return 0
}

/** An explicit `column` (topological depth) wins over the kind-based default. */
function columnOf(node: EvidenceNode): number {
  return node.column ?? nodeColumn(node.kind)
}

const positionedNodes = computed(() => {
  const columnCounts = new Map<number, number>()
  return nodes.value.map((node) => {
    const column = columnOf(node)
    const row = columnCounts.get(column) ?? 0
    columnCounts.set(column, row + 1)
    const label = node.statement || node.rationale || node.id
    return {
      ...node,
      label: label.length > 28 ? `${label.slice(0, 25)}...` : label,
      x: 28 + column * (nodeWidth + columnGap),
      y: 24 + row * (nodeHeight + rowGap),
    }
  })
})

const canvasWidth = computed(() => {
  const maxColumn = positionedNodes.value.reduce((max, node) => Math.max(max, columnOf(node)), 0)
  return (maxColumn + 1) * nodeWidth + maxColumn * columnGap + 80
})

const canvasHeight = computed(() => {
  const counts = new Map<number, number>()
  positionedNodes.value.forEach((node) => {
    const column = columnOf(node)
    counts.set(column, (counts.get(column) ?? 0) + 1)
  })
  const maxRows = Math.max(0, ...counts.values())
  return Math.max(240, maxRows * (nodeHeight + rowGap) + 32)
})

const renderedEdges = computed(() => {
  const positions = new Map(positionedNodes.value.map((node) => [node.id, node]))
  return edges.value.flatMap((edge, index) => {
    const source = positions.get(edge.from)
    const target = positions.get(edge.to)
    if (!source || !target) return []
    return [{
      ...edge,
      id: `${edge.from}:${edge.to}:${edge.kind}:${index}`,
      x1: source.x + nodeWidth,
      y1: source.y + nodeHeight / 2,
      x2: target.x,
      y2: target.y + nodeHeight / 2,
    }]
  })
})

const rootRef = computed(() => {
  const options = props.viewSpec.options
  if (!options || typeof options !== 'object') return ''
  const value = (options as Record<string, unknown>).rootRef
  return typeof value === 'string' ? value : ''
})
const selectedId = ref('')
watchEffect(() => {
  if (!selectedId.value || !nodes.value.some((node) => node.id === selectedId.value)) {
    selectedId.value = rootRef.value || nodes.value[0]?.id || ''
  }
})
const selectedNode = computed(() => nodes.value.find((node) => node.id === selectedId.value) ?? null)
</script>

<style scoped>
.evidence-graph {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(210px, 28%);
  min-height: 320px;
  border: var(--line-w) solid var(--line-hairline);
  background: var(--color-bg-secondary);
}

.evidence-graph--unframed {
  min-height: 100%;
  border: 0;
  background: transparent;
}

.evidence-graph__canvas { overflow: auto; min-width: 0; }
.evidence-graph__canvas svg { display: block; width: 100%; min-width: 720px; height: auto; color: var(--color-text-muted); }
.evidence-graph__edge { stroke: var(--color-text-muted); stroke-width: 1.5; color: var(--color-text-muted); }
.evidence-graph__edge--supports, .evidence-graph__edge--derives { stroke: var(--color-success); color: var(--color-success-text); }
.evidence-graph__edge--opposes { stroke: var(--color-error); color: var(--color-error-text); stroke-dasharray: 5 4; }
.evidence-graph__node { cursor: pointer; outline: none; }
.evidence-graph__node rect { fill: var(--color-bg-secondary); stroke: var(--color-text-muted); stroke-width: 1.5; }
.evidence-graph__node--artifact rect { fill: var(--color-bg-muted); stroke: var(--color-text-muted); }
.evidence-graph__node--inference rect { fill: var(--color-info-soft); stroke: var(--color-info); }
.evidence-graph__node--claim rect,
.evidence-graph__node--hypothesis rect,
.evidence-graph__node--conclusion rect { fill: var(--color-success-soft); stroke: var(--color-success); }
.evidence-graph__node.is-selected rect,
.evidence-graph__node:focus rect { stroke-width: 3; }
/* The claim verdict, rendered: the tag on the node (SVG text paints by fill)
   and the detail line (HTML paints by color) share the state classes — both
   properties set so one vocabulary serves both outputs. Node strokes follow:
   refuted/challenged claim trouble, inconclusive reads as a dashed outline
   (an open bound, not a failure), supported keeps the claim green. */
.evidence-graph__status { font-size: var(--text-label); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.evidence-graph__status--supported { fill: var(--color-success-text); color: var(--color-success-text); }
.evidence-graph__status--refuted { fill: var(--color-error-text); color: var(--color-error-text); }
.evidence-graph__status--challenged { fill: var(--color-warning-text); color: var(--color-warning-text); }
.evidence-graph__status--proposed { fill: var(--color-info-text); color: var(--color-info-text); }
.evidence-graph__status--inconclusive { fill: var(--color-text-muted); color: var(--color-text-muted); }
.evidence-graph__node--status-refuted rect { stroke: var(--color-error); }
.evidence-graph__node--status-challenged rect { stroke: var(--color-warning); }
.evidence-graph__node--status-inconclusive rect { stroke-dasharray: 4 3; }
.evidence-graph__kind { fill: var(--color-text-secondary); font-size: var(--text-label); font-weight: 700; text-transform: uppercase; }
.evidence-graph__label { fill: var(--color-text); font-size: var(--text-sm); }
.evidence-graph__detail { padding: 18px; border-left: var(--line-w) solid var(--line-seam); background: var(--color-bg-muted); overflow-wrap: anywhere; }
.evidence-graph__detail-kind { color: var(--color-info-text); font-size: var(--text-label); font-weight: 700; text-transform: uppercase; }
.evidence-graph__detail-status { display: flex; align-items: baseline; gap: var(--space-2); margin-top: var(--space-1); }
.evidence-graph__detail-label { color: var(--color-text-secondary); font-size: var(--text-sm); }
.evidence-graph__detail-title { margin-top: var(--space-2); color: var(--color-text); font-size: var(--text-md); font-weight: 650; line-height: 1.45; }
.evidence-graph__detail-copy { margin-top: var(--space-3); color: var(--color-text-secondary); font-size: var(--text-sm); line-height: 1.5; }
.evidence-graph__review { margin-top: 14px; padding-top: var(--space-3); border-top: var(--line-w) solid var(--line-hairline); }
.evidence-graph__review-status { color: var(--color-success-text); font-size: var(--text-label); font-weight: 700; text-transform: uppercase; }
.evidence-graph__detail-ref { margin-top: var(--space-4); color: var(--color-text-muted); font-family: var(--font-mono); font-size: var(--text-label); }

@media (max-width: 720px) {
  .evidence-graph { grid-template-columns: 1fr; }
  .evidence-graph__detail { border-top: var(--line-w) solid var(--line-seam); border-left: 0; }
}
</style>
