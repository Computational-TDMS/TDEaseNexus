import { describe, expect, it, vi } from 'vitest'

import {
  createProducedPathLedger,
  createTDEaseExtension,
  type ActiveAgentRun,
  type ProducedPathLedger,
  type TDEaseExtensionOptions,
} from './tdease-extension'

/**
 * The tool_result hook is where a successful `tdease.session.reportBlocked`
 * call becomes a fact on the active run — the fact SessionHost later reads to
 * settle the turn as `blocked`. These tests pin that recording, including the
 * failure case: a rejected reportBlocked must NOT block the turn.
 */

interface HookRig {
  handlers: Map<string, (event: never) => unknown>
  run: ActiveAgentRun
}

function makeRig(extra?: {
  producedPaths?: ProducedPathLedger
}): HookRig {
  const handlers = new Map<string, (event: never) => unknown>()
  const run: ActiveAgentRun = {
    definition: {
      turnId: 'turn-1',
      userMessage: 'go',
      mindset: 'explorer',
      budgets: { wallClockMs: 1_000 },
      referencedAssetsDigest: 'digest',
      initialModel: { providerId: 'provider', modelId: 'model' },
      initialThinkingLevel: 'off',
    } as ActiveAgentRun['definition'],
    prompt: { systemPrompt: 'system', digest: 'digest', fragments: [] },
    requestSeq: 0,
    toolCalls: 0,
    blocked: null,
  }
  const options: TDEaseExtensionOptions = {
    binding: { sessionId: 'session', permissionCeiling: {} } as TDEaseExtensionOptions['binding'],
    store: {} as never,
    prompt: {
      snapshotProviderRequest: (turnId: string, requestSeq: number) => ({
        turnId,
        requestSeq,
        systemPromptDigest: 'digest',
        contextDigest: 'digest',
        activeToolsDigest: 'digest',
        thinkingLevel: 'off',
        model: { providerId: 'provider', modelId: 'model' },
      }),
    } as never,
    approvals: {} as never,
    observers: { auditTool: vi.fn() } as never,
    activeRun: () => run,
    activeModel: () => ({ providerId: 'provider', modelId: 'model' }),
    activeThinkingLevel: () => 'off',
    actionForTool: () => undefined,
    isBlockedReport: (name) => name === 'tdease.session.reportBlocked',
    isTodoWrite: (name) => name === 'todo_write',
    append: vi.fn(async () => undefined),
    ambient: {
      drainSettledJobs: () => [],
      drainSettledSubagents: () => [],
      drainSettledRuns: () => [],
      ...(extra?.producedPaths ? { producedPaths: extra.producedPaths } : {}),
    },
  }
  createTDEaseExtension(options)({
    on: (name: string, handler: never) => void handlers.set(name, handler),
    getActiveTools: () => [],
  } as never)
  return { handlers, run }
}

/**
 * Rig whose approval action maps a tool to 'ask' so the tool_call hook reaches
 * approvals.request. `approvals.request` is spied so the test can assert the
 * tool's input is forwarded as the 4th argument — the data the approval UI
 * needs to show what shell command is about to run.
 */
