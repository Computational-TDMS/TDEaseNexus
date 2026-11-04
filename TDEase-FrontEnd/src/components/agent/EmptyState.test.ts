import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EmptyState from './EmptyState.vue'

/**
 * The empty state's contract is WHICH row does WHAT: the no-data setup row
 * executes (emit `setup` — AgentPage opens the one workspace-choosing panel;
 * the Agent itself has no folder-picker tool), while every goal row only
 * fills the composer (emit `select`). And the goals SPLIT BY MINDSET — the
 * two modes are two offerings: Workflow Analysis suggests actions, Explore
 * suggests questions. A regression that blends them (or turns the setup row
 * back into a prompt) breaks the first-run path.
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

  it('offers action goals in the Workflow Analysis mindset', async () => {
    const wrapper = mount(EmptyState, { props: { rawFileCount: 3 } })

    const rows = wrapper.findAll('.agent-empty__goal')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('帮我鉴定这 3 个原始文件里的蛋白质异构体')
    expect(rows[1].text()).toContain('为我的数据设计分析工作流，先给我方案再执行')

    await rows[0].trigger('click')
    expect(wrapper.emitted('select')).toEqual([['帮我鉴定这 3 个原始文件里的蛋白质异构体']])
    expect(wrapper.emitted('setup')).toBeUndefined()
  })

  it('offers question goals in the Explore mindset', () => {
    const wrapper = mount(EmptyState, { props: { rawFileCount: 3, mindset: 'analysis' } })

    const texts = wrapper.findAll('.agent-empty__goal').map(r => r.text())
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('先看看这些原始文件里有什么，再决定怎么分析')
    expect(texts[1]).toContain('这些数据适合回答哪些科学问题？')

    // With runs in the Workspace the questions turn to them.
    const withRuns = mount(EmptyState, { props: { rawFileCount: 3, runCount: 2, mindset: 'analysis' } })
    const runTexts = withRuns.findAll('.agent-empty__goal').map(r => r.text())
    expect(runTexts).toHaveLength(3)
    expect(runTexts[1]).toContain('这些运行都发现了什么？先给我一份结果总览')
    expect(runTexts[2]).toContain('带我逐项解读最近一次运行的结果')
  })
})
