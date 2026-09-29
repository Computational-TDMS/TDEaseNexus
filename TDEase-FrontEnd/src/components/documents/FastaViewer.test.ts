import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import FastaViewer from './FastaViewer.vue'

const source = '>sp|P62805|H4_HUMAN Histone H4\nMSGRGKGGKGLGKGGAKRHRK\n>ref2 second\nACDEFG\n'

describe('FastaViewer', () => {
  it('renders a compact summary and expandable wrapped records', () => {
    const wrapper = mount(FastaViewer, {
      props: { source },
    })

    expect(wrapper.find('[data-render-target="fasta-formatted"]').exists()).toBe(true)
    expect(wrapper.findAll('.fasta-viewer__record')).toHaveLength(2)
    expect(wrapper.text()).toContain('sp|P62805|H4_HUMAN')
    expect(wrapper.text()).toContain('Histone H4')
    expect(wrapper.find('.fasta-viewer__sequence').text()).toContain('MSGRGKGGKGLGKGGAKRHRK')
  })

  it('searches sequences, filtering records and highlighting 1-based residue hits', async () => {
    const wrapper = mount(FastaViewer, {
      props: { source },
    })

    await wrapper.find('.fasta-viewer__search').setValue('ggk')
    expect(wrapper.text()).toContain('1 / 2')
    expect(wrapper.findAll('.fasta-viewer__record')).toHaveLength(1)
    expect(wrapper.text()).toContain('位置 7–9')
    expect(wrapper.findAll('.fasta-viewer__sequence mark').map((mark) => mark.text())).toEqual(['GGK'])

    await wrapper.find('.fasta-viewer__search').setValue('zzzz')
    expect(wrapper.findAll('.fasta-viewer__record')).toHaveLength(0)
    expect(wrapper.text()).toContain('没有匹配 “zzzz” 的记录。')
  })
})
