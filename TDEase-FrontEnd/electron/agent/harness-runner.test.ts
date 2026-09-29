import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { runAgentHarness, type HarnessRuntime } from './harness-runner'
import { DEFAULT_AGENT_TOOL_SETTINGS, type RuntimeEvent } from '../../src/contracts/agent-runtime'

describe('runAgentHarness', () => {
  it('drives one auto-authority runtime session and captures canonical tool pairs', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-harness-'))
    let emit: ((sessionId: string, event: RuntimeEvent) => void) | undefined
    const calls: string[] = []
    const runtime: HarnessRuntime = {
      bindSession: async () => {
        calls.push('bind')
        return {
          ok: true, generation: 1, resumed: false, resumeError: null, modelMeta: {},
          provider: { providerId: 'provider', displayName: 'provider', models: ['model'], configured: true },
        }
      },
      prompt: async ({ sessionId }) => {
        calls.push('prompt')
        emit?.(sessionId, {
          type: 'event_committed', generation: 1,
          event: { seq: 1, type: 'tool.requested', turn_id: 'turn-1', call_id: 'call-1', name: 'tdease.spectra.query', args: { path: 'run.mzML' } },
        })
        emit?.(sessionId, {
          type: 'event_committed', generation: 1,
          event: { seq: 2, type: 'tool.completed', turn_id: 'turn-1', call_id: 'call-1', ok: true, result: { count: 1, resultRef: { id: 'msr_123' } } },
        })
        return { ok: true, generation: 1, turnId: 'turn-1', outcome: 'resolved', usage: { input_tokens: 10, output_tokens: 4, tool_calls: 1, wall_clock_ms: 2 } }
      },
      resolveApproval: () => ({ ok: true }),
      dispose: async () => { calls.push('dispose'); return { ok: true } },
    }

    const summary = await runAgentHarness({
      runtime,
      onEvent: (handler) => { emit = handler; return () => { emit = undefined } },
      sessionDir,
      binding: {
        workspaceId: 'workspace-1', sessionId: 'session-1', mindset: 'explorer', authority: 'ask',
        model: { providerId: 'provider', modelId: 'model' }, thinkingLevel: 'off', agentTools: DEFAULT_AGENT_TOOL_SETTINGS,
      },
      prompts: ['inspect'],
    })

    expect(calls).toEqual(['bind', 'prompt', 'dispose'])
    expect(summary.tools).toEqual({ 'tdease.spectra.query': 1 })
    expect(summary.failedTools).toBe(0)
    expect(summary.sessionId).toBe('session-1')
    expect(JSON.parse(await fs.readFile(path.join(sessionDir, 'session.json'), 'utf8'))).toMatchObject({
      version: 1,
      id: 'session-1',
      archived: false,
      mindset: 'explorer',
    })
    await fs.rm(sessionDir, { recursive: true, force: true })
  })

  it('fails when auto authority emits an approval request', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-harness-approval-'))
    let emit: ((sessionId: string, event: RuntimeEvent) => void) | undefined
    const runtime: HarnessRuntime = {
      bindSession: async () => ({
        ok: true, generation: 1, resumed: false, resumeError: null, modelMeta: {},
        provider: { providerId: 'provider', displayName: 'provider', models: ['model'], configured: true },
      }),
      prompt: async ({ sessionId }) => {
        emit?.(sessionId, {
          type: 'approval_requested', generation: 1, approvalId: 'unexpected',
          action: 'workspace.write', basis: 'fixture', args: {},
        })
        return { ok: true, generation: 1, turnId: 'turn-1', outcome: 'resolved', usage: { input_tokens: 1, output_tokens: 1, tool_calls: 0, wall_clock_ms: 1 } }
      },
      resolveApproval: () => ({ ok: true }),
      dispose: async () => ({ ok: true }),
    }
    await expect(runAgentHarness({
      runtime,
      onEvent: (handler) => { emit = handler; return () => { emit = undefined } },
      sessionDir,
      binding: {
        workspaceId: 'workspace-1', sessionId: 'session-approval', mindset: 'explorer', authority: 'auto',
        model: { providerId: 'provider', modelId: 'model' }, thinkingLevel: 'off', agentTools: DEFAULT_AGENT_TOOL_SETTINGS,
      },
      prompts: ['inspect'],
    })).rejects.toThrow('AUTO_AUTHORITY_DRIFT')
    await fs.rm(sessionDir, { recursive: true, force: true })
  })

  it('does not send later scripted turns after an unresolved outcome', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-harness-stop-'))
    let prompts = 0
    const runtime: HarnessRuntime = {
      bindSession: async () => ({
        ok: true, generation: 1, resumed: false, resumeError: null, modelMeta: {},
        provider: { providerId: 'provider', displayName: 'provider', models: ['model'], configured: true },
      }),
      prompt: async () => {
        prompts += 1
        return {
          ok: true, generation: 1, turnId: 'turn-1', outcome: 'failed',
          usage: { input_tokens: 0, output_tokens: 0, tool_calls: 0, wall_clock_ms: 1 },
        }
      },
      resolveApproval: () => ({ ok: true }),
      dispose: async () => ({ ok: true }),
    }

    const summary = await runAgentHarness({
      runtime,
      onEvent: () => () => {},
      sessionDir,
      binding: {
        workspaceId: 'workspace-1', sessionId: 'session-stop', mindset: 'explorer', authority: 'auto',
        model: { providerId: 'provider', modelId: 'model' }, thinkingLevel: 'off', agentTools: DEFAULT_AGENT_TOOL_SETTINGS,
      },
      prompts: ['first', 'must not run'],
    })

    expect(prompts).toBe(1)
    expect(summary.outcomes).toEqual(['failed'])
    await fs.rm(sessionDir, { recursive: true, force: true })
  })
})
