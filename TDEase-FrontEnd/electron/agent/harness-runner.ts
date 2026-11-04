import { promises as fs } from 'node:fs'
import path from 'node:path'

import type {
  AgentBridgeResult,
  BindSessionInput,
  BoundSession,
  PromptInput,
  PromptResult,
  ResolveApprovalInput,
  RuntimeEvent,
} from '../../src/contracts/agent-runtime'

export interface HarnessRuntime {
  bindSession(input: BindSessionInput): Promise<AgentBridgeResult<BoundSession>>
  prompt(input: PromptInput): Promise<AgentBridgeResult<PromptResult>>
  resolveApproval(input: ResolveApprovalInput): { ok: true }
  dispose(sessionId: string): Promise<{ ok: true }>
  /** Read-side job snapshot; present on the real runtime, omitted by test fakes. */
  listJobs?(sessionId: string): ReadonlyArray<{ jobId: string; state: string }>
}

/** How long the runner waits for agent-started jobs to settle after the last
 *  prompt resolves, before collecting them. Batch jobs are minutes-scale; the
 *  trap this guards is the runner disposing a session while a job is still
 *  running — the model's "results will follow" never gets its follow-up turn. */
const JOB_SETTLE_TIMEOUT_MS = 30 * 60_000
const JOB_SETTLE_POLL_MS = 5_000
/** Unconditional collection rounds after the prompts; repair reruns started
 * inside a collect turn extend the budget (a die→fix→rerun→report loop needs
 * more turns than a plain collection), up to the hard cap. */
const JOB_COLLECT_TURNS = 2
const JOB_COLLECT_MAX_TURNS = 4
const JOB_COLLECT_PROMPT =
  '所有后台任务已结束或超时。请读取每个任务的最终输出（结果文件/stdout），完成你要交付的汇总与报告；如果任务失败且失败原因明确可修（例如门禁拒绝的声明缺陷），可以启动必要的修复性重跑（同一分析的修正声明），除此之外不要启动新的后台任务。'

export interface HarnessSummary {
  readonly sessionId: string
  readonly sessionDir: string
  readonly outcomes: ReadonlyArray<string>
  readonly events: number
  readonly tools: Readonly<Record<string, number>>
  readonly failedTools: number
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly toolCalls: number }
}

export async function runAgentHarness(options: {
  runtime: HarnessRuntime
  onEvent: (handler: (sessionId: string, event: RuntimeEvent) => void) => () => void
  sessionDir: string
  binding: BindSessionInput
  prompts: ReadonlyArray<string>
  pauseBetweenPromptsMs?: number
}): Promise<HarnessSummary> {
  await createSessionRecord(options)
  const outcomes: string[] = []
  const tools: Record<string, number> = {}
  const usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 }
  let events = 0
  let failedTools = 0
  let approvalDrift = 0

  const unsubscribe = options.onEvent((sessionId, event) => {
    if (sessionId !== options.binding.sessionId) return
    if (event.type === 'approval_requested') {
      approvalDrift += 1
      options.runtime.resolveApproval({ sessionId, approvalId: event.approvalId, decision: 'deny' })
      return
    }
    if (event.type !== 'event_committed') return
    events += 1
    if (event.event.type === 'tool.requested') {
      tools[event.event.name] = (tools[event.event.name] ?? 0) + 1
    } else if (event.event.type === 'tool.completed' && !event.event.ok) {
      failedTools += 1
    }
  })

  try {
    const bound = await options.runtime.bindSession(options.binding)
    if (!bound.ok) throw new Error(`${bound.code}: ${bound.message}`)
    for (const [index, message] of options.prompts.entries()) {
      if (index > 0 && (options.pauseBetweenPromptsMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.pauseBetweenPromptsMs))
      }
      const result = await options.runtime.prompt({ sessionId: options.binding.sessionId, message })
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
      outcomes.push(result.outcome)
      usage.inputTokens += result.usage.input_tokens
      usage.outputTokens += result.usage.output_tokens
      usage.toolCalls += result.usage.tool_calls
      if (result.outcome !== 'resolved') break
    }
    await collectSettledJobs(options, { outcomes, usage })
    if (approvalDrift) throw new Error(`AUTO_AUTHORITY_DRIFT: ${approvalDrift} approval request(s) emitted`)
  } finally {
    await options.runtime.dispose(options.binding.sessionId)
    unsubscribe()
    await touchSessionRecord(options.sessionDir)
  }

  return { sessionId: options.binding.sessionId, sessionDir: options.sessionDir, outcomes, events, tools, failedTools, usage }
}

/** Runner-lifetime guard: after the scripted prompts resolve, agent-started
 *  background jobs may still be running or newly settled. Wait (bounded) for
 *  settlement, then give the session a continuation turn to collect their
 *  outputs — the context hook injects settled-job summaries into the next
 *  turn, which only exists if the runner sends it. Without this, the batch
 *  runner disposes the session and kills the jobs the model promised to
 *  summarize ("results will follow" never follows). */
async function collectSettledJobs(
  options: Parameters<typeof runAgentHarness>[0],
  acc: { outcomes: string[]; usage: { inputTokens: number; outputTokens: number; toolCalls: number } },
): Promise<void> {
  const listJobs = options.runtime.listJobs?.bind(options.runtime)
  if (!listJobs) return
  const sessionId = options.binding.sessionId
  const waitUntilSettled = async (): Promise<ReadonlyArray<{ jobId: string; state: string }>> => {
    const deadline = Date.now() + JOB_SETTLE_TIMEOUT_MS
    for (;;) {
      const jobs = listJobs(sessionId)
      if (!jobs.some((job) => job.state === 'running')) return jobs
      if (Date.now() >= deadline) return jobs
      await new Promise((resolve) => setTimeout(resolve, JOB_SETTLE_POLL_MS))
    }
  }
  for (let round = 0; round < JOB_COLLECT_MAX_TURNS; round += 1) {
    const jobs = await waitUntilSettled()
    if (!jobs.length) return
    const idsBefore = new Set(jobs.map((job) => job.jobId))
    const result = await options.runtime.prompt({ sessionId, message: JOB_COLLECT_PROMPT })
    if (!result.ok) return
    acc.outcomes.push(result.outcome)
    acc.usage.inputTokens += result.usage.input_tokens
    acc.usage.outputTokens += result.usage.output_tokens
    acc.usage.toolCalls += result.usage.tool_calls
    if (result.outcome !== 'resolved') return
    const settled = await waitUntilSettled()
    const startedNew = settled.some((job) => !idsBefore.has(job.jobId))
    if (round + 1 >= JOB_COLLECT_TURNS && !startedNew) return
  }
}

async function createSessionRecord(options: {
  sessionDir: string
  binding: BindSessionInput
  prompts: ReadonlyArray<string>
}): Promise<void> {
  await fs.mkdir(options.sessionDir, { recursive: true })
  const now = Date.now()
  await fs.writeFile(path.join(options.sessionDir, 'session.json'), `${JSON.stringify({
    version: 1,
    id: options.binding.sessionId,
    title: options.prompts[0]?.trim().slice(0, 80) || 'Agent harness',
    createdAt: now,
    updatedAt: now,
    archived: false,
    mindset: options.binding.mindset,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
}

async function touchSessionRecord(sessionDir: string): Promise<void> {
  const target = path.join(sessionDir, 'session.json')
  const metadata = JSON.parse(await fs.readFile(target, 'utf8')) as Record<string, unknown>
  metadata.updatedAt = Date.now()
  await fs.writeFile(target, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
}