function makeApprovalRig(): {
  handlers: Map<string, (event: never) => unknown>
  approvalsRequest: ReturnType<typeof vi.fn>
} {
  const handlers = new Map<string, (event: never) => unknown>()
  const run: ActiveAgentRun = {
    definition: {
      turnId: 'turn-1',
      userMessage: 'go',
      mindset: 'explorer',
      budgets: { wallClockMs: 1_000 },
      referencedAssetsDigest: 'digest',
      initialModel: { providerId: 'provider', modelId: 'model' },
      initialThinkingLevel: 'off',
    } as ActiveAgentRun['definition'],
    prompt: { systemPrompt: 'system', digest: 'digest', fragments: [] },
    requestSeq: 0,
    toolCalls: 0,
    blocked: null,
  }
  const approvalsRequest = vi.fn(async () => 'allow' as const)
  const hasSessionGrant = vi.fn(() => false)
  const options: TDEaseExtensionOptions = {
    binding: { sessionId: 'session', permissionCeiling: { 'shell.exec': 'ask' } } as TDEaseExtensionOptions['binding'],
    store: {} as never,
    prompt: {} as never,
    approvals: { request: approvalsRequest, resolve: vi.fn(), cancelSession: vi.fn(), hasSessionGrant, sessionRulesFor: () => [] } as never,
    observers: { auditTool: vi.fn() } as never,
    activeRun: () => run,
    activeModel: () => ({ providerId: 'provider', modelId: 'model' }),
    activeThinkingLevel: () => 'off',
    actionForTool: (name) => (name === 'tdease.bash' ? 'shell.exec' : undefined),
    isBlockedReport: () => false,
    isTodoWrite: () => false,
    append: vi.fn(async () => undefined),
    ambient: { drainSettledJobs: () => [], drainSettledSubagents: () => [], drainSettledRuns: () => [] },
  }
  createTDEaseExtension(options)({ on: (name: string, handler: never) => void handlers.set(name, handler) } as never)
  return { handlers, approvalsRequest, hasSessionGrant }
}

function toolResult(overrides: Record<string, unknown>) {
  return {
    toolCallId: 'call-1',
    toolName: 'tdease.session.reportBlocked',
    isError: false,
    input: { reason: 'no fasta reference found', needed: 'a fasta file in the Workspace' },
    content: [],
    details: {},
    ...overrides,
  } as never
}

describe('TDEaseExtension reportBlocked recording', () => {
  it('records the reason and needed input on the active run after a successful call', async () => {
    const { handlers, run } = makeRig()
    await handlers.get('tool_result')!(toolResult({}))
    expect(run.blocked).toEqual({
      reason: 'no fasta reference found',
      needed: 'a fasta file in the Workspace',
    })
  })

  it('does not settle the turn as blocked when the tool call failed', async () => {
    const { handlers, run } = makeRig()
    await handlers.get('tool_result')!(toolResult({ isError: true }))
    expect(run.blocked).toBeNull()
  })

  it('ignores other tools', async () => {
    const { handlers, run } = makeRig()
    await handlers.get('tool_result')!(toolResult({ toolName: 'tdease.runs.list' }))
    expect(run.blocked).toBeNull()
  })
})

describe('TDEaseExtension approval request', () => {
  it('forwards the tool input as args so the approval UI can show it', async () => {
    const { handlers, approvalsRequest } = makeApprovalRig()

    const result = await handlers.get('tool_call')!({
      toolCallId: 'call-9',
      toolName: 'tdease.bash',
      input: { command: 'pnpm test', cwd: '/repo' },
    } as never)

    expect(approvalsRequest).toHaveBeenCalledTimes(1)
    // (sessionId, action, basis, args)
    const [, action, , args] = approvalsRequest.mock.calls[0]
    expect(action).toBe('shell.exec')
    expect(args).toEqual({ command: 'pnpm test', cwd: '/repo' })
    // The hook awaited the approval and let the call proceed.
    expect(result).toBeUndefined()
  })

  it('skips the prompt when a session grant already covers the action', async () => {
    const { handlers, approvalsRequest, hasSessionGrant } = makeApprovalRig()
    // The user already said "Allow for this session" for shell.exec this turn.
    hasSessionGrant.mockReturnValue(true)

    const result = await handlers.get('tool_call')!({
      toolCallId: 'call-10',
      toolName: 'tdease.bash',
      input: { command: 'pnpm test', cwd: '/repo' },
    } as never)

    // No approval requested — the grant settled it. The call proceeds.
    expect(approvalsRequest).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })
})

