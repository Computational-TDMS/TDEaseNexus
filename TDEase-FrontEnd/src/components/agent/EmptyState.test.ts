import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EmptyState from './EmptyState.vue'

/**
 * The empty state's contract is WHICH row does WHAT: the no-data setup row
 * executes (emit `setup` — AgentPage opens the one workspace-choosing panel;
 * the Agent itself has no folder-picker tool), while every goal row only
 * fills the composer (emit `select`). A regression that turns the setup row
 * back into a prompt — or a goal into an action — breaks the first-run path.
 */
describe('EmptyState', () => {
  it('offers the setup action plus the preparation question when there is no data', async () => {
    const wrapper = mount(EmptyState)

    const rows = wrapper.findAll('.agent-empty__goal')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('打开工作区文件夹')
    expect(rows[1].text()).toContain('开始之前我还需要准备什么？')

    await rows[0].trigger('click')
    expect(wrapper.emitted('setup')).toHaveLength(1)
    expect(wrapper.emitted('select')).toBeUndefined()

    await rows[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([['开始之前我还需要准备什么？']])
    expect(wrapper.emitted('setup')).toHaveLength(1)
  })

  it('offers only composer goals once the workspace has data', async () => {
    const wrapper = mount(EmptyState, { props: { rawFileCount: 3 } })

    expect(wrapper.findAll('.agent-empty__goal')).toHaveLength(3)
    const first = wrapper.findAll('.agent-empty__goal')[0]
    expect(first.text()).toContain('识别 3 个原始文件中的蛋白质异构体')

    await first.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['识别 3 个原始文件中的蛋白质异构体']])
    expect(wrapper.emitted('setup')).toBeUndefined()
  })
})
