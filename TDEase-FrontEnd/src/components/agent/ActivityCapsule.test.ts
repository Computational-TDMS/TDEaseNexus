import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { ref } from 'vue'
import ActivityCapsule from './ActivityCapsule.vue'
import { useAgentTabsStore } from '@/stores/agentTabs'
import type { TurnHudState } from './TurnHud.vue'
import type { AgentChatMessage, ToolCall } from '@/stores/chat-types'

/**
 * The spine meta's contract, rendered for real: a node that took calls shows
 * ≤3 category chips plus the FULL count (chips sample, number is truth — no
 * "+n"), a node with no calls shows no meta at all, and the meta never steals
 * the node row's open-plan click — the spine stays a preview of the plan.
 */
const hud: TurnHudState = { phase: 'waiting' }

function tool(name: string): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2)}`, name, args: {}, done: true, success: true, status: 'succeeded' }
}

function act(id: string, tools: ToolCall[]): AgentChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      { type: 'thinking', id: `${id}:th`, text: '…', sealed: true },
      { type: 'tool_group', id: `${id}:tg`, tools },
    ],
  }
}

function todoWrite(todos: { content: string; status: string }[]): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2)}`, name: 'todo_write', args: { todos }, done: true, success: true, status: 'succeeded' }
}

/** 排查 takes 5 calls across 4 categories; 写修复 takes 1; 联调 takes none. */
const messages = [
  act('m1', [
    todoWrite([{ content: '排查', status: 'in_progress' }, { content: '写修复', status: 'pending' }, { content: '联调', status: 'pending' }]),
    tool('tdease.bash'), tool('tdease.read'), tool('tdease.grep'), tool('tdease.edit'), tool('tdease.write'),
  ]),
  act('m2', [
    todoWrite([{ content: '排查', status: 'completed' }, { content: '写修复', status: 'in_progress' }, { content: '联调', status: 'pending' }]),
    tool('tdease.grep'),
  ]),
  act('m3', [
    todoWrite([{ content: '排查', status: 'completed' }, { content: '写修复', status: 'completed' }, { content: '联调', status: 'in_progress' }]),
  ]),
]

function mountCapsule() {
  return mount(ActivityCapsule, {
    props: { hud, mindset: 'executor', lastOutcome: null, sending: true, suspended: false, expanded: true },
    global: { provide: { chatMessages: ref(messages) } },
  })
}

describe('ActivityCapsule spine meta', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('renders ≤3 chips plus the full call count, and nothing for a call-less node', () => {
    const wrapper = mountCapsule()
    const items = wrapper.findAll('.capsule-spine__item')
    expect(items).toHaveLength(3)

    // 排查 — 5 calls, 4 distinct icons → 3 chips (sampled), count 5 (full).
    const firstMeta = items[0].find('.capsule-spine__meta')
    expect(firstMeta.exists()).toBe(true)
    expect(items[0].findAll('.capsule-spine__meta-chip')).toHaveLength(3)
    expect(firstMeta.attributes('title')).toBe('5 次工具调用')
    expect(firstMeta.text()).toBe('5')

    // 写修复 — 1 call → 1 chip + count 1.
    expect(items[1].findAll('.capsule-spine__meta-chip')).toHaveLength(1)
    expect(items[1].find('.capsule-spine__meta').text()).toBe('1')

    // 联调 — no calls yet → no meta at all.
    expect(items[2].find('.capsule-spine__meta').exists()).toBe(false)
  })

  it('keeps the node row an open-plan control — the meta never intercepts it', async () => {
    const wrapper = mountCapsule()
    await wrapper.findAll('.capsule-spine__node')[0].trigger('click')
    const tabs = useAgentTabsStore().tabs
    expect(tabs).toHaveLength(1)
    expect(tabs[0].key).toMatchObject({ kind: 'agent-plan' })
  })
})
