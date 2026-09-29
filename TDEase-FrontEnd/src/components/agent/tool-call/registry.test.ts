import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolCallRow from './ToolCallRow.vue'
import ToolCallRenderer from './ToolCallRenderer.vue'
import {
  hasPlayedEntryAnimation,
  markEntryAnimationPlayed,
  resolveToolCallRenderer,
} from './registry'
import type { ToolCall } from '@/stores/chat-types'

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1',
    name: 'tdease.bash',
    done: true,
    success: true,
    status: 'succeeded',
    ...overrides,
  }
}

describe('tool-call registry', () => {
  it('falls through to the generic row for unknown tools', () => {
    expect(resolveToolCallRenderer('tdease.bash')).toBe(resolveToolCallRenderer('tdease.unknown-plugin.widget'))
  })

  it('plays the entry animation once per key, then reports settled', () => {
    expect(hasPlayedEntryAnimation('toolgroup:event:7')).toBe(false)
    markEntryAnimationPlayed('toolgroup:event:7')
    expect(hasPlayedEntryAnimation('toolgroup:event:7')).toBe(true)
  })

  it('caps the animation LRU so a long session cannot grow it without bound', () => {
    // Fill well past the cap (800) with throwaway keys.
    for (let i = 0; i < 900; i++) {
      markEntryAnimationPlayed(`toolgroup:fill:${i}`)
    }
    expect(hasPlayedEntryAnimation('toolgroup:fill:0')).toBe(false)
    expect(hasPlayedEntryAnimation('toolgroup:fill:899')).toBe(true)
    // The keys this suite recorded earlier may itself have been evicted —
    // re-mark and re-check to keep the assertion order-independent.
    markEntryAnimationPlayed('toolgroup:event:7')
    expect(hasPlayedEntryAnimation('toolgroup:event:7')).toBe(true)
  })
})

describe('ToolCallRenderer', () => {
  it('renders the generic row with the tool identity from the context', () => {
    const wrapper = mount(ToolCallRenderer, {
      props: {
        tool: {
          ...call(),
          full: 'npm test -- --run',
        },
        isSingle: true,
      },
    })

    const row = wrapper.find('[data-tool="tdease.bash"]')
    expect(row.exists()).toBe(true)
    expect(row.get('.tool-name').text()).toBe('bash')
    expect(row.get('.tool-detail--full').text()).toBe('npm test -- --run')
    // Single-tool group: no icon/phrase echo of the summary row.
    expect(row.find('.tool-desc').exists()).toBe(false)
  })

  it('renders the failure glyph for a failed call and the output preview for a successful one', () => {
    const failed = mount(ToolCallRenderer, {
      props: { tool: call({ name: 'bash', status: 'failed', error: 'exit 1' }), isSingle: false },
    })
    expect(failed.get('.tool-status').classes()).toContain('failed')

    const succeeded = mount(ToolCallRenderer, {
      props: {
        tool: call({
          status: 'succeeded',
          resultPreview: { text: 'all green', truncated: true, totalChars: 4000 } as never,
        }),
        isSingle: false,
      },
    })
    expect(succeeded.find('.tool-output-text').text()).toBe('all green')
    expect(succeeded.get('.tool-output-meta').text()).toContain('4000')
  })
})
