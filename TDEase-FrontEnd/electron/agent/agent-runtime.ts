import { appendFileSync, existsSync, mkdirSync, promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

import {
  AGENT_PERMISSION_ACTIONS,
  type AgentBridgeResult,
  type AgentModelMetadata,
  type AgentPermissionAction,
  type AgentPermissionDecision,
  type BindSessionInput,
  type BoundSession,
  type PromptInput,
  type PromptResult,
  type ResolveApprovalInput,
  type RuntimeEvent,
} from '../../src/contracts/agent-runtime'
import type { SessionEvent } from '../../src/agent/events'
import { parseWorkspacePermissionPolicy, resolvePermission, sortPermissionRules, systemRulesForMode, type PermissionRule } from '../../src/services/agent/permissionResolver'
import { mergeWhitelistRule, serializePolicy, type WhitelistDerivation } from '../../src/services/agent/permissionWhitelist'
import { defaultPolicyFor } from '../../src/services/agent/defaultPermissionPolicy'
import { writeTextAtomicQueued } from '../atomic-write'
import { createUsageLedger, type UsageLedger } from '../../src/ai/core/usage-ledger'
import { createToolNameProtocol } from '../../src/ai/core/tool-name-protocol'
import { createAgentToolProfile, type AgentToolProfile } from '../../src/agent/tool-profile'
import { createStudioCommandRegistry } from '../../src/studio/commands/definitions'
import type { CommandContext, CommandRegistry, JobCommandPort, JobPeek, JobStatus, NodeInstallOutcome, SubagentCommandPort, SubagentPeek, SubagentStatus } from '../../src/studio/commands/registry'
import { asWorkspaceId, asRunId, type RunId } from '../../src/studio/domain/identity'
import type { RunSummary } from '../../src/studio/domain/run'
import { StudioRuntime } from '../../src/studio/runtime/studio-runtime'
import { DEFAULT_SNAPSHOT_SELECTION } from '../../src/studio/use-cases/prepare-analysis'
import { DesktopWorkspaceRepository } from '../../src/services/workspace/studioWorkspaceRepository'
import { TDEaseClient } from '../../src/services/backend/backend'
import { createStudioInfrastructure } from '../../src/services/backend/studioInfrastructure'
import { createSystemTemplateCatalog } from '../../src/services/catalog/systemTemplateCatalog'
import { containedPath } from '../path_containment.cjs'
import { resolveUv, skillRuntimeEnv } from '../skill_runtime.cjs'

import { createViewPort } from './view-port'
import { NodeApprovalCoordinator } from './approval-coordinator'
import type { RuntimeEventSink, RuntimePush } from './contracts'
import { NodeEventAdapter } from './event-adapter'
import { createNodeSkillCatalog } from './node-skill-catalog'
import { createNodeSystemAssets, type SystemAssetCatalog } from './node-system-assets'
import { createNodeWorkspaceBridge } from './node-workspace-bridge'
import { NodeObservers } from './observers'
import { NodePermissionGateway } from './permission-gateway'
import { NodePromptPipeline } from './prompt-pipeline'
import { resolveRunReference } from './mention-resolvers'
import { NodeProviderRegistry, type CredentialKeyLookup } from './provider-registry'
import { NodeSessionStore } from './session-store'
import { SessionHost } from './session-host'
import { createProducedPathLedger } from './tdease-extension'
import { createToolCallGate } from './tool-call-gate'
import { createPtcPort, type PtcToolLike } from './ptc-runtime'
import { createToolGateway } from './tool-gateway'
import { createCostGuard, type CostGuard } from './cost-guard'
import { PtyTerminalService } from './pty-terminal'
import { createNodeReferenceCommandPort } from './reference-command-port'
import { createSubagentRegistry } from './subagent-registry'
import { createJobRegistry } from './job-registry'
import { buildBashEnv } from './bash-env'
import { isTransientError } from './transient-failure'
import { deepFreeze, type SessionBinding, type ToolCeiling } from './turn-definition'

export interface BackendConnection {
  baseUrl: string
  accessToken: string | null
  /**
   * The launch's agent token: same working scopes as the owner token but
   * WITHOUT the irreversible ones (run:purge), capping a hallucinated
   * destructive call loop at reversible trash. Falls back to the owner token
   * for externally-configured connections that predate the token pair.
   */
  agentToken: string | null
}

export interface AgentRuntimeOptions {
  readonly settingsPath: string
  readonly systemRoot: string
  readonly agentDir: string
  /**
   * The managed tool bin dir the bash sandbox PATH prefixes; the `tdeasenexus-toolbox`
   * CLI is provisioned here so its short name resolves in bash (D16). Defaults
   * to `<agentDir>/tools` (the canonical `agentToolsRoot`).
   */
  readonly managedBinDir?: string
  readonly systemAssets: SystemAssetCatalog
  readonly resolveWorkspaceRoot: (workspaceId: string) => Promise<string>
  readonly backendConnection: () => BackendConnection
  /**
   * safeStorage-backed credential lookup (main decrypts, the utility child
   * cannot): returns the plaintext key for a provider whose key lives in
   * credentials.json, or null. Optional — absent means settings.json is the
   * only key source (tests, tooling, pre-migration installs).
   */
  readonly credentialKey?: CredentialKeyLookup
  /** Absolute path to the provisioned `tdeasenexus-toolbox` CLI (D16/D12-R). */
  readonly nativeCliPath?: string
  /** Read-only product assets root (skills/, prompts/...); injected into bash as `TDEASE_SYSTEM_ASSETS`. */
  readonly systemAssetsRoot: string
  /** Full PEP 723 runtime env installed as the authoritative bash spawn env. */
  readonly resolveBashEnv: () => NodeJS.ProcessEnv
  /** The runtime's one outward event surface — turn events plus the read-side
   *  pushes (Run invalidation, subagent/job snapshots, context occupancy).
   *  See RuntimePush: the push vocabulary is named once and grows here. */
  readonly push: RuntimePush
  readonly usageLedger?: UsageLedger
  /** Local Node-catalog installation (Electron main owns the copy because the
   *  agent's filesystem reach ends at the Workspace). Absent in remote Backend
   *  mode — `nodes.install` then gates off with the boundary message. */
  readonly nodeCatalogInstaller?: (sourceDir: string) => Promise<NodeInstallOutcome>
  /** Discovery-layer model-metadata lookup (model-catalog-refresher's warm
   *  cache) feeding each host's unknown-model register branch. Optional. */
  readonly resolveModelMeta?: (providerId: string, modelId: string) => Promise<AgentModelMetadata | null>
}

/**
 * Compaction tuning from the app settings file's `compaction` block, passed
 * through to each Pi session's settings manager. Optional by contract: an
 * absent, half-written or empty block leaves Pi's own defaults in charge
 * (reserveTokens 16384 / keepRecentTokens 20000).
 */
export interface CompactionSettings {
  readonly reserveTokens?: number
  readonly keepRecentTokens?: number
}

function readCompactionSettings(settingsPath: string): CompactionSettings | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return undefined
  }
  const block = (parsed as { compaction?: unknown } | null)?.compaction;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined
  const raw = block as Record<string, unknown>
  const positiveNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  const reserveTokens = positiveNumber(raw.reserveTokens)
  const keepRecentTokens = positiveNumber(raw.keepRecentTokens)
  if (reserveTokens === undefined && keepRecentTokens === undefined) return undefined
  return {
    ...(reserveTokens !== undefined ? { reserveTokens } : {}),
    ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
  }
}

