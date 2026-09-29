/**
 * Subagent registry — the Node-side implementation of `SubagentCommandPort`
 * (src/studio/commands/registry.ts §11.1, SUBAGENT-RUNTIME.md §11).
 *
 * Four execution primitives, no lifecycle side channel:
 *
 *   subagent.spawn  — bind a child session on an independent sessionId
 *                     (`sub_<role>_<uuid>`), narrow its tool surface from the
 *                     role's `tdease-ai-capability/system/subagents/<role>/SKILL.md`
 *                     `allowed_tool_refs`, run the task in the background, and
 *                     return `{ subagentId }` immediately.
 *   subagent.wait   — block on one group or explicit ID set, then return every
 *                     terminal structured result in one tool response.
 *   subagent.followup — continue a settled child in the same bound session.
 *   subagent.cancel — abort + dispose the child, settling the record as
 *                     cancelled with whatever partial result the child produced.
 *
 * First-principles: a subagent is a completely ordinary bound session — the
 * same `bindSession` / `prompt` / `abort` / `dispose` / `fork` surface the
 * parent session uses, never a new agent loop or a new abstraction layer. The
 * only differences are the independent sessionId and the narrowed tool surface.
 * The single-host SessionHost is untouched: each child IS a host of its own.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

import type {
  AgentBridgeResult,
  AgentPermissionRule,
  AgentToolSettingKey,
  AgentToolSettings,
  AuthorityId,
  BindSessionInput,
  BoundSession,
  PermissionSnapshot,
  PromptInput,
  PromptResult,
} from '../../src/contracts/agent-runtime'
import { studioCommandDefinitions } from '../../src/studio/commands/definitions'
import type { CommandDefinition } from '../../src/studio/commands/registry'
import type { SessionEvent } from '../../src/agent/events'
import type {
  SubagentAgentInfo,
  SubagentCommandPort,
  SubagentGroupSpawnInput,
  SubagentGroupSpawnResult,
  SubagentPeek,
  SubagentResult,
  SubagentSpawnInput,
  SubagentState,
  SubagentStatus,
} from '../../src/studio/commands/registry'
import type { NodeSystemAssets } from './node-system-assets'
import { createTaskRecords } from './task-records'

/**
 * The controlled slice of AgentRuntime that the registry is allowed to drive. The
 * full AgentRuntime exposes far more (compact, resolveApproval, session
 * subscription); passing this narrow surface instead keeps the subagent port
 * from reaching anything it has no business touching.
 */
export interface SubagentRuntime {
  bindSession(input: BindSessionInput): Promise<AgentBridgeResult<BoundSession>>
  prompt(input: PromptInput): Promise<AgentBridgeResult<PromptResult>>
  abort(sessionId: string): Promise<{ ok: true }>
  dispose(sessionId: string): Promise<{ ok: true }>
  fork(sessionId: string, targetSessionId: string): Promise<{ ok: true }>
  /** Read the persisted canonical events of a bound session. */
  readSessionEvents(sessionId: string): Promise<ReadonlyArray<SessionEvent>>
}

/**
 * A read-only snapshot of the registry pushed to subscribers whenever a
 * record is created or transitions state. The shape mirrors
 * `SubagentStatus` one-for-one so the renderer can render it directly with
 * no translation layer — there is exactly one subagent data model, not two.
 */
export type SubagentRecordsSnapshot = ReadonlyArray<SubagentStatus>

export type SubagentRecordsListener = (snapshot: SubagentRecordsSnapshot) => void

/** The parent binding the child clones its model/mindset/workspace from. */
export interface SubagentParent {
  readonly sessionId: string
  readonly workspaceId: string
  readonly mindset: BindSessionInput['mindset']
  readonly authority: AuthorityId
  /**
   * The parent's frozen permission ceiling. Children inherit it verbatim —
   * a child never re-resolves the workspace policy or an authority ladder,
   * so `decisionOf(child) ≤ decisionOf(parent)` per action holds by
   * construction (AGENT-LIFECYCLE.md §Delegation).
   */
  readonly permissionCeiling: PermissionSnapshot
  /**
   * The parent's frozen parameterized permission overrides, inherited
   * verbatim alongside the ceiling — same rule: the child never re-resolves
   * the workspace policy. Absent when the parent bound without overrides.
   */
  readonly permissionRules?: ReadonlyArray<AgentPermissionRule>
  readonly model: BindSessionInput['model']
  readonly thinkingLevel: BindSessionInput['thinkingLevel']
  readonly agentTools: AgentToolSettings
}

interface RoleProfile {
  readonly allowedToolRefs: ReadonlyArray<string>
  readonly toolProfile: SubagentToolProfile
  readonly thinkingLevel?: BindSessionInput['thinkingLevel']
  /** The role's own system prompt (SKILL.md frontmatter `system_prompt`). */
  readonly systemPrompt?: string
}

type SubagentToolProfile = 'explore' | 'general'

const SUBAGENT_BASE_TOOLS = [
  'read', 'grep', 'find', 'ls', 'bash',
  'skill.read',
] as const

const SUBAGENT_GENERAL_TOOLS = ['write', 'edit'] as const

