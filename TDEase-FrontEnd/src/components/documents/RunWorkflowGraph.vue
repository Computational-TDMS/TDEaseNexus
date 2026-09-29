<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import dagre from 'dagre'
import type { WorkflowGraph } from '@/studio/ports/backend-gateway'
import { useI18n } from 'vue-i18n'
import AppButton from '@/components/primitives/AppButton.vue'

// Read-only run monitoring, rendered as a publication-grade figure rather
// than a graph-editor canvas: an editor toolkit (pan/zoom chrome, draggable
// nodes) is the wrong instrument here and its default skin is what made the
// panel look dev-tool. dagre owns topology; this file owns the picture.
const props = defineProps<{ graph: WorkflowGraph | null; loading: boolean; error: boolean; terminal: boolean }>()
const emit = defineEmits<{ retry: []; inspect: [nodeId: string] }>()
const { t } = useI18n()

const NODE_W = 176
const NODE_H = 56
const STATUS_ORDER = ['running', 'succeeded', 'failed', 'cancelled', 'waiting', 'up_to_date'] as const

interface LaidNode { id: string; label: string; detail: string | null; status: string; wildcards: Readonly<Record<string, string>>; x: number; y: number; name: string; detailText: string | null; glyph: string | null; textMax: number }
interface LaidEdge { id: string; source: string; target: string; path: string; active: boolean }

const nodes = ref<LaidNode[]>([])
const edges = ref<LaidEdge[]>([])

// Direct neighbours of the hovered node, rebuilt with each layout. Plain
// (non-reactive) is enough: layout changes already re-render the template,
// and hover state itself lives in the reactive `hoveredId`.
let adjacency = { up: new Map<string, Set<string>>(), down: new Map<string, Set<string>>() }

const counts = computed(() => {
  const result: Record<string, number> = {}
  for (const node of props.graph?.nodes ?? []) result[node.status] = (result[node.status] ?? 0) + 1
  return STATUS_ORDER.filter((status) => (result[status] ?? 0) > 0).map((status) => ({ status, count: result[status] }))
})

const measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null

function fitText(text: string, font: string, maxWidth: number): string {
  if (!measureCtx) return text
  measureCtx.font = font
  if (measureCtx.measureText(text).width <= maxWidth) return text
  let cut = text.length
  while (cut > 0 && measureCtx.measureText(`${text.slice(0, cut - 1)}…`).width > maxWidth) cut--
  return `${text.slice(0, Math.max(0, cut - 1))}…`
}

// First-paint truncation above only estimates widths with a generic font, so
// it can undershoot the real face (and ignores --font-scale). Once rendered,
// re-truncate against getComputedTextLength — the actually painted width —
// and again whenever web fonts finish loading.
function applyTextFit() {
  const texts = svgEl.value ? Array.from(svgEl.value.querySelectorAll<SVGTextElement>('text[data-fit]')) : []
  if (!texts.length || typeof texts[0].getComputedTextLength !== 'function') return
  for (const el of texts) {
    const max = Number(el.dataset.max ?? '0')
    const full = el.dataset.full ?? ''
    el.textContent = full
    if (!full || el.getComputedTextLength() <= max) continue
    let cut = full.length
    while (cut > 1) {
      el.textContent = `${full.slice(0, cut - 1)}…`
      if (el.getComputedTextLength() <= max) break
      cut--
    }
  }
}

