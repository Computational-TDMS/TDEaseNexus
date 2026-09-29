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
})
