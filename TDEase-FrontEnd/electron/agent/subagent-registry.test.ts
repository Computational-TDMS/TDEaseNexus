import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentBridgeResult, BoundSession, PromptInput, PromptResult } from '../../src/contracts/agent-runtime'
import type { AgentToolSettings, BindSessionInput } from '../../src/contracts/agent-runtime'
import type { SessionEvent } from '../../src/agent/events'
import {
  createSubagentRegistry,
  narrowAgentTools,
  parseFrontmatter,
  parseResult,
  type SubagentRuntime,
} from './subagent-registry'

const PARENT_TOOLS: AgentToolSettings = {
  discovery: true, workflow: true, runObservation: true, runControl: true,
  workspaceWrite: true, shell: true, mcp: true,
}

const PARENT = {
  sessionId: 'parent-1',
  workspaceId: 'ws-1',
  mindset: 'explorer' as const,
  authority: 'ask' as const,
  permissionCeiling: {
    'workspace.read': 'allow',
    'shell.exec': 'ask',
    'workspace.write': 'ask',
    'subagent.spawn': 'ask',
  },
  model: { providerId: 'test', modelId: 'test-model' },
  thinkingLevel: 'medium' as const,
  agentTools: PARENT_TOOLS,
}

const SKILL = `---
name: evidence-specialist
description: test fixture
allowed_tool_refs:
  - uniprot.query
  - runs.fetchFile
  - read
---
# Test fixture
`

function boundSession(): AgentBridgeResult<BoundSession> {
  return {
    ok: true,
    generation: 1,
    resumed: false,
    resumeError: null,
    modelMeta: { reasoning: false, input: ['text'] },
    provider: { providerId: 'test', displayName: 'Test', models: ['test-model'], configured: true },
  }
}

function messageCompleted(content: string): SessionEvent {
  return { seq: 1, type: 'message.completed', turn_id: 't1', role: 'assistant', content }
}

function resolvedPrompt(outcome: PromptResult['outcome'] = 'resolved'): AgentBridgeResult<PromptResult> {
  return { ok: true, generation: 1, turnId: 't1', outcome, usage: { input_tokens: 0, output_tokens: 0, tool_calls: 0, wall_clock_ms: 0 } }
}

function makeRuntime(options: {
  prompt?: (input: PromptInput) => Promise<AgentBridgeResult<PromptResult>>
  events?: (sessionId: string) => Promise<ReadonlyArray<SessionEvent>>
} = {}) {
  const bind = vi.fn(async (_input: BindSessionInput): Promise<AgentBridgeResult<BoundSession>> => boundSession())
  const prompt = vi.fn(options.prompt ?? (async (_input: PromptInput): Promise<AgentBridgeResult<PromptResult>> => resolvedPrompt()))
  const readSessionEvents = vi.fn(options.events ?? (async (_sessionId: string): Promise<ReadonlyArray<SessionEvent>> => []))
  const abort = vi.fn(async (_sessionId: string): Promise<{ ok: true }> => ({ ok: true }))
  const dispose = vi.fn(async (_sessionId: string): Promise<{ ok: true }> => ({ ok: true }))
  const fork = vi.fn(async (_sessionId: string, _target: string): Promise<{ ok: true }> => ({ ok: true }))
  const runtime: SubagentRuntime = { bindSession: bind, prompt, readSessionEvents, abort, dispose, fork }
  return { runtime, bind, prompt, readSessionEvents, abort, dispose, fork }
}

function makeAssets(frontmatter: string) {
  return {
    readText: vi.fn(async (_relative: string) => frontmatter),
    listFiles: vi.fn(async () => []),
    resolvePath: vi.fn(async () => '/tmp'),
  }
}

