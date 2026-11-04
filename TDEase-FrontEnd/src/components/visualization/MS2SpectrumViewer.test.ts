import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { FragmentationCalculator, activationToIonTypes } from '@/composables/ms2-sequence'
import type { MatchedFragment, Modification, SpectrumPeak } from '@/composables/ms2-sequence/fragmentation'
import AnnotatedSpectrumIPSA from '@/components/visualization/ms2-sequence/AnnotatedSpectrumIPSA.vue'
import SequenceTrack from '@/components/visualization/ms2-sequence/SequenceTrack.vue'
import { resolveMs2SelectionContext } from '@/components/visualization/ms2-sequence/composition'
import { resolveMsalignSource } from '@/components/visualization/ms2-sequence/artifactSource'

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

// ---------------------------------------------------------------------------
// Rendering smoke for the underlying spectrum/track components — the helper
// invariants live in ms2-sequence-helpers.test.ts; only mount-observable
// behavior is kept here.
// ---------------------------------------------------------------------------

function createPeak(overrides: Partial<SpectrumPeak> = {}): SpectrumPeak {
  return { index: 1, mz: 100, intensity: 1000, ...overrides }
}

function createFragment(overrides: Partial<MatchedFragment> = {}): MatchedFragment {
  return {
    ionType: 'b',
    position: 2,
    charge: 1,
    theoreticalMass: 200,
    theoreticalMz: 201,
    sequenceRange: [1, 2],
    isMatched: true,
    ...overrides,
  }
}

describe('AnnotatedSpectrumIPSA (rendering smoke)', () => {
  const globalStubs = {
    'el-switch': { template: '<div class="switch-stub"></div>' },
  }

  it('renders peaks and residue letters, emits peakHover, and keeps tooltips text-only', async () => {
    const wrapper = mount(AnnotatedSpectrumIPSA, {
      props: {
        sequence: 'PEPTIDE',
        peaks: [createPeak({ index: 1, mz: 100 }), createPeak({ index: 2, mz: 200 })],
        matchedFragments: [
          createFragment({
            matchedPeak: createPeak({ index: 1, mz: 100 }),
            neutralLoss: '<img src=x onerror=alert(1)>' as unknown as MatchedFragment['neutralLoss'],
          }),
        ],
      },
      global: { stubs: globalStubs },
    })

    const peaks = wrapper.findAll('rect.peak')
    expect(peaks.length).toBe(2)
    expect(wrapper.findAll('g.title-seq text.residue-letter').length).toBe(7)

    await peaks[0].trigger('mouseenter')
    expect(wrapper.emitted('peakHover')).toBeTruthy()
    // Tooltip content must render as text, never as HTML.
    expect(wrapper.find('.tooltip img').exists()).toBe(false)
    expect(wrapper.find('.tooltip').text()).toContain('<img src=x onerror=alert(1)>')
  })

  it('wraps long proteoform rows and annotates modified residues', () => {
    const wrapper = mount(AnnotatedSpectrumIPSA, {
      props: {
        sequence: 'PEPTIDE'.repeat(12),
        modifications: [{
          id: 'mod-1',
          name: 'Phospho',
          type: 'ptm',
          position: 3,
          massShift: 79.9663,
        }],
        peaks: [createPeak({ index: 1, mz: 100 })],
        matchedFragments: [createFragment()],
        width: 620,
        height: 520,
      },
      global: { stubs: globalStubs },
    })

    expect(wrapper.findAll('g.proteoform-row').length).toBeGreaterThan(1)
    expect(wrapper.find('.mod-label').text()).toContain('+79.97')
  })
})

