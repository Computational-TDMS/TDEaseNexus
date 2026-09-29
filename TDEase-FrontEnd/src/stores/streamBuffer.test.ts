/**
 * StreamBuffer tool-merge core path — pins the "every tool renders as 'tool'
 * once it finishes" bug.
 *
 * `tool.requested` arrives with the real name + args; the later
 * `tool.completed` carries only id/done/success/status — it has NO name field
 * in the event vocabulary (vocabulary.ts `ToolCompletedEvent`). The buffer
 * must MERGE the completion patch onto the existing entry, not replace it. The
 * live path (`useAgentTurn`) now sends exactly this shape: a status-only
 * patch with no name.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'
import { StreamBuffer } from './streamBuffer'
import type { ToolCall, ToolGroupBlock } from './chat-types'

function setup(): { buffer: StreamBuffer; messageId: string; store: ReturnType<typeof useAgentStore> } {
  const store = useAgentStore()
  store.bindWorkspace('ws_1')
  const session = store.createSession()
  store.addMessage(session.id, 'user', 'run it')
  const assistant = store.addMessage(session.id, 'assistant', '')
  const buffer = new StreamBuffer(store, session.id)
  buffer.attach(assistant.id)
  return { buffer, messageId: assistant.id, store }
}

function toolGroup(store: ReturnType<typeof useAgentStore>, messageId: string): ToolGroupBlock {
  const msg = store.findMessage(store.active!.id, messageId)!
  const group = msg.blocks?.find((b) => b.type === 'tool_group')
  if (!group) throw new Error('no tool_group block after flush')
  return group as ToolGroupBlock
}

describe('StreamBuffer upsertTool merges completion patches', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('preserves the requested name + args when tool.completed patches status only', async () => {
    const { buffer, messageId, store } = setup()

    buffer.upsertTool({
      id: 'call-1',
      name: 'tdease.bash',
      args: { command: 'pnpm test' },
      done: false,
      success: false,
      status: 'running',
    } as ToolCall)

    // Completion patch: status fields only, exactly what useAgentTurn emits
    // for tool.completed. No name, no args.
    buffer.upsertTool({
      id: 'call-1',
      done: true,
      success: true,
      status: 'succeeded',
    } as ToolCall)

    await buffer.flushNow()

    const group = toolGroup(store, messageId)
    expect(group.tools).toHaveLength(1)
    expect(group.tools[0].name).toBe('tdease.bash') // real name preserved, not dropped
    expect(group.tools[0].args).toEqual({ command: 'pnpm test' }) // args preserved too
    expect(group.tools[0].status).toBe('succeeded')
    expect(group.tools[0].done).toBe(true)
  })

  it('seals the thinking block the moment answer text arrives, not at stream end', async () => {
    // Regression: `inThinking` used to stay true until flushNow, so the whole
    // answer streamed with the thinking block still announcing "正在思考".
    // Fluses here ride the buffer's real rAF cadence — flushNow would mean
    // "stream over" and seal by itself.
    const { buffer, messageId, store } = setup()
    const tick = () => new Promise((r) => setTimeout(r, 50))

    buffer.appendThinking('let me check the run first')
    await tick()

    const msg = () => store.findMessage(store.active!.id, messageId)!
    const thinkingBlock = () => msg().blocks?.find((b) => b.type === 'thinking') as
      | { sealed: boolean; durationMs?: number; text: string }
      | undefined
    expect(thinkingBlock()?.sealed).toBe(false)

    // The transition itself: text arriving ends the reasoning segment. One
    // flush later the block is sealed and duration-stamped — the stream is
    // NOT over (no flushNow).
    buffer.appendText('The run is healthy because…')
    await tick()

    const sealed = thinkingBlock()
    expect(sealed?.sealed).toBe(true)
    expect(sealed?.durationMs).toBeTypeOf('number')
    expect(sealed?.text).toBe('let me check the run first')
    // The answer text is a separate block AFTER the sealed thinking block.
    expect(msg().blocks?.at(-1)?.type).toBe('text')
  })

  it('seals the thinking block when a tool call follows reasoning with no text', async () => {
    const { buffer, messageId, store } = setup()

    buffer.appendThinking('planning the call')
    buffer.upsertTool({ id: 'call-9', name: 'tdease.bash', args: {}, done: false, success: false, status: 'running' } as ToolCall)
    await buffer.flushNow()

    const msg = store.findMessage(store.active!.id, messageId)!
    const thinking = msg.blocks?.find((b) => b.type === 'thinking') as { sealed: boolean } | undefined
    expect(thinking?.sealed).toBe(true)
  })

  it('mints a fresh tool_group with the committed event id so it survives the settle swap', async () => {
    // The replay projection names a group after its first tool's seq
    // (`event:<seq>`); the live group must carry the SAME id, or the
    // transcript-wide fold map orphans the user's expansion at settle.
    const { buffer, messageId, store } = setup()

    buffer.upsertTool({ id: 'call-1', name: 'tdease.bash', args: {}, done: false, success: false, status: 'running' } as ToolCall, 'event:7')
    await buffer.flushNow()

    const group = toolGroup(store, messageId)
    expect(group.id).toBe('event:7')

    // A second call joining the existing group must NOT rename it (its own
    // seq is irrelevant; only the group-creating call names the group).
    buffer.upsertTool({ id: 'call-2', name: 'tdease.read', args: {}, done: false, success: false, status: 'running' } as ToolCall, 'event:9')
    await buffer.flushNow()

    const groups = store.findMessage(store.active!.id, messageId)!.blocks!
      .filter(b => b.type === 'tool_group') as ToolGroupBlock[]
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('event:7')
    expect(groups[0].tools).toHaveLength(2)
  })
})
