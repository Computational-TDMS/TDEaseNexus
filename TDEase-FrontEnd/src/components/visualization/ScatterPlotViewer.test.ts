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
    emits: ['selectionChange', 'configChange'],
    setup(props, { emit }) {
      plotlyViewerProps.push(props as unknown as Record<string, unknown>)
      return () => h('button', {
        class: 'plotly-viewer-stub',
        onClick: () => emit('selectionChange', {
          selectedIndices: new Set([1]),
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
    'el-select': { template: '<select><slot /></select>' },
    'el-option': { template: '<option />' },
    'el-row': { template: '<div><slot /></div>' },
    'el-col': { template: '<div><slot /></div>' },
    'el-form-item': { template: '<label><slot /></label>' },
    'el-button': defineComponent({
      setup(_, { slots }) {
        return () => h('button', slots.default?.() ?? [])
      },
    }),
  }
}

describe('ScatterPlotViewer', () => {
  beforeEach(() => {
    plotlyViewerProps.length = 0
  })

  it('compiles table rows into Plotly scatter traces', async () => {
    const ScatterPlotViewer = (await import('@/components/visualization/ScatterPlotViewer.vue')).default
    mount(ScatterPlotViewer, {
      props: {
        data: {
          columns: [
            { id: 'x', name: 'x', type: 'number', visible: true },
            { id: 'y', name: 'y', type: 'number', visible: true },
            { id: 'group', name: 'group', type: 'number', visible: true },
          ],
          rows: [
            { x: 1, y: 2, group: 10 },
            { x: 3, y: 4, group: 20 },
          ],
          totalRows: 2,
          sourceFile: 'scatter.tsv',
        },
        config: { axisMapping: { x: 'x', y: 'y', color: 'group' } },
      },
      global: { stubs: elementStubs() },
    })

    const viewSpec = plotlyViewerProps.at(-1)?.viewSpec as Record<string, unknown>
    const figure = viewSpec.figure as Record<string, unknown>
    const data = figure.data as Array<Record<string, unknown>>

    expect(data[0]).toMatchObject({
      type: 'scattergl',
      mode: 'markers',
      x: [1, 3],
      y: [2, 4],
      customdata: [0, 1],
    })
    expect(data[0].marker).toMatchObject({ color: [10, 20], showscale: true })
    expect(figure.layout).toMatchObject({
      xaxis: { title: { text: 'x' } },
      yaxis: { title: { text: 'y' } },
    })
  })

  it('forwards Plotly selection indices', async () => {
    const ScatterPlotViewer = (await import('@/components/visualization/ScatterPlotViewer.vue')).default
    const wrapper = mount(ScatterPlotViewer, {
      props: {
        data: {
          columns: [
            { id: 'x', name: 'x', type: 'number', visible: true },
            { id: 'y', name: 'y', type: 'number', visible: true },
          ],
          rows: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
          totalRows: 2,
          sourceFile: 'scatter.tsv',
        },
      },
      global: { stubs: elementStubs() },
    })

    await wrapper.find('.plotly-viewer-stub').trigger('click')
    expect(wrapper.emitted('selectionChange')?.[0]?.[0]).toMatchObject({
      selectedIndices: new Set([1]),
      filterCriteria: [],
      brushRegion: null,
    })
  })
})
