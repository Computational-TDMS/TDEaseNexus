import type { WorkspaceId } from '../domain/identity'
import type { NodeDetail, NodeSummary, TemplateDetail, TemplateSummary } from '../ports/backend-gateway'
import type { PermissionGateway } from '../ports/permission-gateway'
import type { AgentToolSettingKey } from '@/contracts/agent-runtime'
import type { StudioAnalysisRuntime, StudioRunRuntime } from '../runtime/studio-runtime'
import { isPermissionAction, type PermissionAction } from '@/services/agent/permissionResolver'

export type CommandId = string

export interface JsonSchema {
  type: string
  properties?: Readonly<Record<string, JsonSchema>>
  required?: ReadonlyArray<string>
  additionalProperties?: boolean
  [key: string]: unknown
}

export interface SkillCommandPort {
  list(): Promise<ReadonlyArray<{ name: string; scope: 'system' | 'workspace'; description?: string }>>
  read(id: string, resource?: string): Promise<{
    id: string
    scope: 'system' | 'workspace'
    content: string
    resource?: string
    resources?: ReadonlyArray<string>
  }>
}

/**
 * The subagent port (SUBAGENT-RUNTIME.md §11.1). A subagent is
 * an ordinary bound session on an independent sessionId (`sub_<role>_<uuid>`)
 * with a narrowed tool surface; `spawn` returns immediately and the child
 * streams nothing into the parent transcript. The parent explicitly calls
 * `wait` to receive complete structured terminal results.
 *
 * `list` and `subscribe` are the read-side used by the renderer's Agent
 * inspector (the Subagents tab and the SessionBar running-count badge). They
 * do not widen the agent-facing command surface; `list/subscribe` exist so
 * the UI does not need a parallel data source.
 */
export interface SubagentCommandPort {
  spawn(input: SubagentSpawnInput): Promise<{ subagentId: string }>
  /** Spawn N independent children under one shared `groupId` (parallel fan-out).
   *  Each task is a normal spawn; the group is just a UI/aggregation label. */
  spawnGroup(input: SubagentGroupSpawnInput): Promise<SubagentGroupSpawnResult>
  /** Wait for one explicit set or group and return every terminal record.
   *  `signal` is the tool call's abort: a user stop (or budget halt) settles
   *  the wait at once instead of parking the parent turn until every child
   *  finishes on its own. */
  wait(input: SubagentWaitInput, signal?: AbortSignal): Promise<ReadonlyArray<SubagentStatus>>
  /** Continue a settled child in its existing session/context. */
  followup(input: SubagentFollowupInput): Promise<{ subagentId: string }>
  status(subagentId: string): Promise<SubagentStatus>
  /** Tail a child's recent activity (last tools + assistant snippet) for the
   *  panel's peek view. Best-effort: returns `{}` if the child has no events. */
  peek(subagentId: string, lines?: number): Promise<SubagentPeek>
  cancel(subagentId: string): Promise<{ ok: true; result?: SubagentResult }>
  /** Snapshot of all records for this parent session. */
  list(): ReadonlyArray<SubagentStatus>
  /** Return subagents that settled (running→terminal) since the last call, each
   *  carrying its §6 result, and mark them notified so the context hook never
   *  re-announces an old completion. The subagent analogue of
   *  `JobCommandPort.drainSettled` — lets a spawned-without-wait child's result
   *  reach the parent model without an explicit `subagent.wait`. `wait`/`status`
   *  also mark their records notified, so a result the model already consumed is
   *  never duplicated as an injection. */
  drainSettled(): ReadonlyArray<SubagentStatus>
  /** Discover available roles from role SKILL.md files — global
   *  `system/subagents/<role>/SKILL.md` and skill-local
   *  `system/skills/<skill>/subagents/<role>/SKILL.md` (global names win on
   *  clash). Lets the model read the roster dynamically instead of a hardcoded
   *  list. */
  listAgents(): Promise<ReadonlyArray<SubagentAgentInfo>>
  /** Subscribe to records changes (spawn / state transition / cancel). */
  subscribe(listener: (snapshot: ReadonlyArray<SubagentStatus>) => void): () => void
}

