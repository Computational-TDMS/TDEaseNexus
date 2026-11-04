import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import Composer from './Composer.vue'

/**
 * The credential gate's contract: while the active provider has no usable
 * key, a send MUST die here (button disabled, Enter refused, draft kept) and
 * the strip's one action EXECUTES the fix (emit `configure-model` — AgentPage
 * opens Settings on the providers section). Before the gate, the user's
 * first message became a failed turn carrying the raw provider error.
 */
describe('Composer credential gate', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  const mountComposer = (credentialMissing: boolean) => mount(Composer, {
    props: { modelValue: '分析这些数据', credentialMissing },
  })

  it('pauses sending and executes the fixing action while the key is missing', async () => {
    const wrapper = mountComposer(true)

    const strip = wrapper.find('.composer__credential')
    expect(strip.exists()).toBe(true)
    expect(strip.text()).toContain('发送已暂停')

    expect(wrapper.find('.composer__send').attributes('disabled')).toBeDefined()

    // Enter from SlashInput routes through the same onSend — it must be
    // refused, keeping the draft instead of starting a doomed turn.
    wrapper.findComponent({ name: 'SlashInput' }).vm.$emit('send', '分析这些数据')
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('send')).toBeUndefined()

    await wrapper.find('.composer__credential-action').trigger('click')
    expect(wrapper.emitted('configure-model')).toHaveLength(1)
  })

  it('stays silent and sends once a credential exists', async () => {
    const wrapper = mountComposer(false)

    expect(wrapper.find('.composer__credential').exists()).toBe(false)
    expect(wrapper.find('.composer__send').attributes('disabled')).toBeUndefined()

    await wrapper.find('.composer__send').trigger('click')
    expect(wrapper.emitted('send')).toEqual([['分析这些数据']])
  })
})