function defaultSubagentAllowlist(profile: RoleProfile): string[] {
  return [
    ...SUBAGENT_BASE_TOOLS,
    ...(profile.toolProfile === 'general' ? SUBAGENT_GENERAL_TOOLS : []),
    ...profile.allowedToolRefs,
  ].filter((value, index, values) => values.indexOf(value) === index)
}

interface RunRecord {
  readonly subagentId: string
  readonly role: string
  state: SubagentState
  readonly createdAt: number
  settledAt?: number
  /** Shared id when spawned via spawnGroup (parallel fan-out). */
  groupId?: string
  /**
   * The delegation scope the spawn ACTUALLY granted (role defaults ∩ the
   * caller's toolAllowlist), persisted as a creation fact. `followup` and
   * restore re-bind with THIS list — recomputing the role default there
   * widened the delegation on every continuation (a first-pass `read`-only
   * child resumed with bash/write/edit).
   */
  allowlist?: ReadonlyArray<string>
  result?: SubagentResult
  error?: { code: string; message: string }
}

export function createSubagentRegistry(options: {
  runtime: SubagentRuntime
  parent: SubagentParent
  systemAssets: NodeSystemAssets
  /** Absolute Workspace root — used only to persist/restore run records under
   *  `<workspaceRoot>/.tdease/sessions/<parentSessionId>/subagents/`. Optional:
   *  absent, the registry is in-memory only (the pre-persist behaviour). */
  workspaceRoot?: string
}): SubagentCommandPort {
  // ── Record bookkeeping over the shared task-records machinery ────────────
  // Records, per-record persistence, restore-with-orphan, subscribe, and the
  // drainSettled-once semantics live in task-records.ts (shared with the job
  // registry — the parts whose semantics must match anyway). This registry
  // owns the subagent-specific parts: the record shape, the §6 status
  // projection, the revive rules, and the driver below (a child bound
  // session rather than a child process).
  const tasks = createTaskRecords<RunRecord, SubagentStatus>({
    kind: '[subagents]',
    // Each record is mirrored to `<sessionDir>/subagents/<subagentId>.json` so
    // a session re-bind (workspace switch-back, app restart) restores history.
    persistDir: options.workspaceRoot
      ? path.join(options.workspaceRoot, '.tdease', 'sessions', options.parent.sessionId, 'subagents')
      : null,
    idOf: (record) => record.subagentId,
    toStatus,
    isRunning: (record) => record.state === 'running',
    revive: reviveSubagent,
  })
  const records = tasks.records
  // Restore synchronously at construction so the first `list()` reflects history.
  tasks.restore()

  return {
    async spawn(input: SubagentSpawnInput) {
      const role = input.role.trim()
      if (!role) throw new Error('subagent.spawn role must be a non-empty string')

      const profile: RoleProfile = role === 'generic'
        ? { allowedToolRefs: [], toolProfile: 'general' }
        : await readRole(options.systemAssets, role)
      const safeRole = role.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
      const subagentId = `sub_${safeRole || 'generic'}_${randomUUID()}`
      const sessionId = subagentId
      const record: RunRecord = { subagentId, role, state: 'running', createdAt: Date.now(), ...(input.groupId ? { groupId: input.groupId } : {}) }
      records.set(subagentId, record)
      tasks.announce(record)

      try {
        // Subagents use one of two small runtime-owned profiles. They never
        // inherit a high-authority parent's management surface. A role selects
        // explore/general and may add its scientific read commands; an explicit
        // spawn allowlist can only narrow that default. bindSession intersects
        // the result with the parent's normal profile and permission ceiling.
        const defaults = defaultSubagentAllowlist(profile)
        const allowlist = input.toolAllowlist
          ? defaults.filter((tool) => input.toolAllowlist!.includes(tool))
          : defaults
        // The delegation scope is a creation fact: persist it before the bind
        // so followup and restore re-bind with the SAME surface (recomputing
        // the role default widened the delegation on every continuation).
        record.allowlist = allowlist
        tasks.announce(record)
        const childAgentTools = narrowAgentTools(allowlist, options.parent.agentTools)
        // The child's system prompt is its role briefing (base contract + role
        // system_prompt), threaded through the same bindSession surface. A
        // base read failure degrades to the role prompt alone — never a
        // failed spawn.
        const systemPromptOverride = await buildRoleSystemPrompt(options.systemAssets, profile)

        // Named specialists already receive a complete role prompt plus one
        // bounded task. Forking the parent transcript contaminates that task
        // with orchestration instructions intended only for the main agent.
        // Fork remains available for an explicitly generic continuation.
        if (role === 'generic' && input.context === 'fork') {
          try {
            await options.runtime.fork(options.parent.sessionId, sessionId)
          } catch (error) {
            // The parent has no persisted Pi session yet (never ran a prompt);
            // fall back to a fresh child rather than failing the whole spawn.
            console.warn(`subagent fork unavailable (${messageOf(error)}); spawning fresh`)
          }
        }

        const bound = await options.runtime.bindSession({
          workspaceId: options.parent.workspaceId,
          sessionId,
          mindset: options.parent.mindset,
          // §11.4, corrected 2026-09-05: the child inherits the parent's frozen
          // permission ceiling verbatim and presents approvals on the parent's
          // stream. The previous `authority: 'auto'` re-resolved the workspace
          // policy at auto — an `ask` parent could spawn a child that ran bash
          // without a single prompt, widening authority across delegation.
          authority: options.parent.authority,
          delegation: {
            permissionCeiling: options.parent.permissionCeiling,
            ...(options.parent.permissionRules ? { permissionRules: options.parent.permissionRules } : {}),
            approvalPresenterSessionId: options.parent.sessionId,
          },
          model: options.parent.model,
          thinkingLevel: profile.thinkingLevel ?? options.parent.thinkingLevel,
          agentTools: childAgentTools,
          toolAllowlist: allowlist,
          systemPromptOverride,
        })
        if (!bound.ok) throw new Error(`Subagent bind failed: ${bound.code} ${bound.message}`)
      } catch (error) {
        record.state = 'blocked'
        record.settledAt = Date.now()
        record.error = { code: 'SUBAGENT_BIND_FAILED', message: messageOf(error) }
        tasks.announce(record)
        return { subagentId }
      }

      // The child is a plain bound session: its whole task is the `prompt`
      // message. Structured `input` (run/scan/candidate context) rides along as
      // JSON so the child actually sees what the parent wants it to work on.
      const message = input.input
        ? `${input.task}\n\n# Structured context\n\`\`\`json\n${JSON.stringify(input.input)}\n\`\`\``
        : input.task

      // Background settle — fire-and-forget. The parent command returned
      // `{ subagentId }` above; this only updates the run record.
      void (async () => {
        try {
          const result = await options.runtime.prompt({ sessionId, message })
          if (record.state !== 'running') return
          const parsed = await readResult(options.runtime, sessionId, subagentId, role)
          if (record.state !== 'running') return
          record.result = parsed
          record.settledAt = Date.now()
          if (result.ok) {
            record.state = result.outcome === 'resolved' ? 'returned' : result.outcome === 'cancelled' ? 'cancelled' : 'blocked'
          } else {
            record.state = 'blocked'
            record.error = { code: result.code, message: result.message }
          }
        } catch (error) {
          if (record.state !== 'running') return
          record.state = 'blocked'
          record.settledAt = Date.now()
          record.error = { code: 'SUBAGENT_SETTLE_FAILED', message: messageOf(error) }
        } finally {
          tasks.announce(record)
          // A settled child keeps a full SessionHost (and any PTY it spawned)
          // alive for no purpose: its result is already parsed into the
          // record, `peek` degrades to the record by design, and `followup`
          // re-binds from the persisted session. Release the host now.
          if (record.state !== 'running') {
            await options.runtime.dispose(sessionId).catch(() => undefined)
          }
        }
      })()

      return { subagentId }
    },

    async spawnGroup(input: SubagentGroupSpawnInput): Promise<SubagentGroupSpawnResult> {
      const tasks = input.tasks
      if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('subagent.spawnGroup requires a non-empty tasks array')
      const groupId = input.groupId ?? `grp_${randomUUID()}`
      // In-process children are cheap; concurrency caps how many bind at once.
      // Default (no cap) starts all tasks immediately — they share the same
      // event loop, so "parallel" means interleaved turns, not OS threads.
      const concurrency = Math.max(1, input.concurrency ?? tasks.length)
      const subagentIds: string[] = []
      const queue = [...tasks]
      // Bind `this` so the worker can call the port's spawn (defined above).
      const port = this as SubagentCommandPort
      const runWorker = async (): Promise<void> => {
        let task: Omit<SubagentSpawnInput, 'groupId'> | undefined
        while ((task = queue.shift()) !== undefined) {
          if (!task) continue
          const { subagentId } = await port.spawn({ ...task, groupId })
          subagentIds.push(subagentId)
        }
      }
      const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => runWorker())
      await Promise.all(workers)
      return { groupId, subagentIds }
    },

    async followup(input) {
      const record = records.get(input.subagentId)
      if (!record) throw new Error(`No subagent run: ${input.subagentId}`)
      const message = input.message.trim()
      if (!message) throw new Error('subagent.followup message must be a non-empty string')
      if (record.state === 'running') throw new Error(`Subagent is still running: ${input.subagentId}`)
      if (record.state === 'cancelled') throw new Error(`Cancelled subagent cannot continue: ${input.subagentId}`)

      // Re-bind the original child session before every continuation. In the
      // same process this refreshes the ordinary session host; after an app
      // restart it restores the child's persisted model session under the
      // same subagentId. `followup` is therefore the single resume primitive.
      const profile: RoleProfile = record.role === 'generic'
        ? { allowedToolRefs: [], toolProfile: 'general' }
        : await readRole(options.systemAssets, record.role)
      // The spawn's persisted scope, never a recomputed role default — the
      // continuation must keep exactly the delegation the child was created
      // with (record.allowlist is absent only for pre-persisting records).
      const allowlist = record.allowlist ?? defaultSubagentAllowlist(profile)
      const bound = await options.runtime.bindSession({
        workspaceId: options.parent.workspaceId,
        sessionId: record.subagentId,
        mindset: options.parent.mindset,
        // Same inheritance rule as spawn: the resumed child keeps the parent's
        // ceiling, never an auto re-resolution.
        authority: options.parent.authority,
        delegation: {
          permissionCeiling: options.parent.permissionCeiling,
          ...(options.parent.permissionRules ? { permissionRules: options.parent.permissionRules } : {}),
          approvalPresenterSessionId: options.parent.sessionId,
        },
        model: options.parent.model,
        thinkingLevel: profile.thinkingLevel ?? options.parent.thinkingLevel,
        agentTools: narrowAgentTools(allowlist, options.parent.agentTools),
        toolAllowlist: allowlist,
        systemPromptOverride: await buildRoleSystemPrompt(options.systemAssets, profile),
      })
      if (!bound.ok) throw new Error(`Subagent resume bind failed: ${bound.code} ${bound.message}`)

      record.state = 'running'
      record.settledAt = undefined
      record.error = undefined
      // A re-run will settle again — clear the prior announcement so the new
      // completion is injected/delivered fresh, not silently skipped.
      tasks.clearNotified(record.subagentId)
      tasks.announce(record)
      void (async () => {
        try {
          const result = await options.runtime.prompt({ sessionId: record.subagentId, message })
          const parsed = await readResult(options.runtime, record.subagentId, record.subagentId, record.role)
          if (record.state !== 'running') return
          record.result = parsed
          record.settledAt = Date.now()
          if (result.ok) {
            record.state = result.outcome === 'resolved' ? 'returned' : result.outcome === 'cancelled' ? 'cancelled' : 'blocked'
          } else {
            record.state = 'blocked'
            record.error = { code: result.code, message: result.message }
          }
        } catch (error) {
          if (record.state !== 'running') return
          record.state = 'blocked'
          record.settledAt = Date.now()
          record.error = { code: 'SUBAGENT_FOLLOWUP_FAILED', message: messageOf(error) }
        } finally {
          tasks.announce(record)
          if (record.state !== 'running') {
            await options.runtime.dispose(record.subagentId).catch(() => undefined)
          }
        }
      })()
      return { subagentId: record.subagentId }
    },

    async peek(subagentId: string, lines = 40): Promise<SubagentPeek> {
      const record = records.get(subagentId)
      const state = record?.state ?? 'blocked'
      // Best-effort: read the child's own events and compress to the panel's
      // peek shape. A missing/failed read yields just the state.
      try {
        const events = await options.runtime.readSessionEvents(subagentId)
        const recentTools: string[] = []
        for (const event of events) {
          const name = event.type === 'tool.requested' ? (event as { name?: string }).name : undefined
          if (name && !recentTools.includes(name)) recentTools.push(name)
        }
        const lastMessage = [...events].reverse().find((event) => event.type === 'message.completed')
        const content = lastMessage && lastMessage.type === 'message.completed' ? lastMessage.content : undefined
        const lastAssistantSnippet = typeof content === 'string'
          ? content.slice(-lines * 80) // ≈ last `lines` lines of prose
          : undefined
        return {
          subagentId,
          ...(recentTools.length ? { recentTools: recentTools.slice(-15) } : {}),
          ...(lastAssistantSnippet ? { lastAssistantSnippet } : {}),
          state,
        }
      } catch {
        return { subagentId, state }
      }
    },

    async listAgents(): Promise<ReadonlyArray<SubagentAgentInfo>> {
      return discoverAgents(options.systemAssets)
    },

    async status(subagentId: string) {
      const record = records.get(subagentId)
      if (!record) throw new Error(`No subagent run: ${subagentId}`)
      // status hands the §6 result to the model — mark notified so drainSettled
      // does not re-inject what the model just read.
      if (record.state !== 'running') tasks.markNotified(subagentId)
      return toStatus(record)
    },

    async cancel(subagentId: string) {
      const record = records.get(subagentId)
      if (!record) throw new Error(`No subagent run: ${subagentId}`)
      if (record.state === 'running') {
        await options.runtime.abort(subagentId).catch(() => undefined)
        // Capture whatever the child said before the abort settled it.
        record.result = await readResult(options.runtime, subagentId, subagentId, record.role).catch(() => record.result)
        record.state = 'cancelled'
        record.settledAt = Date.now()
        await options.runtime.dispose(subagentId).catch(() => undefined)
        tasks.announce(record)
      }
      return { ok: true, result: record.result }
    },

    /** Snapshot of all records for this parent session (renderer inspector). */
    list(): SubagentRecordsSnapshot {
      return tasks.snapshot()
    },

    drainSettled(): SubagentRecordsSnapshot {
      // The §6 result rides inside toStatus, so the context-hook summary shows
      // what the child concluded, not just its terminal state.
      return tasks.drainSettled()
    },

    /**
     * Subscribe to records changes. Returns an unsubscribe fn. Used by
     * AgentRuntime to forward `subagent:changed` to the owning renderer; the
     * renderer's store subscribes once per bound parent session.
     */
    subscribe(listener: SubagentRecordsListener): () => void {
      return tasks.subscribe(listener)
    },

    async wait(input, signal): Promise<ReadonlyArray<SubagentStatus>> {
      const explicitIds = input.subagentIds ? [...input.subagentIds] : null
      if (explicitIds?.length === 0) throw new Error('subagent.wait subagentIds must not be empty')
      const hasGroup = input.groupId !== undefined
      const hasIds = explicitIds !== null
      if (hasGroup && hasIds) {
        throw new Error('subagent.wait accepts at most one of groupId or subagentIds')
      }

      // Unscoped (neither selector): every record in this parent session. This
      // is the "collect everything" form — the model need not remember ids to
      // recover each child's terminal result (orphan-proofing a parent that
      // spawned without keeping the groupId/subagentIds).
      const selected: RunRecord[] = hasIds
        ? explicitIds!.map((id) => {
            const record = records.get(id)
            if (!record) throw new Error(`No subagent run: ${id}`)
            return record
          })
        : hasGroup
          ? [...records.values()].filter((record) => record.groupId === input.groupId)
          : [...records.values()]

      // Scoped selectors stay strict (an unknown group is a caller error). The
      // unscoped form tolerates "no children yet" and returns an empty set.
      if (hasGroup && selected.length === 0) throw new Error(`No subagent runs for group: ${input.groupId}`)

      const runningAtEntry = selected.filter((record) => record.state === 'running')
      const all = hasGroup || hasIds ? input.all === true : true

      // A signal cancelled BEFORE the wait started (between the permission
      // check and this call) must not park the tool call for the children.
      if (signal?.aborted) return selected.map(toStatus)

      if (runningAtEntry.length > 0) {
        // The task-records settle kernel: ONE shared flush per record, waiter
        // dispose on abandon (abort or a lost first-completion race never
        // leaves a resolver behind).
        const handles = runningAtEntry.map((record) => tasks.whenSettled(record.subagentId))
        const settle = all
          ? Promise.all(handles.map((handle) => handle.promise))
          : Promise.race(handles.map((handle) => handle.promise))
        await new Promise<void>((resolve) => {
          let finished = false
          const finish = (): void => {
            if (finished) return
            finished = true
            signal?.removeEventListener('abort', onAbort)
            for (const handle of handles) handle.dispose()
            resolve()
          }
          const onAbort = (): void => finish()
          signal?.addEventListener('abort', onAbort, { once: true })
          void settle.then(finish, finish)
        })
      }
      // `wait` hands every terminal result to the model as a tool response —
      // mark these notified so drainSettled does not re-inject them as a user
      // message on the next provider request. A still-running selection (the
      // `all: false` first-completion form, or an aborted wait) leaves the
      // rest for a later drain.
      const statuses = selected.map(toStatus)
      for (const record of selected) {
        if (record.state !== 'running') tasks.markNotified(record.subagentId)
      }
      return statuses
    },
  }
}

