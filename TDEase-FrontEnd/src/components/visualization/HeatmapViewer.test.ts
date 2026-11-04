import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const { plotlyViewerProps } = vi.hoisted(() => ({
  plotlyViewerProps: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/components/visualization/PlotlyViewer.vue', () => ({
  default: defineComponent({
    name: 'PlotlyViewerStub',
    props: ['viewSpec', 'config', 'selection'],
    emits: ['selectionChange'],
    setup(props, { emit }) {
      plotlyViewerProps.push(props as unknown as Record<string, unknown>)
      return () => h('button', {
        class: 'plotly-viewer-stub',
        onClick: () => emit('selectionChange', {
          selectedIndices: new Set([2]),
          filterCriteria: [],
          brushRegion: null,
        }),
      }, JSON.stringify(props.viewSpec))
    },
  }),
}))

function elementStubs() {
  return {
    'el-tag': { template: '<span><slot /></span>' },
    'el-button': defineComponent({
      setup(_, { slots }) {
        return () => h('button', slots.default?.() ?? [])
      },
    }),
  }
}

describe('HeatmapViewer', () => {
  beforeEach(() => {
    plotlyViewerProps.length = 0
  })

  it('compiles long-form table rows into a Plotly heatmap matrix', async () => {
    const HeatmapViewer = (await import('@/components/visualization/HeatmapViewer.vue')).default
    mount(HeatmapViewer, {
      props: {
        data: {
          columns: [
            { id: 'row', name: 'row', type: 'string', visible: true },
            { id: 'column', name: 'column', type: 'string', visible: true },
            { id: 'value', name: 'value', type: 'number', visible: true },
          ],
          rows: [
            { row: 'r1', column: 'c1', value: 1 },
            { row: 'r1', column: 'c2', value: 2 },
            { row: 'r2', column: 'c1', value: 3 },
          ],
          totalRows: 3,
          sourceFile: 'heatmap.tsv',
        },
      },
      global: { stubs: elementStubs() },
    })

    const viewSpec = plotlyViewerProps.at(-1)?.viewSpec as Record<string, unknown>
    const figure = viewSpec.figure as Record<string, unknown>
    const data = figure.data as Array<Record<string, unknown>>

    expect(data[0]).toMatchObject({
      type: 'heatmap',
      x: ['c1', 'c2'],
      y: ['r1', 'r2'],
      z: [[1, 2], [3, null]],
      customdata: [[0, 1], [2, null]],
    })
  })

  it('forwards Plotly heatmap selection indices', async () => {
    const HeatmapViewer = (await import('@/components/visualization/HeatmapViewer.vue')).default
    const wrapper = mount(HeatmapViewer, {
      props: {
        data: {
          columns: [
            { id: 'row', name: 'row', type: 'string', visible: true },
            { id: 'column', name: 'column', type: 'string', visible: true },
            { id: 'value', name: 'value', type: 'number', visible: true },
          ],
          rows: [{ row: 'r2', column: 'c1', value: 3 }],
          totalRows: 1,
          sourceFile: 'heatmap.tsv',
        },
      },
      global: { stubs: elementStubs() },
    })

    await wrapper.find('.plotly-viewer-stub').trigger('click')
    expect(wrapper.emitted('selectionChange')?.[0]?.[0]).toMatchObject({ selectedIndices: new Set([2]) })
  })
})