/**
 * The product entry point. Absorbs what runtime-bootstrap.ts used to forward:
 * the PEP 723 bash env is constructed here (resolveUv + skillRuntimeEnv), so
 * callers pass `isDev` / `systemCacheRoot` — never a hand-built env. The class
 * below stays the wiring seam; product code enters through this factory.
 */
export function createAgentRuntime(options: {
  settingsPath: string
  systemRoot: string
  agentDir: string
  managedBinDir?: string
  systemAssets: SystemAssetCatalog
  systemAssetsRoot: string
  systemCacheRoot: string
  isDev: boolean
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string>
  backendConnection: () => BackendConnection
  credentialKey?: CredentialKeyLookup
  nativeCliPath?: string
  push: RuntimePush
  usageLedger?: UsageLedger
  resolveModelMeta?: (providerId: string, modelId: string) => Promise<AgentModelMetadata | null>
}): AgentRuntime {
  const bashEnv = () => {
    const uvPath = resolveUv(options.isDev)
    return skillRuntimeEnv({
      isDev: options.isDev,
      uvPath,
      systemAssetsRoot: options.systemAssetsRoot,
      cacheRoot: options.systemCacheRoot,
    })
  }
  return new AgentRuntime({ ...options, resolveBashEnv: bashEnv })
}

interface BoundEntry {
  readonly input: BindSessionInput
  readonly host: SessionHost
  readonly approvals: NodeApprovalCoordinator
  readonly studio: StudioRuntime
  readonly store: NodeSessionStore
  readonly generation: number
  /**
   * The per-parent-session subagent registry. Set on bind (agent-runtime.ts
   * §11); `null` while the bind is still mid-flight (createSubagentRegistry
   * runs after the studio context). Used by the read-side inspector IPC.
   */
  subagents: SubagentCommandPort | null
  /**
   * Disposer for the registry's change subscription wired to `emit`, so the
   * runtime stops forwarding `subagent:changed` after the session is disposed.
   */
  sessionRuns: Map<RunId, RunSummary>
  unsubscribeSubagents?: () => void
  /** The background-job registry for this session (null before bind completes). */
  jobs: JobCommandPort | null
  /** Disposer for the job registry's change subscription (see unsubscribeSubagents). */
  unsubscribeJobs?: () => void
  /** Disposer for the session-run snapshot subscription (see unsubscribeJobs). */
  unsubscribeSessionRuns?: () => void
  /** The owner-scoped PTY registry backing the persistent bash tool. */
  ptyTerminals: PtyTerminalService
}

