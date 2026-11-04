import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import ViewerSurface from './ViewerSurface.vue'

const renderer = defineComponent({
  props: {
    datasets: { type: Array, required: true },
    viewSpec: { type: Object, required: true },
    selection: { type: Object, default: null },
  },
  emits: ['selection-change'],
  setup(props, { emit }) {
    return () => h('button', {
      class: 'marks',
      onClick: () => emit('selection-change', {
        selectedIndices: new Set([0]),
        selectedRefs: [{ field: 'feature.id', value: 'F1' }],
        filterCriteria: [],
        brushRegion: null,
      }),
    }, JSON.stringify({
      kinds: (props.datasets as Array<{ kind: string }>).map(dataset => dataset.kind),
      viewSpec: props.viewSpec,
      selectedRefs: (props.selection as { selectedRefs?: unknown[] } | null)?.selectedRefs ?? [],
    }))
  },
})

vi.mock('@/services/visualization/ViewerRegistry', () => ({
  viewerRegistry: {
    require: (id: string) => id === 'featuremap'
      ? {
          id,
          component: renderer,
          ports: {
            data: [{ id: 'features', accepts: ['feature_table'], cardinality: 'one', required: true }],
            selectionInputs: [{ id: 'features', kind: 'proteomics/feature', keyField: 'feature.id' }],
            selectionOutputs: [{ id: 'features', kind: 'proteomics/feature', keyField: 'feature.id' }],
          },
        }
      : undefined,
  },
}))

describe('ViewerSurface', () => {
  it('renders port-keyed canonical data without presentation chrome and emits semantic selection', async () => {
    const wrapper = mount(ViewerSurface, {
      props: {
        input: {
          viewer: 'featuremap',
          inputs: {
            features: {
              id: 'features',
              kind: 'feature_table',
              columns: [{ name: 'feature.id', type: 'string' }],
              rows: [{ 'feature.id': 'F1' }],
            },
          },
          selections: {
            features: { kind: 'proteomics/feature', keys: ['F1'] },
          },
          params: { x: 'feature.rt' },
        },
      },
    })

    expect(wrapper.find('.marks').text()).toContain('feature_table')
    expect(wrapper.find('.marks').text()).toContain('feature.rt')
    expect(wrapper.find('header').exists()).toBe(false)

    await wrapper.find('.marks').trigger('click')
    expect(wrapper.emitted('selection')?.[0]?.[0]).toEqual({
      port: 'features',
      kind: 'proteomics/feature',
      keys: ['F1'],
    })
  })
})