function roundedPath(points: ReadonlyArray<{ x: number; y: number }>, radius = 8): string {
  if (points.length < 2) return ''
  const r2 = (n: number) => Math.round(n * 100) / 100
  let d = `M ${r2(points[0].x)} ${r2(points[0].y)}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1], corner = points[i], next = points[i + 1]
    const seg = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y)
    const rIn = Math.min(radius, seg(prev, corner) / 2), rOut = Math.min(radius, seg(corner, next) / 2)
    const toward = (from: { x: number; y: number }, dist: number) => {
      const len = seg(corner, from)
      const t = len === 0 ? 0 : dist / len
      return { x: r2(corner.x + (from.x - corner.x) * t), y: r2(corner.y + (from.y - corner.y) * t) }
    }
    const pIn = toward(prev, rIn), pOut = toward(next, rOut)
    d += ` L ${pIn.x} ${pIn.y} Q ${r2(corner.x)} ${r2(corner.y)} ${pOut.x} ${pOut.y}`
  }
  const last = points[points.length - 1]
  d += ` L ${r2(last.x)} ${r2(last.y)}`
  return d
}

function statusGlyph(status: string): string | null {
  return status === 'succeeded' ? '✓' : status === 'failed' ? '✗' : null
}

function layoutGraph(graph: WorkflowGraph) {
  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ rankdir: 'LR', ranksep: 76, nodesep: 34 })
  for (const item of graph.nodes) layout.setNode(String(item.id), { width: NODE_W, height: NODE_H })
  for (const edge of graph.edges) if (edge.source !== edge.target) layout.setEdge(String(edge.source), String(edge.target))
  dagre.layout(layout)
  const statusById = new Map(graph.nodes.map((item) => [String(item.id), item.status]))
  adjacency = { up: new Map(), down: new Map() }
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue
    const source = String(edge.source), target = String(edge.target)
    if (!adjacency.down.has(source)) adjacency.down.set(source, new Set())
    adjacency.down.get(source)!.add(target)
    if (!adjacency.up.has(target)) adjacency.up.set(target, new Set())
    adjacency.up.get(target)!.add(source)
  }
  nodes.value = graph.nodes.map((item) => {
    const point = layout.node(String(item.id))
    const detail = Object.values(item.wildcards).join(' · ') || null
    const glyph = statusGlyph(item.status)
    const textW = NODE_W - 26 - (glyph !== null ? 18 : 8)
    return {
      id: String(item.id), label: item.label, detail, status: item.status, glyph, textMax: textW,
      wildcards: item.wildcards,
      x: point.x - NODE_W / 2, y: point.y - NODE_H / 2,
      name: fitText(item.label, '600 12px sans-serif', textW),
      detailText: detail ? fitText(detail, '11px monospace', textW) : null,
    }
  })
  edges.value = graph.edges.flatMap((edge, index) => {
    if (edge.source === edge.target) return []
    const points = layout.edge(String(edge.source), String(edge.target))?.points
    if (!points?.length) return []
    return [{
      id: `e-${index}-${edge.source}-${edge.target}`,
      source: String(edge.source),
      target: String(edge.target),
      path: roundedPath(points),
      active: statusById.get(String(edge.target)) === 'running',
    }]
  })
}

// Camera: fit-to-view never exceeds 100% — a three-node workflow blown up to
// 180% was the single ugliest thing in the old panel. Refit only while the
// user has not claimed the viewport; polling status updates keep the camera.
const camera = ref({ x: 0, y: 0, k: 1 })
const svgEl = ref<SVGSVGElement | null>(null)
const canvasEl = ref<HTMLElement | null>(null)
const canvasSize = ref({ w: 0, h: 0 })
const panning = ref(false)
let userMoved = false
let panOrigin: { x: number; y: number; cx: number; cy: number; pointerId: number; captured: boolean } | null = null
let resizeObserver: ResizeObserver | null = null
let rootAttrObserver: MutationObserver | null = null
const ZOOM_MIN = 0.2
const ZOOM_MAX = 1.6

function fitCamera() {
  const { w, h } = canvasSize.value
  if (!w || !h || !nodes.value.length) return
  const minX = Math.min(...nodes.value.map((n) => n.x))
  const minY = Math.min(...nodes.value.map((n) => n.y))
  const maxX = Math.max(...nodes.value.map((n) => n.x + NODE_W))
  const maxY = Math.max(...nodes.value.map((n) => n.y + NODE_H))
  const pad = 28
  const k = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY), 1)
  camera.value = {
    k,
    x: (w - (maxX - minX) * k) / 2 - minX * k,
    y: (h - (maxY - minY) * k) / 2 - minY * k,
  }
}

function requestFit() {
  void nextTick(() => { if (!userMoved) fitCamera() })
}

function scheduleTextFit() {
  void nextTick(applyTextFit)
}

function zoomAt(px: number, py: number, factor: number) {
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.value.k * factor))
  const scale = k / camera.value.k
  camera.value.x = px - (px - camera.value.x) * scale
  camera.value.y = py - (py - camera.value.y) * scale
  camera.value.k = k
}

function onWheel(event: WheelEvent) {
  const rect = svgEl.value?.getBoundingClientRect()
  if (!rect) return
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0015))
  userMoved = true
  dismissHover()
}

function zoomStep(factor: number) {
  zoomAt(canvasSize.value.w / 2, canvasSize.value.h / 2, factor)
  userMoved = true
}

function resetCamera() {
  userMoved = false
  fitCamera()
}

// Hover: dimming is immediate, the card waits for a short intent delay so
// sweeping the pointer across the graph doesn't flicker cards. Panning or
// zooming dismisses both.
const hoveredId = ref<string | null>(null)
const cardShown = ref(false)
let hoverTimer: ReturnType<typeof setTimeout> | null = null
let suppressClick = false

const hoveredNode = computed(() => (hoveredId.value === null ? null : nodes.value.find((node) => node.id === hoveredId.value) ?? null))

const cardStyle = computed(() => {
  const node = hoveredNode.value
  if (!node || !cardShown.value) return null
  const { w } = canvasSize.value
  const k = camera.value.k
  const centerX = Math.min(Math.max(node.x * k + camera.value.x + (NODE_W * k) / 2, 150), Math.max(w - 150, 150))
  const nodeTop = node.y * k + camera.value.y
  const above = nodeTop > 170
  return {
    left: `${centerX}px`,
    top: above ? `${nodeTop - 10}px` : `${nodeTop + NODE_H * k + 10}px`,
    transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
  }
})

function clearHoverTimer() {
  if (hoverTimer !== null) { clearTimeout(hoverTimer); hoverTimer = null }
}

function onNodeEnter(node: LaidNode) {
  hoveredId.value = node.id
  clearHoverTimer()
  hoverTimer = setTimeout(() => { cardShown.value = true }, 150)
}

function onNodeLeave() {
  clearHoverTimer()
  hoveredId.value = null
  cardShown.value = false
}

function dismissHover() {
  onNodeLeave()
}

function isNodeDim(id: string): boolean {
  if (hoveredId.value === null) return false
  if (id === hoveredId.value) return false
  return !adjacency.up.get(hoveredId.value)?.has(id) && !adjacency.down.get(hoveredId.value)?.has(id)
}

function isEdgeDim(edge: LaidEdge): boolean {
  if (hoveredId.value === null) return false
  return edge.source !== hoveredId.value && edge.target !== hoveredId.value
}

function isEdgeOut(edge: LaidEdge): boolean {
  return hoveredId.value !== null && edge.source === hoveredId.value
}

function nodeAria(node: LaidNode): string {
  return `${node.label}${node.detail ? ` — ${node.detail}` : ''} · ${t(`workbench.runDocument.workflowStatus.${node.status}`)}`
}

function onNodeClick(node: LaidNode) {
  if (suppressClick || node.status !== 'failed') return
  emit('inspect', node.id)
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  panOrigin = { x: event.clientX, y: event.clientY, cx: camera.value.x, cy: camera.value.y, pointerId: event.pointerId, captured: false }
  panning.value = true
}

function onPointerMove(event: PointerEvent) {
  if (!panOrigin) return
  const dx = event.clientX - panOrigin.x
  const dy = event.clientY - panOrigin.y
  // Capture lazily, only once a real drag emerges: capturing on pointerdown
  // would redirect the subsequent click away from the node the user clicked.
  if (!panOrigin.captured && Math.hypot(dx, dy) > 3) {
    svgEl.value?.setPointerCapture(panOrigin.pointerId)
    panOrigin.captured = true
    suppressClick = true
    userMoved = true
    dismissHover()
  }
  if (!panOrigin.captured) return
  camera.value.x = panOrigin.cx + dx
  camera.value.y = panOrigin.cy + dy
}

function onPointerUp(event: PointerEvent) {
  if (panOrigin?.captured) svgEl.value?.releasePointerCapture(event.pointerId)
  panOrigin = null
  panning.value = false
  // A drag must not register as the failed-node click that follows it.
  setTimeout(() => { suppressClick = false }, 0)
}

function measureCanvas(entries: ResizeObserverEntry[]) {
  const rect = entries[0]?.contentRect
  canvasSize.value = { w: rect?.width ?? 0, h: rect?.height ?? 0 }
  if (!userMoved) fitCamera()
}

onMounted(() => {
  const el = canvasEl.value
  if (el && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measureCanvas)
    resizeObserver.observe(el)
  }
  scheduleTextFit()
  document.fonts?.ready.then(() => applyTextFit()).catch(() => {})
  document.fonts?.addEventListener?.('loadingdone', applyTextFit)
  // Global typography (--font-scale) and themes land on <html> style/class;
  // truncation must re-measure when they change, from wherever they are set.
  if (typeof MutationObserver !== 'undefined') {
    rootAttrObserver = new MutationObserver(applyTextFit)
    rootAttrObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
  }
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  rootAttrObserver?.disconnect()
  clearHoverTimer()
  document.fonts?.removeEventListener?.('loadingdone', applyTextFit)
})

// Layout owns geometry only. A dagre pass is O(V+E) and refits the camera, so
// it must run when the topology changes (nodes/edges appear or disappear) —
// not on every poll tick that merely flips a node status while a run document
// is open. Status drift is patched onto the laid-out nodes by the watcher
// below; the template's reactive class bindings make that visible without
// touching geometry.
const topologyKey = computed(() => {
  const graph = props.graph
  if (!graph) return ''
  return `${graph.nodes.map((item) => String(item.id)).join(',')}|${graph.edges.map((edge) => `${edge.source}-${edge.target}`).join(',')}`
})

watch(topologyKey, () => {
  const graph = props.graph
  if (!graph) { nodes.value = []; edges.value = []; return }
  layoutGraph(graph)
  requestFit()
  scheduleTextFit()
}, { immediate: true })

// Poll/status drift: copy the status-derived fields onto the already-laid-out
// nodes in place. Signature-keyed so an unchanged poll costs a string build,
// not a layout; text re-fit only runs when visible text actually changed.
const statusKey = computed(() => {
  const graph = props.graph
  if (!graph) return ''
  return graph.nodes
    .map((item) => `${item.id}:${item.status}:${item.label}:${Object.values(item.wildcards).join('\u0001')}`)
    .join(',')
})

watch(statusKey, () => {
  const graph = props.graph
  if (!graph || !nodes.value.length) return
  const itemById = new Map(graph.nodes.map((item) => [String(item.id), item]))
  let textChanged = false
  for (const node of nodes.value) {
    const item = itemById.get(node.id)
    if (!item) continue
    const detail = Object.values(item.wildcards).join(' · ') || null
    if (node.detail !== detail || node.label !== item.label) textChanged = true
    node.status = item.status
    node.glyph = statusGlyph(item.status)
    node.label = item.label
    node.name = fitText(item.label, '600 12px sans-serif', node.textMax)
    node.detail = detail
    node.detailText = detail ? fitText(detail, '11px monospace', node.textMax) : null
    node.wildcards = item.wildcards
  }
  for (const edge of edges.value) {
    edge.active = itemById.get(edge.target)?.status === 'running'
  }
  if (textChanged) scheduleTextFit()
})
</script>

<template>
  <section class="workflow-graph" :aria-label="t('workbench.runDocument.workflowTitle')">
    <header class="workflow-graph__header">
      <h3>{{ t('workbench.runDocument.workflowTitle') }}</h3>
      <div class="workflow-graph__counts" aria-live="polite">
        <span v-for="entry in counts" :key="entry.status">
          <i :class="`workflow-dot workflow-dot--${entry.status}`" />{{ entry.count }} {{ t(`workbench.runDocument.workflowStatus.${entry.status}`) }}
        </span>
      </div>
    </header>
    <div ref="canvasEl" class="workflow-graph__canvas">
      <div v-if="loading" class="workflow-graph__empty">{{ t('workbench.runDocument.workflowLoading') }}</div>
      <div v-else-if="error" class="workflow-graph__empty workflow-graph__error">
        <span>{{ t('workbench.runDocument.workflowLoadFailed') }}</span>
        <AppButton variant="default" size="sm" class="workflow-graph__retry" @click="emit('retry')">
          {{ t('workbench.runDocument.workflowRetry') }}
        </AppButton>
      </div>
      <div v-else-if="!nodes.length" class="workflow-graph__empty">
        {{ t(props.terminal ? 'workbench.runDocument.workflowNotRecorded' : 'workbench.runDocument.workflowEmpty') }}
      </div>
      <svg
        v-else
        ref="svgEl"
        class="workflow-graph__svg"
        :class="{ 'workflow-graph__svg--panning': panning }"
        role="img"
        :aria-label="t('workbench.runDocument.workflowTitle')"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <defs>
          <marker id="wf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0.8 L7.5 4 L0 7.2 Z" class="workflow-graph__arrow" />
          </marker>
          <marker id="wf-arrow-active" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0.8 L7.5 4 L0 7.2 Z" class="workflow-graph__arrow--active" />
          </marker>
        </defs>
        <g :transform="`translate(${camera.x} ${camera.y}) scale(${camera.k})`">
          <path
            v-for="edge in edges"
            :key="edge.id"
            class="workflow-graph__edge"
            :class="{
              'workflow-graph__edge--active': edge.active,
              'workflow-graph__edge--dim': isEdgeDim(edge),
              'workflow-graph__edge--out': isEdgeOut(edge),
            }"
            :d="edge.path"
            :marker-end="edge.active || isEdgeOut(edge) ? `url(#wf-arrow-active)` : `url(#wf-arrow)`"
          />
          <g
            v-for="node in nodes"
            :key="node.id"
            class="workflow-graph__node"
            :class="[`workflow-graph__node--${node.status}`, { 'workflow-graph__node--dim': isNodeDim(node.id) }]"
            :aria-label="nodeAria(node)"
            @pointerenter="onNodeEnter(node)"
            @pointerleave="onNodeLeave"
            @click="onNodeClick(node)"
          >
            <rect class="workflow-graph__node-box" :x="node.x" :y="node.y" :width="NODE_W" :height="NODE_H" rx="8" />
            <rect class="workflow-graph__node-accent" :x="node.x + 5" :y="node.y + 10" width="3" :height="NODE_H - 20" rx="1.5" />
            <text class="workflow-graph__node-name" data-fit :data-max="node.textMax" :data-full="node.label" :x="node.x + 16" :y="node.detailText ? node.y + 24 : node.y + NODE_H / 2 + 4">{{ node.name }}</text>
            <text v-if="node.detailText" class="workflow-graph__node-detail" data-fit :data-max="node.textMax" :data-full="node.detail ?? ''" :x="node.x + 16" :y="node.y + 40">{{ node.detailText }}</text>
            <text v-if="node.glyph" class="workflow-graph__node-glyph" :x="node.x + NODE_W - 14" :y="node.y + NODE_H / 2 + 4">{{ node.glyph }}</text>
            <circle v-else-if="node.status === 'running'" class="workflow-graph__node-pulse" :cx="node.x + NODE_W - 14" :cy="node.y + NODE_H / 2" r="3.5" />
          </g>
        </g>
      </svg>
      <div v-if="cardStyle && hoveredNode" class="workflow-graph__card" :style="cardStyle">
        <div class="workflow-graph__card-head">
          <span class="workflow-graph__card-rule">{{ hoveredNode.label }}</span>
          <span class="workflow-graph__card-status" :class="`workflow-graph__card-status--${hoveredNode.status}`">
            {{ t(`workbench.runDocument.workflowStatus.${hoveredNode.status}`) }}
          </span>
        </div>
        <div v-if="Object.keys(hoveredNode.wildcards).length" class="workflow-graph__card-wildcards">
          <span v-for="(value, key) in hoveredNode.wildcards" :key="key" class="workflow-graph__card-wildcard">
            <i>{{ key }}</i>{{ value }}
          </span>
        </div>
        <span v-if="hoveredNode.status === 'failed'" class="workflow-graph__card-hint">{{ t('workbench.runDocument.inspectHint') }}</span>
      </div>
      <div v-if="nodes.length" class="workflow-graph__zoom">
        <button type="button" :title="t('visualization.viewer.zoomIn')" :aria-label="t('visualization.viewer.zoomIn')" @click="zoomStep(1.25)">
          <svg viewBox="0 0 12 12"><path d="M6 2.2 V9.8 M2.2 6 H9.8" /></svg>
        </button>
        <button type="button" :title="t('visualization.viewer.zoomOut')" :aria-label="t('visualization.viewer.zoomOut')" @click="zoomStep(0.8)">
          <svg viewBox="0 0 12 12"><path d="M2.2 6 H9.8" /></svg>
        </button>
        <button type="button" :title="t('visualization.viewer.reset')" :aria-label="t('visualization.viewer.reset')" @click="resetCamera">
          <svg viewBox="0 0 12 12"><path d="M1.5 4 V1.5 H4 M8 1.5 H10.5 V4 M10.5 8 V10.5 H8 M4 10.5 H1.5 V8" /></svg>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.workflow-graph { width: 100%; flex: none; border-bottom: var(--line-w) solid var(--line-hairline); }
.workflow-graph__header { height: var(--row-h); display: flex; align-items: center; gap: var(--space-5); padding: 0 var(--space-3); background: var(--color-bg-secondary); }
.workflow-graph__header h3 { margin: 0; font-size: var(--text-md); color: var(--color-text); }
.workflow-graph__counts { display: flex; flex-wrap: wrap; gap: var(--space-3); color: var(--color-text-muted); font-size: var(--text-sm); }
.workflow-graph__counts span { display: inline-flex; align-items: center; gap: 5px; }
.workflow-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-text-muted); }
.workflow-dot--running { background: var(--color-primary); } .workflow-dot--succeeded { background: var(--color-success); } .workflow-dot--failed { background: var(--color-error); }
.workflow-dot--up_to_date, .workflow-dot--cancelled { background: var(--color-text-muted); opacity: 0.65; }
.workflow-graph__canvas { position: relative; width: 100%; height: 280px; background: var(--color-bg); }
.workflow-graph__empty { height: 100%; display: grid; place-items: center; color: var(--color-text-muted); font-size: var(--text-sm); }
.workflow-graph__error { align-content: center; gap: var(--space-2); color: var(--color-error); }
.workflow-graph__retry { padding: var(--space-1) var(--space-2); border: 1px solid currentColor; border-radius: var(--radius-sm); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.workflow-graph__retry:hover { background: color-mix(in srgb, currentColor 10%, transparent); }

.workflow-graph__svg { width: 100%; height: 100%; display: block; user-select: none; cursor: grab; }
.workflow-graph__svg--panning { cursor: grabbing; }

.workflow-graph__edge {
  fill: none;
  stroke: var(--color-border-panel-strong);
  stroke-width: 1.25;
  vector-effect: non-scaling-stroke;
  transition: stroke 200ms ease;
}
.workflow-graph__arrow { fill: var(--color-border-panel-strong); }
.workflow-graph__arrow--active { fill: var(--color-primary); }
.workflow-graph__edge--active { stroke: var(--color-primary); stroke-dasharray: 5 4; animation: workflow-dash 1.6s linear infinite; }

/* Status changes crossfade instead of snapping: across a long monitoring
   session the moment a job turns green (or red) should be visible as an
   event, which is information, not decoration. */
.workflow-graph__node-box,
.workflow-graph__node-accent,
.workflow-graph__node-glyph {
  transition: fill 200ms ease, stroke 200ms ease;
}

.workflow-graph__node-box {
  fill: var(--color-bg-card);
  stroke: var(--line-seam-strong);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.workflow-graph__node-accent { fill: color-mix(in srgb, var(--color-text-muted) 45%, transparent); }
.workflow-graph__node-name { fill: var(--color-text); font-size: calc(12px * var(--font-scale)); font-weight: 600; }
.workflow-graph__node-detail { fill: var(--color-text-muted); font-family: var(--font-mono); font-size: calc(11px * var(--font-scale)); }
.workflow-graph__node-glyph { fill: var(--color-text-muted); font-size: calc(11px * var(--font-scale)); text-anchor: end; }
.workflow-graph__node-pulse { fill: var(--color-primary); animation: workflow-pulse 1.6s ease-in-out infinite; }

.workflow-graph__node--succeeded .workflow-graph__node-accent { fill: var(--color-success); }
.workflow-graph__node--succeeded .workflow-graph__node-glyph { fill: var(--color-success); }
.workflow-graph__node--running .workflow-graph__node-accent { fill: var(--color-primary); }
.workflow-graph__node--failed .workflow-graph__node-accent { fill: var(--color-error); }
.workflow-graph__node--failed .workflow-graph__node-glyph { fill: var(--color-error); }
.workflow-graph__node--failed .workflow-graph__node-box { fill: color-mix(in srgb, var(--color-error) 5%, var(--color-bg-card)); }
.workflow-graph__node--failed { cursor: pointer; }

.workflow-graph__edge, .workflow-graph__node { transition: opacity 200ms ease; }
.workflow-graph__edge--dim { opacity: 0.15; }
.workflow-graph__node--dim { opacity: 0.3; }
.workflow-graph__edge--out { stroke: var(--color-primary); }

.workflow-graph__card {
  position: absolute;
  z-index: var(--z-float);
  max-width: 280px;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--line-seam-strong);
  border-radius: var(--radius-sm);
  background: var(--chart-tooltip-bg);
  backdrop-filter: blur(6px);
  box-shadow: 0 6px 20px rgb(0 0 0 / 0.18);
  pointer-events: none;
}
.workflow-graph__card-head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.workflow-graph__card-rule { font-family: var(--font-mono); font-size: var(--text-label); font-weight: 600; color: var(--color-text); overflow-wrap: anywhere; }
.workflow-graph__card-status { flex: none; margin-left: auto; padding: 1px 6px; border-radius: 999px; font-size: var(--text-label); color: var(--color-text-muted); }
.workflow-graph__card-status--running { color: var(--color-primary); background: var(--color-primary-soft); }
.workflow-graph__card-status--succeeded { color: var(--color-success); background: var(--color-success-soft); }
.workflow-graph__card-status--failed { color: var(--color-error); background: var(--color-error-soft); }
.workflow-graph__card-wildcards { display: flex; flex-direction: column; gap: 2px; }
.workflow-graph__card-wildcard { font-family: var(--font-mono); font-size: var(--text-label); color: var(--color-text); overflow-wrap: anywhere; }
.workflow-graph__card-wildcard i { font-style: normal; margin-right: 6px; color: var(--color-text-muted); }
.workflow-graph__card-wildcard i::after { content: ':'; }
.workflow-graph__card-hint { font-size: var(--text-label); color: var(--color-text-muted); }

.workflow-graph__zoom {
  position: absolute;
  left: var(--space-2);
  bottom: var(--space-2);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-hairline);
  border-radius: var(--radius-sm);
  background: var(--color-bg-card);
  overflow: hidden;
}
.workflow-graph__zoom button {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.workflow-graph__zoom button + button { border-top: 1px solid var(--line-hairline); }
.workflow-graph__zoom button:hover { color: var(--color-text); background: var(--color-hover); }
.workflow-graph__zoom button svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; }

@keyframes workflow-dash { to { stroke-dashoffset: -18; } }
@keyframes workflow-pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) {
  .workflow-graph__edge--active, .workflow-graph__node-pulse { animation: none; }
}
</style>