export class AgentRuntime {
  private readonly sessions = new Map<string, BoundEntry>()
  /**
   * child sessionId → parent sessionId. A subagent (or background job) session
   * is bound internally by the registry, not via the `agent:bind-session` IPC,
   * so it never gets an owner entry of its own in the main-process owner map.
   * This lookup lets the bootstrap `emit` route a child session's turn events
   * (text deltas, tool commits, …) to the renderer that owns its PARENT —
   * which is where a live `SubagentConversation` tab is watching that child.
   * Populated from the registry snapshot on every change; stale entries are
   * harmless (routing resolves the parent's owner, and a gone parent drops).
   */
  private readonly childSessions = new Map<string, string>()
  /**
   * approvalId → the session whose ApprovalCoordinator holds the pending
   * approval. Delegated children surface their cards on the parent's stream,
   * so the renderer resolves with the PARENT's sessionId; this map routes the
   * answer back to the child's own coordinator (whose grants and cancel
   * discipline stay child-scoped). Parent-session approvals are their own
   * holders and never enter the map.
   */
  private readonly approvalRouting = new Map<string, string>()
  private readonly generations = new Map<string, number>()
  private readonly providers: NodeProviderRegistry
  private readonly systemAssets
  private readonly observers: NodeObservers
  /** sessionId → compact eval audit file path (registered on bind, cleared on dispose). */
  private readonly auditFiles = new Map<string, string>()
  /** Serialized queue for whitelist policy writes (allow_always persistence). */
  private whitelistQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: AgentRuntimeOptions) {
    this.providers = new NodeProviderRegistry(options.settingsPath, options.credentialKey)
    this.systemAssets = createNodeSystemAssets(options.systemAssets)
    const ledger = options.usageLedger ?? createUsageLedger({ storagePath: path.join(options.systemRoot, 'usage-ledger.json') })
    this.observers = new NodeObservers({
      ledger,
      // Compact eval audit: append one flat JSON line per completed tool call to
      // <sessionDir>/tool-audit.jsonl. The full conversation truth stays in the
      // session's events.jsonl; this is the trimmed, scan-friendly index.
      toolAuditSink: (entry) => {
        const file = this.auditFiles.get(entry.sessionId)
        if (!file) return
        try {
          const dir = path.dirname(file)
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
        } catch (error) {
          // Observability, not a prerequisite — a failing audit write must never
          // break the turn (same contract as the observer's own try/catch).
          console.warn('[agent-runtime] tool-audit write failed', error)
        }
      },
    })
  }

  async bindSession(input: BindSessionInput): Promise<AgentBridgeResult<BoundSession>> {
    try {
      await this.dispose(input.sessionId)
      const workspaceRoot = await this.options.resolveWorkspaceRoot(input.workspaceId)
      const generation = (this.generations.get(input.sessionId) ?? 0) + 1
      this.generations.set(input.sessionId, generation)
      // Compact eval audit file lives beside the full transcript, in the same
      // session dir the SessionStore owns.
      this.auditFiles.set(input.sessionId, path.join(workspaceRoot, '.tdease', 'sessions', input.sessionId, 'tool-audit.jsonl'))
      const registry = createStudioCommandRegistry()
      // A delegated child inherits the parent's frozen ceiling AND rules
      // verbatim; it never re-resolves the workspace policy, which is how a
      // child could previously out-permit an `ask` parent via `authority: 'auto'`.
      const permissionProfile = input.delegation
        ? {
            ceiling: deepFreeze({ ...input.delegation.permissionCeiling }),
            rules: deepFreeze([...(input.delegation.permissionRules ?? [])]),
          }
        : await loadPermissionProfile(workspaceRoot, input.authority)
      const { toolProfile, toolCeiling } = this.resolveToolSurface(input, registry)
      const binding = deepFreeze<SessionBinding>({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        workspaceRoot,
        authority: input.authority,
        permissionCeiling: permissionProfile.ceiling,
        ...(permissionProfile.rules.length ? { permissionRules: permissionProfile.rules } : {}),
        toolCeiling,
        generation,
        systemPromptOverride: input.systemPromptOverride,
        ptcEnabled: input.ptcEnabled === true,
        ...(input.delegation ? { delegatedFrom: input.delegation.approvalPresenterSessionId } : {}),
        ...(input.toolAllowlist ? { delegationScope: input.toolAllowlist } : {}),
      })
      const store = new NodeSessionStore(workspaceRoot)
      const permission = new NodePermissionGateway(
        binding,
        path.join(this.options.systemRoot, 'wiki'),
        // The product's data root (system + backend state) is reachable by the
        // agent subject to the ask/auto ceiling — see NodePermissionGateway.
        path.dirname(this.options.systemRoot),
        // The skills/prompts root the agent sees as TDEASE_SYSTEM_ASSETS: the
        // string prefilter must recognize its absolute spellings as exposed,
        // not as workspace escapes.
        this.options.systemAssetsRoot,
      )
      const sink = this.createSink(binding)
      const presenterSessionId = input.delegation?.approvalPresenterSessionId
      const approvals = new NodeApprovalCoordinator((pending) => {
        if (this.generations.get(pending.sessionId) !== generation) return
        if (presenterSessionId) {
          // A delegated child has no renderer subscription of its own, so its
          // approval card rides the PARENT conversation's stream, stamped with
          // the parent's current generation so the parent's staleness guard
          // accepts it. Resolution routes back to this child's coordinator by
          // approvalId (see resolveApproval).
          const parentEntry = this.sessions.get(presenterSessionId)
          if (!parentEntry) return
          this.approvalRouting.set(pending.approvalId, pending.sessionId)
          this.options.push.turnEvent(presenterSessionId, {
            type: 'approval_requested',
            generation: parentEntry.generation,
            approvalId: pending.approvalId,
            action: pending.action,
            basis: pending.basis,
            args: pending.args,
          })
          return
        }
        sink.approvalRequested(pending.sessionId, pending.approvalId, pending.action, pending.basis, pending.args)
      }, (info) => {
        // "Always allow": persist the derived whitelist rule into THIS
        // workspace's policy. The overlay already covers the live session —
        // the write is for future binds, so it is queued and never awaited by
        // the tool loop.
        this.enqueueWhitelistWrite(workspaceRoot, info)
      })
      const { workspace, skills, prompt } = this.createSessionPipeline(input, workspaceRoot, toolProfile)
      // Session-scoped run channel (contracts.ts RuntimePush.sessionRuns):
      // runs DISPATCHED by this conversation (analysis run/submit, rerun) are
      // recorded here and pushed with live status, so the Agent page's run
      // list shows only this session's runs — never the workspace's history.
      // The status stream is the run repository's onChange; the dispatch hook
      // only seeds membership.
      const sessionRuns = new Map<RunId, RunSummary>()
      const { studio, context } = await this.createStudioContext(
        binding, registry, workspace, skills,
        permission, approvals, store,
        (run) => sessionRuns.set(run.id, run),
      )
      const emitSessionRuns = this.options.push.sessionRuns
      const pushSessionRuns = () => {
        if (!emitSessionRuns || sessionRuns.size === 0) return
        const live = studio.runs.snapshot().runs
        emitSessionRuns(input.sessionId,
          [...sessionRuns.keys()].map((id) => live.get(id) ?? sessionRuns.get(id)!))
      }
      const unsubscribeSessionRuns = studio.runs.onChange(pushSessionRuns)
      const { subagents, unsubscribeSubagents, jobs, unsubscribeJobs } =
        this.attachBackgroundTasks(input, binding, context, permission)
      // view.* — only a top-level session has a Workbench to point at; a
      // delegated child never drives the user's viewers. Set before the tool
      // surface so the family's `enabled` gate sees it.
      const emitView = this.options.push.view
      if (!input.delegation && emitView) {
        context.view = createViewPort({ workspaceRoot, sessionId: input.sessionId, emit: (envelope) => emitView(input.sessionId, envelope) })
      }
      const { producedPaths, ptcInternals } = this.attachPtc(input, binding, context, approvals, store)
      const { ptyTerminals, canonicalTools, toolNames, tools, activeToolNames, costGuard } =
        this.createToolSurface(binding, context, permission, registry, toolProfile, toolCeiling, producedPaths)
      // PTC internals go live: the callable list is the canonical surface
      // (names as the model sees them), actions resolve through the profile's
      // single tool-action table, and the turn id resolves through the host
      // once it exists.
      ptcInternals.tools = canonicalTools as unknown as ReadonlyArray<PtcToolLike>
      ptcInternals.actionForTool = toolProfile.actionForTool
      const events = new NodeEventAdapter({ toolNames: canonicalTools.map((tool) => tool.name) })
      const host = new SessionHost({
        binding,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        agentDir: this.options.agentDir,
        providers: this.providers,
        compactionSettings: readCompactionSettings(this.options.settingsPath),
        resolveModelMeta: this.options.resolveModelMeta,
        store,
        prompt,
        approvals,
        events,
        observers: this.observers,
        sink,
        tools,
        activeToolNames,
        toolNames,
        costGuard,
        actionForTool: (name) => toolProfile.actionForTool(toolNames.toCanonical(name)),
        // The ambient turn services, one seam (contracts.ts TurnAmbient):
        // drains feed the context hook's completion injection, the probe holds
        // the deadline while children run, image markers read through the
        // containment-checked bridge, and the occupancy push is
        // generation-guarded like createSink — a stale host emit must not
        // reach the renderer.
        ambient: {
          drainSettledJobs: () => jobs?.drainSettled() ?? [],
          drainSettledSubagents: () => subagents?.drainSettled() ?? [],
          drainSettledRuns: () => studio.runs.drainSettledRuns(),
          hasActiveSubagents: () => subagents?.list().some((record) => record.state === 'running') ?? false,
          readWorkspaceBytes: (relative) => workspace.readBytes(workspaceRoot, relative),
          workspaceFileSize: async (relative) => {
            try {
              return await workspace.fileSize(workspaceRoot, relative)
            } catch {
              return null
            }
          },
          emitContextUsage: (sessionId, usage) => {
            if (this.generations.get(binding.sessionId) === binding.generation) {
              this.options.push.contextUsage?.(sessionId, usage)
            }
          },
          producedPaths,
        },
      })
      const result = await host.initialize()
      ptcInternals.turnId = () => host.activeTurnId() ?? ''
      this.sessions.set(input.sessionId, { input, host, approvals, studio, store, generation, sessionRuns, subagents, unsubscribeSubagents, jobs, unsubscribeJobs, unsubscribeSessionRuns, ptyTerminals })
      return result
    } catch (error) {
      return failure('AGENT_BIND_FAILED', error, false)
    }
  }

  /** Read-side: the live snapshot of subagent records for a parent session. */
  listSubagents(sessionId: string): ReadonlyArray<SubagentStatus> {
    return this.sessions.get(sessionId)?.subagents?.list() ?? []
  }

  /**
   * The parent session that owns a child (subagent/job) session, or `undefined`
   * if `childSessionId` is not a known child. Used by the bootstrap `emit` to
   * route a child session's turn events to its parent's renderer — children are
   * bound internally and have no owner entry of their own.
   */
  parentSessionOf(childSessionId: string): string | undefined {
    return this.childSessions.get(childSessionId)
  }

  /** Read-side: cancel a subagent by id (parent session resolves the registry). */
  async cancelSubagent(parentSessionId: string, subagentId: string): Promise<{ ok: true; result?: SubagentStatus['result'] }> {
    const registry = this.sessions.get(parentSessionId)?.subagents
    if (!registry) throw new Error(`No subagent registry for session: ${parentSessionId}`)
    return registry.cancel(subagentId)
  }

  /** Read-side: peek a child's recent activity (panel conversation peek). */
  async peekSubagent(parentSessionId: string, subagentId: string, lines?: number): Promise<SubagentPeek> {
    const registry = this.sessions.get(parentSessionId)?.subagents
    if (!registry) throw new Error(`No subagent registry for session: ${parentSessionId}`)
    return registry.peek(subagentId, lines)
  }

  /** Read-side: the live snapshot of background-job records for a parent session. */
  listJobs(sessionId: string): ReadonlyArray<JobStatus> {
    return this.sessions.get(sessionId)?.jobs?.list() ?? []
  }

  /** Read-side: the runs this parent session dispatched (submit/rerun), with
   *  live status — the initial fill for the renderer's session-run store. */
  listSessionRuns(sessionId: string): ReadonlyArray<RunSummary> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return []
    const live = entry.studio.runs.snapshot().runs
    return [...entry.sessionRuns.values()].map((run) => live.get(run.id) ?? run)
  }

  /** Read-side: cancel a background job by id (parent session resolves the registry). */
  async cancelJob(parentSessionId: string, jobId: string): Promise<{ ok: true }> {
    const registry = this.sessions.get(parentSessionId)?.jobs
    if (!registry) throw new Error(`No job registry for session: ${parentSessionId}`)
    return registry.cancel(jobId)
  }

  /** Read-side: peek a job's recent stdout/stderr (panel tail view). */
  async peekJob(parentSessionId: string, jobId: string, lines?: number): Promise<JobPeek> {
    const registry = this.sessions.get(parentSessionId)?.jobs
    if (!registry) throw new Error(`No job registry for session: ${parentSessionId}`)
    return registry.peek(jobId, lines)
  }

  async prompt(input: PromptInput): Promise<AgentBridgeResult<PromptResult>> {
    const entry = this.sessions.get(input.sessionId)
    if (!entry) return failure('AGENT_SESSION_NOT_BOUND', new Error(`Agent session not bound: ${input.sessionId}`), false)
    try {
      return await entry.host.prompt(input.message, entry.input.mindset, input.inlineVisualization === true)
    } catch (error) {
      return failure('AGENT_PROMPT_FAILED', error, isTransientError(error))
    }
  }

  async abort(sessionId: string): Promise<{ ok: true }> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return { ok: true }
    // A user stop means "stop everything this conversation started". The
    // parent turn aborts first — its signal settles any wait tool the turn is
    // parked in (runs.wait / subagent.wait) — then the background work the
    // turn owned: running children settle as cancelled, keeping their partial
    // results (the same path as `subagent.cancel`). The budget-halt path
    // deliberately does NOT come through here: SessionHost.abort keeps
    // children alive so their results can drain (session-host.ts
    // MERGE_GRACE_MS).
    await entry.host.abort()
    // Background jobs are this conversation's children too: a user stop kills
    // every running job's process tree (the former gap — jobs survived abort)
    // and confirms the trees exited before returning.
    await entry.jobs?.cancelAll()
    const registry = entry.subagents
    if (registry) {
      for (const record of registry.list()) {
        if (record.state === 'running') await registry.cancel(record.subagentId).catch(() => undefined)
      }
    }
    return { ok: true }
  }

  async compact(sessionId: string): Promise<{ ok: true }> {
    const entry = requiredEntry(this.sessions, sessionId)
    await entry.host.compact()
    return { ok: true }
  }

  async fork(sessionId: string, targetSessionId: string): Promise<{ ok: true }> {
    // F12: a bound host owns the target's live state — forking into it would
    // clone artifacts underneath a running session. (The on-disk transcript
    // case is refused inside SessionHost.fork.)
    if (this.sessions.has(targetSessionId)) {
      throw new Error(`Cannot fork: target session ${targetSessionId} is bound to a live agent session`)
    }
    const entry = requiredEntry(this.sessions, sessionId)
    await entry.host.fork(targetSessionId)
    return { ok: true }
  }

  /**
   * Read the persisted canonical events of a bound session. Exposed to the
   * subagent registry so a spawn can extract the child's final assistant
   * message after `prompt` settles (SUBAGENT-RUNTIME.md §6). The child's events
   * are its own; they never stream into the parent transcript.
   */
  async readSessionEvents(sessionId: string): Promise<ReadonlyArray<SessionEvent>> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return []
    return entry.store.readEvents(sessionId)
  }

  resolveApproval(input: ResolveApprovalInput): { ok: true } {
    // The holder wins: a child's approval card arrives on the parent's stream,
    // so the addressed session and the coordinator that owns the pending
    // approval can differ. Unknown holder or disposed session is a clean
    // no-op — the same stale-answer contract the coordinator itself applies,
    // and the only safe answer across a dispose race (cancelSession already
    // rejected the promise the card was correlated with).
    const holder = this.approvalRouting.get(input.approvalId) ?? input.sessionId
    this.approvalRouting.delete(input.approvalId)
    const entry = this.sessions.get(holder) ?? this.sessions.get(input.sessionId)
    if (!entry) return { ok: true }
    entry.approvals.resolve(input.approvalId, input.decision)
    return { ok: true }
  }

  /**
   * Persist one "always allow" whitelist rule into the workspace policy
   * (`.tdease/permissions.json`), serialized through `whitelistQueue`.
   * Read-merge-write with the runtime's own parser: a hand-broken policy file
   * is never silently replaced from a card click — the write is skipped and
   * the user repairs the file (the settings editor surfaces the same error).
   * Idempotent (`mergeWhitelistRule` dedups), so double answers are no-ops.
   */
  private enqueueWhitelistWrite(workspaceRoot: string, derivation: WhitelistDerivation): void {
    this.whitelistQueue = this.whitelistQueue.then(async () => {
      const file = path.join(workspaceRoot, '.tdease', 'permissions.json')
      let rules: PermissionRule[] = []
      try {
        rules = parseWorkspacePermissionPolicy(await fs.readFile(file, 'utf8')).rules
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.warn('[agent-runtime] whitelist persist skipped: policy unreadable', error)
          return
        }
      }
      const merged = mergeWhitelistRule(rules, derivation)
      if (!merged.added) return
      await writeTextAtomicQueued(file, serializePolicy(merged.rules))
    }).catch((error) => {
      console.warn('[agent-runtime] whitelist persist failed', error)
    })
  }

  /** Dispose every bound session — the app-quit sweep (before-quit). Each
   *  dispose cancels its background jobs, disposes its PTYs and children, so
   *  a graceful exit leaves no owned process behind. */
  async disposeAll(): Promise<{ ok: true }> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.dispose(sessionId).catch(() => undefined)
    }
    return { ok: true }
  }

  async dispose(sessionId: string): Promise<{ ok: true }> {
    const entry = this.sessions.get(sessionId)
    // The child→parent routing map entry goes even when the session was
    // never bound (records restored from disk announce mappings eagerly).
    this.childSessions.delete(sessionId)
    if (!entry) return { ok: true }
    this.sessions.delete(sessionId)
    this.generations.set(sessionId, entry.generation + 1)
    // Approvals this session held die with it — drop their routing entries so
    // a late answer resolves on nothing instead of a revived session.
    for (const [approvalId, holder] of [...this.approvalRouting]) {
      if (holder === sessionId) this.approvalRouting.delete(approvalId)
    }
    // Running background jobs never outlive their owner session: their child
    // processes are killed (with exit confirmation, bounded) and the records
    // settle cancelled (partial output kept), alongside the teardown below.
    await entry.jobs?.cancelAll().catch(() => undefined)
    // Children (subagent sessions) never outlive the parent that owns them:
    // their hosts — and any PTY they spawned — go down with the parent.
    const children = [...this.childSessions.entries()]
      .filter(([, parent]) => parent === sessionId)
      .map(([child]) => child)
    for (const child of children) await this.dispose(child).catch(() => undefined)
    // Stop forwarding subagent records to a renderer that no longer owns this
    // session — otherwise a stale subscription survives a rebind and pushes
    // snapshots to the wrong owner.
    entry.unsubscribeSubagents?.()
    entry.unsubscribeJobs?.()
    entry.unsubscribeSessionRuns?.()
    try {
      await entry.host.dispose()
      entry.studio.dispose()
    } finally {
      // A live shell must never outlive its owner: PTY teardown runs even
      // when host/studio disposal throws, and the entry is already
      // unregistered above so a throw can never strand a session record.
      try {
        await entry.ptyTerminals.disposeAll()
      } finally {
        this.auditFiles.delete(sessionId)
      }
    }
    return { ok: true }
  }



  // ── bindSession's capability seams ────────────────────────────────────────
  // One named factory per seam; bindSession above is the ordered assembly
  // manifest. Each body is moved verbatim from the former 267-line method.

  /** The mindset/settings tool profile over the registry's exposure metadata,
   *  narrowed by an explicit allowlist when one is given, plus the frozen
   *  builtin/MCP ceiling derived from it. */
  private resolveToolSurface(input: BindSessionInput, registry: CommandRegistry): {
    toolProfile: AgentToolProfile
    toolCeiling: ToolCeiling
  } {
    const baseToolProfile = createAgentToolProfile(input.mindset, input.agentTools, registry.list())
    const exactTools = input.toolAllowlist ? new Set(input.toolAllowlist) : null
    const toolProfile: AgentToolProfile = exactTools
      ? {
          key: `${baseToolProfile.key}:${JSON.stringify([...exactTools].sort())}`,
          runtime: {
            builtins: baseToolProfile.runtime.builtins.filter((name) => exactTools.has(name)),
            mcp: baseToolProfile.runtime.mcp && exactTools.has('mcp'),
          },
          includeTodo: false,
          allowsStudioCommand: (id) => exactTools.has(id) && baseToolProfile.allowsStudioCommand(id),
          actionForTool: baseToolProfile.actionForTool,
        }
      : baseToolProfile
    return { toolProfile, toolCeiling: buildToolCeiling(toolProfile) }
  }

  /** The workspace bridge, skill catalog, and @-reference prompt pipeline. */
  private createSessionPipeline(input: BindSessionInput, workspaceRoot: string, toolProfile: AgentToolProfile): {
    workspace: ReturnType<typeof createNodeWorkspaceBridge>
    skills: ReturnType<typeof createNodeSkillCatalog>
    prompt: NodePromptPipeline
  } {
    const workspace = createNodeWorkspaceBridge(workspaceRoot)
    const skills = createNodeSkillCatalog(workspaceRoot, workspace, this.systemAssets)
    const prompt = new NodePromptPipeline({
      systemAssets: { readText: (relative) => this.systemAssets.readText(relative) },
      workspaceRoot,
      workspaceReadText: (relative) => workspace.readText(workspaceRoot, relative),
      systemReadText: (relative) => this.systemAssets.readText(relative),
      listSkillIndex: () => skills.index(),
      // The capability seam: the SAME resolved profile the gateway gates with,
      // reduced to the booleans prompt fragments may condition on. A fragment
      // can therefore assert only what the tool gate guarantees — the
      // prompt/tool desync class (doctrine naming tools the session lacks)
      // cannot re-enter through a new asset.
      capabilities: Object.freeze({
        shell: toolProfile.runtime.builtins.includes('bash'),
        write: toolProfile.runtime.builtins.includes('write'),
        subagents: toolProfile.allowsStudioCommand('subagent.spawn'),
      }),
      resolveRunReference: async (runId) => {
        // Dual identity: the Backend answer is authoritative whenever it is
        // reachable, because a local `runs/<id>/` directory exists from the
        // moment outputs start syncing and proves nothing about which results
        // are actually present. Only when the Backend cannot be reached does
        // the local directory stand alone — stated as unverified, never as
        // "Backend discovery is unnecessary".
        const localRun = path.join(workspaceRoot, 'runs', runId)
        const hasLocal = existsSync(localRun)
        let remote: Awaited<ReturnType<typeof resolveRunReference>> | undefined
        try {
          const client = new TDEaseClient(...connectionArgs(this.options.backendConnection()))
          remote = await resolveRunReference({ client, runId, workspaceId: input.workspaceId })
        } catch { remote = undefined }
        if (remote) {
          if (!hasLocal) return remote
          return {
            ...remote,
            body: `${remote.body}\n\nA local Workspace directory runs/${runId} exists; its presence alone does not prove results are synced — verify against the Backend manifest and materialize files with runs.listFiles / runs.pullFile (binding the result revision) before reading them.`,
          }
        }
        if (hasLocal) {
          return {
            name: runId,
            status: 'LOCAL',
            body: `A local Workspace Run directory runs/${runId} exists, but the Backend could not be reached to confirm this Run's identity or status. Treat local files as potentially partial; re-verify against the Backend when it is reachable.`,
          }
        }
        return undefined
      },
    })
    return { workspace, skills, prompt }
  }

  /** The background-task layer: subagent + job registries (task-records
   *  drivers) with their renderer push subscriptions. Mutates `context` so
   *  the enabled gates on the subagent / job commands advertise. */
  private attachBackgroundTasks(input: BindSessionInput, binding: SessionBinding, context: CommandContext, permission: NodePermissionGateway): {
    subagents: SubagentCommandPort
    unsubscribeSubagents: () => void
    jobs: JobCommandPort
    unsubscribeJobs: (() => void) | undefined
  } {
    const workspaceRoot = binding.workspaceRoot
    // Subagent three-primitives (§11): the port drives this very AgentRuntime
    // through a narrow surface (bindSession/prompt/abort/dispose/fork + read
    // the child's own events), cloning the parent's model/mindset/workspace.
    // Set before createToolGateway so the `enabled` gate on subagent.* sees it.
    context.subagents = createSubagentRegistry({
      runtime: this,
      parent: {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        mindset: input.mindset,
        // The delegation axes: children inherit the parent's authority label
        // and its FROZEN ceiling verbatim (subagent-registry.ts §spawn) —
        // never an auto re-resolution of the workspace policy.
        authority: input.authority,
        permissionCeiling: binding.permissionCeiling,
        ...(binding.permissionRules ? { permissionRules: binding.permissionRules } : {}),
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        agentTools: input.agentTools,
      },
      systemAssets: this.systemAssets,
      workspaceRoot,
    })
    // Forward registry change events to the owning renderer through a
    // dedicated `emitSubagents` callback (separate from the turn-event
    // `emit`) so the RuntimeEvent union stays pure — subagent records are a
    // read-side data stream, not a turn event. The renderer's subagent store
    // subscribes once per bound parent session and projects the snapshot
    // into its per-session list. The callback no-ops when no owner is
    // registered, so a dispose race is safe.
    const subagents = context.subagents
    const emitSubagents = this.options.push.subagents
    // Each registry change also refreshes the child→parent map so the
    // bootstrap `emit` can route a child session's turn events to this
    // parent's renderer (see `parentSessionOf` / main.ts `emit`).
    const unsubscribeSubagents = subagents.subscribe((snapshot) => {
      for (const record of snapshot) this.childSessions.set(record.subagentId, input.sessionId)
      if (emitSubagents) emitSubagents(input.sessionId, snapshot)
    })
    // Background job registry — same isolation pattern as subagents: a
    // session-scoped registry whose snapshots ride a dedicated emit channel
    // (never the turn-event stream). Long shell commands run async here; the
    // context hook (tdease-extension.ts) injects completion into the next
    // provider request. Set before createToolGateway so `job.*` `enabled`
    // gates see it.
    context.jobs = createJobRegistry({
      workspaceRoot,
      parentSessionId: input.sessionId,
      // The complete bash env (same factory the bash tool uses): without it
      // jobs missed TDEASE_WORKSPACE and the managed-bin PATH, and their
      // shell was cmd.exe — a correct bash command died as a literal
      // filename. One env, both runners.
      resolveEnv: () => buildBashEnv(
        workspaceRoot,
        this.options.managedBinDir ?? '',
        this.options.systemAssetsRoot,
        this.options.resolveBashEnv,
      ),
      permission,
    })
    const jobs = context.jobs
    const emitJobs = this.options.push.jobs
    const unsubscribeJobs = emitJobs
      ? jobs.subscribe((snapshot) => emitJobs(input.sessionId, snapshot))
      : undefined
    return { subagents, unsubscribeSubagents, jobs, unsubscribeJobs }
  }

  /** The produced-path ledger (shared by gateway hooks and the historical
   *  guard) and the opt-in PTC port. Returns the lazy internals the tool
   *  surface fills once it exists. */
  private attachPtc(input: BindSessionInput, binding: SessionBinding, context: CommandContext, approvals: NodeApprovalCoordinator, store: NodeSessionStore): {
    producedPaths: ReturnType<typeof createProducedPathLedger>
    ptcInternals: { tools: ReadonlyArray<PtcToolLike>; actionForTool: (name: string) => AgentPermissionAction | undefined; turnId: () => string }
  } {
    // Produced-path ledger, shared by this session's gateway and extension.
    // The extension's tool_result hook notes write/edit targets and consults
    // the ledger in the historical-analysis guard. Created before the gateway
    // so the extension's hook always sees the same ledger instance.
    const producedPaths = createProducedPathLedger()
    // PTC (docs/design/PTC-RUNTIME.md): programmatic tool calling — a JS
    // script's tool() calls execute gated invocations of the session's own
    // tools inside one tdease.ptc.exec call. A distinct opt-in from
    // orchestration (round-trip collapsing, not subagent organization, no
    // journal). The port is created before the gateway so the command's
    // `enabled` gate advertises it, but its internals resolve lazily: the
    // callable list and the canonical-name action map only exist after the
    // tool build below.
    const ptcInternals: {
      tools: ReadonlyArray<PtcToolLike>
      actionForTool: (name: string) => AgentPermissionAction | undefined
      turnId: () => string
    } = {
      tools: [],
      actionForTool: () => undefined,
      turnId: () => '',
    }
    if (input.ptcEnabled) {
      context.ptc = createPtcPort({
        binding,
        tools: () => ptcInternals.tools,
        gate: createToolCallGate({
          binding,
          approvals,
          producedPaths,
          actionForTool: (name) => ptcInternals.actionForTool(name),
          // Approval audit events persist straight through the session
          // store — the same EventInput stream the extension's hook appends;
          // PTC runs inside a tool call, so the host's turn queue is busy by
          // definition.
          append: async (event) => {
            await store.appendEvent(binding.sessionId, event)
          },
          turnId: () => ptcInternals.turnId(),
        }),
        observers: this.observers,
        producedPaths,
      })
    }
    return { producedPaths, ptcInternals }
  }

  /** The owner-scoped PTY registry and the session tool surface: builtin +
   *  studio + MCP tools, canonical names, provider-mapped descriptors, and
   *  the active-name set. */
  private createToolSurface(binding: SessionBinding, context: CommandContext, permission: NodePermissionGateway, registry: CommandRegistry, toolProfile: AgentToolProfile, toolCeiling: ToolCeiling, producedPaths: ReturnType<typeof createProducedPathLedger>): {
    ptyTerminals: PtyTerminalService
    canonicalTools: ToolDefinition[]
    toolNames: ReturnType<typeof createToolNameProtocol>
    tools: ToolDefinition[]
    activeToolNames: string[]
    costGuard: CostGuard
  } {
    const workspaceRoot = binding.workspaceRoot
    // Owner-scoped PTY registry: the persistent bash tool's terminal session
    // lives here, keyed to this agent session, and is disposed with it. One
    // registry per bound session — subagent sessions get their own, so a
    // child's shell can never be reached by the parent's tool calls.
    const ptyTerminals = new PtyTerminalService()
    // One cost guard per agent session, shared by the gateway (which trips
    // the rules on builtin reads) and the extension (which re-announces them
    // once per loop, so they survive compaction) — see cost-guard.ts.
    const costGuard = createCostGuard()
    const gateway = createToolGateway({
      binding,
      permission,
      workspaceRoot,
      systemRoot: this.options.systemRoot,
      terminals: ptyTerminals,
      systemAssetsRoot: this.options.systemAssetsRoot,
      resolveBashEnv: this.options.resolveBashEnv,
      managedBinDir: this.options.managedBinDir ?? path.join(this.options.agentDir, "tools"),
      studioContext: context,
      commandRegistry: registry,
      producedPaths,
      costGuard,
      profile: {
        // The mindset + Agent-Tools filter, applied once here in
        // buildStudioTools. Previously this was routed through a frozen
        // toolCeiling.studioCommands array that buildToolCeiling had already
        // filtered with this same predicate — a redundant membership re-check
        // that could never fail. See buildStudioTools (tool-gateway.ts).
        allowsStudioCommand: toolProfile.allowsStudioCommand,
        runtime: toolProfile.runtime,
      },
    })
    const canonicalTools = [
      ...gateway.buildBuiltinTools(toolCeiling.builtins),
      ...gateway.buildStudioTools(),
      gateway.buildMcpTool(),
    ].filter(Boolean) as ToolDefinition[]
    const toolNames = createToolNameProtocol(canonicalTools.map((tool) => tool.name))
    const tools = canonicalTools.map((tool) => ({
      ...tool,
      name: toolNames.toProvider(tool.name),
      description: toolNames.rewriteForProvider(tool.description),
    }))
    const activeToolNames = [...new Set([
      ...toolCeiling.builtins,
      ...tools.map((tool) => tool.name),
    ])]
    return { ptyTerminals, canonicalTools, toolNames, tools, activeToolNames, costGuard }
  }

  private createSink(binding: SessionBinding): RuntimeEventSink {
    const emit = (event: RuntimeEvent) => {
      if (this.generations.get(binding.sessionId) === binding.generation) this.options.push.turnEvent(binding.sessionId, event)
    }
    return {
      textDelta: (_sessionId, text) => emit({ type: 'text_delta', generation: binding.generation, text }),
      thinkingDelta: (_sessionId, text) => emit({ type: 'thinking_delta', generation: binding.generation, text }),
      approvalRequested: (_sessionId, approvalId, action, basis, args) => emit({
        type: 'approval_requested', generation: binding.generation, approvalId, action, basis, args,
      }),
      eventCommitted: (_sessionId, event) => emit({ type: 'event_committed', generation: binding.generation, event }),
      turnTerminal: (_sessionId, turnId, outcome, usage) => emit({
        type: 'turn_terminal', generation: binding.generation, turnId, outcome, usage,
      }),
    }
  }

  private async createStudioContext(
    binding: SessionBinding,
    registry: CommandRegistry,
    workspace: ReturnType<typeof createNodeWorkspaceBridge>,
    skills: ReturnType<typeof createNodeSkillCatalog>,
    permission: NodePermissionGateway,
    approvals: NodeApprovalCoordinator,
    store: NodeSessionStore,
    onRunDispatched: (run: RunSummary) => void,
  ): Promise<{ studio: StudioRuntime; context: CommandContext }> {
    const connection = this.options.backendConnection()
    const client = new TDEaseClient(connection.baseUrl, connection.agentToken ?? connection.accessToken)
    const infrastructure = createStudioInfrastructure(client, {
      readWorkspaceBlob: async (root, relative) => {
        const bytes = await workspace.readBytes(root, relative)
        return new Blob([bytes])
      },
    })
    const workspaceRepository = new DesktopWorkspaceRepository(
      { id: asWorkspaceId(binding.workspaceId), name: path.basename(binding.workspaceRoot) },
      binding.workspaceRoot,
      workspace,
      () => ({ start: async () => {}, stop: async () => {}, on: () => () => {} }),
    )
    const studio = new StudioRuntime({
      backend: infrastructure.agentGateway(binding.workspaceRoot),
      workspace: workspaceRepository,
      snapshotSelection: DEFAULT_SNAPSHOT_SELECTION,
      runSubscriptions: infrastructure.runSubscriptions,
      runRepository: infrastructure.runRepository,
      onRunsChanged: () => this.options.push.runsInvalidated?.(binding.workspaceId),
      onRunDispatched,
      templates: createSystemTemplateCatalog(this.systemAssets),
    })
    const postHookPermission = {
      decide: (action: AgentPermissionAction) => permission.decide(action) === 'deny' ? 'deny' as const : 'allow' as const,
      request: async () => true,
    }
    const context: CommandContext = {
      studio,
      workspaceId: asWorkspaceId(binding.workspaceId),
      permission: postHookPermission,
      skills: { list: () => skills.list(), read: (id, resource) => skills.read(id, resource) },
      references: createNodeReferenceCommandPort({
        writableReferenceRoot: path.join(this.options.systemRoot, 'reference'),
        resultStoreRoot: path.join(this.options.systemRoot, 'cache', 'reference-results'),
        uniprotBaseUrl: 'https://rest.uniprot.org',
      }),
      ...(this.options.nodeCatalogInstaller ? {
        nodeCatalog: {
          // A relative path names a folder inside this session's Workspace —
          // the only root the agent can legitimately point at.
          install: (sourceDir: string) => path.isAbsolute(sourceDir)
            ? this.options.nodeCatalogInstaller!(sourceDir)
            : this.options.nodeCatalogInstaller!(path.resolve(binding.workspaceRoot, sourceDir)),
        },
      } : {}),
    }
    return { studio, context }
  }
}