export interface SubagentFollowupInput {
  subagentId: string
  message: string
}

// ── Background job (long shell commands run async, no sleep-poll) ────────────
//
// A background job is the shell-command analogue of a subagent: a Node-owned,
// session-scoped task whose lifetime may exceed the turn that started it. The
// model calls `job.start`, gets a jobId back immediately, and keeps working;
// completion is injected into the next provider request via the context hook
// (tdease-extension.ts), so the model never `bash sleep + status` polls.
/** The Agent's pointer into the Workbench viewers (contracts/view-runtime.ts).
 *  `issue` validates the path against the Workspace and pushes the command to
 *  the session's owning window; it resolves with the delivery fact only. */
export interface ViewCommandPort {
  issue(command: import('@/contracts/view-runtime').ViewCommand): Promise<{ delivered: boolean; path: string; note: string }>
}

export interface JobCommandPort {
  start(input: JobStartInput): Promise<JobStartResult>
  status(jobId: string): Promise<JobStatus>
  peek(jobId: string, lines?: number): Promise<JobPeek>
  cancel(jobId: string): Promise<{ ok: true }>
  /** Kill every running job's process tree and settle each as cancelled —
   *  the owner-sweep primitive `AgentRuntime.abort`/`dispose` and the app-quit
   *  path call so no background job outlives its owner. Idempotent. Resolves
   *  once the killed trees confirmed their exit (bounded), so a quit never
   *  races the OS kill into orphaning grandchildren. */
  cancelAll(): Promise<void>
  /** Block until the selected jobs settle (or the first does) and return
   *  their statuses — the wait primitive that replaces status polling.
   *  `signal` is the tool call's abort: a user stop settles the wait at once. */
  wait(input: JobWaitInput, signal?: AbortSignal): Promise<ReadonlyArray<JobStatus>>
  /** Snapshot of all records for this parent session (renderer inspector). */
  list(): ReadonlyArray<JobStatus>
  /** Return jobs that settled (running→terminal) since the last call, each
   *  carrying a short stdout/stderr tail, and mark them notified so the context
   *  hook never re-announces an old completion. Drives the auto-notification
   *  that replaces `sleep + status` polling. */
  drainSettled(): ReadonlyArray<JobStatus>
  /** Subscribe to records changes (start / state transition / cancel). */
  subscribe(listener: (snapshot: ReadonlyArray<JobStatus>) => void): () => void
}

export type JobState = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobStatus {
  jobId: string
  command: string
  state: JobState
  createdAt: number
  elapsedS?: number
  pid?: number
  exitCode?: number
  stdoutTail?: string
  stderrTail?: string
  error?: { code: string; message: string }
}

/** A compressed peek at a job's live output (panel tail view). */
export interface JobPeek {
  jobId: string
  stdoutTail: string
  stderrTail: string
  state: JobState
}

export interface JobStartInput {
  command: string
  cwd?: string
  timeoutS?: number
}

/**
 * The start response. `waitable` is always true — the job is (or immediately
 * became) a task `job.wait` can block on — and `suggestedWaitS` names the
 * effective timeout budget so the model sizes its wait instead of polling.
 */
export interface JobStartResult {
  jobId: string
  waitable: true
  /** The job's effective timeout in seconds (absent when it failed to spawn). */
  suggestedWaitS?: number
}

export interface JobWaitInput {
  /** Wait on these jobs. Omitted: every job in this session. */
  jobIds?: ReadonlyArray<string>
  /** Wait for every selected job to settle. Default returns on the first
   *  completion so an early result is not held behind the slowest job. */
  all?: boolean
}

export type SubagentState = 'running' | 'returned' | 'blocked' | 'cancelled'

export interface SubagentStatus {
  subagentId: string
  role: string
  state: SubagentState
  createdAt: number
  elapsedS?: number
  /** Shared id when spawned via `spawnGroup`; absent for single `spawn`. */
  groupId?: string
  /** The delegation scope this child was created with (persisted creation
   *  fact; followup/restore re-bind with it, never a recomputed role default). */
  allowlist?: ReadonlyArray<string>
  result?: SubagentResult        // present on returned / blocked-with-partial
  error?: { code: string; message: string }
}