/** Let the fire-and-forget background settle run to completion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('subagent-registry', () => {
  it('spawn resolves immediately while the child prompt runs in the background', async () => {
    let settle!: (value: AgentBridgeResult<PromptResult>) => void
    const pending = new Promise<AgentBridgeResult<PromptResult>>((resolve) => { settle = resolve })
    const { runtime, bind, prompt } = makeRuntime({ prompt: () => pending })
    const assets = makeAssets(SKILL)
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: assets })

    const result = await registry.spawn({ role: 'evidence-specialist', task: 'validate scan 1164' })
    // spawn returned BEFORE the prompt settled — no blocking on the LLM.
    expect(result.subagentId).toMatch(/^sub_evidence-specialist_[0-9a-f-]+$/)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith({ sessionId: result.subagentId, message: 'validate scan 1164' })

    // Still running until the child settles.
    const running = await registry.status(result.subagentId)
    expect(running.state).toBe('running')

    settle(resolvedPrompt())
    await flush()

    const settled = await registry.status(result.subagentId)
    expect(settled.state).toBe('returned')
    expect(settled.elapsedS).toBeGreaterThanOrEqual(0)
  })

  it('wait settles at once when the abort signal fires, children still running', async () => {
    // The user-stop contract: a parent turn parked in subagent.wait must not
    // stay parked until the children finish on their own.
    const pending = new Promise<AgentBridgeResult<PromptResult>>(() => {})
    const { runtime } = makeRuntime({ prompt: () => pending })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'never settles' })

    const controller = new AbortController()
    let done = false
    const waiting = registry.wait({ subagentIds: [subagentId] }, controller.signal)
      .then((results) => { done = true; return results })
    await flush()
    expect(done).toBe(false)

    controller.abort()
    const results = await waiting
    expect(done).toBe(true)
    expect(results[0].state).toBe('running')
  })

  it('wait({all:true}) blocks until every selected child is terminal', async () => {
    let settleA!: (value: AgentBridgeResult<PromptResult>) => void
    let settleB!: (value: AgentBridgeResult<PromptResult>) => void
    const pendingA = new Promise<AgentBridgeResult<PromptResult>>((resolve) => { settleA = resolve })
    const pendingB = new Promise<AgentBridgeResult<PromptResult>>((resolve) => { settleB = resolve })
    const promptByTask = new Map([['a', pendingA], ['b', pendingB]])
    const { runtime } = makeRuntime({ prompt: (input) => promptByTask.get(input.message) ?? resolvedPrompt() })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    const spawned = await registry.spawnGroup({ tasks: [
      { role: 'evidence-specialist', task: 'a' },
      { role: 'evidence-specialist', task: 'b' },
    ] })
    let returned = false
    const waiting = registry.wait({ groupId: spawned.groupId, all: true }).then((results) => {
      returned = true
      return results
    })
    await flush()
    expect(returned).toBe(false)
    settleA(resolvedPrompt()) // one settles — all:true must keep blocking
    await flush()
    expect(returned).toBe(false)
    settleB(resolvedPrompt())
    const results = await waiting
    expect(results.map((result) => result.subagentId).sort()).toEqual([...spawned.subagentIds].sort())
    expect(results.every((result) => result.state === 'returned')).toBe(true)
  })

  it('wait (default) returns on the first completion, not the slowest child', async () => {
    let settleA!: (value: AgentBridgeResult<PromptResult>) => void
    let settleB!: (value: AgentBridgeResult<PromptResult>) => void
    const pendingA = new Promise<AgentBridgeResult<PromptResult>>((resolve) => { settleA = resolve })
    const pendingB = new Promise<AgentBridgeResult<PromptResult>>((resolve) => { settleB = resolve })
    const promptByTask = new Map([['a', pendingA], ['b', pendingB]])
    const { runtime } = makeRuntime({ prompt: (input) => promptByTask.get(input.message) ?? resolvedPrompt() })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    const spawned = await registry.spawnGroup({ tasks: [
      { role: 'evidence-specialist', task: 'a' },
      { role: 'evidence-specialist', task: 'b' },
    ] })
    // Default: resolve the moment the first child settles, with the other still running.
    let done = false
    const waiting = registry.wait({ groupId: spawned.groupId }).then((results) => { done = true; return results })
    await flush()
    expect(done).toBe(false)
    settleA(resolvedPrompt()) // only the 'a' child settles
    await flush()
    expect(done).toBe(true)
    const first = await waiting
    expect(first).toHaveLength(2)
    expect(first.filter((result) => result.state === 'returned')).toHaveLength(1)
    expect(first.filter((result) => result.state === 'running')).toHaveLength(1)
  })

  it('wait (unscoped) collects every child and blocks until all running settle', async () => {
    let settleA!: (value: AgentBridgeResult<PromptResult>) => void
    let settleB!: (value: AgentBridgeResult<PromptResult>) => void
    const pendingA = new Promise<AgentBridgeResult<PromptResult>>((resolve) => { settleA = resolve })
    const pendingB = new Promise<AgentBridgeResult<PromptResult>>((resolve) => { settleB = resolve })
    const promptByTask = new Map([['a', pendingA], ['b', pendingB]])
    const { runtime } = makeRuntime({ prompt: (input) => promptByTask.get(input.message) ?? resolvedPrompt() })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    await registry.spawn({ role: 'evidence-specialist', task: 'a' })
    await registry.spawn({ role: 'evidence-specialist', task: 'b' })

    // The unscoped form forgets the ids entirely — it must wait for ALL
    // children, not return on the first settle (that would force a drain loop
    // the model has no ids to drive).
    let done = false
    const waiting = registry.wait({}).then((results) => { done = true; return results })
    await flush()
    expect(done).toBe(false)
    settleA(resolvedPrompt())
    await flush()
    expect(done).toBe(false)
    settleB(resolvedPrompt())
    const results = await waiting
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.state === 'returned')).toBe(true)
  })

  it('wait (unscoped) with no children returns an empty set instead of throwing', async () => {
    const { runtime } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    await expect(registry.wait({})).resolves.toEqual([])
  })

  it('continues a settled child in the same session and waits for its revised result', async () => {
    const { runtime, prompt } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'first pass' })
    await registry.wait({ subagentIds: [subagentId] })

    await registry.followup({ subagentId, message: 'recheck the mass assignment' })
    const [result] = await registry.wait({ subagentIds: [subagentId] })

    expect(prompt).toHaveBeenLastCalledWith({ sessionId: subagentId, message: 'recheck the mass assignment' })
    expect(result.state).toBe('returned')
  })

  it('followup re-binds with the ORIGINAL delegation scope, never a recomputed role default', async () => {
    // The 2026-09-05 review defect: spawn narrowed the child to ['read'], but
    // followup rebuilt the role-default surface (bash/write/edit returned).
    // The spawn's granted scope is a persisted creation fact now.
    const { runtime, bind } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    const { subagentId } = await registry.spawn({
      role: 'evidence-specialist',
      task: 'first pass',
      toolAllowlist: ['read'],
    })
    await registry.wait({ subagentIds: [subagentId] })
    await registry.followup({ subagentId, message: 'continue' })

    const resume = bind.mock.calls[bind.mock.calls.length - 1][0]
    expect(resume.sessionId).toBe(subagentId)
    expect(resume.toolAllowlist).toEqual(['read'])
    expect(resume.agentTools.shell).toBe(false)
    expect(resume.agentTools.workspaceWrite).toBe(false)
  })

  it('rebinds and resumes the same child after the parent process restarts', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'subagent-resume-'))
    try {
      const { runtime, bind, prompt } = makeRuntime({
        events: async () => [messageCompleted('resumed conclusion')],
      })
      const first = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL), workspaceRoot: workspace })
      const { subagentId } = await first.spawn({ role: 'evidence-specialist', task: 'first pass' })
      await first.wait({ subagentIds: [subagentId] })

      const restored = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL), workspaceRoot: workspace })
      await restored.followup({ subagentId, message: 'continue from the prior conclusion' })
      const [result] = await restored.wait({ subagentIds: [subagentId] })

      expect(bind).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: subagentId }))
      expect(prompt).toHaveBeenLastCalledWith({ sessionId: subagentId, message: 'continue from the prior conclusion' })
      expect(result.state).toBe('returned')
      expect(result.result?.findings).toEqual([{ raw: 'resumed conclusion' }])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('binds the child with the parent authority + inherited ceiling, explore profile and SKILL-derived sessionId', async () => {
    const { runtime, bind } = makeRuntime()
    const assets = makeAssets(SKILL)
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: assets })

    await registry.spawn({ role: 'evidence-specialist', task: 't' })

    expect(assets.readText).toHaveBeenCalledWith('subagents/evidence-specialist/SKILL.md')
    expect(bind).toHaveBeenCalledTimes(1)
    const input = bind.mock.calls[0][0]
    expect(input.workspaceId).toBe('ws-1')
    // Delegation monotonicity: the child never re-resolves its own authority —
    // it inherits the parent's authority label and its FROZEN ceiling verbatim,
    // and its approval cards surface on the parent's stream.
    expect(input.authority).toBe('ask')
    expect(input.delegation).toEqual({
      permissionCeiling: PARENT.permissionCeiling,
      approvalPresenterSessionId: 'parent-1',
    })
    expect(input.mindset).toBe('explorer')
    expect(input.model).toEqual({ providerId: 'test', modelId: 'test-model' })
    expect(input.toolAllowlist).toEqual([
      'read', 'grep', 'find', 'ls', 'bash', 'skill.read',
      'uniprot.query', 'runs.fetchFile',
    ])
    expect(input.agentTools.workflow).toBe(false)
    expect(input.agentTools.runControl).toBe(false)
    expect(input.agentTools.workspaceWrite).toBe(false)
    expect(input.agentTools.shell).toBe(true)
    expect(input.agentTools.runObservation).toBe(true)
  })

  it('injects the assembled base + role system prompt into the child bind', async () => {
    const { runtime, bind } = makeRuntime()
    const assets = {
      readText: vi.fn(async (relative: string) => {
        if (relative === 'prompts/internal/subagent_base.md') return '# Base\nSubagent operating contract'
        return `---
name: discovery-specialist
allowed_tool_refs:
  - read
system_prompt: "You are the discovery specialist. Triage the residual table."
---`
      }),
      listFiles: vi.fn(async () => []),
      resolvePath: vi.fn(async () => '/tmp'),
    }
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: assets })

    await registry.spawn({ role: 'discovery-specialist', task: 'triage priority.csv' })

    expect(assets.readText).toHaveBeenCalledWith('prompts/internal/subagent_base.md')
    const input = bind.mock.calls[0][0]
    // base fragment + role-specific system_prompt, assembled in one string.
    expect(input.systemPromptOverride).toBe(
      '# Base\nSubagent operating contract\n\nYou are the discovery specialist. Triage the residual table.',
    )
  })

  it('degrades to the role prompt alone when the base fragment is unreadable', async () => {
    const { runtime, bind } = makeRuntime()
    const assets = {
      readText: vi.fn(async (relative: string) => {
        if (relative === 'prompts/internal/subagent_base.md') throw new Error('base missing')
        return `---
name: evidence-specialist
allowed_tool_refs:
  - read
system_prompt: "You are the evidence specialist."
---`
      }),
      listFiles: vi.fn(async () => []),
      resolvePath: vi.fn(async () => '/tmp'),
    }
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: assets })

    await registry.spawn({ role: 'evidence-specialist', task: 'validate' })

    // The spawn still succeeds and the child keeps its role prompt.
    expect(bind).toHaveBeenCalledTimes(1)
    expect(bind.mock.calls[0][0].systemPromptOverride).toBe('You are the evidence specialist.')
  })

  it('a generic child gets the base contract alone, no role prompt', async () => {
    const { runtime, bind } = makeRuntime()
    const assets = {
      readText: vi.fn(async (relative: string) => (relative === 'prompts/internal/subagent_base.md' ? '# Base\nSubagent operating contract' : '')),
      listFiles: vi.fn(async () => []),
      resolvePath: vi.fn(async () => '/tmp'),
    }
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: assets })

    await registry.spawn({ role: 'generic', task: 'one-off' })

    expect(bind.mock.calls[0][0].systemPromptOverride).toBe('# Base\nSubagent operating contract')
  })

  it('keeps named specialists fresh even when the caller requests a fork', async () => {
    const { runtime, fork } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    await registry.spawn({ role: 'evidence-specialist', task: 'validate', context: 'fork' })
    expect(fork).not.toHaveBeenCalled()
  })

  it('allows an explicit generic continuation to fork the parent transcript', async () => {
    const { runtime, fork } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    await registry.spawn({ role: 'generic', task: 'continue', context: 'fork' })
    expect(fork).toHaveBeenCalledWith(PARENT.sessionId, expect.stringMatching(/^sub_generic_/))
  })

  it('parses the child final message as the §6 result envelope on settle', async () => {
    const events = [messageCompleted(JSON.stringify({
      findings: [{ candidate: 'Bromo', verdict: 'supported' }],
      evidenceLinks: [{ kind: 'unimod', id: 'UNIMOD:340', label: 'Bromo' }],
      confidence: 'medium',
      openQuestions: ['Y88 vs Y98'],
    }))]
    const { runtime } = makeRuntime({ events: async () => events })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })

    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'validate' })
    await flush()

    const status = await registry.status(subagentId)
    expect(status.state).toBe('returned')
    expect(status.result?.confidence).toBe('medium')
    expect(status.result?.findings).toEqual([{ candidate: 'Bromo', verdict: 'supported' }])
    expect(status.result?.evidenceLinks).toEqual([{ kind: 'unimod', id: 'UNIMOD:340', label: 'Bromo' }])
    expect(status.result?.openQuestions).toEqual(['Y88 vs Y98'])
  })

  it('keeps a raw non-JSON child conclusion instead of dropping it', async () => {
    const { runtime } = makeRuntime({ events: async () => [messageCompleted('no support for Y88')] })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })

    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'validate' })
    await flush()

    const status = await registry.status(subagentId)
    expect(status.state).toBe('returned')
    expect(status.result?.findings).toEqual([{ raw: 'no support for Y88' }])
    expect(status.result?.confidence).toBe('low')
  })

  it('cancel aborts and disposes a running child, settling as cancelled with partial result', async () => {
    let settle!: (value: AgentBridgeResult<PromptResult>) => void
    const pending = new Promise<AgentBridgeResult<PromptResult>>((resolve) => { settle = resolve })
    const { runtime, abort, dispose } = makeRuntime({
      prompt: () => pending,
      events: async () => [messageCompleted('partial finding')],
    })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })

    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'long task' })
    const cancelled = await registry.cancel(subagentId)

    expect(cancelled.ok).toBe(true)
    expect(abort).toHaveBeenCalledWith(subagentId)
    expect(dispose).toHaveBeenCalledWith(subagentId)

    const status = await registry.status(subagentId)
    expect(status.state).toBe('cancelled')
    expect(status.result?.findings).toEqual([{ raw: 'partial finding' }])

    // A cancelled settle is never silently rewritten to success by the settle.
    settle(resolvedPrompt())
    await flush()
    const after = await registry.status(subagentId)
    expect(after.state).toBe('cancelled')
  })

  it('settles as blocked on a failed bind', async () => {
    const bind = vi.fn(async (): Promise<AgentBridgeResult<BoundSession>> => ({ ok: false, code: 'AGENT_BIND_FAILED', message: 'bad', retryable: false }))
    const runtime: SubagentRuntime = {
      bindSession: bind, prompt: vi.fn(), readSessionEvents: vi.fn(), abort: vi.fn(), dispose: vi.fn(), fork: vi.fn(),
    }
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })

    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 't' })
    const status = await registry.status(subagentId)
    expect(status.state).toBe('blocked')
    expect(status.error?.code).toBe('SUBAGENT_BIND_FAILED')
  })

  it('rejects an unknown role before binding anything', async () => {
    const assets = {
      readText: vi.fn(async () => { throw new Error('not found') }),
      listFiles: vi.fn(async () => []),
      resolvePath: vi.fn(async () => '/tmp'),
    }
    const { runtime, bind } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: assets })

    await expect(registry.spawn({ role: 'no-such-role', task: 't' })).rejects.toThrow(/Unknown subagent role/)
    expect(bind).not.toHaveBeenCalled()
  })

  it('status/cancel reject an unknown subagentId', async () => {
    const { runtime } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    await expect(registry.status('sub_nope_1')).rejects.toThrow(/No subagent run/)
    await expect(registry.cancel('sub_nope_1')).rejects.toThrow(/No subagent run/)
  })
})

describe('subagent-registry drainSettled (spawn-without-wait injection)', () => {
  // The §6 envelope a settled child returns via its final assistant message.
  const ENVELOPE = JSON.stringify({
    findings: [{ raw: 'scan 1164 validated as carbamidomethyl' }],
    confidence: 'high',
    evidenceLinks: [{ kind: 'unimod', label: 'Carbamidomethyl [M+57]' }],
    openQuestions: [],
  })

  function makeSettledRegistry() {
    const { runtime } = makeRuntime({ events: async () => [messageCompleted(ENVELOPE)] })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    return { runtime, registry }
  }

  it('drainSettled returns a fire-and-forget child exactly once with its §6 result', async () => {
    const { registry } = makeSettledRegistry()
    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'validate 1164' })
    await flush() // let the background settle finish

    const first = registry.drainSettled()
    expect(first).toHaveLength(1)
    expect(first[0].subagentId).toBe(subagentId)
    expect(first[0].state).toBe('returned')
    expect(first[0].result?.confidence).toBe('high')
    expect(first[0].result?.findings).toHaveLength(1)

    // Second drain is empty — the child was marked notified.
    expect(registry.drainSettled()).toHaveLength(0)
  })

  it('a child collected via wait is not re-injected by drainSettled', async () => {
    const { registry } = makeSettledRegistry()
    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'validate 1164' })
    // wait hands the result to the model directly (it blocks until settled).
    const waited = await registry.wait({ subagentIds: [subagentId], all: true })
    expect(waited).toHaveLength(1)
    expect(waited[0].state).toBe('returned')

    // drainSettled must stay empty — the model already consumed this result.
    expect(registry.drainSettled()).toHaveLength(0)
  })

  it('status marks a settled child notified so it is not re-injected', async () => {
    const { registry } = makeSettledRegistry()
    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'validate 1164' })
    await flush()
    const read = await registry.status(subagentId)
    expect(read.state).toBe('returned')
    expect(registry.drainSettled()).toHaveLength(0)
  })

  it('followup re-runs a child and drainSettled announces the new completion', async () => {
    const { registry } = makeSettledRegistry()
    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'validate 1164' })
    await flush()
    expect(registry.drainSettled()).toHaveLength(1) // first completion announced

    await registry.followup({ subagentId, message: 're-check with MS2' })
    await flush() // re-run settles
    const second = registry.drainSettled()
    expect(second).toHaveLength(1)
    expect(second[0].subagentId).toBe(subagentId)
    expect(second[0].state).toBe('returned')
  })
})

describe('parseFrontmatter', () => {
  it('extracts allowed_tool_refs', () => {
    expect(parseFrontmatter(SKILL)).toEqual({
      allowedToolRefs: ['uniprot.query', 'runs.fetchFile', 'read'],
      toolProfile: 'explore',
    })
  })

  it('is empty for a role with no frontmatter', () => {
    expect(parseFrontmatter('# no frontmatter')).toEqual({ allowedToolRefs: [], toolProfile: 'explore' })
  })

  it('extracts system_prompt with escaped quotes intact', () => {
    const skill = `---
name: discovery-specialist
system_prompt: "You are a specialist. Query UniMod kind:\\"solveMass\\" for combinations; do NOT guess."
---
`
    expect(parseFrontmatter(skill)).toEqual({
      allowedToolRefs: [],
      toolProfile: 'explore',
      systemPrompt: 'You are a specialist. Query UniMod kind:"solveMass" for combinations; do NOT guess.',
    })
  })

  it('extracts a role-specific thinking level', () => {
    expect(parseFrontmatter('---\nallowed_tool_refs:\n  - read\nthinking_level: low\n---')).toEqual({
      allowedToolRefs: ['read'], toolProfile: 'explore', thinkingLevel: 'low',
    })
  })

  it('extracts inline allowed_tool_refs used by role Skills', () => {
    expect(parseFrontmatter('---\nallowed_tool_refs: [read, bash]\n---')).toEqual({
      allowedToolRefs: ['read', 'bash'], toolProfile: 'explore',
    })
  })

  it('recognizes the general default profile', () => {
    expect(parseFrontmatter('---\nsubagent_profile: general\n---')).toEqual({
      allowedToolRefs: [], toolProfile: 'general',
    })
  })
})

describe('narrowAgentTools', () => {
  it('keeps only the buckets the allowlist grants', () => {
    const narrowed = narrowAgentTools(['spectra.query', 'runs.fetchFile', 'read'], PARENT_TOOLS)
    expect(narrowed.workflow).toBe(false)
    expect(narrowed.runControl).toBe(false)
    expect(narrowed.shell).toBe(false)
    expect(narrowed.runObservation).toBe(true)
    expect(narrowed.mcp).toBe(false)
  })

  it('a named role receives the fixed explore profile by default', async () => {
    const { runtime, bind } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    await registry.spawn({ role: 'evidence-specialist', task: 't' })
    const input = bind.mock.calls[0][0]
    expect(input.agentTools.workspaceWrite).toBe(false)
    expect(input.agentTools.workflow).toBe(false)
    expect(input.agentTools.runControl).toBe(false)
    expect(input.agentTools.shell).toBe(true)
    expect(input.toolAllowlist).toContain('skill.read')
  })

  it('an explicit spawn-time toolAllowlist narrows against the parent profile', async () => {
    const { runtime, bind } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    await registry.spawn({ role: 'evidence-specialist', task: 't', toolAllowlist: ['workflow.run', 'bash'] })
    const input = bind.mock.calls[0][0]
    expect(input.agentTools.workflow).toBe(false)
    expect(input.agentTools.shell).toBe(true)
    expect(input.agentTools.runObservation).toBe(false)
    expect(input.toolAllowlist).toEqual(['bash'])
  })

  it('general adds Workspace write without management tools', async () => {
    const skill = SKILL.replace('description: test fixture', 'description: test fixture\nsubagent_profile: general')
    const { runtime, bind } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(skill) })
    await registry.spawn({ role: 'general-worker', task: 't' })
    const input = bind.mock.calls[0][0]
    expect(input.agentTools.workspaceWrite).toBe(true)
    expect(input.toolAllowlist).toEqual(expect.arrayContaining(['write', 'edit', 'bash', 'skill.read']))
    expect(input.agentTools.workflow).toBe(false)
    expect(input.agentTools.runControl).toBe(false)
  })
})

describe('parseResult', () => {
  it('falls back to a low-confidence raw finding for prose', () => {
    expect(parseResult('prose conclusion', 'sub_x', 'r')).toEqual({
      subagentId: 'sub_x', role: 'r', findings: [{ raw: 'prose conclusion' }], evidenceLinks: [], confidence: 'low', openQuestions: [],
    })
  })

  it('returns the empty envelope for no content', () => {
    expect(parseResult(undefined, 'sub_x', 'r')).toEqual({
      subagentId: 'sub_x', role: 'r', findings: [], evidenceLinks: [], confidence: 'low', openQuestions: [],
    })
  })

  it('parses a JSON envelope wrapped in a prose + ```json fence', () => {
    const content = 'Here is the result:\n```json\n{"findings":["Bromo supported"],' +
      '"evidenceLinks":[{"kind":"unimod","id":"UNIMOD:340","label":"Bromo"}],' +
      '"confidence":"high","openQuestions":["site not localized"]}\n```\nThe evidence is recorded.'
    const result = parseResult(content, 'sub_x', 'r')
    expect(result.confidence).toBe('high')
    expect(result.findings).toEqual(['Bromo supported'])
    expect(result.evidenceLinks).toEqual([{ kind: 'unimod', id: 'UNIMOD:340', label: 'Bromo' }])
    expect(result.openQuestions).toEqual(['site not localized'])
  })

  it('parses a bare JSON envelope (no fence)', () => {
    const content = JSON.stringify({ findings: ['x'], evidenceLinks: [], confidence: 'medium', openQuestions: [] })
    const result = parseResult(content, 'sub_x', 'r')
    expect(result.confidence).toBe('medium')
    expect(result.findings).toEqual(['x'])
  })

  it('carries a role-defined terminal state through the envelope', () => {
    const content = JSON.stringify({ findings: ['Bromo supported'], evidenceLinks: [], confidence: 'high', openQuestions: [], state: 'partially_resolved' })
    const result = parseResult(content, 'sub_x', 'r')
    expect(result.state).toBe('partially_resolved')
  })

  it('preserves a per-event envelope instead of parsing it into empty findings (harness_5a5857d4)', () => {
    // massshift-deepresearch emits ONE state/status/confidence triple per
    // event under `events`. The old parser accepted the JSON but found no
    // top-level `findings`, so 128 tool calls of real work reached the parent
    // as findings:[].
    const content = 'Summary prose.\n```json\n' + JSON.stringify({
      skill: 'system:massshift-deepresearch',
      run: 'runs/histone48-mouse',
      events: [
        {
          assignment_id: 'M98b108484a07:F10',
          state: 'evidence_assigned',
          status: 1,
          confidence: 'high',
          findings: ['Oxidation on M59, c59+16 observed'],
          evidenceLinks: [{ kind: 'file', path: 'runs/r/analysis/z/deep/F10/verdict.json', label: 'verdict' }],
        },
        {
          assignment_id: 'M00b45a54281a:F635',
          state: 'unexplained',
          status: 4,
          confidence: 'medium',
          findings: ['no plausible composition'],
          openQuestions: ['diagnostic MS2 needed'],
        },
      ],
    }) + '\n```'
    const result = parseResult(content, 'sub_x', 'massshift-deepresearch')
    expect(result.findings).toHaveLength(2)
    expect((result.findings[0] as Record<string, unknown>).assignment_id).toBe('M98b108484a07:F10')
    expect((result.findings[0] as Record<string, unknown>).state).toBe('evidence_assigned')
    expect((result.findings[1] as Record<string, unknown>).status).toBe(4)
    // Per-event evidence links and open questions merge upward; confidence
    // rolls up to the strongest event.
    expect(result.evidenceLinks).toEqual([{ kind: 'file', path: 'runs/r/analysis/z/deep/F10/verdict.json', label: 'verdict' }])
    expect(result.openQuestions).toEqual(['diagnostic MS2 needed'])
    expect(result.confidence).toBe('high')
  })

  it('accepts the other natural per-event wrappings: {envelopes:[...]} and a bare array (harness_f4beccd3)', () => {
    // Real production shapes: one child emitted {"envelopes":[...]}, another
    // pasted the bare array in a ```json fence. Both must arrive structured.
    const envelopes = 'Done.\n```json\n{"envelopes":[' +
      '{"assignment_id":"M8376552229c6:F72","state":"unexplained","status":"3","confidence":"medium","findings":["mass closure fails for every candidate"]},' +
      '{"assignment_id":"M4edc701cacf0:F65","state":"ambiguous","status":"2B","confidence":"medium","findings":["isobaric"]}' +
      ']}\n```'
    const viaEnvelopes = parseResult(envelopes, 'sub_x', 'massshift-deepresearch')
    expect(viaEnvelopes.findings).toHaveLength(2)
    expect((viaEnvelopes.findings[0] as Record<string, unknown>).assignment_id).toBe('M8376552229c6:F72')
    expect(viaEnvelopes.confidence).toBe('medium')

    const bare = 'Summary prose.\n```json\n[' +
      '{"assignment_id":"M3bd122133de2:F4516","state":"unexplained","status":"3","confidence":"medium","findings":["no composition"]}' +
      ']\n```'
    const viaArray = parseResult(bare, 'sub_x', 'massshift-deepresearch')
    expect(viaArray.findings).toHaveLength(1)
    expect((viaArray.findings[0] as Record<string, unknown>).state).toBe('unexplained')
  })

  it('omits the state field when the envelope has none', () => {
    const result = parseResult(JSON.stringify({ findings: ['x'], evidenceLinks: [], confidence: 'low', openQuestions: [] }), 'sub_x', 'r')
    expect(result.state).toBeUndefined()
  })

  it('coerces a bare path string in evidenceLinks into a file link', () => {
    const content = JSON.stringify({
      findings: ['scan 1164 supports bromo'],
      evidenceLinks: ['runs/sample/analysis/dr-F103/findings.md'],
      confidence: 'medium',
      openQuestions: [],
    })
    const result = parseResult(content, 'sub_x', 'r')
    expect(result.evidenceLinks).toEqual([
      { kind: 'file', label: 'runs/sample/analysis/dr-F103/findings.md', path: 'runs/sample/analysis/dr-F103/findings.md' },
    ])
  })

  it('keeps an explicit workspace path on a structured evidenceLink', () => {
    const content = JSON.stringify({
      findings: ['bromo localized to C77'],
      evidenceLinks: [{ kind: 'file', label: 'Findings', path: 'runs/sample/analysis/dr-F103/findings.md' }],
      confidence: 'high',
      openQuestions: [],
    })
    const result = parseResult(content, 'sub_x', 'r')
    expect(result.evidenceLinks).toEqual([
      { kind: 'file', label: 'Findings', path: 'runs/sample/analysis/dr-F103/findings.md' },
    ])
  })

  it('caps findings/evidenceLinks/openQuestions by count and flags truncated', () => {
    const findings = Array.from({ length: 30 }, (_, i) => ({ candidate: `candidate-${i}` }))
    const evidenceLinks = Array.from({ length: 60 }, (_, i) => ({ kind: 'unimod', id: `U:${i}`, label: `L${i}` }))
    const openQuestions = Array.from({ length: 20 }, (_, i) => `q${i}`)
    const result = parseResult(JSON.stringify({ findings, evidenceLinks, confidence: 'high', openQuestions }), 'sub_x', 'r')
    expect(result.findings).toHaveLength(24)
    expect(result.evidenceLinks).toHaveLength(48)
    expect(result.openQuestions).toHaveLength(16)
    expect(result.truncated).toBe(true)
  })

  it('clamps an over-long raw conclusion instead of carrying the whole blast', () => {
    const result = parseResult('x'.repeat(5000), 'sub_x', 'r')
    const raw = (result.findings[0] as { raw: string }).raw
    expect(raw.length).toBeLessThan(1500)
    expect(raw).toContain('[+')
    // count was not exceeded — only the string was clamped, so no `truncated`
    // flag is attached (it is an optional field, present only when capped).
    expect(result.truncated).toBeUndefined()
  })
})

// ── Phase A2 capabilities: parallel groups, persistence, discovery, peek ─────

describe('subagent-registry Phase A2 (parallel / persist / discovery / peek)', () => {
  it('spawnGroup spawns N children sharing one groupId', async () => {
    // Pending prompt so children stay running while the test inspects them.
    const pending = new Promise<AgentBridgeResult<PromptResult>>(() => {})
    const { runtime } = makeRuntime({ prompt: () => pending })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })

    const result = await registry.spawnGroup({
      tasks: [
        { role: 'evidence-specialist', task: 'validate A' },
        { role: 'evidence-specialist', task: 'validate B' },
        { role: 'evidence-specialist', task: 'validate C' },
      ],
    })
    expect(result.subagentIds).toHaveLength(3)
    expect(result.groupId).toMatch(/^grp_/)
    // Every child carries the same groupId and is still running.
    for (const id of result.subagentIds) {
      const status = await registry.status(id)
      expect(status.groupId).toBe(result.groupId)
      expect(status.state).toBe('running')
    }
  })

  it('persists records to disk and restores them on re-bind (running → orphaned)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'subagent-persist-'))
    try {
      // Pending prompt keeps the child running so the persisted record is in
      // the running state when the second registry restores it.
      const pending = new Promise<AgentBridgeResult<PromptResult>>(() => {})
      const { runtime } = makeRuntime({ prompt: () => pending })
      const r1 = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL), workspaceRoot: workspace })
      const { subagentId } = await r1.spawn({ role: 'evidence-specialist', task: 't' })

      // The persist dir under the parent session holds one JSON file per run,
      // written on the spawn emitChange. The record is running.
      const persistDir = join(workspace, '.tdease', 'sessions', PARENT.sessionId, 'subagents')
      const written = JSON.parse(readFileSync(join(persistDir, `${subagentId}.json`), 'utf8'))
      expect(written.state).toBe('running')

      // Second registry (simulating a re-bind after process restart): restores
      // history. The in-process child is gone, so the running record is marked
      // blocked + SUBAGENT_ORPHANED, but the record survives.
      const r2 = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL), workspaceRoot: workspace })
      const restored = r2.list().find((s) => s.subagentId === subagentId)
      expect(restored).toBeDefined()
      expect(restored!.state).toBe('blocked')
      expect(restored!.error?.code).toBe('SUBAGENT_ORPHANED')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('listAgents discovers roles from systemAssets and parses description/defaultContext', async () => {
    const assets = {
      readText: vi.fn(async (relative: string) => {
        if (relative.endsWith('discovery-specialist/SKILL.md')) {
          return '---\nname: discovery-specialist\ndescription: Triage the residual table.\ndefaultContext: fork\n---\n# body'
        }
        return '---\nname: evidence-specialist\ndescription: Validate one candidate.\n---\n# body'
      }),
      listFiles: vi.fn(async (rel: string) => {
        // listFiles returns paths RELATIVE to the queried root (no leading
        // prefix) — mirror the real catalog, not a prefixed shorthand.
        if (rel === 'subagents') return ['discovery-specialist/SKILL.md', 'evidence-specialist/SKILL.md']
        return []
      }),
      resolvePath: vi.fn(async () => '/tmp'),
    }
    const { runtime } = makeRuntime()
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: assets })
    const agents = await registry.listAgents()
    expect(agents.map((a) => a.name).sort()).toEqual(['discovery-specialist', 'evidence-specialist'])
    const discovery = agents.find((a) => a.name === 'discovery-specialist')
    expect(discovery?.description).toBe('Triage the residual table.')
    expect(discovery?.defaultContext).toBe('fork')
  })

  it('peek tails a child recent tools and last assistant snippet', async () => {
    const events: SessionEvent[] = [
      { seq: 1, type: 'tool.requested', turn_id: 't1', name: 'tdease.spectra.query' } as SessionEvent,
      { seq: 2, type: 'tool.requested', turn_id: 't1', name: 'tdease.unimod.query' } as SessionEvent,
      { seq: 3, type: 'message.completed', turn_id: 't1', role: 'assistant', content: 'Bromo is supported at high confidence.' } as SessionEvent,
    ]
    const { runtime } = makeRuntime({ events: async () => events })
    const registry = createSubagentRegistry({ runtime, parent: PARENT, systemAssets: makeAssets(SKILL) })
    const { subagentId } = await registry.spawn({ role: 'evidence-specialist', task: 'validate' })

    const peek = await registry.peek(subagentId)
    expect(peek.recentTools).toContain('tdease.spectra.query')
    expect(peek.recentTools).toContain('tdease.unimod.query')
    expect(peek.lastAssistantSnippet).toContain('Bromo is supported')
  })
})
