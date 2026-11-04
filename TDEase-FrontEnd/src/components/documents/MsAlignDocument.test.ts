import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import workbenchZh from '@/locales/zh-CN/workbench.json'

// SpectrumViewer (rendered as a child) imports plotly.js-dist-min; mock it so
// the test never touches a real Plotly bundle in jsdom.
vi.mock('plotly.js-dist-min', () => ({
  default: {
    react: vi.fn(),
    newPlot: vi.fn(),
    purge: vi.fn(),
    Plots: { resize: vi.fn() },
  },
}))

import MsAlignDocument from './MsAlignDocument.vue'
import type { MsAlignSpectrum } from '@/services/visualization/msalign'

const peaksUnit = workbenchZh.fileDocument.msalign.peaksUnit

function makeSpectrum(overrides: Partial<MsAlignSpectrum> = {}): MsAlignSpectrum {
  return {
    spectrumId: 1,
    scan: 100,
    activation: 'HCD',
    precursorMz: 500.25,
    precursorCharge: 2,
    peaks: [
      { index: 0, mz: 100.1, intensity: 10 },
      { index: 1, mz: 200.2, intensity: 20 },
      { index: 2, mz: 300.3, intensity: 30 },
    ],
    metadata: {},
    ...overrides,
  }
}

async function mountDocument(spectra: MsAlignSpectrum[]) {
  // The DynamicScroller settles its DOM window a tick after mount.
  const wrapper = mount(MsAlignDocument, {
    props: { spectra, fileName: 'sample_ms2.msalign' },
    global: {
      stubs: {
        // Stub the heavy child; we only assert MsAlignDocument's own list/
        // selection wiring, not Plotly output (SpectrumViewer has its own tests).
        SpectrumViewer: { template: '<div class="spectrum-stub" />' },
      },
    },
  })
  await flushPromises()
  return wrapper
}


/**
 * The scroller keeps a pool of views; unused ones stay in the DOM with
 * `visibility: hidden`. List assertions must count only the used window.
 */
function visibleItems(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('.msalign-document__item').filter((item) => {
    const host = item.element.closest('.vue-recycle-scroller__item-view') as HTMLElement | null
    return !host || host.style.visibility !== 'hidden'
  })
}