/** A compressed peek at a child's live activity (panel §conversation peek). */
export interface SubagentPeek {
  subagentId: string
  /** Most recent tool names, newest last (capped). */
  recentTools?: ReadonlyArray<string>
  /** Trailing assistant text snippet (capped to `lines`). */
  lastAssistantSnippet?: string
  state: SubagentState
}

/** One discovered role (the model reads this via `subagent.list`). */
export interface SubagentAgentInfo {
  name: string
  description: string
  defaultContext?: 'fresh' | 'fork'
  output?: string
}

/** §6 report-back protocol types — the vehicle for entity-link delivery. */
export interface SubagentResult {
  subagentId: string
  role: string
  findings: ReadonlyArray<unknown>
  evidenceLinks: ReadonlyArray<{
    kind: string        // 'uniprot' | 'unimod' | 'spectrum' | 'knowledge'
    url?: string
    id?: string
    path?: string       // workspace-relative path
    label: string
  }>
  confidence: 'high' | 'medium' | 'low'
  openQuestions: ReadonlyArray<string>
  /** Role-defined terminal state (e.g. massshift-deepresearch's
   *  `evidence_assigned` / `provisional` / `ambiguous` / …). Absent for
   *  roles that define no state vocabulary. */
  state?: string
  /** True when findings/evidenceLinks/openQuestions were capped by the
   *  context-window bounds — the stored result is a summary, not the complete
   *  child conclusion. */
  truncated?: boolean
}

export interface SubagentSpawnInput {
  role: string                 // role name, or 'generic' for a one-off plain child
  task: string                 // instruction for the child; plain child = a single task string
  input?: Record<string, unknown>       // structured context (run/scan/candidate)
  toolAllowlist?: ReadonlyArray<string> // bare command ids (definition.id) + builtin names; from SKILL allowed_tool_refs
  context?: 'fresh' | 'fork'            // fork = cloneConversation from the parent leaf (isomorphic reuse)
  /** Tag this child as part of a parallel group (set by spawnGroup). */
  groupId?: string
}

/** Parallel fan-out: N independent tasks, each a normal spawn, one group id. */
export interface SubagentGroupSpawnInput {
  /** One task per child. Each item is a single-spawn input minus `groupId`. */
  tasks: ReadonlyArray<Omit<SubagentSpawnInput, 'groupId'>>
  /** Optional concurrency cap (default: all tasks start at once, in-process). */
  concurrency?: number
  /** Caller-supplied group id; auto-generated `grp_<uuid>` when omitted. */
  groupId?: string
}

export interface SubagentGroupSpawnResult {
  groupId: string
  subagentIds: ReadonlyArray<string>
}

export interface SubagentWaitInput {
  groupId?: string
  subagentIds?: ReadonlyArray<string>
  /** Wait for every selected child to settle. Default returns on the first
   *  completion so early results are not held behind the slowest child. */
  all?: boolean
}

/**
 * Programmatic tool calling (PTC). PTC executes *tool calls* the model
 * scripts inline, collapsing round-trips. No journal — tool calls have side
 * effects that must never silently replay.
 * See docs/design/PTC-RUNTIME.md. The runtime lives in
 * electron/agent/ptc-runtime.ts; this port is the command-layer surface.
 */
export interface PtcCommandPort {
  /** Run one script. `tool(name, args)` and `log(...)` are its only globals. */
  exec(input: { script: string; timeout?: number; signal?: AbortSignal }): Promise<PtcExecResult>
}

export interface PtcExecResult {
  ok: boolean
  /** The script's serialized return value (head/tail truncated). */
  result?: string
  /** Failure message with a trimmed stack. */
  error?: string
  /** Per tool() call outcome, in execution order. */
  calls: ReadonlyArray<{ name: string; ok: boolean }>
  /** Captured log() lines. */
  log: ReadonlyArray<string>
  timedOut?: boolean
  /** True when the tool call's abort (user stop) ended the script. */
  aborted?: boolean
}

