<!--
  WorkflowDagViewer — renders a Snakemake workflow's dry-run DAG on a Vue Flow
  canvas, visually identical to the DSH workbench workflow DAG (the product's
  single DAG language: @vue-flow here mirrors @xyflow/react there).

  The DAG arrives as a `DryRunProjection` (`{ nodes, edges }`) from
  `documentsStore.projectWorkspaceWorkflow`, which runs Snakemake's native
  dry-run and returns the resolved rule graph. This component only projects
  that structure; it invents no topology.

  Visual language ported 1:1 from the workbench canvas (frontend-plugins
  workbench-ui src/workbench/workflow/dagStyles.js): a quiet inset sheet, node
  cards carrying just the rule name, hairline dependency edges, one small
  paper control cluster. No dot grid, no minimap, no legend panel. Status
  colour hooks (data-status) exist but stay neutral for dry-run projections,
  which carry no execution state.

  Layout is the workbench's deterministic layered placement (Kahn depth, then
  lane order) — same geometry constants, so both canvases place an identical
  graph identically.

  jsdom safety: Vue Flow measures the DOM (ResizeObserver); until the browser
  APIs exist and the component is mounted, a stable placeholder renders — the
  document surface never white-screens in tests.
-->
<template>
  <div class="workflow-dag tdease-wf-dag" data-testid="workflow-dag">
    <VueFlow
      v-if="ready"
      :id="flowId"
      :nodes="flowNodes"
      :edges="flowEdges"
      :fit-view-on-init="true"
      :nodes-connectable="false"
      :elements-selectable="true"
      :edges-updatable="false"
      :pan-on-drag="true"
      :zoom-on-scroll="true"
      :prevent-scrolling="true"
      class="tdease-dag-flow"
    >
      <template #node-card="{ data }">
        <div class="tdease-wf-card" :data-status="data.status" :title="data.title ?? undefined">
          <div class="tdease-wf-card-head">
            <span class="tdease-wf-card-rule">{{ data.rule }}</span>
            <span class="tdease-wf-chip" aria-hidden="true"><i class="tdease-dag-dot" /></span>
          </div>
        </div>
        <Handle type="target" :position="Position.Left" class="tdease-wf-handle" />
        <Handle type="source" :position="Position.Right" class="tdease-wf-handle" />
      </template>
    </VueFlow>
    <div v-if="ready" class="tdease-dag-toolbar" role="group" aria-label="DAG view controls">
      <button type="button" :title="t('workbench.workflowDag.zoomIn')" :aria-label="t('workbench.workflowDag.zoomIn')" @click="zoomIn()"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" /></svg></button>
      <button type="button" :title="t('workbench.workflowDag.zoomOut')" :aria-label="t('workbench.workflowDag.zoomOut')" @click="zoomOut()"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M5 11h14v2H5z" /></svg></button>
      <button type="button" :title="t('workbench.workflowDag.fitView')" :aria-label="t('workbench.workflowDag.fitView')" @click="fitView()"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M4 4h6v2H6v4H4zm16 0v6h-2V6h-4V4zM4 20v-6h2v4h4v2zm16 0h-6v-2h4v-4h2z" /></svg></button>
    </div>
    <div v-if="!ready" class="tdease-dag-placeholder">
      <p>{{ placeholderText }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Handle, Position, useVueFlow, VueFlow } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import type { DryRunProjection } from '@/studio/ports/backend-gateway'

/**
 * Card geometry and column/lane pitch copied from the workbench canvas
 * (RunGraph.js layout constants) so both products place the same graph the
 * same way.
 */
const DAG_COLUMN_WIDTH = 220
const DAG_LANE_HEIGHT = 90
const LAYOUT_ORIGIN = 20

const props = defineProps<{
  projection: DryRunProjection
}>()

const { t } = useI18n()

const mounted = ref(false)
const supportsMeasurement =
  typeof window !== 'undefined' && typeof window.ResizeObserver !== 'undefined'
const ready = computed(
  () => mounted.value && supportsMeasurement && layout.value.nodes.length > 0)
