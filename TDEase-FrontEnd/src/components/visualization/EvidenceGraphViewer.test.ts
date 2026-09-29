import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import EvidenceGraphViewer from './EvidenceGraphViewer.vue'

describe('EvidenceGraphViewer', () => {
  it('renders claims, inference nodes, and supporting/opposing edges', async () => {
    const wrapper = mount(EvidenceGraphViewer, {
      props: {
        datasets: [
          {
            id: 'nodes',
            kind: 'evidence_nodes',
            columns: [],
            rows: [
              { id: 'artifact:1', kind: 'artifact' },
              { id: 'inference:1', kind: 'inference', rationale: 'Ion support' },
              {
                id: 'claim:1',
                kind: 'conclusion',
                statement: 'M12 localization',
                reviews: [
                  { verdict: 'accepted', status: 'confirmed', rationale: 'Human review' },
                ],
              },
            ],
          },
          {
            id: 'edges',
            kind: 'evidence_edges',
            columns: [],
            rows: [
              { from: 'artifact:1', to: 'inference:1', kind: 'premise' },
              { from: 'inference:1', to: 'claim:1', kind: 'supports' },
            ],
          },
        ],
        viewSpec: { options: { rootRef: 'claim:1' } },
      },
    })

    expect(wrapper.find('[data-testid="evidence-graph-viewer"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-evidence-node]')).toHaveLength(3)
    expect(wrapper.findAll('[data-evidence-edge]')).toHaveLength(2)
    expect(wrapper.text()).toContain('M12 localization')

    await wrapper.find('[data-node-id="claim:1"]').trigger('click')
    expect(wrapper.find('[data-testid="evidence-node-detail"]').text()).toContain(
      'M12 localization',
    )
    expect(wrapper.find('[data-testid="evidence-node-detail"]').text()).toContain('accepted')
  })

  it('renders the claim verdict as a node tag, a node class and a detail line', async () => {
    const wrapper = mount(EvidenceGraphViewer, {
      props: {
        datasets: [{
          id: 'nodes',
          kind: 'evidence_nodes',
          columns: [],
          rows: [
            { id: 'claim:a', kind: 'claim', statement: 'Dual lipidation', status: 'supported' },
            { id: 'claim:b', kind: 'claim', statement: 'Swapped sites', status: 'refuted' },
            { id: 'claim:c', kind: 'claim', statement: 'Open bound', status: 'inconclusive' },
            { id: 'claim:x', kind: 'claim', statement: 'Future word', status: 'sequestered' },
          ],
        }],
      },
    })

    const nodes = wrapper.findAll('[data-evidence-node]')
    expect(nodes[0].classes()).toContain('evidence-graph__node--status-supported')
    expect(nodes[1].classes()).toContain('evidence-graph__node--status-refuted')
    // The closed five-state vocabulary localizes; an unknown status renders
    // verbatim — shown, never swallowed.
    expect(nodes[0].text()).toContain('已支持')
    expect(nodes[1].text()).toContain('已反驳')
    expect(nodes[2].text()).toContain('尚无定论')
    expect(nodes[3].text()).toContain('sequestered')

    await wrapper.find('[data-node-id="claim:b"]').trigger('click')
    const detail = wrapper.find('[data-testid="evidence-node-detail"]')
    expect(detail.text()).toContain('状态')
    expect(detail.text()).toContain('已反驳')
  })

  it('stays silent about status when a node carries none', () => {
    const wrapper = mount(EvidenceGraphViewer, {
      props: {
        datasets: [{
          id: 'nodes',
          kind: 'evidence_nodes',
          columns: [],
          rows: [{ id: 'artifact:1', kind: 'artifact' }],
        }],
      },
    })
    expect(wrapper.find('.evidence-graph__status').exists()).toBe(false)
    expect(wrapper.findAll('[data-evidence-node]')[0].text()).not.toContain('状态')
  })
})
