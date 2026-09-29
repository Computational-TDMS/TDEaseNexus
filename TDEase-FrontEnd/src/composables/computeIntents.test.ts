/**
 * computeIntents attribution — the fold line's intent wording is only as good
 * as the act→todo attribution behind it. Three end-to-end assertions over a
 * real message projection: attribution follows the applied plan, only applied
 * (succeeded) calls move it, and no plan means no intents.
 */
import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { computeIntents } from './useSessionTodos'
import type { AgentChatMessage, ToolCall } from '@/stores/chat-types'

function todoTool(args: ToolCall['args'], status: ToolCall['status'] = 'succeeded'): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2)}`, name: 'todo_write', args, done: true, success: status === 'succeeded', status }
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

describe('computeIntents', () => {
  it('attributes each act the in_progress activeForm, falling back to the one before it', () => {
    const intents = computeIntents(ref([
      act('m1'),                                  // before any plan → no intent
      act('m2', [todoTool(plan1)]),               // its own write marks m2's intent
      act('m3'),                                  // inherits m2's in_progress
      act('m4', [todoTool(plan2)]),               // write moved on → new activeForm
      act('m5', [todoTool(planAllDone)]),         // nothing in progress after → falls back to before
    ])).value
    expect(intents.get('m1')).toBeUndefined()
    expect(intents.get('m2')).toBe('正在排查构建')
    expect(intents.get('m3')).toBe('正在排查构建')
    expect(intents.get('m4')).toBe('正在写修复')
    expect(intents.get('m5')).toBe('正在写修复')
  })

  it('a declined / failed todo_write never moves the attribution', () => {
    const stranger = { todos: [{ content: 'x', activeForm: '正在做别的事', status: 'in_progress' }] }
    const intents = computeIntents(ref([
      act('m1', [todoTool(plan1)]),
      act('m2', [todoTool(stranger, 'cancelled')]),
      act('m3', [todoTool(structuredClone(stranger), 'failed')]),
    ])).value
    expect(intents.get('m2')).toBe('正在排查构建')
    expect(intents.get('m3')).toBe('正在排查构建')
  })

  it('no plan anywhere → empty map', () => {
    const intents = computeIntents(ref([
      act('m1'),
      act('m2', [{ id: 'c', name: 'tdease.bash', args: { command: 'ls' }, done: true, success: true, status: 'succeeded' }]),
    ])).value
    expect(intents.size).toBe(0)
  })
})