describe('MsAlignDocument', () => {
  it('lists every spectrum with its scan, level and peak count', async () => {
    const spectra = [
      makeSpectrum({ spectrumId: 1, scan: 100, peaks: [{ index: 0, mz: 1, intensity: 1 }] }),
      makeSpectrum({ spectrumId: 2, scan: 200, peaks: [{ index: 0, mz: 1, intensity: 1 }, { index: 1, mz: 2, intensity: 2 }] }),
    ]
    const wrapper = await mountDocument(spectra)

    const items = visibleItems(wrapper)
    expect(items).toHaveLength(2)
    // The scroller's DOM order is not the list order — assert by content.
    // Peak counts surface in the list so the user can gauge each spectrum.
    const texts = items.map((item) => item.text())
    expect(texts.some((text) => text.includes(`#1`) && text.includes(`1 ${peaksUnit}`))).toBe(true)
    expect(texts.some((text) => text.includes(`#2`) && text.includes(`2 ${peaksUnit}`))).toBe(true)
  })

  it('selects the first spectrum by default and renders it', async () => {
    const spectra = [
      makeSpectrum({ spectrumId: 7, scan: 700, peaks: [{ index: 0, mz: 9, intensity: 9 }] }),
    ]
    const wrapper = await mountDocument(spectra)

    const active = visibleItems(wrapper).find((item) => item.classes().includes('is-active'))
    expect(active.exists()).toBe(true)
    expect(active.text()).toContain('#7')
    // The selected spectrum reaches the viewer pane.
    expect(wrapper.find('.spectrum-stub').exists()).toBe(true)
  })

  it('switches the rendered spectrum when another row is clicked', async () => {
    const spectra = [
      makeSpectrum({ spectrumId: 1, scan: 10, peaks: [{ index: 0, mz: 1, intensity: 1 }] }),
      makeSpectrum({ spectrumId: 2, scan: 20, peaks: [{ index: 0, mz: 2, intensity: 2 }] }),
    ]
    const wrapper = await mountDocument(spectra)

    expect(visibleItems(wrapper).find((item) => item.classes().includes('is-active'))!.text()).toContain('#1')

    const second = visibleItems(wrapper).find((item) => item.text().includes('#2'))!
    await second.trigger('click')

    const active = visibleItems(wrapper).find((item) => item.classes().includes('is-active'))
    expect(active.text()).toContain('#2')
  })

  it('filters the list by scan range and shows the filtered count', async () => {
    const spectra = [
      makeSpectrum({ spectrumId: 1, scan: 111 }),
      makeSpectrum({ spectrumId: 2, scan: 222 }),
      makeSpectrum({ spectrumId: 3, scan: 333 }),
    ]
    const wrapper = await mountDocument(spectra)

    await wrapper.find('[data-field="scan-min"]').setValue('200')
    await wrapper.find('[data-field="scan-max"]').setValue('299')
    await flushPromises()

    const items = visibleItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('#2')
    // The count summary distinguishes a filtered view from the total.
    expect(wrapper.find('.msalign-document__count').text()).toContain('1')
    expect(wrapper.find('.msalign-document__count').text()).toContain('3')
  })

  it('combines multiple filter dimensions (m/z range + level)', async () => {
    const spectra = [
      makeSpectrum({ spectrumId: 1, scan: 11, precursorMz: 400.0, metadata: { LEVEL: '1' } }),
      makeSpectrum({ spectrumId: 2, scan: 22, precursorMz: 500.5, metadata: { LEVEL: '2' } }),
      makeSpectrum({ spectrumId: 3, scan: 33, precursorMz: 700.9, metadata: { LEVEL: '2' } }),
    ]
    const wrapper = await mountDocument(spectra)

    await wrapper.find('[data-field="mz-min"]').setValue('450')
    await wrapper.find('[data-field="mz-max"]').setValue('600')
    await wrapper.find('.msalign-document__select').setValue('2')
    await flushPromises()

    const items = visibleItems(wrapper)
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('#2')
  })

  it('prefills the filter ranges from the data itself', async () => {
    const spectra = [
      makeSpectrum({ spectrumId: 1, scan: 5, precursorMz: 400.12345, metadata: { RT: '0.50' } }),
      makeSpectrum({ spectrumId: 2, scan: 90, precursorMz: 700.5, metadata: { RT: '12.00' } }),
    ]
    const wrapper = await mountDocument(spectra)

    // The form states the file's span before the user narrows anything…
    expect((wrapper.find('[data-field="scan-min"]').element as HTMLInputElement).value).toBe('5')
    expect((wrapper.find('[data-field="scan-max"]').element as HTMLInputElement).value).toBe('90')
    expect((wrapper.find('[data-field="mz-min"]').element as HTMLInputElement).value).toBe('400.1234')
    expect((wrapper.find('[data-field="mz-max"]').element as HTMLInputElement).value).toBe('700.5')
    expect((wrapper.find('[data-field="rt-min"]').element as HTMLInputElement).value).toBe('0.5')
    expect((wrapper.find('[data-field="rt-max"]').element as HTMLInputElement).value).toBe('12')
    // …and the prefilled bounds exclude nothing.
    expect(visibleItems(wrapper)).toHaveLength(2)
  })

  it('keeps MS1 scans visible through the prefilled precursor range — the dimension targets MS2+', async () => {
    const spectra = [
      makeSpectrum({ spectrumId: 1, scan: 10, precursorMz: undefined, metadata: { LEVEL: '1' } }),
      makeSpectrum({ spectrumId: 2, scan: 20, precursorMz: 400.0, metadata: { LEVEL: '2' } }),
      makeSpectrum({ spectrumId: 3, scan: 30, precursorMz: 700.5, metadata: { LEVEL: '2' } }),
    ]
    const wrapper = await mountDocument(spectra)

    // The range is prefilled to the file's own MS2 precursor bounds (400–700.5):
    // the MS1 scan stays listed, and narrowing the range trims MS2 only.
    expect(wrapper.findAll('.msalign-document__item')).toHaveLength(3)

    await wrapper.find('[data-field="mz-min"]').setValue('500')
    await flushPromises()

    const texts = visibleItems(wrapper).map((item) => item.text())
    expect(texts).toHaveLength(2)
    expect(texts.some((text) => text.includes('#1'))).toBe(true)
    expect(texts.some((text) => text.includes('#3'))).toBe(true)
  })

  it('re-selects the first matching spectrum when the filter excludes the selection', async () => {
    const spectra = [
      makeSpectrum({ spectrumId: 1, scan: 10 }),
      makeSpectrum({ spectrumId: 2, scan: 20 }),
      makeSpectrum({ spectrumId: 3, scan: 30 }),
    ]
    const wrapper = await mountDocument(spectra)
    expect(visibleItems(wrapper).find((item) => item.classes().includes('is-active'))!.text()).toContain('#1')

    // Narrow past the selection — the pane must switch, not go blank.
    await wrapper.find('[data-field="scan-min"]').setValue('25')
    await flushPromises()

    const active = visibleItems(wrapper).find((item) => item.classes().includes('is-active'))
    expect(active.exists()).toBe(true)
    expect(active.text()).toContain('#3')
  })

  it('renders the first spectrum as soon as its lazy decode lands — no re-selection needed', async () => {
    const spectra = [
      makeSpectrum({ spectrumId: 1, peaks: [], metadata: { PEAKS_COUNT: '2' } }),
    ]
    let resolvePeaks: (peaks: { index: number; mz: number; intensity: number }[]) => void = () => {}
    const peakLoader = vi.fn(() => new Promise((resolve) => { resolvePeaks = resolve }))
    const wrapper = mount(MsAlignDocument, {
      props: { spectra, fileName: 'sample.mzML', peakLoader },
      global: { stubs: { SpectrumViewer: { template: '<div class="spectrum-stub" />' } } },
    })

    // While the decode is in flight the pane says so…
    expect(wrapper.find('.msalign-document__view-empty').text()).toContain('解码')
    // …and the moment it lands the spectrum renders, without any selection change.
    resolvePeaks([{ index: 0, mz: 100.1, intensity: 10 }, { index: 1, mz: 200.2, intensity: 20 }])
    await flushPromises()

    expect(peakLoader).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.spectrum-stub').exists()).toBe(true)
  })

  it('shows the empty state when there are no spectra', async () => {
    const wrapper = await mountDocument([])
    expect(wrapper.find('.msalign-document__empty').exists()).toBe(true)
    expect(wrapper.findAll('.msalign-document__item')).toHaveLength(0)
  })

  it('virtualizes a large list — the DOM window stays far below the data', async () => {
    const spectra: MsAlignSpectrum[] = Array.from({ length: 2500 }, (_, i) => ({
      spectrumId: i + 1,
      scan: i + 1,
      peaks: [{ index: 0, mz: 1, intensity: 1 }],
      metadata: {},
    }))
    const wrapper = await mountDocument(spectra)
    await flushPromises()

    // The DynamicScroller renders a viewport-sized window, not 2500 rows…
    const rendered = wrapper.findAll('.msalign-document__item')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(2500)
    // …and 2500 spectra is far under the sanity cap, so nothing is hidden.
    expect(wrapper.find('.msalign-document__truncated').exists()).toBe(false)
  })

  it('still truncates beyond the sanity cap and reports how many are hidden', async () => {
    const spectra: MsAlignSpectrum[] = Array.from({ length: 20001 }, (_, i) => ({
      spectrumId: i + 1,
      scan: i + 1,
      peaks: [{ index: 0, mz: 1, intensity: 1 }],
      metadata: {},
    }))
    const wrapper = await mountDocument(spectra)

    expect(wrapper.find('.msalign-document__truncated').exists()).toBe(true)
    expect(wrapper.find('.msalign-document__truncated').text()).toContain('20001')
  })
})
