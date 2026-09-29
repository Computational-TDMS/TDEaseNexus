import { describe, expect, it } from 'vitest'

import type { SessionEvent } from './vocabulary'
import { projectTrajectory } from './trajectory'

/** Minimal valid events; seq is stamped by the helper to keep fixtures terse. */
function events(...inputs: Array<Omit<SessionEvent, 'seq'>>): SessionEvent[] {
  return inputs.map((input, index) => ({ ...input, seq: index + 1 }) as SessionEvent)
}

const START = (turnId: string, over: Partial<{ user_message: string; model: string; mindset: string }> = {}) => ({
  type: 'turn.started' as const,
  turn_id: turnId,
  user_message: over.user_message ?? 'find isoforms',
  prompt_snapshot_digest: 'a'.repeat(64),
  model: over.model ?? 'deepseek-v4',
  mindset: over.mindset ?? 'scientific',
  authority: 'ask',
})

const REQUEST = (turnId: string, request_seq: number, over: Partial<{ model: string; thinking_level: string }> = {}) => ({
  type: 'model.request.prepared' as const,
  turn_id: turnId,
  request_seq,
  system_prompt_digest: `${request_seq}`.padStart(64, 's'),
  context_digest: `${request_seq}`.padStart(64, 'c'),
  active_tools_digest: `${request_seq}`.padStart(64, 't'),
  model: over.model ?? 'deepseek-v4',
  thinking_level: over.thinking_level ?? 'medium',
})

const TOOL_REQ = (turnId: string, callId: string, name = 'tdease.runs.list') => ({
  type: 'tool.requested' as const,
  turn_id: turnId,
  call_id: callId,
  name,
  args: {},
})

const TOOL_OK = (turnId: string, callId: string) => ({
  type: 'tool.completed' as const,
  turn_id: turnId,
  call_id: callId,
  ok: true as const,
  result: null,
})

describe('projectTrajectory', () => {
  it('folds one turn into a row with its request, tools and settlement', () => {
    const log = events(
      START('t1'),
      REQUEST('t1', 1),
      { type: 'thinking.recorded', turn_id: 't1', content: 'plan' },
      { type: 'message.completed', turn_id: 't1', role: 'assistant' as const, content: 'done' },
      TOOL_REQ('t1', 'c1'),
      TOOL_OK('t1', 'c1'),
      { type: 'turn.completed', turn_id: 't1', outcome: 'resolved' as const, usage: { input_tokens: 10, output_tokens: 5, tool_calls: 1, wall_clock_ms: 900 } },
    )
    const trajectory = projectTrajectory(log)
    expect(trajectory.turns).toHaveLength(1)
    const turn = trajectory.turns[0]!
    expect(turn.userMessage).toBe('find isoforms')
    expect(turn.seqStart).toBe(1)
    expect(turn.seqEnd).toBe(7)
    expect(turn.requests.map((request) => request.requestSeq)).toEqual([1])
    expect(turn.requests[0]!.contextDigest.startsWith('c')).toBe(true)
    expect(turn.tools).toEqual([
      { seq: 5, callId: 'c1', name: 'tdease.runs.list', ok: true },
    ])
    expect(turn.thinking).toEqual([{ seq: 3, preview: 'plan' }])
    expect(turn.messages).toEqual([{ seq: 4, preview: 'done' }])
    expect(turn.settlement).toMatchObject({ kind: 'completed', outcome: 'resolved' })
    expect(trajectory).toMatchObject({ totalEvents: 7, totalRequests: 1, totalToolCalls: 1 })
  })

  it('keeps turns separate and counts across them', () => {
    const log = events(
      START('t1'), TOOL_REQ('t1', 'c1'), TOOL_OK('t1', 'c1'),
      { type: 'turn.completed', turn_id: 't1', outcome: 'resolved' as const, usage: { input_tokens: 1, output_tokens: 1, tool_calls: 1, wall_clock_ms: 1 } },
      START('t2', { model: 'deepseek-r2' }), REQUEST('t2', 1), REQUEST('t2', 2),
      { type: 'turn.completed', turn_id: 't2', outcome: 'blocked' as const, usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0, wall_clock_ms: 1 } },
    )
    const trajectory = projectTrajectory(log)
    expect(trajectory.turns.map((turn) => turn.turnId)).toEqual(['t1', 't2'])
    expect(trajectory.turns[1]!.model).toBe('deepseek-r2')
    expect(trajectory.turns[1]!.requests).toHaveLength(2)
    expect(trajectory.totalRequests).toBe(2)
    expect(trajectory.totalToolCalls).toBe(1)
  })

  it('folds approval decision onto the tool row and failure onto the settlement', () => {
    const log = events(
      START('t1'),
      { type: 'approval.requested', turn_id: 't1', call_id: 'c1', action: 'workspace.write', basis: 'run commit' },
      { type: 'approval.resolved', turn_id: 't1', call_id: 'c1', decision: 'approved', by: 'user' },
      TOOL_REQ('t1', 'c1', 'tdease.workflow.submit'),
      { type: 'tool.completed', turn_id: 't1', call_id: 'c1', ok: false, error: { code: 'BACKEND_REFUSED', message: 'no such node' } },
      { type: 'turn.failed', turn_id: 't1', error: { code: 'AGENT_PROMPT_FAILED', message: 'provider 502' } },
    )
    const turn = projectTrajectory(log).turns[0]!
    expect(turn.tools[0]).toMatchObject({
      callId: 'c1',
      ok: false,
      error: { code: 'BACKEND_REFUSED' },
      approval: { decision: 'approved', reason: 'run commit' },
    })
    expect(turn.settlement).toMatchObject({ kind: 'failed', error: { code: 'AGENT_PROMPT_FAILED' } })
  })

  it('carries the reportBlocked question onto a blocked settlement', () => {
    const log = events(
      START('t1'),
      { type: 'tool.requested', turn_id: 't1', call_id: 'c1', name: 'tdease.session.reportBlocked', args: { reason: 'missing precursor', needed: 'rev-2' } },
      { type: 'tool.completed', turn_id: 't1', call_id: 'c1', ok: true, result: null },
      { type: 'turn.completed', turn_id: 't1', outcome: 'blocked' as const, usage: { input_tokens: 1, output_tokens: 1, tool_calls: 1, wall_clock_ms: 1 } },
    )
    const turn = projectTrajectory(log).turns[0]!
    expect(turn.settlement).toMatchObject({ kind: 'completed', outcome: 'blocked', blocked: { reason: 'missing precursor', needed: 'rev-2' } })
  })

  it('tolerates an open tool and a live prefix without settlement', () => {
    const log = events(START('t1'), TOOL_REQ('t1', 'c1'))
    const turn = projectTrajectory(log).turns[0]!
    expect(turn.tools[0]!.callId).toBe('c1')
    expect(turn.tools[0]!.ok).toBeUndefined()
    expect(turn.settlement).toBeNull()
  })

  it('refuses non-contiguous sequence numbers and unknown turns', () => {
    const gap = events(START('t1'), TOOL_REQ('t1', 'c1'))
    gap[1]!.seq = 3
    expect(() => projectTrajectory(gap)).toThrow(/contiguous/)
    const orphan = events({ type: 'thinking.recorded', turn_id: 'ghost', content: 'x' })
    expect(() => projectTrajectory(orphan)).toThrow(/unknown turn ghost/)
  })
})