// ── SKILL.md frontmatter ──────────────────────────────────────────────────────

/**
 * Resolve a role's profile from `tdease-ai-capability/system/subagents/<role>/SKILL.md`. The
 * `role: 'generic'` fast path skips SKILL.md entirely (one-off plain child).
 */
async function readRole(systemAssets: NodeSystemAssets, role: string): Promise<RoleProfile> {
  // Global first, then skill-local — a skill may bundle its own subagents as a
  // self-contained plugin (`<skill>/subagents/<role>/SKILL.md`).
  try {
    return parseFrontmatter(await systemAssets.readText(`subagents/${role}/SKILL.md`))
  } catch { /* not global — search skills below */ }
  const skillFiles = (await systemAssets.listFiles('skills').catch(() => [])) ?? []
  const hit = skillFiles.find((file) => file.includes('/subagents/') && file.endsWith(`subagents/${role}/SKILL.md`))
  if (!hit) {
    throw new Error(`Unknown subagent role: ${role}. Roles live under subagents/<role>/ or a skill's subagents/<role>/.`)
  }
  return parseFrontmatter(await systemAssets.readText(`skills/${hit}`))
}

/**
 * Parse the three frontmatter fields the spawn needs. Accept both YAML block
 * and inline lists because role Skills are user-editable and both forms are
 * already present in the shipped corpus.
 */
