import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'

// Mock plotly.js-dist-min
const mockNewPlot = vi.fn()
const mockReact = vi.fn()
const mockPurge = vi.fn()

vi.mock('plotly.js-dist-min', () => ({
  default: {
    newPlot: mockNewPlot,
    react: mockReact,
    purge: mockPurge,
  },
}))

function elementStubs() {
  return {
    'el-tag': { template: '<span><slot /></span>' },
    'el-button': defineComponent({
      setup(_props, { slots }) {
        return () => h('button', slots.default?.() ?? [])
      },
    }),
  }
}

/** Helper: pull the latest trace array sent to Plotly.newPlot / react. */
function lastTraces(): Array<Record<string, unknown>> {
  const call = mockNewPlot.mock.calls.at(-1) ?? mockReact.mock.calls.at(-1)
  return call ? call[1] as Array<Record<string, unknown>> : []
}

/** Helper: pull the latest figure layout. */
function lastLayout(): Record<string, unknown> {
  const call = mockNewPlot.mock.calls.at(-1) ?? mockReact.mock.calls.at(-1)
  return call ? call[2] as Record<string, unknown> : {}
}

describe('FeatureMapViewer (self-contained)', () => {
  beforeEach(() => {
    mockNewPlot.mockClear()
    mockReact.mockClear()
    mockPurge.mockClear()
    mockNewPlot.mockImplementation(async (element: HTMLElement & { on?: (name: string, handler: (event: unknown) => void) => void }) => {
      const handlers = new Map<string, (event: unknown) => void>()
      element.on = (name, handler) => handlers.set(name, handler)
      ;(element as HTMLElement & { __plotlyHandlers?: Map<string, (event: unknown) => void> }).__plotlyHandlers = handlers
    })
  })

  it('compiles feature rows into a single horizontal-segment trace', async () => {
    const FeatureMapViewer = (await import('@/components/visualization/FeatureMapViewer.vue')).default
    mount(FeatureMapViewer, {
      props: {
        datasets: [
          {
            id: 'features',
            kind: 'feature_table',
            columns: [
              { name: 'minElutionTime', type: 'number' as const },
              { name: 'maxElutionTime', type: 'number' as const },
              { name: 'monoMass', type: 'number' as const },
              { name: 'apexIntensity', type: 'number' as const },
            ],
            rows: [
              { id: 'f1', minElutionTime: 10, maxElutionTime: 12, monoMass: 500.2, apexIntensity: 1000 },
            ],
          },
        ],
        viewSpec: { title: 'Feature window' },
      },
      global: { stubs: elementStubs() },
    })

    await nextTick()

    // newPlot should have been called
    expect(mockNewPlot).toHaveBeenCalled()
    const traces = lastTraces()
    expect(traces.length).toBeGreaterThanOrEqual(1)
    // Main trace: scattergl + lines (WebGL — feature maps scale to 100k points)
    expect(traces[0]).toMatchObject({
      type: 'scattergl',
      mode: 'lines',
      name: 'Features',
      x: [10, 12, null],
      y: [500.2, 500.2, null],
      customdata: [0, 0, null],
    })
    // Second trace is the invisible colorbar
    expect(traces[1]).toMatchObject({ type: 'scattergl', mode: 'markers' })

    const layout = lastLayout()
    expect(layout.title).toMatchObject({ text: 'Feature window' })
    expect(layout.xaxis).toMatchObject({ title: { text: 'Retention time' } })
    expect(layout.yaxis).toMatchObject({ title: { text: 'Mass' } })
  })

  it('maps intensity onto the trace color when an intensity column exists', async () => {
    const FeatureMapViewer = (await import('@/components/visualization/FeatureMapViewer.vue')).default
    mount(FeatureMapViewer, {
      props: {
        datasets: [
          {
            id: 'features',
            kind: 'feature_table',
            columns: [
              { name: 'minElutionTime', type: 'number' as const },
              { name: 'maxElutionTime', type: 'number' as const },
              { name: 'monoMass', type: 'number' as const },
              { name: 'apexIntensity', type: 'number' as const },
            ],
            rows: [
              { id: 'f1', minElutionTime: 10, maxElutionTime: 12, monoMass: 500, apexIntensity: 1000 },
              { id: 'f2', minElutionTime: 20, maxElutionTime: 22, monoMass: 600, apexIntensity: 2000 },
            ],
          },
        ],
      },
      global: { stubs: elementStubs() },
    })

    await nextTick()
    const trace = lastTraces()[0]
    const line = trace.line as Record<string, unknown>
    expect(Array.isArray(line.color)).toBe(true)
    expect((line.color as Array<unknown>).length).toBe(6)
    // colors are hex strings (rgb(...))
    expect((line.color as Array<string>)[0]).toMatch(/^rgb\(/)
  })

  it('uses a flat color when no intensity column is detected', async () => {
    const FeatureMapViewer = (await import('@/components/visualization/FeatureMapViewer.vue')).default
    mount(FeatureMapViewer, {
      props: {
        datasets: [
          {
            id: 'features',
            kind: 'feature_table',
            columns: [
              { name: 'start', type: 'number' as const },
              { name: 'mass', type: 'number' as const },
            ],
            rows: [{ id: 'f1', start: 5, mass: 700 }],
          },
        ],
      },
      global: { stubs: elementStubs() },
    })

    await nextTick()
    const trace = lastTraces()[0]
    // Token-driven series color; '#1e66f5' is the --chart-series-1 fallback
    // (design tokens aren't loaded in the jsdom test env).
    expect((trace.line as Record<string, unknown>).color).toBe('#1e66f5')
    // No colorbar trace when no intensity
    expect(lastTraces().length).toBe(1)
  })

  it('renders TopFD single-RT rows as zero-length segments', async () => {
    const FeatureMapViewer = (await import('@/components/visualization/FeatureMapViewer.vue')).default
    mount(FeatureMapViewer, {
      props: {
        datasets: [
          {
            id: 'features',
            kind: 'feature_table',
            columns: [
              { name: 'Feature_ID', type: 'integer' as const },
              { name: 'Mass', type: 'number' as const },
              { name: 'Apex_time', type: 'number' as const },
              { name: 'Abundance', type: 'number' as const },
            ],
            rows: [
              { Feature_ID: 161, Mass: 13877.44, Apex_time: 26.94, Abundance: 12345 },
            ],
          },
        ],
      },
      global: { stubs: elementStubs() },
    })

    await nextTick()
    const traces = lastTraces()
    expect(traces[0]).toMatchObject({ type: 'scattergl', mode: 'lines' })
    expect(traces[0].x).toEqual([26.94, 26.94, null])
    expect(traces[0].y).toEqual([13877.44, 13877.44, null])
  })

  it('handles DSL path: viewSpec.figure passes through verbatim', async () => {
    const FeatureMapViewer = (await import('@/components/visualization/FeatureMapViewer.vue')).default
    mount(FeatureMapViewer, {
      props: {
        viewSpec: {
          figure: {
            data: [{
              type: 'scattergl',
              mode: 'markers',
              x: [1, 2, 3],
              y: [4, 5, 6],
            }],
            layout: { title: { text: 'DSL figure' } },
            config: { responsive: true },
          },
        },
      },
      global: { stubs: elementStubs() },
    })

    await nextTick()
    const traces = lastTraces()
    expect(traces).toHaveLength(1)
    expect(traces[0]).toMatchObject({
      type: 'scattergl',
      mode: 'markers',
      x: [1, 2, 3],
      y: [4, 5, 6],
    })
    const layout = lastLayout()
    expect(layout.title).toMatchObject({ text: 'DSL figure' })
  })

  it('produces identical trace shape regardless of dataset kind', async () => {
    const FeatureMapViewer = (await import('@/components/visualization/FeatureMapViewer.vue')).default
    const columns = [
      { name: 'Apex Time', type: 'number' as const },
      { name: 'Mono Mass', type: 'number' as const },
      { name: 'Abundance', type: 'number' as const },
    ]
    const rows = [{ 'Apex Time': 30, 'Mono Mass': 1000, Abundance: 5000 }]

    // Mount with feature_table kind
    mount(FeatureMapViewer, {
      props: { datasets: [{ id: 'a', kind: 'feature_table', columns, rows }] },
      global: { stubs: elementStubs() },
    })
    await nextTick()
    const ftTraces = lastTraces().map((t) => ({ x: t.x, y: t.y }))

    mockNewPlot.mockClear()

    // Mount with table kind
    mount(FeatureMapViewer, {
      props: { datasets: [{ id: 'b', kind: 'table', columns, rows }] },
      global: { stubs: elementStubs() },
    })
    await nextTick()
    const tTraces = lastTraces().map((t) => ({ x: t.x, y: t.y }))

    expect(tTraces).toEqual(ftTraces)
  })

  it('emits canonical feature identities on Plotly selection', async () => {
    const FeatureMapViewer = (await import('@/components/visualization/FeatureMapViewer.vue')).default
    const wrapper = mount(FeatureMapViewer, {
      props: {
        config: {
          axisMapping: { startTime: 'start', endTime: 'start', mass: 'mass' },
        },
        datasets: [
          {
            id: 'features',
            kind: 'feature_table',
            columns: [
              { name: 'feature.id', type: 'string' as const },
              { name: 'start', type: 'number' as const },
              { name: 'mass', type: 'number' as const },
            ],
            rows: [
              { 'feature.id': 'f1', start: 10, mass: 500 },
              { 'feature.id': 'f2', start: 20, mass: 600 },
            ],
          },
        ],
      },
      global: { stubs: elementStubs() },
    })

    await nextTick()
    await flushPromises()

    const plotDiv = wrapper.find('.plot-container__canvas').element as HTMLElement & {
      __plotlyHandlers?: Map<string, (event: unknown) => void>
    }
    plotDiv.__plotlyHandlers?.get('plotly_selected')?.({
      points: [{ customdata: 0 }, { customdata: 1 }],
      range: { x: [10, 30], y: [400, 700] },
    })

    expect(wrapper.emitted('selectionChange')?.[0]?.[0]).toMatchObject({
      selectedRefs: [
        { field: 'feature.id', value: 'f1' },
        { field: 'feature.id', value: 'f2' },
      ],
    })
  })
})
