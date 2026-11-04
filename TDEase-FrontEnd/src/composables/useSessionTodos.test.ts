/**
 * parseTodos' APPLIED-call gate — pins the "declined todo_write switched the
 * plan card" defect.
 *
 * The plan is a derived summary of todo_write payloads, but only calls that
 * actually SUCCEEDED are facts: a requested-but-declined, failed or cancelled
 * call never wrote the plan, so its payload must not become the card's truth
 * either — the card would contradict the failed tool row beside it.
 */
import { describe, expect, it } from 'vitest'
import { parseTodos } from './useSessionTodos'
import type { ToolCall } from '@/stores/chat-types'

function todoTool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    name: 'todo_write',
    args: {
      todos: [
        { content: 'read the log', activeForm: 'reading the log', status: 'in_progress' },
        { content: 'write the fix', activeForm: 'writing the fix', status: 'pending' },
      ],
    },
    done: true,
    success: true,
    status: 'succeeded',
    ...overrides,
  }
}

describe('useSessionTodos parseTodos', () => {
  it('parses a succeeded todo_write payload', () => {
    const todos = parseTodos(todoTool())
    expect(todos).toHaveLength(2)
    expect(todos![0]).toMatchObject({ content: 'read the log', status: 'in_progress' })
  })

  it('rejects calls that never succeeded — declined, failed, cancelled, still running', () => {
    // A declined approval sweeps to 'cancelled' at turn end; a failed call
    // carries status 'failed'; an in-flight one is 'running'. None of them
    // wrote the plan.
    for (const status of ['cancelled', 'failed', 'running', 'unknown'] as const) {
      expect(parseTodos(todoTool({ status }))).toBeNull()
    }
  })

  it('rejects non-todo tools outright', () => {
    expect(parseTodos(todoTool({ name: 'tdease.bash' }))).toBeNull()
  })

  it('rejects malformed payloads even when the call succeeded', () => {
    expect(parseTodos(todoTool({ args: {} }))).toBeNull()
    expect(parseTodos(todoTool({ args: { todos: 'nope' } }))).toBeNull()
  })
})