export function parseFrontmatter(content: string): RoleProfile {
  const block = frontmatterBlock(content)
  if (!block) return { allowedToolRefs: [], toolProfile: 'explore' }
  const parsed = parseYaml(block) as Record<string, unknown> | null
  const refs = Array.isArray(parsed?.allowed_tool_refs)
    ? parsed.allowed_tool_refs.filter((value): value is string => typeof value === 'string')
    : []
  const thinking = typeof parsed?.thinking_level === 'string' && ['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(parsed.thinking_level)
    ? parsed.thinking_level as BindSessionInput['thinkingLevel']
    : undefined
  const systemPrompt = typeof parsed?.system_prompt === 'string' ? parsed.system_prompt.trim() : undefined
  const toolProfile: SubagentToolProfile = parsed?.subagent_profile === 'general' ? 'general' : 'explore'
  return {
    allowedToolRefs: refs,
    toolProfile,
    ...(thinking ? { thinkingLevel: thinking } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
  }
}

/**
 * Assemble a subagent child's system-prompt override: the shared operating
 * contract (`prompts/internal/subagent_base.md`) plus the role's own
 * `system_prompt` from its SKILL.md. Fragments are separate files so a new
 * role adds only its specific fragment — no duplicated boilerplate. A missing
 * base fragment degrades to the role prompt alone and never fails a spawn.
 */
async function buildRoleSystemPrompt(
  systemAssets: NodeSystemAssets,
  profile: RoleProfile,
): Promise<string | undefined> {
  let base = ''
  try {
    base = await systemAssets.readText('prompts/internal/subagent_base.md')
  } catch {
    // A base read failure degrades to the role prompt alone — keep ''.
  }
  const baseText = base.trim()
  const role = profile.systemPrompt?.trim() ?? ''
  if (role) return baseText ? `${baseText}\n\n${role}` : role
  return baseText || undefined
}

// ── Tool-surface narrowing ────────────────────────────────────────────────────

/**
 * Narrow the parent session's coarse tool settings to the commands a subagent
 * may actually call. The tool profile gates commands in coarse buckets
 * (src/agent/tool-profile.ts); the "scientific" buckets (spectra/reference/
 * evidence) are enabled for explorer/executor regardless of the settings
 * record, so an allowlist narrows what it can and the scientific tools stay
 * available exactly as the parent mindset grants them.
 *
 * Which commands keep which bucket alive is derived from the registry's own
 * metadata — a command keeps its `exposure.setting` bucket, and any command
 * that writes Workspace state (permission `workspace.write`)
 * keeps `workspaceWrite` — so a new command narrows correctly the day it is
 * declared, without a parallel id list here to remember.
 */
export function narrowAgentTools(
  allowlist: ReadonlyArray<string>,
  parent: AgentToolSettings,
  definitions: ReadonlyArray<Pick<CommandDefinition, 'id' | 'exposure' | 'permission'>> = studioCommandDefinitions(),
): AgentToolSettings {
  const allowed = definitions.filter((definition) => allowlist.includes(definition.id))
  const keepsSetting = (setting: AgentToolSettingKey): boolean =>
    allowed.some((definition) => definition.exposure?.setting === setting)
  const writesWorkspace = allowed.some((definition) =>
    definition.permission === 'workspace.write')
  const has = (...names: string[]) => names.some((name) => allowlist.includes(name))
  return {
    discovery: parent.discovery && keepsSetting('discovery'),
    workflow: parent.workflow && keepsSetting('workflow'),
    runObservation: parent.runObservation && keepsSetting('runObservation'),
    runControl: parent.runControl && keepsSetting('runControl'),
    workspaceWrite: parent.workspaceWrite && (has('write', 'edit') || writesWorkspace),
    shell: parent.shell && has('bash'),
    mcp: parent.mcp && has('mcp'),
  }
}

// ── Result capture (§6 protocol) ──────────────────────────────────────────────

/**
 * Read the child's final assistant message from its own event log and parse it
 * as the §6 envelope. A child that did not emit the JSON envelope keeps its raw
 * text in a single finding rather than being silently dropped — the main agent
 * still needs to see what the child concluded.
 */
async function readResult(runtime: SubagentRuntime, sessionId: string, subagentId: string, role: string): Promise<SubagentResult> {
  const events = await runtime.readSessionEvents(sessionId)
  const lastMessage = [...events].reverse().find((event) => event.type === 'message.completed')
  const content = lastMessage && lastMessage.type === 'message.completed' ? lastMessage.content : undefined
  return parseResult(content, subagentId, role)
}

export function parseResult(content: string | undefined, subagentId: string, role: string): SubagentResult {
  if (content) {
    // A subagent naturally wraps its structured envelope in a ```json fence.
    // Strip the fence (and any prose wrapper) so JSON.parse sees the object —
    // or the bare per-event array, hence the bracket in the fallback match.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content) ?? content.match(/[[{][\s\S]*[\]}]/)
    const candidate = fenced ? fenced[1] ?? fenced[0] : content
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown
      // The per-event §6 envelope (massshift-deepresearch and peers): one
      // state/status/confidence triple PER EVENT, not one top-level triple.
      // Children phrase the wrapper three natural ways — `{events:[...]}`,
      // `{envelopes:[...]}`, and a bare `[...]` — and before this branch any
      // of them either parsed "successfully" into findings:[] (128 tool calls
      // of real work surfaced as empty, harness_5a5857d4) or degraded to a
      // 1200-char raw clamp that the parent then had to chase on disk
      // (harness_f4beccd3). Each event rides as its own finding; evidence
      // links and open questions merge upward; confidence rolls up to the
      // strongest event.
      const isEventObject = (value: unknown): value is Record<string, unknown> =>
        !!value && typeof value === 'object' && !Array.isArray(value)
      const eventList = Array.isArray(parsed)
        ? parsed
        : isEventObject(parsed) && (Array.isArray((parsed as Record<string, unknown>).events) || Array.isArray((parsed as Record<string, unknown>).envelopes))
          ? ((parsed as Record<string, unknown>).events ?? (parsed as Record<string, unknown>).envelopes) as unknown[]
          : undefined
      if (eventList !== undefined) {
        const events = eventList.filter(isEventObject)
        const rank: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 }
        const confidence = events.reduce<'high' | 'medium' | 'low'>((best, event) => {
          const c = event.confidence
          return c === 'high' || c === 'medium' || c === 'low'
            ? (rank[c] > rank[best] ? c : best)
            : best
        }, 'low')
        return boundResult({
          subagentId,
          role,
          findings: events,
          evidenceLinks: events
            .flatMap((event) => (Array.isArray(event.evidenceLinks) ? event.evidenceLinks : []))
            .map(coerceEvidenceLink)
            .filter((link): link is SubagentResult['evidenceLinks'][number] => link !== undefined),
          confidence,
          openQuestions: events
            .flatMap((event) => (Array.isArray(event.openQuestions) ? event.openQuestions : []))
            .filter((question): question is string => typeof question === 'string'),
        })
      }
      if (isEventObject(parsed)) {
        const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low' ? parsed.confidence : 'low'
        const state = typeof parsed.state === 'string' && parsed.state.trim() ? parsed.state.trim() : undefined
        return boundResult({
          subagentId,
          role,
          findings: Array.isArray(parsed.findings) ? parsed.findings : [],
          evidenceLinks: Array.isArray(parsed.evidenceLinks)
            ? parsed.evidenceLinks
                .map(coerceEvidenceLink)
                .filter((link): link is SubagentResult['evidenceLinks'][number] => link !== undefined)
            : [],
          confidence,
          openQuestions: Array.isArray(parsed.openQuestions)
            ? parsed.openQuestions.filter((item): item is string => typeof item === 'string')
            : [],
          ...(state ? { state } : {}),
        })
      }
    } catch { /* not the §6 envelope — keep the raw text below */ }
  }
  return boundResult({
    subagentId,
    role,
    findings: content ? [{ raw: content }] : [],
    evidenceLinks: [],
    confidence: 'low',
    openQuestions: [],
  })
}