describe('TDEaseExtension tool-loop guard', () => {
  it('audits a non-zero bash exit as a failed tool result', async () => {
    const { handlers } = makeRig()
    const failed = { toolCallId: 'bash-1', toolName: 'bash', input: { command: 'false' } } as never
    await handlers.get('tool_call')!(failed)
    await handlers.get('tool_result')!(toolResult({
      ...failed,
      isError: false,
      details: { exitCode: 1 },
      content: [{ type: 'text', text: '[exit code: 1]' }],
    }))
    expect(await handlers.get('tool_call')!({ ...failed, toolCallId: 'bash-2' } as never)).toMatchObject({ block: true })
  })

  it('blocks an exact successful call instead of spending another tool invocation', async () => {
    const { handlers } = makeRig()
    const first = { toolCallId: 'query-1', toolName: 'tdease.unimod.query', input: { kind: 'search', mass: 14 } } as never
    await handlers.get('tool_call')!(first)
    await handlers.get('tool_result')!(toolResult({ ...first, isError: false }))

    const repeated = await handlers.get('tool_call')!({ ...first, toolCallId: 'query-2' } as never)
    expect(repeated).toMatchObject({ block: true })
  })

  it('lets a repeated successful poll through — its result changed since the last read', async () => {
    const { handlers } = makeRig()
    const first = { toolCallId: 'status-1', toolName: 'tdease.job.status', input: { jobId: 'job_1' } } as never
    await handlers.get('tool_call')!(first)
    await handlers.get('tool_result')!(toolResult({ ...first, isError: false }))

    expect(await handlers.get('tool_call')!({ ...first, toolCallId: 'status-2' } as never)).toBeUndefined()
  })

  it('resets the call ledger for the next Agent turn', async () => {
    const { handlers } = makeRig()
    const call = { toolCallId: 'query-1', toolName: 'tdease.unimod.query', input: { kind: 'search', mass: 14 } } as never
    await handlers.get('tool_call')!(call)
    await handlers.get('tool_result')!(toolResult({ ...call, isError: false }))
    await handlers.get('before_agent_start')!({} as never)

    expect(await handlers.get('tool_call')!({ ...call, toolCallId: 'query-2' } as never)).toBeUndefined()
  })

  it('blocks a repeated non-transient failure but leaves a timeout retryable', async () => {
    const { handlers } = makeRig()
    const failed = { toolCallId: 'status-1', toolName: 'tdease.runs.status', input: { runId: 'missing' } } as never
    await handlers.get('tool_call')!(failed)
    await handlers.get('tool_result')!(toolResult({ ...failed, isError: true, content: [{ type: 'text', text: 'Run not found' }] }))
    expect(await handlers.get('tool_call')!({ ...failed, toolCallId: 'status-2' } as never)).toMatchObject({ block: true })

    const retryable = { toolCallId: 'query-timeout-1', toolName: 'tdease.unimod.query', input: { kind: 'search', mass: 25 } } as never
    await handlers.get('tool_call')!(retryable)
    await handlers.get('tool_result')!(toolResult({ ...retryable, isError: true, content: [{ type: 'text', text: 'temporary network timeout' }] }))
    expect(await handlers.get('tool_call')!({ ...retryable, toolCallId: 'query-timeout-2' } as never)).toBeUndefined()
  })

  it('allows native capability calls through the bash tool', async () => {
    const { handlers } = makeRig()
    const result = await handlers.get('tool_call')!({
      toolCallId: 'native-cli-1',
      toolName: 'bash',
      input: { command: 'tdeasenexus-toolbox unimod-search --mass 317.102 --tolerance 0.1' },
    } as never)

    expect(result).toBeUndefined()
  })

  it('allows a pure `which tdeasenexus-toolbox` probe — it resolves without executing', async () => {
    const { handlers } = makeRig()
    const result = await handlers.get('tool_call')!({
      toolCallId: 'probe-1',
      toolName: 'bash',
      input: { command: 'which tdeasenexus-toolbox 2>/dev/null' },
    } as never)

    expect(result).toBeUndefined()
  })

  it('does not impose scientific file-reading policy on assignment checklists', async () => {
    const { handlers } = makeRig()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'checklist-read', toolName: 'read',
      input: { path: 'runs/sample/analysis/open/assignment-checklist.csv' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'checklist-shell-dump', toolName: 'bash',
      input: { command: 'head -100 runs/sample/analysis/open/assignment-checklist.csv' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'checklist-python-dump', toolName: 'bash',
      input: { command: 'python - <<\'PY\'\nfor row in rows:\n print(row)\nPY # assignment-checklist.csv' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'checklist-python-bounded', toolName: 'bash',
      input: { command: 'python - <<\'PY\'\nfor row in rows[:20]:\n print(row)\nPY # assignment-checklist.csv' },
    } as never)).toBeUndefined()
  })

  it('does not impose scientific file-reading policy on Evidence paths', async () => {
    const { handlers } = makeRig()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'evidence-list', toolName: 'ls', input: { path: 'runs/sample/evidence' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'evidence-shell-list', toolName: 'bash', input: { command: 'ls runs/sample/evidence' },
    } as never)).toBeUndefined()
  })

  it('does not classify Workspace analysis as forbidden input', async () => {
    const { handlers } = makeRig()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'analysis-list', toolName: 'ls', input: { path: 'runs/sample/analysis' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'analysis-readme', toolName: 'read', input: { path: 'runs/sample/analysis/README.md' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'historical-result', toolName: 'read', input: { path: 'runs/sample/analysis/current/result.json' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'pipeline-write', toolName: 'bash',
      input: { command: 'uv run --script proteoform_pipeline.py --out-dir runs/sample/analysis/current 2>&1 | tail -30' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'recursive-parent', toolName: 'bash',
      input: { command: 'find runs/sample -type d' },
    } as never)).toBeUndefined()
  })
})

