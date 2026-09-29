import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const { plotlyViewerProps } = vi.hoisted(() => ({
  plotlyViewerProps: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/components/visualization/PlotlyViewer.vue', () => ({
  default: defineComponent({
    name: 'PlotlyViewerStub',
    props: ['viewSpec'],
    setup(props) {
      plotlyViewerProps.push(props as unknown as Record<string, unknown>)
      return () => h('div', { class: 'plotly-viewer-stub' }, JSON.stringify(props.viewSpec ?? {}))
    },
  }),
}))

describe('ErrorHeatmapViewer', () => {
  beforeEach(() => {
    plotlyViewerProps.length = 0
  })

  it('compiles heatmap_grid datasets into Plotly heatmap figures', async () => {
    const ErrorHeatmapViewer = (await import('@/components/visualization/ErrorHeatmapViewer.vue')).default
    mount(ErrorHeatmapViewer, {
      props: {
        datasets: [{
          id: 'err',
          kind: 'heatmap_grid',
          label: 'Error grid',
          columns: [
            { name: 'position', type: 'number' },
            { name: 'charge', type: 'number' },
            { name: 'ppm_error', type: 'number' },
          ],
          rows: [
            { position: 1, charge: 1, ppm_error: 0.1 },
            { position: 2, charge: 1, ppm_error: 0.2 },
            { position: 1, charge: 2, ppm_error: -0.3 },
          ],
        }],
      },
    })

    const viewSpec = plotlyViewerProps.at(-1)?.viewSpec as Record<string, unknown>
    const figure = viewSpec.figure as Record<string, unknown>
    const data = figure.data as Array<Record<string, unknown>>

    expect(data[0]).toMatchObject({
      type: 'heatmap',
      x: [1, 2],
      y: [1, 2],
      z: [[0.1, 0.2], [-0.3, null]],
    })
  })

  it('compiles binder grids into split heatmap figures without datasets', async () => {
    const ErrorHeatmapViewer = (await import('@/components/visualization/ErrorHeatmapViewer.vue')).default
    mount(ErrorHeatmapViewer, {
      props: {
        datasets: [],
        viewSpec: {
          title: 'Fragment continuity',
          bindings: {
            grids: [
              {
                id: 'c',
                rows: [
                  { position: 1, charge: 1, value: 0.1 },
                  { position: 2, charge: 1, value: 0.2 },
                ],
                columns: { position: 'position', charge: 'charge', value: 'ppm_error' },
              },
              {
                id: 'z',
                rows: [
                  { position: 1, charge: 2, value: -0.3 },
                ],
                columns: { position: 'position', charge: 'charge', value: 'ppm_error' },
              },
            ],
          },
        },
      },
    })

    expect(plotlyViewerProps).toHaveLength(2)
    const first = plotlyViewerProps[0].viewSpec as Record<string, unknown>
    const firstFigure = first.figure as Record<string, unknown>
    const firstData = firstFigure.data as Array<Record<string, unknown>>
    expect(firstData[0]).toMatchObject({
      type: 'heatmap',
      x: [1, 2],
      y: [1],
      z: [[0.1, 0.2]],
    })
  })
})
