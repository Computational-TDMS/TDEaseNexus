import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProcessFold from './ProcessFold.vue'
import * as markdown from '@/utils/markdown'
import type { AgentChatMessage, ContentBlock } from '@/stores/chat-types'
import type { TurnSettlement } from '@/agent/events'

/**
 * The ordering contract (ProcessFold header): ONE chronological walk over the
 * message's blocks — the fold decides per block whether it hides, never
 * re-orders. The recurring regression was a folded act rendered from two
 * separately filtered lists (process in the panel, ALL text below it), which
 * hoisted every paragraph the model emitted BETWEEN two tool calls out of
 * sequence. These mounts lock the visible sequence: a text block stays
 * between the tool groups it arrived between — folded (collapsed and
 * expanded) and unfolded alike.
 */

function textBlock(id: string, text: string): ContentBlock {
  return { type: 'text', id, text }
}

function thinkingBlock(id: string): ContentBlock {
  return { type: 'thinking', id, text: `reasoning for ${id}`, sealed: true }
}

function toolGroup(id: string, toolName: string): ContentBlock {
  return {
    type: 'tool_group',
    id,
    tools: [{ id: `${id}:t1`, name: toolName, done: true, success: true, status: 'succeeded' }],
  }
}

/** think → say → act → say → act → say, exactly the live stream order. */
function interleavedMessage(): AgentChatMessage {
  return {
    id: 'turn:t1:act:1',
    role: 'assistant',
    blocks: [
      thinkingBlock('th1'),
      textBlock('tx1', 'INTRO-PARAGRAPH'),
      toolGroup('tg1', 'read_file'),
      textBlock('tx2', 'MIDDLE-PARAGRAPH'),
      toolGroup('tg2', 'run_command'),
      textBlock('tx3', 'FINAL-PARAGRAPH'),
    ],
  }
}

/** The visible content sequence: 'text' for a paragraph, 'tools' for a group. */
function visibleSequence(wrapper: { findAll: (selector: string) => Array<{ classes: () => string[]; text: () => string }> }): string[] {
  return wrapper
    .findAll('.md-content, .tool-group')
    .map((n) => (n.classes().includes('md-content') ? 'text' : 'tools'))
}

describe('ProcessFold ordering', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders the unfolded act through the same chronological walk', () => {
    // A FAILED turn never folds — the identical single walk, nothing hidden.
    const failed: TurnSettlement = { kind: 'failed', error: { message: 'boom' } as never }
    const wrapper = mount(ProcessFold, {
      props: { message: interleavedMessage(), settlement: failed },
    })

    expect(wrapper.find('.fold-summary').exists()).toBe(false)
    expect(visibleSequence(wrapper)).toEqual(['text', 'tools', 'text', 'tools', 'text'])
  })
})

describe('ProcessFold block render cache (module-level LRU)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('reuses cached block HTML across virtualizer remounts — no re-parse', async () => {
    const renderSpy = vi.spyOn(markdown, 'renderMarkdown')
    // Unique block ids: the file's ordering test above renders the same
    // fixed ids and would warm the shared cache, making the first mount a
    // hit and the cold-parse assertion below meaningless.
    const message: AgentChatMessage = {
      id: 'lru-m1',
      role: 'assistant',
      blocks: [textBlock('lru-tx1', 'LRU-PARAGRAPH'), textBlock('lru-tx2', 'LRU-SECOND')],
    }
    const first = mount(ProcessFold, {
      props: { message, settlement: { kind: 'failed', error: { message: 'x' } as never } },
    })
    const callsAfterFirstMount = renderSpy.mock.calls.length
    expect(callsAfterFirstMount).toBeGreaterThan(0)
    first.unmount()

    const second = mount(ProcessFold, {
      props: { message, settlement: { kind: 'failed', error: { message: 'x' } as never } },
    })
    await nextTick(); await nextTick()
    // Same text blocks → served from the shared module cache: zero new parses.
    expect(renderSpy.mock.calls.length).toBe(callsAfterFirstMount)
    expect(second.text()).toContain('LRU-SECOND')
    renderSpy.mockRestore()
  })
})
