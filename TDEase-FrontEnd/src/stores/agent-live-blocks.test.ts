import { describe, expect, it } from 'vitest'
import { createLiveBlocksSlice } from './agent-live-blocks'
import type { AgentSession } from './agent-session-meta'
import type { ContentBlock, TextBlock, ThinkingBlock, ToolGroupBlock } from './chat-types'

/**
 * The DATA-side ordering lock. An assistant act is one ordered
 * parts array (pi / AI SDK v5 shape);
 * the live assembly folds must keep it that way under interleaved arrival:
 * think → say → act → say → act → say. The store may merge a delta into the
 * immediately-preceding block of the same kind and may patch a tool wherever
 * it lives — it must never move a block, never merge across a different
 * block, never reorder by type. This is the invariant whose render-side
 * violation shipped twice as "all tools, then all text".
 */
describe('live block assembly keeps arrival order', () => {
  function setup() {
    const session = {
      id: 's1',
      workspaceId: 'ws',
      title: '',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
    } as unknown as AgentSession
    const slice = createLiveBlocksSlice(() => session)
    return { session, slice }
  }

  it('interleaved thinking/text/tool deltas assemble into the exact arrival sequence', () => {
    const { slice } = setup()
    const msg = slice.addMessage('s1', 'assistant')

    slice.appendThinking('s1', msg.id, 'reasoning')
    slice.sealThinking('s1', msg.id)
    slice.appendText('s1', msg.id, 'intro ')
    slice.appendText('s1', msg.id, 'continued')          // merges: same open text block
    slice.upsertTool('s1', msg.id, { id: 't1', name: 'read', done: false, success: false, status: 'running' })
    slice.appendText('s1', msg.id, 'middle')             // NEW text block — a tool group sits between
    slice.upsertTool('s1', msg.id, { id: 't2', name: 'bash', done: false, success: false, status: 'running' })
    slice.appendText('s1', msg.id, 'final')              // NEW text block again
    // t1 completes AFTER later text existed — patch in place, no move.
    slice.upsertTool('s1', msg.id, { id: 't1', done: true, success: true, status: 'succeeded' })

    const types = (msg.blocks ?? []).map((b: ContentBlock) => b.type)
    expect(types).toEqual(['thinking', 'text', 'tool_group', 'text', 'tool_group', 'text'])

    const [th0, tx1, , tx2, , tx3] = msg.blocks as [ThinkingBlock, TextBlock, ToolGroupBlock, TextBlock, ToolGroupBlock, TextBlock]
    expect(tx1.text).toBe('intro continued')
    expect(tx2.text).toBe('middle')
    expect(tx3.text).toBe('final')
    expect(th0.sealed).toBe(true)
    // The completion patched the ORIGINAL group's tool, preserving its name.
    const firstGroup = (msg.blocks as ToolGroupBlock[])[2]
    expect(firstGroup.tools).toHaveLength(1)
    expect(firstGroup.tools[0]).toMatchObject({ id: 't1', name: 'read', status: 'succeeded' })
    expect((msg.blocks as ToolGroupBlock[])[4].tools[0]).toMatchObject({ id: 't2', name: 'bash', status: 'running' })
  })

  it('consecutive tool calls share ONE group; a text between splits them', () => {
    const { slice } = setup()
    const msg = slice.addMessage('s1', 'assistant')

    slice.upsertTool('s1', msg.id, { id: 'a', name: 'read', done: true, success: true, status: 'succeeded' })
    slice.upsertTool('s1', msg.id, { id: 'b', name: 'grep', done: true, success: true, status: 'succeeded' })
    slice.appendText('s1', msg.id, 'note')
    slice.upsertTool('s1', msg.id, { id: 'c', name: 'bash', done: true, success: true, status: 'succeeded' })

    const groups = (msg.blocks ?? []).filter((b): b is ToolGroupBlock => b.type === 'tool_group')
    expect(groups).toHaveLength(2)
    expect(groups[0].tools.map((t) => t.id)).toEqual(['a', 'b'])
    expect(groups[1].tools.map((t) => t.id)).toEqual(['c'])
    expect((msg.blocks ?? []).map((b) => b.type)).toEqual(['tool_group', 'text', 'tool_group'])
  })

  it('a later thinking segment starts a NEW block after text — never merges backwards', () => {
    const { slice } = setup()
    const msg = slice.addMessage('s1', 'assistant')

    slice.appendThinking('s1', msg.id, 'first')
    slice.sealThinking('s1', msg.id)
    slice.appendText('s1', msg.id, 'answer')
    slice.appendThinking('s1', msg.id, 'second')

    expect((msg.blocks ?? []).map((b) => b.type)).toEqual(['thinking', 'text', 'thinking'])
    const blocks = msg.blocks as ThinkingBlock[]
    expect(blocks[0].text).toBe('first')
    expect(blocks[2].text).toBe('second')
  })
})