describe('TDEaseExtension produced-path ledger', () => {
  it('does not restrict analysis navigation', async () => {
    const produced = createProducedPathLedger()
    // The pipeline wrote the task's checklist — the tool_result hook notes it.
    produced.note('runs/sample/analysis/20201107-mod-assignment/assignment-checklist.csv')
    const { handlers } = makeRig({ producedPaths: produced })

    expect(await handlers.get('tool_call')!({
      toolCallId: 'task-ls', toolName: 'ls', input: { path: 'runs/sample/analysis/20201107-mod-assignment' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'task-shell-ls', toolName: 'bash',
      input: { command: 'ls runs/sample/analysis/20201107-mod-assignment/ | head -20' },
    } as never)).toBeUndefined()
    expect(await handlers.get('tool_call')!({
      toolCallId: 'parent-ls', toolName: 'ls', input: { path: 'runs/sample/analysis' },
    } as never)).toBeUndefined()
  })

  it('does not block commands spanning analysis paths', async () => {
    const produced = createProducedPathLedger()
    produced.note('runs/sample/analysis/20201107-mod-assignment/assignment-checklist.csv')
    const { handlers } = makeRig({ producedPaths: produced })

    expect(await handlers.get('tool_call')!({
      toolCallId: 'mixed-ls', toolName: 'bash',
      input: { command: 'ls runs/sample/analysis/20201107-mod-assignment runs/other-sample/analysis' },
    } as never)).toBeUndefined()
  })

  it('notes successful write targets so their directory becomes listable', async () => {
    const produced = createProducedPathLedger()
    const { handlers } = makeRig({ producedPaths: produced })

    await handlers.get('tool_result')!(toolResult({
      toolCallId: 'write-1',
      toolName: 'write',
      input: { path: 'runs/sample/analysis/20201107-mod-assignment/dr-F103/findings.md' },
    }))
    expect(await handlers.get('tool_call')!({
      toolCallId: 'dr-ls', toolName: 'ls', input: { path: 'runs/sample/analysis/20201107-mod-assignment/dr-F103' },
    } as never)).toBeUndefined()
  })

  it('does not restrict analysis after an observed path', async () => {
    const produced = createProducedPathLedger()
    const { handlers } = makeRig({ producedPaths: produced })

    await handlers.get('tool_result')!(toolResult({
      toolCallId: 'ls-1',
      toolName: 'ls',
      input: { path: 'runs/sample' },
    }))
    expect(await handlers.get('tool_call')!({
      toolCallId: 'historical-after-ls', toolName: 'ls', input: { path: 'runs/sample/analysis' },
    } as never)).toBeUndefined()
  })
})

describe('TDEaseExtension session plan reminder', () => {
  const TWO_STEP_PLAN = { todos: [
    { content: 'Inspect files', activeForm: 'Inspecting files', status: 'completed' },
    { content: 'Build workflow', activeForm: 'Building workflow', status: 'in_progress' },
    { content: 'Submit run', activeForm: 'Submitting run', status: 'pending' },
  ] }

  async function contextMessages(handlers: Map<string, (event: never) => unknown>) {
    const result = await handlers.get('context')!({ messages: [{ role: 'user', content: 'go' }] } as never)
    return (result as { messages: Array<{ role: string; content: string }> }).messages
  }

  it('announces once per loop: the opening request pins the plan, later requests do not repeat it', async () => {
    const { handlers } = makeRig()
    await handlers.get('tool_result')!(toolResult({ toolName: 'todo_write', input: TWO_STEP_PLAN }))
    const opening = await contextMessages(handlers)
    const injected = opening.at(-1)!
    expect(injected.role).toBe('user')
    expect(injected.content).toBe('[plan] 1/3 done — in progress: Building workflow (1 pending)')
    expect(opening).toHaveLength(2)
    // Same loop, next step: no re-announcement (AGENT-LOOP.md §1 — the loop,
    // not the request, is the injection unit).
    expect(await contextMessages(handlers)).toHaveLength(1)
  })

  it('a failed todo_write leaves the previous plan intact — nothing is injected', async () => {
    const { handlers } = makeRig()
    await handlers.get('tool_result')!(toolResult({ toolName: 'todo_write', isError: true, input: TWO_STEP_PLAN }))
    expect(await contextMessages(handlers)).toHaveLength(1)
  })

  it('guides pickup when no task is in progress, and stays silent once all are complete', async () => {
    const { handlers } = makeRig()
    await handlers.get('tool_result')!(toolResult({
      toolName: 'todo_write',
      input: { todos: [
        { content: 'Inspect files', activeForm: 'Inspecting files', status: 'completed' },
        { content: 'Submit run', activeForm: 'Submitting run', status: 'pending' },
      ] },
    }))
    expect((await contextMessages(handlers)).at(-1)!.content)
      .toBe('[plan] 1/2 done — no task in progress; pick up "Submit run" and mark it in_progress with todo_write')

    // A fresh loop with every item complete stays silent — nothing to guide.
    await handlers.get('tool_result')!(toolResult({
      toolName: 'todo_write',
      input: { todos: [
        { content: 'Inspect files', activeForm: 'Inspecting files', status: 'completed' },
        { content: 'Submit run', activeForm: 'Submitting run', status: 'completed' },
      ] },
    }))
    handlers.get('before_agent_start')!(undefined as never)
    expect(await contextMessages(handlers)).toHaveLength(1)
  })

  it('the plan survives a turn boundary — a new user turn opens with the plan in view', async () => {
    const { handlers } = makeRig()
    await handlers.get('tool_result')!(toolResult({ toolName: 'todo_write', input: TWO_STEP_PLAN }))
    handlers.get('before_agent_start')!(undefined as never)
    expect((await contextMessages(handlers)).at(-1)!.content)
      .toBe('[plan] 1/3 done — in progress: Building workflow (1 pending)')
  })
})