export function buildToolCeiling(profile: AgentToolProfile): ToolCeiling {
  // studioCommands is intentionally NOT here: it was a frozen snapshot of the
  // mindset filter whose only consumer re-checked membership with the same
  // predicate (redundant). The live mindset+settings gate now runs once, in
  // buildStudioTools, against profile.allowsStudioCommand directly. builtins
  // and mcp stay — they feed buildBuiltinTools and the MCP gate respectively.
  //
  // `todo_write` is appended here, not carried in runtime.builtins, because it
  // is a session-plan affordance shared by both parent mindsets, never a user
  // Agent Tools toggle — the settings union stays exactly the seven file/shell
  // names. Allowlist-narrowed (subagent) profiles set includeTodo:false, so a
  // child session can never plan: planning belongs to the parent.
  return deepFreeze({
    builtins: profile.includeTodo ? [...profile.runtime.builtins, 'todo_write'] : profile.runtime.builtins,
    mcp: profile.runtime.mcp,
  })
}

/**
 * Resolve the bind-time permission profile: the coarse per-action ceiling
 * (deny-dominant over the ladder + ACTION-LEVEL workspace rules, unchanged
 * v1 semantics) plus the parameterized overrides sorted for first-match
 * evaluation. Both freeze together into the binding; nothing here is ever
 * re-read mid-session (permission-gateway.ts header).
 */