/**
 * The read-only discovery face (Node catalog + template catalog), shaped
 * exactly like `StudioRuntime.discovery` so the full class satisfies it
 * structurally and partial hosts can supply just the reads they own.
 */
export interface StudioDiscoverySurface {
  listNodes(): Promise<ReadonlyArray<NodeSummary>>
  getNode(id: string): Promise<NodeDetail>
  listTemplates(): Promise<ReadonlyArray<TemplateSummary>>
  getTemplate(id: string): Promise<TemplateDetail>
}

/**
 * What a command context needs from Studio — the three capability faces,
 * narrowed from the `StudioRuntime` class so a host that owns only part of the
 * surface (the renderer's Run store) satisfies the contract with its real
 * objects instead of faking the whole class. `StudioRuntime` satisfies this
 * structurally; the Electron main process binds the class unchanged.
 */
export interface StudioCommandSurface {
  runs: StudioRunRuntime
  analysis: StudioAnalysisRuntime
  discovery: StudioDiscoverySurface
}

export interface CommandContext {
  studio: StudioCommandSurface
  workspaceId: WorkspaceId
  permission: PermissionGateway
  skills?: SkillCommandPort
  subagents?: SubagentCommandPort
  /** Present only when the binding opted into PTC (`ptcEnabled`). */
  ptc?: PtcCommandPort
  jobs?: JobCommandPort
  /** Present only for top-level sessions bound by a window (subagents and
   *  headless sessions have no Workbench to point at). */
  view?: ViewCommandPort
  /** Local Node-catalog installation. Present only in local Backend mode —
   *  a remote Backend connection owns its own catalog on its own host, so
   *  `nodes.install` gates off and reports that boundary instead. */
  nodeCatalog?: NodeCatalogCommandPort
  selection?: unknown
}

/** Outcome of installing one Node package into the local Backend catalog. */
export interface NodeInstallOutcome {
  nodeId: string
  targetDir: string
  files: number
}

/**
 * Installs a Node package from a Workspace folder into the LOCAL Backend node
 * catalog (`<data root>/backend/nodes`). The agent's own filesystem reach ends
 * at the Workspace, so the copy is owned by this port (Electron main), which
 * also enforces the local/remote boundary.
 */
export interface NodeCatalogCommandPort {
  /**
   * @param sourceDir absolute path, or a path relative to the session's
   * Workspace root, of a folder containing `rules.smk`.
   */
  install(sourceDir: string): Promise<NodeInstallOutcome>
}

/**
 * The approval ladder.
 *
 * - `silent`   — nothing to approve. Read-only commands.
 * - `inline`   — the approval card in the Agent dock resolves it: a script
 *                write, a cancel. Small, reversible, or cheap.
 * - `document` — must be reviewed on a real surface before it can be allowed.
 *                Approving a four-hour Run from a 380 px chat bubble is how
 *                people approve things they did not read.
 */
export type CommandStakes = 'silent' | 'inline' | 'document'

/**
 * A standing "allow for the rest of this session" grant is only ever offered at
 * `inline`.
 *
 * At `document` it is a contradiction: the whole reason that tier exists is
 * that each instance must be read, and a grant that survives the instance means
 * the next one is never read. At `silent` there is nothing to grant.
 *
 * This is the rule the ladder implies and never states, so it is
 * stated here as one function rather than re-derived by every approval surface.
 */
export function allowsSessionGrant(stakes: CommandStakes): boolean {
  return stakes === 'inline'
}

/** The declared stakes, or the derivation for a command that omitted them. */
export function stakesOf(definition: Pick<CommandDefinition, 'mutates' | 'stakes'>): CommandStakes {
  return definition.stakes ?? (definition.mutates ? 'inline' : 'silent')
}