const placeholderText = computed(() =>
  layout.value.nodes.length === 0
    ? t('workbench.workflowDag.emptyProjection')
    : t('workbench.workflowDag.preparing'))

/**
 * The workbench's deterministic layered layout, ported verbatim: Kahn depth
 * over the dependency edges, then lane order within a column. Pure — same
 * projection in, same positions out.
 */
function layoutProjection(projection: DryRunProjection) {
  const nodes = projection?.nodes ?? []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = (projection?.edges ?? []).filter(
    (edge) => byId.has(edge.source) && byId.has(edge.target))
  const pending = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map(
    nodes.map((node) => [node.id, [] as Array<(typeof nodes)[number]['id']>]))
  const depth = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of edges) {
    pending.set(edge.target, (pending.get(edge.target) ?? 0) + 1)
    outgoing.get(edge.source)!.push(edge.target)
  }
  const queue = nodes.filter((node) => pending.get(node.id) === 0).map((node) => node.id)
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    for (const target of outgoing.get(id) ?? []) {
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(id) ?? 0) + 1))
      pending.set(target, (pending.get(target) ?? 1) - 1)
      if (pending.get(target) === 0) queue.push(target)
    }
  }
  const lanes = new Map<number, number>()
  const placed = nodes.map((node) => {
    const level = depth.get(node.id) ?? 0
    const lane = lanes.get(level) ?? 0
    lanes.set(level, lane + 1)
    return {
      ...node,
      x: LAYOUT_ORIGIN + level * DAG_COLUMN_WIDTH,
      y: LAYOUT_ORIGIN + lane * DAG_LANE_HEIGHT,
    }
  })
  return { nodes: placed, edges }
}

const layout = computed(() => layoutProjection(props.projection))

const flowNodes = computed(() =>
  layout.value.nodes.map((node) => ({
    id: String(node.id),
    type: 'card' as const,
    position: { x: node.x, y: node.y },
    data: {
      rule: node.rule,
      title: node.label && node.label !== node.rule ? node.label : undefined,
      status: undefined as string | undefined,
    },
  })),
)

