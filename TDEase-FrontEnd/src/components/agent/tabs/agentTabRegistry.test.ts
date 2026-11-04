import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { resolveAgentTab } from './agentTabRegistry'
import SideChatTab from './SideChatTab.vue'
import { agentTabId } from '@/studio/domain/agent-tab'

describe('agentTabRegistry: agent-side-chat', () => {
  it('dispatches to SideChatTab with the session ids as props', () => {
    const resolved = resolveAgentTab({ kind: 'agent-side-chat', sessionId: 's_child', parentSessionId: 's_parent' })
    expect(resolved.component).toBe(SideChatTab)
    expect(resolved.props).toEqual({ sessionId: 's_child', parentSessionId: 's_parent' })
  })

  it('keys the tab by the child session id, so two side chats are two tabs', () => {
    const a = agentTabId({ kind: 'agent-side-chat', sessionId: 's_a', parentSessionId: 's_p' })
    const b = agentTabId({ kind: 'agent-side-chat', sessionId: 's_b', parentSessionId: 's_p' })
    expect(a).not.toBe(b)
    expect(a).toContain('s_a')
  })
})