/**
 * Which mindsets the Agent may see a command in, and the optional user tool
 * setting that gates it. Declared once on the definition by the family that
 * owns the command; derived by the gating module (`src/agent/tool-profile.ts`).
 * The registry is the single authority for the tool surface (AGENT-CONTRACT),
 * so the mindset classification lives on the definition — not in a parallel
 * id list the definition can drift from.
 *
 * The scientific read/compute surface is shared: reading results, reference
 * queries, background jobs and delegation are capability, not execution
 * authority. The remaining splits follow the working mode:
 * workflow composes Runs and owns the catalogs; analysis owns the scripted
 * tool surface and the viewer pointer.
 *
 * - `all` — both mindsets (the shared read/compute surface).
 * - `analysis` — analysis only (`ptc.exec`, `view.*`).
 * - `workflow` — workflow only (catalog discovery plus Run composition/
 *   control: `nodes.*`, `templates.*`, `workflow.*`, and
 *   `runs.resume/overwrite/cancel/trash/restore`).
 *
 * Absent exposure = never agent-visible (UI-only or compatibility commands);
 * the gating module's default is fail-closed.
 */
export interface CommandExposure {
  mindsets: 'all' | 'analysis' | 'workflow'
  setting?: AgentToolSettingKey
}

export interface CommandDefinition<Args extends Record<string, unknown> = Record<string, unknown>, Result = unknown> {
  id: CommandId
  title: string
  summary: string
  args: JsonSchema
  mutates: boolean
  permission?: PermissionAction
  /**
   * How much surface this command's approval deserves.
   *
   * Declared here, once, rather than decided at each call site — that is the
   * whole point. Two approval surfaces reading the same command must not reach
   * different conclusions about how dangerous it is, and "is this worth a
   * document?" is a property of the command, not of who happens to be asking.
   *
   * Omit it: a read-only command derives `silent`, a mutating one derives
   * `inline`. Declare `document` only for the two things that earn it —
   * committing significant irreversible compute, or writing a scientific claim
   * that will be cited later.
   */
  stakes?: CommandStakes
  agentVisible?: boolean
  hiddenReason?: string
  /** Agent-surface exposure; see {@link CommandExposure}. Absent = UI-only. */
  exposure?: CommandExposure
  enabled?(context: CommandContext): boolean
  run(args: Args, context: CommandContext, execution?: { signal?: AbortSignal }): Promise<Result>
  renderForAgent?(result: Result): string
}

export interface AgentToolDescriptor {
  id: CommandId
  name: string
  description: string
  parameters: JsonSchema
}

export class CommandRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandRegistrationError'
  }
}

export class CommandInvocationError extends Error {
  /** The permission decision that produced this error, when there was one. */
  readonly decision?: string
  constructor(message: string, decision?: string) {
    super(message)
    this.name = 'CommandInvocationError'
    this.decision = decision
  }
}

export class CommandRegistry {
  private readonly definitions = new Map<CommandId, CommandDefinition>()

  constructor(definitions: ReadonlyArray<CommandDefinition> = []) {
    for (const definition of definitions) this.register(definition)
  }

  register(definition: CommandDefinition): void {
    validateDefinition(definition, this.definitions)
    this.definitions.set(definition.id, definition)
  }

  get(id: CommandId): CommandDefinition | undefined {
    return this.definitions.get(id)
  }

  require(id: CommandId): CommandDefinition {
    const definition = this.get(id)
    if (!definition) throw new CommandInvocationError(`Unknown Studio command: ${id}`)
    return definition
  }

  list(): ReadonlyArray<CommandDefinition> {
    return [...this.definitions.values()]
  }

  async invoke(
    id: CommandId,
    args: Record<string, unknown>,
    context: CommandContext,
    execution?: { signal?: AbortSignal },
  ): Promise<unknown> {
    const definition = this.require(id)
    if (definition.enabled && !definition.enabled(context)) {
      throw new CommandInvocationError(`Studio command is unavailable in the current context: ${id}`)
    }
    if (definition.permission) await requirePermission(definition, context.permission)
    return definition.run(args, context, execution)
  }
}

/**
 * Build the agent tool descriptors for a registry — NOT used on the live agent
 * path. The live path is `ToolGateway.buildStudioTools` (electron/agent/), which
 * additionally applies the mindset + Agent-Tools ceiling from
 * `createAgentToolProfile`. This function exists for offline inspection of the
 * registered tool surface with permission forced to 'allow'. Do not wire it
 * into SessionHost — that re-introduces a second, ceiling-less filter.
 */
