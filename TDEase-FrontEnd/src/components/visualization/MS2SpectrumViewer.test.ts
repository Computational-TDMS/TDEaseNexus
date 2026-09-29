import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { FragmentationCalculator, activationToIonTypes } from '@/composables/ms2-sequence'

const { ms2SequenceProps } = vi.hoisted(() => ({
  ms2SequenceProps: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/components/visualization/MS2SequenceViewer.vue', () => ({
  default: defineComponent({
    name: 'MS2SequenceViewerStub',
    props: ['data', 'config', 'selection', 'spectra'],
    emits: ['selectionChange', 'configChange'],
    setup(props) {
      ms2SequenceProps.push(props as unknown as Record<string, unknown>)
      return () => h('div', { class: 'ms2-sequence-viewer-stub' })
    },
  }),
}))

const SequenceTrackStub = defineComponent({
  name: 'SequenceTrackStub',
  props: ['sequence', 'modifications', 'matchedFragments', 'annotationState', 'annotationDetail'],
  setup(props) {
    return () => h('div', { class: 'sequence-track-stub' }, JSON.stringify(props))
  },
})

async function mountViewer(props: Record<string, unknown>) {
  const MS2SpectrumViewer = (await import('@/components/visualization/MS2SpectrumViewer.vue')).default
  const wrapper = mount(MS2SpectrumViewer, {
    props,
    global: { stubs: { SequenceTrack: SequenceTrackStub } },
  })
  await nextTick()
  return wrapper
}

function trackProps(wrapper: Awaited<ReturnType<typeof mountViewer>>) {
  return wrapper.findComponent(SequenceTrackStub).props() as Record<string, unknown>
}

const PRSM_DATASET = {
  id: 'prsm',
  kind: 'table',
  columns: [
    { name: 'Prsm ID', type: 'integer' as const },
    { name: 'Spectrum ID', type: 'integer' as const },
    { name: 'Proteoform', type: 'string' as const },
  ],
  rows: [
    { 'Prsm ID': 12, 'Spectrum ID': 88, Proteoform: 'PEPTIDE' },
  ],
}

describe('MS2SpectrumViewer', () => {
  beforeEach(() => {
    ms2SequenceProps.length = 0
  })

  it('adapts unified PRSM datasets into the fixed D3 MS2 sequence viewer', async () => {
    await mountViewer({ datasets: [PRSM_DATASET] })

    const data = ms2SequenceProps.at(-1)?.data as Record<string, unknown>
    expect(data).toMatchObject({
      totalRows: 1,
      sourceFile: 'prsm',
      rows: [{ 'Prsm ID': 12, 'Spectrum ID': 88, Proteoform: 'PEPTIDE' }],
    })
  })

  it('keeps the spectrum first and the coverage track second in the DOM', async () => {
    const wrapper = await mountViewer({ datasets: [PRSM_DATASET] })

    const html = wrapper.html()
    expect(html.indexOf('ms2-sequence-viewer-stub')).toBeLessThan(html.indexOf('sequence-track-stub'))
  })

  it('feeds the coverage track from the same resolved dataset, with no second fetch', async () => {
    const wrapper = await mountViewer({
      datasets: [{
        ...PRSM_DATASET,
        rows: [{
          'Prsm ID': 12,
          Proteoform: '[Acetyl]-PEPTIDE',
          'Data file name': 'D:/runs/run-1/5_ms2.msalign',
        }],
      }],
    })

    expect(trackProps(wrapper)).toMatchObject({
      sequence: 'PEPTIDE',
      annotationState: 'sequence-only',
      annotationDetail: 'D:/runs/run-1/5_ms2.msalign',
      matchedFragments: [],
    })
    expect((trackProps(wrapper).modifications as unknown[]).length).toBe(1)
  })

  it('prefers an explicit MS2 artifact id over the raw file path for provenance', async () => {
    const wrapper = await mountViewer({
      datasets: [{
        ...PRSM_DATASET,
        rows: [{
          'Prsm ID': 12,
          Proteoform: 'PEPTIDE',
          'MS2 Artifact ID': 'artifact-ms2-001',
          'Data file name': 'D:/runs/run-1/5_ms2.msalign',
        }],
      }],
    })

    expect(trackProps(wrapper).annotationDetail).toBe('artifact-ms2-001')
  })

  it('reports no-sequence when the selected row carries no proteoform', async () => {
    const wrapper = await mountViewer({
      datasets: [{
        ...PRSM_DATASET,
        rows: [{ 'Prsm ID': 12, 'Spectrum ID': 88 }],
      }],
    })

    expect(trackProps(wrapper)).toMatchObject({ sequence: '', annotationState: 'no-sequence' })
  })

  it('follows the table selection when choosing the row the track describes', async () => {
    const wrapper = await mountViewer({
      datasets: [{
        ...PRSM_DATASET,
        rows: [
          { 'Prsm ID': 12, Proteoform: 'PEPTIDE' },
          { 'Prsm ID': 13, Proteoform: 'MAKIGK' },
        ],
      }],
      selection: {
        selectedIndices: new Set<number>(),
        selectedRefs: [{ field: 'Prsm ID', value: 13 }],
        filterCriteria: [],
        brushRegion: null,
      },
    })

    expect(trackProps(wrapper).sequence).toBe('MAKIGK')
  })

  it('matches fragments client-side from a scan-attributed peak table on the port', async () => {
    // Theoretical fragments of the row's proteoform become the peak table's
    // rows — exact masses, so the match is decided by the wiring, not by
    // chemistry tolerances.
    const calculator = new FragmentationCalculator()
    const theoretical = calculator.computeFragments('PEPTIDE', activationToIonTypes(''), 2, [], false)
    expect(theoretical.length).toBeGreaterThan(0)

    const wrapper = await mountViewer({
      datasets: [
        PRSM_DATASET,
        {
          id: 'peaks',
          kind: 'peak_table',
          columns: [
            { name: 'Spectrum ID', type: 'integer' as const },
            { name: 'mass', type: 'number' as const },
            { name: 'intensity', type: 'number' as const },
          ],
          rows: theoretical.map((fragment) => ({
            'Spectrum ID': 88,
            mass: fragment.theoreticalMz,
            intensity: 100,
          })),
        },
      ],
    })

    const track = trackProps(wrapper)
    expect(track.annotationState).toBe('matched')
    expect((track.matchedFragments as unknown[]).length).toBeGreaterThan(0)
    // The same spectra feed the inner viewer — one conversion, both consumers.
    expect((ms2SequenceProps.at(-1)?.spectra as unknown[]).length).toBeGreaterThan(0)
  })

  it('renders no coverage section at all when no dataset resolves', async () => {
    const wrapper = await mountViewer({})
    expect(wrapper.findComponent(SequenceTrackStub).exists()).toBe(false)
  })

  it('lets the coverage section be collapsed and reports its state to assistive tech', async () => {
    const wrapper = await mountViewer({ datasets: [PRSM_DATASET] })

    const toggle = wrapper.find('.coverage-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.attributes('aria-controls')).toBe('ms2-coverage-panel')

    await toggle.trigger('click')
    expect(wrapper.find('.coverage-toggle').attributes('aria-expanded')).toBe('false')
  })
})
