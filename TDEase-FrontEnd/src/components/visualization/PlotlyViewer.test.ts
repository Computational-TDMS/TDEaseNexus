import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { KeepAlive, defineComponent, h, nextTick } from 'vue'
import PlotlyViewer from './PlotlyViewer.vue'

const { newPlotMock, reactMock, purgeMock } = vi.hoisted(() => ({
  newPlotMock: vi.fn(),
  reactMock: vi.fn(),
  purgeMock: vi.fn(),
}))

vi.mock('plotly.js-dist-min', () => ({
  default: {
    newPlot: newPlotMock,
    react: reactMock,
    purge: purgeMock,
  },
}))

describe('PlotlyViewer', () => {
  beforeEach(() => {
    newPlotMock.mockClear()
    reactMock.mockClear()
    purgeMock.mockClear()
  })

  it('renders the backend-provided Plotly figure verbatim', async () => {
    const figure = {
      data: [{ type: 'scatter', x: [1, 2], y: [2, 4], name: 'Observed' }],
      layout: { title: 'Points' },
      config: { scrollZoom: true },
    }

    const wrapper = mount(PlotlyViewer, {
      props: { viewSpec: { figure } },
    })

    expect(wrapper.find('[data-testid="plotly-viewer"]').exists()).toBe(true)
    // No header chrome: the figure title is passed to Plotly itself, never
    // rendered as DOM text (VisContainer owns the panel title).
    expect(wrapper.text()).not.toContain('Points')
    expect(wrapper.text()).not.toContain('Plotly')
    expect(wrapper.text()).not.toContain('trace')

    await nextTick()
    await flushPromises()

    expect(newPlotMock).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      figure.data,
      expect.objectContaining({ title: 'Points' }),
      expect.objectContaining({
        responsive: true,
        displaylogo: false,
        scrollZoom: true,
      }),
    )
  })

  it('compiles chart sugar with datasets when no figure is provided', async () => {
    mount(PlotlyViewer, {
      props: {
        viewSpec: {
          chart: { type: 'scatter', x: 'mz', y: 'intensity' },
        },
        datasets: [
          {
            id: 'peaks',
            kind: 'peak_table',
            columns: [{ name: 'mz', type: 'number' }, { name: 'intensity', type: 'number' }],
            rows: [{ mz: 500.1, intensity: 1000 }],
            label: 'Peaks',
          },
        ],
      },
    })

    await nextTick()
    await flushPromises()

    expect(newPlotMock).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      [expect.objectContaining({
        type: 'scatter',
        mode: 'markers',
        x: [500.1],
        y: [1000],
        customdata: [0],
      })],
      expect.objectContaining({
        xaxis: { title: { text: 'mz' } },
        yaxis: { title: { text: 'intensity' } },
      }),
      expect.objectContaining({ responsive: true, displaylogo: false }),
    )
  })

  it('shows empty state when no figure is provided', () => {
    const wrapper = mount(PlotlyViewer, {
      props: { viewSpec: {} },
    })

    expect(wrapper.text()).toContain('没有数据')
    expect(wrapper.text()).not.toContain('Plotly')
  })

  it('updates with Plotly.react and purges on unmount', async () => {
    const wrapper = mount(PlotlyViewer, {
      props: {
        viewSpec: {
          figure: {
            data: [{ type: 'scatter', x: [1], y: [2] }],
            layout: { title: 'Initial' },
          },
        },
      },
    })
    await nextTick()
    await flushPromises()
    expect(newPlotMock).toHaveBeenCalledTimes(1)

    await wrapper.setProps({
      viewSpec: {
        figure: {
          data: [{ type: 'scatter', x: [1, 2], y: [2, 3] }],
          layout: { title: 'Updated' },
        },
      },
    })
    await nextTick()
    await flushPromises()

    expect(reactMock).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      [{ type: 'scatter', x: [1, 2], y: [2, 3] }],
      expect.objectContaining({ title: 'Updated' }),
      expect.objectContaining({ responsive: true, displaylogo: false }),
    )

    wrapper.unmount()
    expect(purgeMock).toHaveBeenCalledWith(expect.any(HTMLElement))
  })

  it('survives a KeepAlive deactivate/reactivate cycle without purging the plot', async () => {
    // DocumentHost wraps document viewers in <KeepAlive> so switching tabs keeps
    // the (expensive) Plotly instance cached instead of rebuilding it. The
    // contract this guards: deactivate must NOT purge the plot (it stays
    // rendered in the cache); only a true unmount (cache eviction) purges.
    const figure = {
      data: [{ type: 'scatter', x: [1, 2], y: [2, 4] }],
      layout: { title: 'Cached' },
    }

    // Real <KeepAlive> toggling between PlotlyViewer and a placeholder. Toggling
    // `active` swaps the single dynamic child, deactivating then reactivating
    // the viewer exactly as a tab switch does.
    const Host = defineComponent({
      components: { PlotlyViewer },
      data: () => ({ active: true }),
      render() {
        return h(KeepAlive, this.active
          ? () => h(PlotlyViewer, { viewSpec: { figure } })
          : () => h('div', { class: 'placeholder' }))
      },
    })

    const wrapper = mount(Host)
    await nextTick()
    await flushPromises()
    expect(newPlotMock).toHaveBeenCalledTimes(1)
    expect(purgeMock).not.toHaveBeenCalled()
    purgeMock.mockClear()

    // Tab switch away → viewer deactivated (cached), placeholder shown.
    await wrapper.setData({ active: false })
    await nextTick()
    await flushPromises()
    // The key assertion: no purge on deactivate — the plot stays in the cache.
    expect(purgeMock).not.toHaveBeenCalled()
    expect(wrapper.find('.placeholder').exists()).toBe(true)

    // Tab switch back → viewer reactivated, still no purge (same instance).
    await wrapper.setData({ active: true })
    await nextTick()
    await flushPromises()
    expect(purgeMock).not.toHaveBeenCalled()

    // Unmount the host (cache evicted) → now the plot is purged for real.
    wrapper.unmount()
    expect(purgeMock).toHaveBeenCalledWith(expect.any(HTMLElement))
  })
})
