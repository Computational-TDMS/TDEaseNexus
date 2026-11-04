import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

import type { AgentPermissionAction, ModelSelector, ThinkingLevel } from '../../src/contracts/agent-runtime'
import type { EventInput } from '../../src/agent/events'
import type { ApprovalCoordinator, AssembledPrompt, Observers, PromptPipeline, SessionStore, TurnAmbient } from './contracts'
import type { AgentRunDefinition, SessionBinding } from './turn-definition'
import type { JobStatus, SubagentStatus } from '../../src/studio/commands/registry'
import type { RunSummary } from '../../src/studio/domain/run'
import {
  createToolCallGate,
  redact,
  type ToolCallGate,
} from './tool-call-gate'
import type { CostGuard } from './cost-guard'
import { isTransientToolOutput } from './transient-failure'

// Re-exported for the existing consumers (agent-runtime creates the ledger;
// session-host and tests reference the type): the ledger moved into the gate
// module because the gate's guards and the PTC workflow both consume it.
export { createProducedPathLedger } from './tool-call-gate'
export type { ProducedPathLedger } from './tool-call-gate'

export interface ActiveAgentRun {
  readonly definition: AgentRunDefinition
  readonly prompt: AssembledPrompt
  requestSeq: number
  toolCalls: number
  /**
   * Set when `tdease.session.reportBlocked` completes successfully: the turn
   * must settle as `blocked` (AGENT-LOOP.md §3), not `resolved`.
   */
  blocked: { reason: string; needed: string } | null
}

export interface TDEaseExtensionOptions {
  readonly binding: SessionBinding
  readonly store: SessionStore
  readonly prompt: PromptPipeline
  readonly approvals: ApprovalCoordinator
  readonly observers: Observers
  readonly activeRun: () => ActiveAgentRun | null
  readonly activeModel: () => ModelSelector
  readonly activeThinkingLevel: () => ThinkingLevel
  readonly actionForTool: (toolName: string) => AgentPermissionAction | undefined
  /** Canonical-name check for `tdease.session.reportBlocked` (provider names differ). */
  readonly isBlockedReport: (toolName: string) => boolean
  /** Canonical-name check for the `todo_write` plan tool (provider names differ). */
  readonly isTodoWrite: (toolName: string) => boolean
  readonly append: (event: EventInput) => Promise<void>
  /**
   * Cost guard (cost-guard.ts): per-turn ledgers reset at loop open, and
   * rules tripped in earlier turns are re-announced at each loop's opening
   * request — the `[plan]` mechanism, so the rules survive compaction.
   * Optional: absent when the composition root has no guard (tests).
   */
  readonly costGuard?: CostGuard
  /** Ambient turn services: the background-task drains and the produced-path
   *  ledger (see TurnAmbient — supplied complete by the composition root). */
  readonly ambient: Pick<TurnAmbient, 'drainSettledJobs' | 'drainSettledSubagents' | 'drainSettledRuns' | 'producedPaths'>
}

/**
 * Ledger of workspace-relative paths this session produced — see
 * tool-call-gate.ts, where the ledger and its guards live.
 */

/** Render settled background jobs as one user-facing message for the context
 *  hook to inject. Each job carries a short stdout/stderr tail (drainSettled)
 *  so the model sees what the command printed without a follow-up peek. */
const JOB_SUMMARY_MAX_LINES = 6
const JOB_SUMMARY_MAX_CHARS = 1_600
const JOB_SUMMARY_MAX_COMMAND_CHARS = 500

function compactJobTail(value: string | undefined): string {
  if (!value) return ''
  const lines = value.trimEnd().split('\n').slice(-JOB_SUMMARY_MAX_LINES).join('\n')
  return lines.length > JOB_SUMMARY_MAX_CHARS ? lines.slice(-JOB_SUMMARY_MAX_CHARS) : lines
}

function compactJobCommand(value: string): string {
  const oneLine = value.replaceAll(/\s+/g, ' ').trim()
  return oneLine.length > JOB_SUMMARY_MAX_COMMAND_CHARS
    ? `${oneLine.slice(0, JOB_SUMMARY_MAX_COMMAND_CHARS)}…`
    : oneLine
}