const flowEdges = computed(() => {
  const seen = new Set<string>()
  return layout.value.edges
    .filter((edge) => {
      if (edge.source === edge.target) return false
      const key = `${edge.source}->${edge.target}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((edge) => ({
      id: `e-${edge.source}-${edge.target}`,
      source: String(edge.source),
      target: String(edge.target),
      class: 'tdease-dag-edge',
    }))
})

const flowId = `workflow-dag-${Math.random().toString(36).slice(2, 8)}`
const { zoomIn, zoomOut, fitView } = useVueFlow({ id: flowId })

onMounted(() => {
  mounted.value = true
})
onBeforeUnmount(() => {
  mounted.value = false
})
</script>

<!--
  Unscoped on purpose: Vue Flow's internals (pane/nodes/edges) render outside
  the scoped-attribute boundary; every rule is namespaced under
  .workflow-dag, mirroring the workbench dagStyles selectors 1:1.
-->
<style>
.workflow-dag.tdease-wf-dag {
  position: relative;
  width: 100%;
  min-height: 280px;
  height: clamp(280px, 48vh, 560px);
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary, var(--ctp-mantle));
  font-family: var(--font-sans, inherit);
  font-size: 12px;
}

/* the canvas stays quiet: transparent pane, no dot grid */
.workflow-dag .tdease-dag-flow {
  width: 100%;
  height: 100%;
  background: transparent;
}
.workflow-dag .vue-flow__pane { background: transparent; cursor: grab; }
.workflow-dag .vue-flow__pane.dragging { cursor: grabbing; }

/* node cards: paper cards, rule name only (workbench geometry) */
.workflow-dag .tdease-wf-card {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 200px;
  height: 64px;
  box-sizing: border-box;
  padding: 10px 12px;
  background: var(--color-bg-tertiary, var(--ctp-crust));
  border: 0;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  color: var(--color-text, inherit);
  transition: box-shadow 0.14s ease, background-color 0.14s ease;
}
.workflow-dag .tdease-wf-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.workflow-dag .tdease-wf-card-rule {
  min-width: 0;
  font-size: 12.5px;
  line-height: 16px;
  font-weight: 600;
  letter-spacing: -0.005em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workflow-dag .tdease-wf-chip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}
.workflow-dag .tdease-dag-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-live, var(--color-primary));
}
/* status colour hooks — the workbench signal set, wired for the day the
   projection carries execution state */
.workflow-dag .tdease-wf-card[data-status='running'] .tdease-dag-dot { background: var(--color-primary); }
.workflow-dag .tdease-wf-card[data-status='succeeded'] .tdease-dag-dot,
.workflow-dag .tdease-wf-card[data-status='up_to_date'] .tdease-dag-dot { background: var(--color-success); }
.workflow-dag .tdease-wf-card[data-status='failed'] .tdease-dag-dot { background: var(--color-error); }
.workflow-dag .tdease-wf-card[data-status='waiting'] .tdease-dag-dot { background: var(--color-warning); }
.workflow-dag .tdease-wf-card[data-status='cancelled'] .tdease-dag-dot,
.workflow-dag .tdease-wf-card[data-status='skipped'] .tdease-dag-dot { background: var(--color-text-muted); }
.workflow-dag .tdease-wf-card[data-status='cancelled'],
.workflow-dag .tdease-wf-card[data-status='skipped'] { opacity: 0.65; }

/* hover: one soft teal ring, no glow */
.workflow-dag .vue-flow__node:hover .tdease-wf-card,
.workflow-dag .vue-flow__node:focus-visible .tdease-wf-card {
  box-shadow: var(--shadow-md), 0 0 0 1px color-mix(in srgb, var(--color-primary) 45%, transparent);
}
.workflow-dag .vue-flow__node.selected .tdease-wf-card {
  box-shadow: var(--shadow-md), 0 0 0 1.5px var(--color-primary);
}
.workflow-dag .vue-flow__node:focus-visible { outline: none; }

/* handles: 5px paper dots, only while the canvas is under the pointer */
.workflow-dag .vue-flow__handle {
  width: 5px !important;
  height: 5px !important;
  min-width: 0 !important;
  min-height: 0 !important;
  border: 1px solid var(--color-border-panel, var(--ctp-surface1)) !important;
  background: var(--color-bg-tertiary, var(--ctp-crust)) !important;
  border-radius: 50% !important;
  opacity: 0;
}
.workflow-dag.tdease-wf-dag:hover .vue-flow__handle { opacity: 1; }

/* edges: warm hairlines */
.workflow-dag .vue-flow__edge-path { stroke-width: 1.25; }
.workflow-dag .vue-flow__edge.tdease-dag-edge .vue-flow__edge-path {
  stroke: var(--color-border-panel, var(--ctp-surface1));
}
.workflow-dag .vue-flow__edge.selected .vue-flow__edge-path {
  stroke: var(--color-text-muted);
}

/* selection box: none — the card's own ring is the signal */
.workflow-dag .vue-flow__nodesselection-rect,
.workflow-dag .vue-flow__selection { display: none; }

/* chrome: one small paper control cluster */
.workflow-dag .tdease-dag-toolbar {
  position: absolute;
  right: 10px;
  top: 10px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  overflow: hidden;
}
.workflow-dag .tdease-dag-toolbar button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-bottom: 1px solid var(--color-border-panel, var(--ctp-surface1));
  background: var(--color-bg-tertiary, var(--ctp-crust));
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.workflow-dag .tdease-dag-toolbar button:last-child { border-bottom: 0; }
.workflow-dag .tdease-dag-toolbar button:hover {
  background: color-mix(in srgb, var(--color-primary-soft, transparent) 60%, var(--color-bg-tertiary, var(--ctp-crust)));
  color: var(--color-text);
}
.workflow-dag .vue-flow__attribution { display: none; }

/* placeholder: same quiet voice as the workbench canvas */
.workflow-dag .tdease-dag-placeholder {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  height: 100%;
  padding: 0 16px;
  color: var(--color-text-muted);
  font-size: 11.5px;
}
.workflow-dag .tdease-dag-placeholder p { margin: 0; }
</style>
