import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AnnotatedSpectrumIPSA from '@/components/visualization/ms2-sequence/AnnotatedSpectrumIPSA.vue'
import type { MatchedFragment, SpectrumPeak } from '@/composables/ms2-sequence/fragmentation'

function createPeak(overrides: Partial<SpectrumPeak> = {}): SpectrumPeak {
  return {
    index: 1,
    mz: 500,
    intensity: 1000,
    ...overrides,
  }
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
    matchedPeak: createPeak(),
    ...overrides,
  }
}

const globalStubs = {
  'el-switch': { template: '<div class="switch-stub"></div>' },
}

describe('AnnotatedSpectrumIPSA', () => {
  it('renders rect peaks and residue title text', async () => {
    const wrapper = mount(AnnotatedSpectrumIPSA, {
      props: {
        sequence: 'PEPTIDE',
        peaks: [createPeak({ index: 1, mz: 100 }), createPeak({ index: 2, mz: 200 })],
        matchedFragments: [createFragment()],
      },
      global: { stubs: globalStubs },
    })

    const peaks = wrapper.findAll('rect.peak')
    expect(peaks.length).toBe(2)

    const residues = wrapper.findAll('g.title-seq text.residue-letter')
    expect(residues.length).toBe(7)

    await peaks[0].trigger('mouseenter')
    expect(wrapper.emitted('peakHover')).toBeTruthy()
  })

  it('renders peak tooltip as text instead of HTML', async () => {
    const wrapper = mount(AnnotatedSpectrumIPSA, {
      props: {
        sequence: 'PEPTIDE',
        peaks: [createPeak({ index: 1, mz: 100 })],
        matchedFragments: [
          createFragment({
            matchedPeak: createPeak({ index: 1, mz: 100 }),
            neutralLoss: '<img src=x onerror=alert(1)>' as unknown as MatchedFragment['neutralLoss'],
          }),
        ],
      },
      global: { stubs: globalStubs },
    })

    await wrapper.find('rect.peak').trigger('mouseenter')

    expect(wrapper.find('.tooltip img').exists()).toBe(false)
    expect(wrapper.find('.tooltip').text()).toContain('<img src=x onerror=alert(1)>')
  })

  it('keeps modified residues uppercase in the sequence title', () => {
    const wrapper = mount(AnnotatedSpectrumIPSA, {
      props: {
        sequence: 'PEPTIDE',
        modifications: [
          {
            id: 'mod-1',
            name: 'Test Mod',
            type: 'ptm',
            position: 2,
            massShift: 42,
          },
        ],
        peaks: [createPeak({ index: 1, mz: 100 })],
        matchedFragments: [createFragment()],
      },
      global: { stubs: globalStubs },
    })

    const residues = wrapper.findAll('g.title-seq text.residue-letter')
    expect(residues[1]?.text()).toBe('E')
  })

  it('preserves SVG aspect ratio instead of using non-uniform scaling', () => {
    const wrapper = mount(AnnotatedSpectrumIPSA, {
      props: {
        sequence: 'PEPTIDE',
        peaks: [createPeak({ index: 1, mz: 100 })],
        matchedFragments: [createFragment()],
        width: 900,
        height: 340,
      },
      global: { stubs: globalStubs },
    })

    const svg = wrapper.find('svg.chart-svg')
    expect(svg.attributes('viewBox')).toBe('0 0 900 340')
    expect(svg.attributes('preserveAspectRatio')).not.toBe('none')
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

  it('filters displayed peaks from TopMSV-style peak count links', async () => {
    const wrapper = mount(AnnotatedSpectrumIPSA, {
      props: {
        sequence: 'PEPTIDE',
        peaks: [createPeak({ index: 1, mz: 100 }), createPeak({ index: 2, mz: 200 })],
        matchedFragments: [createFragment({ matchedPeak: createPeak({ index: 2, mz: 200 }) })],
      },
      global: { stubs: globalStubs },
    })

    expect(wrapper.findAll('rect.peak').length).toBe(2)
    await wrapper.findAll('.topmsv-peak-links a')[1].trigger('click')
    expect(wrapper.findAll('rect.peak').length).toBe(1)
  })

  it('colors matched peak bars and error points by ion type', () => {
    const wrapper = mount(AnnotatedSpectrumIPSA, {
      props: {
        sequence: 'PEPTIDE',
        peaks: [createPeak({ index: 1, mz: 100 }), createPeak({ index: 2, mz: 200 })],
        matchedFragments: [
          createFragment({
            ionType: 'b',
            matchedPeak: createPeak({ index: 1, mz: 100 }),
            matchErrorPpm: 1.2,
          }),
          createFragment({
            ionType: 'y',
            matchedPeak: createPeak({ index: 2, mz: 200 }),
            matchErrorPpm: -0.8,
          }),
        ],
      },
      global: { stubs: globalStubs },
    })

    const peaks = wrapper.findAll('rect.peak')
    expect(peaks[0].attributes('fill')).toBe('#1e66b3')
    expect(peaks[1].attributes('fill')).toBe('#15803d')
    const errors = wrapper.findAll('circle.err')
    expect(errors[0].attributes('fill')).toBe('#1e66b3')
    expect(errors[1].attributes('fill')).toBe('#15803d')
  })
})