// ── Result size bounds (context-window protection) ───────────────────────────
//
// A `subagent.wait` return is the FULL set of terminal records, each carrying
// its §6 envelope. A heavy fan-out with verbose children could otherwise flood
// the parent context. Findings/evidenceLinks/openQuestions are capped by count;
// every string field is clamped so one pathological finding cannot carry the
// whole blast. A capped result is flagged `truncated: true` so the model knows
// the record is a summary, not the complete child conclusion (re-read the child
// conversation or `followup` for the full detail).
const RESULT_LIMITS = {
  maxFindings: 24,
  maxEvidenceLinks: 48,
  maxOpenQuestions: 16,
  maxStringChars: 1200,
} as const

/** Recursively clamp every string in an arbitrary JSON value. */
function clampText(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') {
    return value.length > maxChars ? `${value.slice(0, maxChars)}…[+${value.length - maxChars} chars]` : value
  }
  if (Array.isArray(value)) return value.map((item) => clampText(item, maxChars))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = clampText(item, maxChars)
    }
    return out
  }
  return value
}

function boundResult(result: SubagentResult): SubagentResult {
  const findings = result.findings
    .slice(0, RESULT_LIMITS.maxFindings)
    .map((finding) => clampText(finding, RESULT_LIMITS.maxStringChars))
  const evidenceLinks = result.evidenceLinks.slice(0, RESULT_LIMITS.maxEvidenceLinks)
  const openQuestions = result.openQuestions
    .slice(0, RESULT_LIMITS.maxOpenQuestions)
    .map((question) => question.length > RESULT_LIMITS.maxStringChars
      ? `${question.slice(0, RESULT_LIMITS.maxStringChars)}…[+${question.length - RESULT_LIMITS.maxStringChars} chars]`
      : question)
  const truncated =
    result.findings.length > RESULT_LIMITS.maxFindings ||
    result.evidenceLinks.length > RESULT_LIMITS.maxEvidenceLinks ||
    result.openQuestions.length > RESULT_LIMITS.maxOpenQuestions
  return {
    ...result,
    findings,
    evidenceLinks,
    openQuestions,
    ...(truncated ? { truncated: true } : {}),
  }
}