export function agentTools(
  registry: CommandRegistry,
  permissions: Pick<PermissionGateway, 'decide'>,
  context?: CommandContext,
): ReadonlyArray<AgentToolDescriptor> {
  return registry.list()
    .filter((definition) => definition.agentVisible !== false)
    .filter((definition) => !definition.permission || permissions.decide(definition.permission) !== 'deny')
    // A command that would refuse in this context must not be advertised: a
    // tool the model can only fail to use is the phantom-tool defect.
    .filter((definition) => !context || !definition.enabled || definition.enabled(context))
    .map((definition) => ({
      id: definition.id,
      name: `tdease.${definition.id}`,
      description: definition.summary,
      parameters: definition.args,
    }))
}

export function renderCommandResult(definition: CommandDefinition, result: unknown): string {
  if (definition.renderForAgent) return definition.renderForAgent(result)
  return canonicalJson(result)
}

function validateDefinition(
  definition: CommandDefinition,
  registered: ReadonlyMap<CommandId, CommandDefinition>,
): void {
  if (!definition.id || !/^[-a-zA-Z0-9_]+(?:\.[-a-zA-Z0-9_]+)+$/.test(definition.id)) {
    throw new CommandRegistrationError(`Command id must use <noun>.<verb> form: ${definition.id || '(empty)'}`)
  }
  if (registered.has(definition.id)) throw new CommandRegistrationError(`Duplicate Studio command id: ${definition.id}`)
  if (!definition.title.trim()) throw new CommandRegistrationError(`Command title is required: ${definition.id}`)
  if (!definition.summary.trim()) throw new CommandRegistrationError(`Command summary is required: ${definition.id}`)
  if (!definition.args || definition.args.type !== 'object') {
    throw new CommandRegistrationError(`Command args must be an object schema: ${definition.id}`)
  }
  if (definition.mutates && !definition.permission) {
    throw new CommandRegistrationError(`Mutating command requires a permission action: ${definition.id}`)
  }
  if (!definition.mutates && definition.permission) {
    throw new CommandRegistrationError(`Read-only command must not declare a permission action: ${definition.id}`)
  }
  if (definition.permission && !isPermissionAction(definition.permission)) {
    throw new CommandRegistrationError(`Command permission action is not registered: ${definition.id}`)
  }
  if (definition.agentVisible === false && !definition.hiddenReason?.trim()) {
    throw new CommandRegistrationError(`Hidden Agent command requires a reason: ${definition.id}`)
  }
  // A read-only command that claims to need a review surface, or a mutating one
  // that claims to need no approval at all, is a mis-declaration rather than a
  // preference — catch it at registration, where the author is, instead of at
  // the approval card, where the user is.
  if (!definition.mutates && definition.stakes && definition.stakes !== 'silent') {
    throw new CommandRegistrationError(
      `Read-only command must not raise its approval stakes: ${definition.id} declares '${definition.stakes}'`,
    )
  }
  if (definition.mutates && definition.stakes === 'silent') {
    throw new CommandRegistrationError(
      `Mutating command must not declare silent stakes: ${definition.id}`,
    )
  }
}

async function requirePermission(definition: CommandDefinition, permission: PermissionGateway): Promise<string> {
  const action = definition.permission
  if (!action) return 'allow'
  const decision = permission.decide(action)
  if (decision === 'deny') throw new CommandInvocationError(`Permission denied: ${action}`, 'deny')
  if (decision === 'ask') {
    if (!await permission.request(action, definition.title)) {
      throw new CommandInvocationError(`Permission declined: ${action}`, 'ask:declined')
    }
    return 'ask:approved'
  }
  return decision
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value))
  return serialized === undefined ? 'null' : serialized
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value instanceof Map) return Object.fromEntries([...value.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, item]) => [String(key), canonicalize(item)]))
  if (value instanceof Set) return [...value].map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
  }
  return value
}
