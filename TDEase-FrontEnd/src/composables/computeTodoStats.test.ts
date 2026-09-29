/**
 * computeTodoStats era attribution — the spine nodes' right-side meta is only
 * as honest as the attribution behind it. Three end-to-end assertions over a
 * real message projection: calls follow the in_progress item across todo_write
 * boundaries (mid-message, in tool order), the todo_write calls themselves and
 * pre-plan / no-in-progress work are never attributed, and failed or
 * cancelled calls still count — they were work under the era.
 */
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { computeTodoStats } from './useSessionTodos'
import type { AgentChatMessage, ToolCall } from '@/stores/chat-types'

function todoTool(args: ToolCall['args'], status: ToolCall['status'] = 'succeeded'): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2)}`, name: 'todo_write', args, done: true, success: status === 'succeeded', status }
}

function tool(name: string, status: ToolCall['status'] = 'succeeded'): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2)}`, name, args: {}, done: true, success: status === 'succeeded', status }
}

/** An act message: a thinking block always, plus one tool_group when given. */
function act(id: string, tools: ToolCall[] = []): AgentChatMessage {
  const blocks: AgentChatMessage['blocks'] = [{ type: 'thinking', id: `${id}:th`, text: '…', sealed: true }]
  if (tools.length) blocks.push({ type: 'tool_group', id: `${id}:tg`, tools })
  return { id, role: 'assistant', blocks }
}

const plan1 = { todos: [
  { content: '排查构建', activeForm: '正在排查构建', status: 'in_progress' },
  { content: '写修复', activeForm: '正在写修复', status: 'pending' },
] }
const plan2 = { todos: [
  { content: '排查构建', activeForm: '正在排查构建', status: 'completed' },
  { content: '写修复', activeForm: '正在写修复', status: 'in_progress' },
] }
const planAllDone = { todos: [
  { content: '排查构建', activeForm: '正在排查构建', status: 'completed' },
  { content: '写修复', activeForm: '正在写修复', status: 'completed' },
] }

describe('computeTodoStats', () => {
  it('attributes calls to the in_progress era, switching at each applied todo_write in tool order', () => {
    const stats = computeTodoStats(ref([
      act('m1', [tool('tdease.bash')]),                  // before any plan → nobody's
      act('m2', [tool('tdease.read'), todoTool(plan1)]), // read ran before the write → nobody's
      act('m3', [tool('tdease.bash'), tool('tdease.grep'), tool('tdease.bash')]), // era 0, icons deduped
      act('m4', [tool('tdease.bash'), todoTool(plan2)]), // bash before the write → the OLD era
      act('m5', [tool('tdease.edit')]),                  // after the write → the new era
    ])).value
    expect(stats.get('0:排查构建')).toEqual({ calls: 4, icons: ['terminal', 'search'], products: [] })
    expect(stats.get('1:写修复')).toEqual({ calls: 1, icons: ['pencil'], products: [] })
    expect(stats.size).toBe(2)
  })

  it('never counts todo_write calls, and pre-plan or no-in-progress work stays unattributed', () => {
    const stranger = { todos: [{ content: 'x', activeForm: '正在做别的事', status: 'in_progress' }] }
    const stats = computeTodoStats(ref([
      act('m1', [tool('tdease.bash'), todoTool(plan1)]),          // bash pre-plan + the write itself → neither counts
      act('m2', [todoTool(stranger, 'failed'), tool('tdease.read')]), // failed write switches nothing; read → era 0
      act('m3', [todoTool(planAllDone)]),                         // nothing in progress anymore → era off
      act('m4', [tool('tdease.bash')]),                           // no era → unattributed
    ])).value
    expect(stats.get('0:排查构建')).toEqual({ calls: 1, icons: ['file'], products: [] })
    expect(stats.size).toBe(1)
  })

  it('counts failed and cancelled calls — they were still work under the era', () => {
    const stats = computeTodoStats(ref([
      act('m1', [todoTool(plan1)]),
      act('m2', [tool('tdease.bash', 'failed'), tool('tdease.read', 'cancelled'), tool('tdease.grep')]),
    ])).value
    expect(stats.get('0:排查构建')).toEqual({ calls: 3, icons: ['terminal', 'file', 'search'], products: [] })
  })

  it('records what the era produced — the task tree branches — once per durable thing', () => {
    const submit = { ...tool('tdease.workflow.submit'), resultPreview: { text: '{"status":"submitted","stage":"submitted","run":{"id":"run_abc123","title":"soybean-all"' } }
    const failedSubmit = { ...tool('tdease.workflow.submit', 'failed'), resultPreview: { text: '{"run":{"id":"run_zzz"' } }
    const edit = (path: string) => ({ ...tool('tdease.edit'), args: { path } })
    const stats = computeTodoStats(ref([
      act('m1', [todoTool(plan1)]),
      act('m2', [submit, failedSubmit, edit('analysis/a.md'), edit('analysis/a.md'), tool('tdease.read')]),
    ])).value
    expect(stats.get('0:排查构建')?.products).toEqual([
      { kind: 'run', runId: 'run_abc123', callId: submit.id },
      { kind: 'file', path: 'analysis/a.md', callId: expect.any(String) },
    ])
  })
})