describe('SequenceTrack (rendering smoke)', () => {
  const globalOptions = {
    stubs: {
      'el-checkbox': {
        props: ['modelValue'],
        template: '<label><slot /></label>',
      },
    },
  }

  function mountTrack(props: Record<string, unknown>) {
    return mount(SequenceTrack, {
      props: { sequence: '', matchedFragments: [], ...props },
      global: globalOptions,
    })
  }

  it('states a caveat for absent sequence/matches, evidence once fragments match', () => {
    const empty = mountTrack({ sequence: '' })
    expect(empty.find('.sequence-container').exists()).toBe(false)
    expect(empty.find('.track-status--caveat').exists()).toBe(true)

    const unmatched = mountTrack({ sequence: 'PEPTIDE', matchedFragments: [] })
    expect(unmatched.find('.sequence-container').exists()).toBe(true)
    expect(unmatched.find('.track-status--caveat').exists()).toBe(true)

    const matched = mountTrack({
      sequence: 'PEPTIDE',
      matchedFragments: [createFragment({ position: 2 }), createFragment({ position: 4, ionType: 'y' })],
    })
    expect(matched.find('.track-status--evidence').exists()).toBe(true)
  })

  it('says when the drawing is truncated instead of silently dropping residues', () => {
    const short = mountTrack({ sequence: 'A'.repeat(10), maxVisibleLength: 10 })
    const long = mountTrack({ sequence: 'A'.repeat(30), maxVisibleLength: 10 })
    expect(long.findAll('.residue')).toHaveLength(10)
    expect(long.findAll('.track-status__detail').length)
      .toBe(short.findAll('.track-status__detail').length + 1)
  })

  it('keeps exactly one residue in the tab order, movable with arrow keys', async () => {
    const wrapper = mountTrack({ sequence: 'PEPT' })
    const residues = () => wrapper.findAll('.residue')
    expect(residues().map((node) => node.attributes('tabindex'))).toEqual(['0', '-1', '-1', '-1'])

    await wrapper.find('.sequence-residues').trigger('keydown', { key: 'ArrowRight' })
    expect(residues().map((node) => node.attributes('tabindex'))).toEqual(['-1', '0', '-1', '-1'])
  })

  it('exposes modification markers to the keyboard', async () => {
    const mod: Modification = {
      id: 'm1', name: 'Acetyl', type: 'ptm', position: 1, massShift: 42.0106,
    }
    const wrapper = mountTrack({ sequence: 'PEPTIDE', modifications: [mod] })
    const marker = wrapper.find('.mod-marker')
    expect(marker.attributes('tabindex')).toBe('0')
    expect(marker.attributes('role')).toBe('button')
    await marker.trigger('keydown.enter')
    expect(wrapper.emitted('mod-click')?.[0]).toEqual([mod])
  })
})

// ---------------------------------------------------------------------------
// Selection/provenance resolution edge cases not observable through the
// viewer mount above.
// ---------------------------------------------------------------------------

describe('resolveMs2SelectionContext', () => {
  it('falls back to row-index selections and treats out-of-range indices as PrSM IDs', () => {
    const rows = [{ 'Prsm ID': '10' }, { 'Prsm ID': '20' }]
    const byIndex = resolveMs2SelectionContext(
      rows,
      { selectedIndices: new Set<number>([1]), selectedRefs: [] } as any,
    )
    expect(byIndex.selectedPrsmId).toBe(20)

    const outOfRange = resolveMs2SelectionContext(
      rows,
      { selectedIndices: new Set<number>([20]), selectedRefs: [] } as any,
    )
    expect(outOfRange.selectedPrsmId).toBe(20)
    expect(outOfRange.selectedRow).toMatchObject({ 'Prsm ID': '20' })
  })

  it('accepts legacy selectedRef val fields and defaults to the first row', () => {
    const legacy = resolveMs2SelectionContext(
      [{ 'Prsm ID': '1', Proteoform: 'A' }, { 'Prsm ID': '2', Proteoform: 'B' }],
      { selectedRefs: [{ field: 'Prsm ID', val: '2' }], selectedIndices: new Set<number>() } as any,
    )
    expect(legacy.selectedPrsmId).toBe(2)
    expect(legacy.selectedRow).toMatchObject({ 'Prsm ID': '2' })

    const none = resolveMs2SelectionContext(
      [{ 'Prsm ID': '10', Proteoform: 'A' }, { 'Prsm ID': '20', Proteoform: 'B' }],
      null,
    )
    expect(none.selectedPrsmId).toBe(10)
  })
})

describe('resolveMsalignSource', () => {
  it('prefers explicit artifact ids, falls back to file paths, else null', () => {
    expect(resolveMsalignSource({
      'MS2 Artifact ID': 'artifact-ms2-001',
      'Data file name': 'D:/TDEase/runs/run-1/sample_ms2.msalign',
    })).toEqual({
      artifactId: 'artifact-ms2-001',
      filePath: 'D:/TDEase/runs/run-1/sample_ms2.msalign',
    })
    expect(resolveMsalignSource({
      'Data file name': 'D:/runs/run-1/5_ms2.msalign',
    })).toEqual({
      artifactId: '__by_path__',
      filePath: 'D:/runs/run-1/5_ms2.msalign',
    })
    expect(resolveMsalignSource({ 'Spectrum ID': '26' })).toBeNull()
  })
})
