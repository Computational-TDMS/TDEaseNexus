import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import SessionBar from './SessionBar.vue'

/**
 * The mindset switch's contract: it lives at the TOP of the conversation
 * (this bar, centered — the product-level placement, not the composer
 * toolbar) and a pick is forwarded verbatim as `update:mindset`. The
 * AgentPage binds that to the shared conversation's `turn.mindset`, which
 * both the prompt assembly and the transcript's mode emblem read.
 */
describe('SessionBar mindset switch', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('hosts the mode switch and forwards a pick verbatim', async () => {
    const wrapper = mount(SessionBar, { props: { mindset: 'workflow' } })

    const buttons = wrapper.findAll('.mode-btn')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].classes()).toContain('active')

    await buttons[1].trigger('click')
    expect(wrapper.emitted('update:mindset')).toEqual([['analysis']])
  })

  it('renders no switch while the mindset is unknown', () => {
    const wrapper = mount(SessionBar)

    expect(wrapper.find('.mode-selector').exists()).toBe(false)
  })
})
