import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { VariantAlignmentModel } from '@/services/sequence/variantAlignment'
import VariantAlignmentViewer from './VariantAlignmentViewer.vue'

const model: VariantAlignmentModel = {
  referenceAccession: 'sp|P3|REF',
  columnCount: 6,
  consensus: 'MKTGVL',
  conservation: [1, 1, 1, 0.5, 1, 1],
  rows: [
    {
      accession: 'sp|P3|REF',
      description: 'reference variant',
      alignedSequence: 'MKTGVL',
      identified: true,
      theoreticalMass: 651.2,
      facts: { accession: 'sp|P3|REF', description: '', firstResidue: 1, lastResidue: 6, proteoformMasses: [651.2], matchCount: 3, bestEValue: 1e-9, maxIntensity: 10, spanSequence: '' },
      state: 'reference',
    },
    {
      accession: 'sp|P1|OTHER',
      description: 'gapped variant',
      alignedSequence: 'MKT-VL',
      identified: true,
      theoreticalMass: 608.1,
      facts: null,
      state: 'aligned',
    },
    {
      accession: 'sp|P9|FAM',
      description: 'family member',
      alignedSequence: 'AAAA--',
      identified: false,
      theoreticalMass: null,
      facts: null,
      state: 'aligned',
    },
  ],
  familyCount: 1,
  fastaRecordCount: 3,
  skipped: [],
}

describe('VariantAlignmentViewer', () => {
  it('renders the alignment in the Figure-5C idiom', () => {
    const wrapper = mount(VariantAlignmentViewer, { props: { model, fastaName: 'histone48.fasta' } })

    expect(wrapper.find('[data-render-target="toppic-variants"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('histone48.fasta')

    const rows = wrapper.findAll('.variant-alignment__row')
    // consensus row exists with its label
    expect(rows.some((row) => row.classes().includes('is-consensus'))).toBe(true)

    // identified rows are tinted, family row is not
    const identifiedRows = wrapper.findAll('.variant-alignment__row.is-identified')
    expect(identifiedRows).toHaveLength(2)
    expect(identifiedRows[0]!.text()).toContain('sp|P3|REF')
    expect(identifiedRows[1]!.text()).toContain('sp|P1|OTHER')

    // theoretical masses render in the sticky label zone
    expect(wrapper.text()).toContain('651.20')
    expect(wrapper.text()).toContain('608.10')

    // the reference-row gap renders as a mismatch-colored or gap-colored run, not plain identity
    const otherRow = identifiedRows[1]!
    expect(otherRow.find('.gap').exists()).toBe(true)
    expect(otherRow.find('.gap').text()).toBe('-')

    // family member's mismatches are marked against the consensus
    const familyRow = wrapper.findAll('.variant-alignment__row').find((row) => row.text().includes('sp|P9|FAM'))!
    expect(familyRow.find('.mismatch').exists()).toBe(true)
  })

  it('renders one block per 60 columns with a conservation strip', () => {
    const wide: VariantAlignmentModel = {
      ...model,
      columnCount: 130,
      consensus: 'M'.repeat(130),
      conservation: new Array<number>(130).fill(1),
      rows: [
        { ...model.rows[0]!, alignedSequence: 'M'.repeat(130) },
      ],
      familyCount: 0,
    }
    const wrapper = mount(VariantAlignmentViewer, { props: { model: wide } })

    const blocks = wrapper.findAll('.variant-alignment__block')
    expect(blocks).toHaveLength(3) // 60 + 60 + 10
    expect(wrapper.findAll('.variant-alignment__bar').length).toBe(130)
  })

  it('states the empty case instead of rendering a shell', () => {
    const empty: VariantAlignmentModel = { ...model, columnCount: 0, consensus: '', conservation: [], rows: [], familyCount: 0, fastaRecordCount: 0 }
    const wrapper = mount(VariantAlignmentViewer, { props: { model: empty } })

    expect(wrapper.find('.variant-alignment__empty').exists()).toBe(true)
    expect(wrapper.find('.variant-alignment__scroll').exists()).toBe(false)
  })
})
