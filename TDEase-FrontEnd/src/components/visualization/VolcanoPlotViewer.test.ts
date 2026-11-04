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
          selectedIndices: new Set([0]),
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
    'el-switch': { props: ['modelValue'], template: '<button type="button" />' },
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

describe('VolcanoPlotViewer', () => {
  beforeEach(() => {
    plotlyViewerProps.length = 0
  })

  it('compiles fold-change rows into categorized Plotly traces', async () => {
    const VolcanoPlotViewer = (await import('@/components/visualization/VolcanoPlotViewer.vue')).default
    mount(VolcanoPlotViewer, {
      props: {
        data: {
          columns: [
            { id: 'fc', name: 'log2FC', type: 'number', visible: true },
            { id: 'p', name: 'pValue', type: 'number', visible: true },
            { id: 'name', name: 'name', type: 'string', visible: true },
          ],
          rows: [
            { fc: 2, p: 0.001, name: 'up' },
            { fc: -2, p: 0.001, name: 'down' },
            { fc: 0.1, p: 0.9, name: 'neutral' },
          ],
          totalRows: 3,
          sourceFile: 'volcano.tsv',
        },
        config: { foldChangeColumn: 'fc', pValueColumn: 'p', nameColumn: 'name' },
      },
      global: { stubs: elementStubs() },
    })

    const viewSpec = plotlyViewerProps.at(-1)?.viewSpec as Record<string, unknown>
    const figure = viewSpec.figure as Record<string, unknown>
    const data = figure.data as Array<Record<string, unknown>>
    const layout = figure.layout as Record<string, unknown>

    expect(data.map((trace) => trace.name)).toEqual(['Up-regulated', 'Down-regulated', 'Not significant'])
    expect(data[0]).toMatchObject({ x: [2], customdata: [0] })
    expect(data[1]).toMatchObject({ x: [-2], customdata: [1] })
    expect(data[2]).toMatchObject({ x: [0.1], customdata: [2] })
    expect(layout.shapes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'line', x0: 1, x1: 1 }),
      expect.objectContaining({ type: 'line', x0: -1, x1: -1 }),
    ]))
  })

  it('emits pointClick from Plotly selection customdata', async () => {
    const VolcanoPlotViewer = (await import('@/components/visualization/VolcanoPlotViewer.vue')).default
    const wrapper = mount(VolcanoPlotViewer, {
      props: {
        data: {
          columns: [
            { id: 'fc', name: 'log2FC', type: 'number', visible: true },
            { id: 'p', name: 'pValue', type: 'number', visible: true },
          ],
          rows: [{ fc: 2, p: 0.001 }],
          totalRows: 1,
          sourceFile: 'volcano.tsv',
        },
        config: { foldChangeColumn: 'fc', pValueColumn: 'p' },
      },
      global: { stubs: elementStubs() },
    })

    await wrapper.find('.plotly-viewer-stub').trigger('click')
    expect(wrapper.emitted('pointClick')?.[0]?.[0]).toMatchObject({ index: 0, foldChange: 2, pValue: 0.001 })
    expect(wrapper.emitted('selectionChange')?.[0]?.[0]).toMatchObject({ selectedIndices: new Set([0]) })
  })
})