/**
 * Accept `{kind, label, path?}` objects and coerce bare path strings — a child
 * naturally cites `analysis/<task>/dr-F103/findings.md` as a plain string, and
 * silently dropping it would sever the evidence chain the finalizer needs
 * (`evidence_refs` must exist on disk). Non-conforming entries are still
 * dropped; the parent sees the kept links and finalize rejects refs that do
 * not exist.
 */
function coerceEvidenceLink(value: unknown): SubagentResult['evidenceLinks'][number] | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    return text ? { kind: 'file', label: text, path: text } : undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  if (typeof entry.kind !== 'string' || typeof entry.label !== 'string') return undefined
  const optional = (key: 'url' | 'id' | 'path'): { url?: string; id?: string; path?: string } =>
    typeof entry[key] === 'string' && entry[key]!.trim() ? { [key]: (entry[key] as string).trim() } : {}
  return { kind: entry.kind, label: entry.label, ...optional('url'), ...optional('id'), ...optional('path') }
}

/** Revive a persisted subagent status: an in-process child cannot resume
 *  after a process restart, so a still-running record settles as `blocked` +
 *  SUBAGENT_ORPHANED — the partial result (if any) is kept so the parent
 *  still sees what the child concluded. */
function reviveSubagent(status: unknown, wasRunning: boolean): RunRecord | null {
  const stored = status as SubagentStatus
  const orphaned: SubagentState = wasRunning ? 'blocked' : stored.state
  return {
    subagentId: stored.subagentId,
    role: stored.role,
    state: orphaned,
    createdAt: stored.createdAt,
    ...(stored.groupId ? { groupId: stored.groupId } : {}),
    ...(stored.allowlist ? { allowlist: stored.allowlist } : {}),
    ...(stored.elapsedS !== undefined ? { settledAt: stored.createdAt + stored.elapsedS * 1000 } : {}),
    ...(stored.result !== undefined ? { result: stored.result } : {}),
    ...(wasRunning
      ? { error: { code: 'SUBAGENT_ORPHANED', message: 'Subagent was running when the session process restarted' } }
      : stored.error !== undefined ? { error: stored.error } : {}),
  }
}