function formatJobSummary(jobs: ReadonlyArray<JobStatus>): string {
  const lines = jobs.map((job) => {
    const status = job.state === 'succeeded'
      ? `succeeded (exit ${job.exitCode ?? 0})`
      : job.state === 'cancelled'
        ? 'cancelled'
        : `failed${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ''}`
    const out = compactJobTail(job.stdoutTail)
    const err = compactJobTail(job.stderrTail)
    return [
      `${job.jobId} ${status}: ${compactJobCommand(job.command)}`,
      ...(out ? [`stdout:\n${out}`] : []),
      ...(err ? [`stderr:\n${err}`] : []),
    ].join('\n')
  })
  return `Jobs settled:\n${lines.join('\n')}`
}

/** Render settled subagents as one user-facing message — the subagent analogue
 *  of formatJobSummary. Each record carries its §6 result (drainSettled), so the
 *  model sees what a fire-and-forget child concluded without calling
 *  subagent.wait. Findings are rendered compactly (capped count + per-string
 *  truncation) so a large fan-out cannot flood the parent context; the full
 *  record stays reachable via subagent.status. */
const SUBAGENT_SUMMARY_MAX_FINDINGS = 6
const SUBAGENT_SUMMARY_MAX_CHARS = 200

function compactFinding(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > SUBAGENT_SUMMARY_MAX_CHARS
    ? `${text.slice(0, SUBAGENT_SUMMARY_MAX_CHARS)}…`
    : text
}

function formatSubagentSummary(records: ReadonlyArray<SubagentStatus>): string {
  const lines = records.map((record) => {
    const result = record.result
    const errorSuffix = record.error ? ` — error: ${record.error.code}` : ''
    const head = result
      ? `[subagent ${record.subagentId} role=${record.role}] ${record.state} — ${result.confidence} confidence`
      : `[subagent ${record.subagentId} role=${record.role}] ${record.state}${errorSuffix}`
    if (!result) return head
    const findings = (result.findings ?? []).slice(0, SUBAGENT_SUMMARY_MAX_FINDINGS)
    const findingsBlock = findings.length > 0
      ? `\nfindings:\n${findings.map((finding, index) => `  ${index + 1}. ${compactFinding(finding)}`).join('\n')}`
      : ''
    const extra = result.evidenceLinks.length > 0 ? `\nevidence: ${result.evidenceLinks.length} link(s)` : ''
    const open = result.openQuestions.length > 0 ? `\nopen questions: ${result.openQuestions.length}` : ''
    const roleState = result.state ? `\nstate: ${result.state}` : ''
    const trunc = result.truncated
      ? '\n(this digest is truncated — call subagent.wait with subagentIds:[this id] for the full result)'
      : ''
    return `${head}${findingsBlock}${extra}${open}${roleState}${trunc}`
  })
  return [
    'Subagent(s) settled since the last step:',
    '',
    lines.join('\n\n'),
    '',
    'The results above are from subagent(s) you spawned without waiting. Call subagent.wait with subagentIds:[the id] for the full §6 result, or subagent.followup to continue a child.',
  ].join('\n')
}

/** Render settled Backend runs as one user-facing message — the `runs.*`
 *  analogue of the two renderers above. A run the session watched (via
 *  runs.wait / runs.status / a submit) reaches the model the moment it goes
 *  terminal, so the model no longer burns requests re-polling a long
 *  workflow. Addressing uses the Workspace run folder when present — the same
 *  name the runs.* tools accept. */
function formatRunSummary(runs: ReadonlyArray<RunSummary>): string {
  const lines = runs.map((run) => {
    const name = run.workspaceRunPath ?? run.id
    const errorSuffix = run.error ? ` — ${run.error}` : ''
    return `- ${name}: ${run.status}${errorSuffix}`
  })
  return `Run(s) settled since the last step:\n${lines.join('\n')}\n\nUse runs.status with the run name above for results, or runs.tailLog / runs.diagnose if it failed.`
}

