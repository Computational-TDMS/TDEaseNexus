import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import type { DryRunProjection } from '@/studio/ports/backend-gateway'

/**
 * The DAG canvas must be the workbench's language on this side of the product
 * too: Vue Flow canvas, quiet pane, card nodes (rule name only), hairline
 * edges, one small control cluster — never a mermaid shell.
 *
 * @vue-flow/core measures the DOM and stays empty under jsdom, so the module
 * is mocked with a shape-compatible stub; these tests pin OUR contract
 * (projection → nodes/edges props, card slot content, toolbar, fallback),
 * not Vue Flow's rendering.
 */

vi.mock('@vue-flow/core', () => {
  const Position = { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' } as const
  // Renders one .vue-flow root plus every node through the caller's
  // `node-card` slot and every edge as a class-carrying element.
  const VueFlow = defineComponent({
    name: 'VueFlow',
    props: ['id', 'nodes', 'edges', 'fitViewOnInit', 'nodesConnectable', 'elementsSelectable', 'edgesUpdatable', 'panOnDrag', 'zoomOnScroll', 'preventScrolling'],
    setup(props, { slots }) {
      return () =>
        h('div', { class: 'vue-flow' }, [
          ...(props.nodes ?? []).map((node: { id: string; data: unknown }) =>
            h('div', { class: 'vue-flow__node', 'data-node-id': node.id }, [slots['node-card']?.({ data: node.data })])),
          ...(props.edges ?? []).map((edge: { id: string; class?: string }) =>
            h('div', { class: ['vue-flow__edge', edge.class], 'data-edge-id': edge.id })),
        ])
    },
  })
  const Handle = defineComponent({
    name: 'Handle',
    props: ['type', 'position'],
    setup(props) {
      return () => h('div', { class: ['vue-flow__handle', `vue-flow__handle-${props.type}`] })
    },
  })
  const api = { zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn() }
  return { VueFlow, Handle, Position, useVueFlow: () => api }
})

const { default: WorkflowDagViewer } = await import('./WorkflowDagViewer.vue')

// The real canvas gate: with no ResizeObserver the component must stay on the
// placeholder. The mounted path needs the browser API to exist at setup time.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function projection(
  nodes: Array<{ id: number; rule: string; label?: string }>,
  edges: Array<{ source: number; target: number }> = [],
): DryRunProjection {
  return { nodes, edges } as unknown as DryRunProjection
}

async function mountViewer(p: DryRunProjection) {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  try {
    const wrapper = mount(WorkflowDagViewer, { props: { projection: p } })
    // the canvas gates behind a mounted flag; let that re-render flush
    await nextTick()
    return wrapper
  } finally {
    vi.unstubAllGlobals()
  }
}

describe('WorkflowDagViewer', () => {
  it('renders one card node per projection node with the rule name', async () => {
    const wrapper = await mountViewer(projection([
      { id: 1, rule: 'all' },
      { id: 2, rule: 'msconvert', label: 'out/sample.mzML' },
      { id: 3, rule: 'topfd' },
    ], [
      { source: 2, target: 1 },
      { source: 3, target: 1 },
    ]))
    const cards = wrapper.findAll('.tdease-wf-card')
    expect(cards).toHaveLength(3)
    const rules = cards.map((card) => card.find('.tdease-wf-card-rule').text())
    expect(rules).toContain('msconvert')
    // the file-path label is a tooltip, never card chrome
    expect(cards[1].attributes('title')).toBe('out/sample.mzML')
    expect(cards[1].text()).not.toContain('out/sample.mzML')
    wrapper.unmount()
  })

  it('maps dependency edges to hairline flow edges and keeps the control cluster small', async () => {
    const wrapper = await mountViewer(projection(
      [{ id: 1, rule: 'a' }, { id: 2, rule: 'b' }, { id: 3, rule: 'b' }], [
        { source: 2, target: 1 },
        { source: 2, target: 1 }, // duplicate: deduped, one hairline per dependency
        { source: 1, target: 1 }, // self-edge: skipped
      ]))
    expect(wrapper.findAll('.vue-flow__edge.tdease-dag-edge')).toHaveLength(1)
    const toolbar = wrapper.findAll('.tdease-dag-toolbar button')
    expect(toolbar).toHaveLength(3) // zoom in / zoom out / fit view
    wrapper.unmount()
  })

  it('is a Vue Flow canvas, not a mermaid shell', async () => {
    const wrapper = await mountViewer(projection([{ id: 1, rule: 'a' }]))
    expect(wrapper.find('.vue-flow').exists()).toBe(true)
    expect(wrapper.find('.mermaid-diagram').exists()).toBe(false)
    wrapper.unmount()
  })

  it('falls back to the quiet placeholder for an empty projection', async () => {
    const wrapper = await mountViewer(projection([]))
    expect(wrapper.find('.tdease-dag-placeholder').exists()).toBe(true)
    expect(wrapper.find('.vue-flow').exists()).toBe(false)
    expect(wrapper.text()).toContain('dry-run')
    wrapper.unmount()
  })
})