function toStatus(record: RunRecord): SubagentStatus {
  const now = Date.now()
  return {
    subagentId: record.subagentId,
    role: record.role,
    state: record.state,
    createdAt: record.createdAt,
    elapsedS: Math.max(0, Math.round(((record.settledAt ?? now) - record.createdAt) / 1000)),
    ...(record.groupId !== undefined ? { groupId: record.groupId } : {}),
    ...(record.allowlist !== undefined ? { allowlist: record.allowlist } : {}),
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
  }
}

/**
 * Discover available roles for subagent.list. A role lives at either
 * `subagents/<role>/SKILL.md` (global) or `<skill>/subagents/<role>/SKILL.md`
 * (skill-local — a skill bundles its own subagents as a self-contained plugin).
 * `listFiles` returns paths RELATIVE to the queried root with no leading prefix,
 * so the global scan sees `<role>/SKILL.md` and the skill scan sees
 * `<skill>/subagents/<role>/SKILL.md`. A read/parse failure for one role skips
 * it — the model still sees the rest. Global names win over skill-local on clash.
 */
async function discoverAgents(systemAssets: NodeSystemAssets): Promise<ReadonlyArray<SubagentAgentInfo>> {
  const SKILL_SUFFIX = '/SKILL.md'
  const SKILL_SUFFIX_LEN = SKILL_SUFFIX.length
  const infos: SubagentAgentInfo[] = []
  const seen = new Set<string>()

  async function pushFrom(readPath: string, name: string): Promise<void> {
    if (!name || name.includes('/') || seen.has(name)) return
    let content: string
    try {
      content = await systemAssets.readText(readPath)
    } catch {
      return
    }
    const block = frontmatterBlock(content)
    if (!block) return
    let parsed: Record<string, unknown> | null
    try {
      parsed = parseYaml(block) as Record<string, unknown> | null
    } catch {
      return
    }
    seen.add(name)
    const description = typeof parsed?.description === 'string' ? parsed.description : name
    const defaultContext = typeof parsed?.defaultContext === 'string' ? parsed.defaultContext : undefined
    const output = typeof parsed?.output === 'string' ? parsed.output : undefined
    infos.push({
      name,
      description: description.replace(/\s+/g, ' ').trim(),
      ...(defaultContext === 'fresh' || defaultContext === 'fork' ? { defaultContext } : {}),
      ...(output ? { output } : {}),
    })
  }

  // Global subagents/<role>/SKILL.md (paths relative to 'subagents/').
  const globalFiles = (await systemAssets.listFiles('subagents').catch(() => [])) ?? []
  for (const file of globalFiles) {
    if (!file.endsWith(SKILL_SUFFIX)) continue
    const name = file.slice(0, file.length - SKILL_SUFFIX_LEN)
    await pushFrom(`subagents/${name}/SKILL.md`, name)
  }
  // Skill-local <skill>/subagents/<role>/SKILL.md (paths relative to 'skills/').
  const skillFiles = (await systemAssets.listFiles('skills').catch(() => [])) ?? []
  for (const file of skillFiles) {
    if (!file.includes('/subagents/') || !file.endsWith(SKILL_SUFFIX)) continue
    const afterSubagents = file.slice(file.lastIndexOf('subagents/') + 'subagents/'.length)
    const name = afterSubagents.slice(0, afterSubagents.length - SKILL_SUFFIX_LEN)
    await pushFrom(`skills/${file}`, name)
  }
  return infos
}

/** Extract the YAML frontmatter block (between --- fences), or null. */
function frontmatterBlock(content: string): string | null {
  if (!content.startsWith('---')) return null
  const end = content.indexOf('\n---', 3)
  return end < 0 ? content.slice(3) : content.slice(3, end)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