export function createTDEaseExtension(options: TDEaseExtensionOptions): ExtensionFactory {
  return (pi) => {
    // The session's task plan, as last successfully written by `todo_write`.
    // Session-scoped on purpose — unlike the per-turn ledgers below, the plan
    // survives turn boundaries so a new user turn still opens with the plan
    // in view. Derived state only: the transcript remains the durable record.
    let plan: ReadonlyArray<PlanItem> = []
    // The plan reminder announces once per LOOP ("one turn, one loop",
    // AGENT-LOOP.md §1), at the loop's opening request. The context-hook
    // injection is an ephemeral per-request overlay in Pi (transformContext),
    // so per-request injection would not accumulate in history — but it would
    // repeat the same user line on every step of a long loop, paying tokens
    // per request and dulling the signal. Announce once per loop — the first
    // request that has something to show (usually the opening); a plan that
    // only becomes announceable mid-loop claims the loop's one announcement
    // at the next request, and later todo_write calls re-announce nothing:
    // their own result is the fresh context.
    let planAnnounced = false
    // Cost rules ride the same once-per-loop cadence as the plan: the denial
    // that tripped a rule reached the model in its own turn; the announcement
    // re-pins the rule in every LATER loop, which is what outlives compaction.
    let costRulesAnnounced = false
    // Pi keeps prior tool results in the turn context. Repeating the same call
    // cannot reveal a new fact, so keep a small per-turn ledger to guard weak
    // models from needless read/reference retries.
    const callKeys = new Map<string, string>()
    const settledCalls = new Map<string, { readonly ok: boolean; readonly retryable: boolean }>()

    pi.on('before_agent_start', () => {
      // The extension lives with a resumable Pi session, while these facts are
      // valid only within one Agent turn. A later user turn may intentionally
      // re-read state changed by the earlier one.
      callKeys.clear()
      settledCalls.clear()
      // A new loop re-opens with the plan in view (§1 one turn, one loop).
      planAnnounced = false
      costRulesAnnounced = false
      options.costGuard?.beginTurn()
      const active = requiredRun(options)
      return { systemPrompt: active.prompt.systemPrompt }
    })

    pi.on('context', async (event) => {
      const active = requiredRun(options)
      active.requestSeq += 1
      // Inject a summary of background jobs that settled since the last
      // provider request — the model learns a long command finished without
      // `sleep + status` polling. drainSettled marks each announced, so a
      // completion is injected exactly once. This is the only path a settled
      // job reaches the model: Pi owns the loop, and a new turn cannot be
      // forced (prompting guard), so the next request is the earliest moment.
      const settledJobs = options.ambient.drainSettledJobs()
      // Same path for subagents spawned without a wait: the §6-result digest
      // reaches the parent model here, so a fire-and-forget child no longer
      // needs an explicit subagent.wait to be heard.
      const settledSubagents = options.ambient.drainSettledSubagents()
      // Same path for Backend runs: a run the session watched reaches the model
      // here the moment it goes terminal — no `runs.status` re-polling loop.
      const settledRuns = options.ambient.drainSettledRuns()
      // The plan reminder rides the same seam, once per loop: the opening
      // request of a turn re-pins the plan the previous loop left behind, so
      // the plan guides the turn instead of scrolling away in a long session.
      const planReminder = planAnnounced ? null : formatPlanReminder(plan)
      if (planReminder) planAnnounced = true
      // Cost rules re-pin here on the same cadence (once per loop), so a rule
      // tripped turns ago still constrains the model after compaction.
      const costRules = costRulesAnnounced ? [] : (options.costGuard?.rules() ?? [])
      if (costRules.length > 0) costRulesAnnounced = true
      const injections = [
        ...(settledJobs.length > 0 ? [formatJobSummary(settledJobs)] : []),
        ...(settledSubagents.length > 0 ? [formatSubagentSummary(settledSubagents)] : []),
        ...(settledRuns.length > 0 ? [formatRunSummary(settledRuns)] : []),
        ...(planReminder ? [planReminder] : []),
        ...(costRules.length > 0 ? [formatCostRules(costRules)] : []),
      ]
      const messages = injections.length > 0
        ? [...event.messages, ...injections.map((content) => ({ role: 'user', content }) as (typeof event.messages)[number])]
        : event.messages
      // Audit the context we return, including runtime injections. Hashing
      // event.messages before assembly hides the very rules under investigation.
      const snapshot = options.prompt.snapshotProviderRequest(
        active.definition.turnId,
        active.requestSeq,
        active.prompt.digest,
        messages,
        pi.getActiveTools(),
        options.activeModel(),
        options.activeThinkingLevel(),
      )
      await options.append({
        type: 'model.request.prepared',
        turn_id: snapshot.turnId,
        request_seq: snapshot.requestSeq,
        system_prompt_digest: snapshot.systemPromptDigest,
        context_digest: snapshot.contextDigest,
        active_tools_digest: snapshot.activeToolsDigest,
        model: `${snapshot.model.providerId}/${snapshot.model.modelId}`,
        thinking_level: snapshot.thinkingLevel,
      })
      return { messages }
    })

    // The policy gate this hook shares with the PTC workflow: data-access
    // guards, permission ceiling, 'ask' approval flow. Built once per bound
    // session; see tool-call-gate.ts for what belongs there and what stays
    // hook-local.
    const gate: ToolCallGate = createToolCallGate({
      binding: options.binding,
      approvals: options.approvals,
      producedPaths: options.ambient.producedPaths,
      actionForTool: options.actionForTool,
      append: options.append,
      turnId: () => requiredRun(options).definition.turnId,
    })

    pi.on('tool_call', async (event) => {
      const active = requiredRun(options)
      active.toolCalls += 1
      const key = toolCallKey(event.toolName, event.input)
      const prior = settledCalls.get(key)
      // Polling tools return time-varying state: an identical second *successful*
      // read is a fresh observation, not a repeat of a settled answer, so the
      // ledger must not block it. A repeated non-transient *failure* still
      // blocks — the reason does not change between reads.
      if (prior && !(prior.ok && isPollingTool(event.toolName)) && (prior.ok || !prior.retryable)) {
        return {
          block: true,
          reason: prior.ok
            ? 'This exact call already succeeded in this turn. Reuse its result instead of repeating it.'
            : 'This exact call already failed with a non-transient error. Change the input or use another path.',
        }
      }
      const decision = await gate.check(event.toolName, event.input, event.toolCallId)
      if (decision) return { block: true, reason: decision.block }
      callKeys.set(event.toolCallId, key)
    })

    pi.on('tool_result', (event) => {
      const key = callKeys.get(event.toolCallId) ?? toolCallKey(event.toolName, event.input)
      const commandFailed = toolResultFailed(event)
      const retryable = commandFailed && isTransientToolOutput(event.content, event.details)
      settledCalls.set(key, { ok: !commandFailed, retryable })
      if (!commandFailed) {
        // Only tools that mutate a path create current-task products. A read,
        // ls, find, or grep path is an observation, not a produced file;
        // recording it would widen the ledger and make historical descendants
        // look like current output.
        const input = asRecord(event.input)
        if (event.toolName === 'write' || event.toolName === 'edit') {
          for (const target of [input?.path, input?.file_path]) {
            if (typeof target === 'string' && target.trim()) options.ambient.producedPaths?.note(target)
          }
        }
        if (event.toolName === 'bash' && typeof input?.command === 'string') {
          // Shell redirections are writes too. Record their targets so a
          // command may inspect its own current analysis output without
          // opening historical sibling directories.
          const redirection = /(?:^|\s)(?:\d?>|>>)\s*([^\s;&|]+)/g
          for (const match of input.command.matchAll(redirection)) {
            const target = match[1]
            if (target && target !== '&1' && target !== '&2') options.ambient.producedPaths?.note(target)
          }
        }
      }
      options.observers.auditTool(
        options.binding.sessionId,
        event.toolCallId,
        event.toolName,
        redact(event.input),
        redact({ content: event.content, details: event.details }),
        !commandFailed,
        // Identity the permission decision ran under: the binding's authority
        // and, for delegated children, the parent + granted scope.
        {
          authority: options.binding.authority,
          ...(options.binding.delegatedFrom
            ? { delegatedFrom: options.binding.delegatedFrom }
            : {}),
          ...(options.binding.delegationScope
            ? { delegationScope: options.binding.delegationScope }
            : {}),
        },
      )
      // Only a successful call settles the turn as blocked (AGENT-LOOP.md §3);
      // a rejected/failed reportBlocked is an ordinary tool error.
      if (!commandFailed && options.isBlockedReport(event.toolName)) {
        const input = asRecord(event.input)
        requiredRun(options).blocked = {
          reason: typeof input?.reason === 'string' ? input.reason : '',
          needed: typeof input?.needed === 'string' ? input.needed : '',
        }
      }
      // A successful todo_write replaces the session plan (replacement
      // semantics, same as the tool); a failed one leaves the old plan intact.
      if (!commandFailed && options.isTodoWrite(event.toolName)) {
        const parsed = parsePlanItems(asRecord(event.input)?.todos)
        if (parsed) plan = parsed
      }
    })
  }
}