async function loadPermissionProfile(workspaceRoot: string, authority: BindSessionInput['authority']) {
  const system: PermissionRule[] = systemRulesForMode(authority)
  let workspace: PermissionRule[] = []
  try {
    workspace = parseWorkspacePermissionPolicy(await fs.readFile(path.join(workspaceRoot, '.tdease', 'permissions.json'), 'utf8')).rules
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  // Only action-level rules feed the coarse ceiling — parameterized rules are
  // the override channel and must never tighten the ladder a v1 consumer sees.
  const actionLevel = (layer: PermissionRule[]): PermissionRule[] => layer.filter((rule) => !rule.match)
  const ceiling = deepFreeze(Object.fromEntries(AGENT_PERMISSION_ACTIONS.map((action) => [
    action,
    resolvePermission({ system, user: [], workspace: actionLevel(workspace) }, action),
  ])) as Record<AgentPermissionAction, AgentPermissionDecision>)
  const rules = deepFreeze(sortPermissionRules([
    ...system,
    ...workspace,
    // Ask authority mounts the shipped default review policy (−2: below
    // hand-written rules and the whitelist, above the ladder): dangerous
    // shell isolated, risky asks, innocuous commands just run.
    // Auto keeps the original behavior; the gateway guards hold regardless.
    ...defaultPolicyFor(authority),
  ].filter((rule) => rule.match)))
  return { ceiling, rules }
}

function connectionArgs(connection: BackendConnection): [string, string | null] {
  return [connection.baseUrl, connection.agentToken ?? connection.accessToken]
}

function requiredEntry(entries: ReadonlyMap<string, BoundEntry>, sessionId: string): BoundEntry {
  const entry = entries.get(sessionId)
  if (!entry) throw new Error(`Agent session not bound: ${sessionId}`)
  return entry
}

function failure(code: string, error: unknown, retryable: boolean) {
  return { ok: false as const, code, message: error instanceof Error ? error.message : String(error), retryable }
}
