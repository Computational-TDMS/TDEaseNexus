import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { MatchedFragment, Modification } from '@/composables/ms2-sequence/fragmentation'
import SequenceTrack from './SequenceTrack.vue'

const globalOptions = {
  stubs: {
    'el-checkbox': {
      props: ['modelValue'],
      template: '<label><slot /></label>',
    },
  },
}

function fragment(overrides: Partial<MatchedFragment> = {}): MatchedFragment {
  return {
    ionType: 'b',
    position: 2,
    charge: 1,
    theoreticalMass: 200,
    theoreticalMz: 201.01,
    sequenceRange: [1, 2],
    isMatched: true,
    ...overrides,
  }
}

function mountTrack(props: Record<string, unknown>) {
  return mount(SequenceTrack, {
    props: { sequence: '', matchedFragments: [], ...props },
    global: globalOptions,
  })
}

describe('SequenceTrack', () => {
  it('renders no ribbon at all when there is no sequence, only a stated reason', () => {
    const wrapper = mountTrack({ sequence: '' })

    expect(wrapper.find('.sequence-container').exists()).toBe(false)
    expect(wrapper.find('.track-legend').exists()).toBe(false)
    // The status block is never omitted — an absent claim must still be stated.
    expect(wrapper.find('.track-status--caveat').exists()).toBe(true)
    expect(wrapper.find('.track-status__headline').text().length).toBeGreaterThan(0)
  })

  it('flags a sequence with no fragment matches as a caveat, not as zero coverage', () => {
    const wrapper = mountTrack({ sequence: 'PEPTIDE', matchedFragments: [] })

    expect(wrapper.find('.sequence-container').exists()).toBe(true)
    expect(wrapper.find('.track-status--caveat').exists()).toBe(true)
    expect(wrapper.find('.track-status--evidence').exists()).toBe(false)
    // Detail lines explain what blank ion rows mean and what the source is.
    expect(wrapper.findAll('.track-status__detail').length).toBeGreaterThanOrEqual(2)
  })

  it('reports coverage as evidence once matched fragments are supplied', () => {
    const wrapper = mountTrack({
      sequence: 'PEPTIDE',
      matchedFragments: [fragment({ position: 2 }), fragment({ position: 4, ionType: 'y' })],
    })

    expect(wrapper.find('.track-status--evidence').exists()).toBe(true)
    expect(wrapper.find('.track-status--caveat').exists()).toBe(false)
  })

  it('honours an explicit annotationState over the derived one', () => {
    const wrapper = mountTrack({
      sequence: 'PEPTIDE',
      matchedFragments: [fragment()],
      annotationState: 'sequence-only',
    })

    expect(wrapper.find('.track-status--caveat').exists()).toBe(true)
  })

  it('says when the drawing is truncated instead of silently dropping residues', () => {
    const short = mountTrack({ sequence: 'A'.repeat(10), maxVisibleLength: 10 })
    const shortDetails = short.findAll('.track-status__detail').length

    const long = mountTrack({ sequence: 'A'.repeat(30), maxVisibleLength: 10 })
    expect(long.findAll('.residue')).toHaveLength(10)
    expect(long.findAll('.track-status__detail').length).toBe(shortDetails + 1)
  })

  it('separates matched from unmatched fragments by dash pattern, not colour alone', () => {
    const wrapper = mountTrack({
      sequence: 'PEPTIDE',
      matchedFragments: [
        fragment({ ionType: 'b', position: 2, isMatched: true }),
        fragment({ ionType: 'b', position: 3, isMatched: false }),
      ],
    })

    const bRow = wrapper.findAll('.ion-row.prefix-ions')[1]
    const lines = bRow.findAll('polyline')
    expect(lines[1].attributes('style')).toContain('stroke-dasharray: none')
    expect(lines[2].attributes('style')).toContain('stroke-dasharray: 3 3')
  })

  it('labels each ion series in text so the row is readable without colour', () => {
    const wrapper = mountTrack({ sequence: 'PEPTIDE', matchedFragments: [fragment()] })
    const labels = wrapper.findAll('.ion-label').map((node) => node.text())
    expect(labels).toEqual(['c', 'b', 'a', 'x', 'y', 'z'])
  })

  it('keeps exactly one residue in the tab order and moves it with the arrow keys', async () => {
    const wrapper = mountTrack({ sequence: 'PEPT' })
    const residues = () => wrapper.findAll('.residue')

    expect(residues().map((node) => node.attributes('tabindex'))).toEqual(['0', '-1', '-1', '-1'])

    await wrapper.find('.sequence-residues').trigger('keydown', { key: 'ArrowRight' })
    expect(residues().map((node) => node.attributes('tabindex'))).toEqual(['-1', '0', '-1', '-1'])

    await wrapper.find('.sequence-residues').trigger('keydown', { key: 'End' })
    expect(residues().map((node) => node.attributes('tabindex'))).toEqual(['-1', '-1', '-1', '0'])
  })

  it('exposes modification markers to the keyboard', async () => {
    const mod: Modification = {
      id: 'm1',
      name: 'Acetyl',
      type: 'ptm',
      position: 1,
      massShift: 42.0106,
    }
    const wrapper = mountTrack({ sequence: 'PEPTIDE', modifications: [mod] })

    const marker = wrapper.find('.mod-marker')
    expect(marker.attributes('tabindex')).toBe('0')
    expect(marker.attributes('role')).toBe('button')

    await marker.trigger('keydown.enter')
    expect(wrapper.emitted('mod-click')?.[0]).toEqual([mod])
  })

  it('marks a modified residue with an underline as well as a tint', () => {
    const wrapper = mountTrack({
      sequence: 'PEPTIDE',
      modifications: [{ id: 'm1', name: 'Acetyl', type: 'ptm', position: 2, massShift: 42 }],
    })

    const modified = wrapper.findAll('.residue').filter((node) => node.classes('modified'))
    expect(modified).toHaveLength(1)
    expect(modified[0].text()).toBe('E')
  })

  it('emits residue-hover on focus so keyboard and pointer drive the same highlight', async () => {
    const wrapper = mountTrack({ sequence: 'PEPT' })
    await wrapper.findAll('.residue')[2].trigger('focus')
    expect(wrapper.emitted('residue-hover')?.[0]).toEqual([3])
  })
})