// ── Session plan (todo_write) ────────────────────────────────────────────────

interface PlanItem {
  readonly content: string
  readonly activeForm: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Read a `todo_write` payload defensively — the wire may carry anything (the
 * Pi loop applies no schema validation before execute; defineTool is an
 * identity for type inference). Returns null (keep the previous plan) unless
 * every item is well-formed, matching the tool's own throw-on-invalid
 * behavior: a payload the tool would have rejected never becomes the plan.
 *
 * The renderer's `parseTodos` (useSessionTodos.ts) reads the same payload
 * leniently — skipping bad items — because it renders what arrived; this one
 * is strict because its output drives injection. The two are twins by
 * payload, not by contract; change both together.
 */
function parsePlanItems(raw: unknown): ReadonlyArray<PlanItem> | null {
  if (!Array.isArray(raw)) return null
  const items: PlanItem[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') return null
    const item = value as Record<string, unknown>
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    const activeForm = typeof item.activeForm === 'string' ? item.activeForm.trim() : ''
    const status = item.status
    if (!content || !activeForm) return null
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
    items.push({ content, activeForm, status })
  }
  return items
}

/** Render the session's tripped cost rules as one user-facing message — same
 *  economy as the plan reminder: one injection, once per loop, listing the
 *  rules so a tripped constraint keeps steering after compaction. */
function formatCostRules(rules: ReadonlyArray<string>): string {
  return [`[cost] Session rules tripped earlier — they still hold:`, ...rules.map((rule) => `- ${rule}`)].join('\n')
}

/**
 * One status line, announced once per loop at its opening request (§1 one
 * turn, one loop) — sized to stay cheaper than a single tool result. Nothing
 * to guide once every item is complete, so a finished plan injects nothing.
 */
function formatPlanReminder(todos: ReadonlyArray<PlanItem>): string | null {  if (todos.length === 0) return null
  const done = todos.filter((todo) => todo.status === 'completed').length
  if (done === todos.length) return null
  const pending = todos.length - done
  const inProgress = todos.find((todo) => todo.status === 'in_progress')
  if (inProgress) {
    const rest = pending - 1
    return `[plan] ${done}/${todos.length} done — in progress: ${inProgress.activeForm}` +
      (rest > 0 ? ` (${rest} pending)` : '')
  }
  const next = todos.find((todo) => todo.status === 'pending')
  return next
    ? `[plan] ${done}/${todos.length} done — no task in progress; pick up "${next.content}" and mark it in_progress with todo_write`
    : null
}

function toolResultFailed(event: { readonly toolName: string; readonly isError: boolean; readonly details?: unknown }): boolean {
  if (event.isError) return true
  if (event.toolName !== 'bash') return false
  const details = asRecord(event.details)
  return details?.timedOut === true
    || (typeof details?.exitCode === 'number' && details.exitCode !== 0)
}

function toolCallKey(toolName: string, input: unknown): string {
  return `${toolName}\n${stableJson(input)}`
}

/** Observability tools whose result changes over time — an identical second
 *  call is a fresh read, never a repeat of a settled answer. The wait tools
 *  belong here too: their whole contract is to be re-called (scoped
 *  first-completion drains, a fresh wait after spawning more work), so the
 *  identical-args ledger must never block the next wait. */
const POLLING_TOOLS = new Set([
  'tdease.job.peek', 'tdease.job.status', 'tdease.job.wait',
  'tdease.runs.status', 'tdease.runs.wait',
  'tdease.subagent.wait',
])

function isPollingTool(toolName: string): boolean {
  return POLLING_TOOLS.has(toolName)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`
}

function requiredRun(options: TDEaseExtensionOptions): ActiveAgentRun {
  const active = options.activeRun()
  if (!active) throw new Error('Pi hook fired outside an active TDEase agent run')
  return active
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}
