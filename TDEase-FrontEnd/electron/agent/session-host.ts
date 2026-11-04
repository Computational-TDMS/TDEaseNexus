import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ContextUsage,
  type SessionEntry,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'

/**
 * The Pi SDK's own provider-api and thinking-level unions, derived from the
 * typed surface this file already consumes. The boundary casts below name
 * what they cross (our contracts' unions → Pi's) instead of erasing it with
 * `any`: if Pi narrows either union, these lines fail loudly.
 */
type PiProviderApi = NonNullable<Parameters<typeof ModelRuntime.prototype.registerProvider>[1]['api']>
type PiThinkingLevel = NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>['thinkingLevel']>

import { DEFAULT_TURN_BUDGETS } from '../../src/contracts/agent-runtime'
import type {
  AgentModelMetadata,
  BoundSession,
  ModelSelector,
  PromptResult,
  ThinkingLevel,
} from '../../src/contracts/agent-runtime'
import { toContextSnapshot } from './context-usage'
import type { CostGuard } from './cost-guard'
import { normalizeModelCard, resolveThinkingLevel } from './model-capabilities'
import { OAUTH_PROVIDER_IDS } from './provider-auth'
import type { EventInput } from '../../src/agent/events'
import { canonicalJson, deepFreeze, type AgentRunDefinition, type SessionBinding } from './turn-definition'
import type {
  ApprovalCoordinator,
  AssembledPrompt,
  EventAdapter,
  Observers,
  PromptPipeline,
  ProviderRegistry,
  ResolvedProvider,
  RuntimeEventSink,
  SessionStore,
  TurnAmbient,
} from './contracts'
import type { ToolNameProtocol } from '../../src/ai/core/tool-name-protocol'
import type { CostRates } from '../../src/ai/core/usage-ledger'
import { createTDEaseExtension, type ActiveAgentRun } from './tdease-extension'
import { buildTurnCard, TurnCardCollector } from './turn-card'
import { resolvePromptImages } from './image-attachment'

export interface SessionHostOptions {
  readonly binding: SessionBinding
  readonly model: ModelSelector
  readonly thinkingLevel: ThinkingLevel
  readonly agentDir: string
  readonly providers: ProviderRegistry
  readonly store: SessionStore
  readonly prompt: PromptPipeline
  readonly approvals: ApprovalCoordinator
  readonly events: EventAdapter & { reset?(): void }
  readonly observers: Observers
  readonly sink: RuntimeEventSink
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly activeToolNames: ReadonlyArray<string>
  readonly toolNames: ToolNameProtocol
  readonly actionForTool: (toolName: string) => import('../../src/contracts/agent-runtime').AgentPermissionAction | undefined
  /** The ambient services a live turn consults (drains, carve-out probe,
 *  image bytes, produced paths, occupancy push) — see TurnAmbient. */
  readonly ambient: TurnAmbient
  /** Cost guard shared with this session's tool gateway: the extension resets
   *  its per-turn ledgers at loop open and re-announces tripped rules
   *  (compaction survival). Optional: absent in hosts built without one. */
  readonly costGuard?: CostGuard
  /** Compaction tuning (`compaction` block of the app settings file), passed
   * through to Pi's settings manager. Optional: absent → Pi's defaults. */
  readonly compactionSettings?: { reserveTokens?: number; keepRecentTokens?: number }
  /** Discovery-layer capability digest for models neither settings.json nor
   * Pi's catalog knows (model-catalog-refresher's warm cache — offline).
   * Consulted once, in the unknown-model register branch, and the answer is
   * persisted as settings truth. Optional: hosts without a catalog keep the
   * conservative register defaults. */
  readonly resolveModelMeta?: (providerId: string, modelId: string) => Promise<AgentModelMetadata | null>
}

export class SessionHost {
  private session: AgentSession | null = null
  private unsubscribe: (() => void) | null = null
  private activeRun: ActiveAgentRun | null = null
  private persistenceTail = Promise.resolve()
  /** First unsettled append failure (F1): rethrown by flushPersistence(). */
  private persistenceFailure: unknown = null
  private observedEvents = 0
  private prompting = false
  private disposed = false
  private provider!: ResolvedProvider
  /** Per-token cost rates resolved at bind (pi catalog / settings meta) — handed to startUsage. */
  private modelCost?: CostRates

  /** The active run's turn id, or null between runs. Read by the PTC
   *  workflow's gate so approval audit events land on the turn the script
   *  executed inside. */
  activeTurnId(): string | null {
    return this.activeRun?.definition.turnId ?? null
  }
  /** Set by abort() — a turn that settles with this flag is `cancelled`, not
   *  `resolved`: Pi resolves prompt() normally after an abort instead of
   *  throwing, so the user-stop outcome is read from the flag, not the catch. */
  private abortRequested = false
  /** The resolved model declares image input (`input: ['text','image']`). */
  private supportsImages = false
  private currentModel: ModelSelector
  private currentThinking: ThinkingLevel
  private resumed = false
  private resumeError: string | null = null
  private turnCards: TurnCardCollector | null = null
  // 0-based index of the next turn card; -1 until lazily seeded from the
  // existing turns.jsonl on the first turn of this host (resume-safe).
  private nextTurnIndex = -1
  // Context-usage emit throttle. `undefined` means "never measured yet", so the
  // first reading always fires even when it is 0 or null.
  private contextUsageTimer: ReturnType<typeof setTimeout> | null = null
  private lastContextTokens: number | null | undefined = undefined

  constructor(private readonly options: SessionHostOptions) {
    this.currentModel = options.model
    this.currentThinking = options.thinkingLevel
  }

  async initialize(): Promise<BoundSession> {
    this.provider = this.options.providers.resolve(this.currentModel)
    // OAuth-backed providers authenticate through the shared auth.json via
    // their pi-side identity (provider-auth.ts owns the mapping and the
    // login flow) — no apiKey in settings.json is expected for them.
    const piProviderId = OAUTH_PROVIDER_IDS[this.currentModel.providerId] ?? this.currentModel.providerId
    const oauthBacked = piProviderId !== this.currentModel.providerId
    if (!this.provider.apiKey && !oauthBacked) {
      throw new Error(`Provider credential is missing: ${this.provider.providerId}`)
    }
    this.options.store.ensureSessionDirs(this.options.binding.sessionId)

    // One runtime owns both credentials and the model catalog;
    // create() touches no network by default, so bind stays deterministic.
    // The authPath MUST match provider-auth.ts's login target: an OAuth
    // login in Settings is a login for every session.
    const modelRuntime = await ModelRuntime.create({ authPath: join(this.options.agentDir, 'auth.json') })
    if (this.provider.apiKey) await modelRuntime.setRuntimeApiKey(piProviderId, this.provider.apiKey)
    let model = modelRuntime.getModel(piProviderId, this.provider.modelId)
    let seamMeta: AgentModelMetadata | undefined = this.provider.modelMeta
    // A settings baseUrl override must win over the native catalog: Pi bakes
    // vendor endpoints (e.g. deepseek -> api.deepseek.com) into its native
    // models, so a found model whose endpoint differs from the resolved
    // provider config is stale — the user's endpoint (or a test double) would
    // be silently ignored and the key sent to the vendor. Re-register with
    // settings truth in that case, same as the not-found path.
    const needsEndpointOverride =
      !!model && !!this.provider.baseUrl && model.baseUrl !== this.provider.baseUrl
    if (!model || needsEndpointOverride) {
      // Settings truth first. When the user has no metadata for this model,
      // the discovery layer's digest (models.dev via the refresher's warm
      // cache — a local read, bind stays offline) fills the card and is
      // frozen into settings.json, where the next bind reads it as plain
      // truth and a hand edit still outranks every other layer.
      if (!seamMeta && this.options.resolveModelMeta) {
        try {
          seamMeta = await this.options.resolveModelMeta(this.currentModel.providerId, this.provider.modelId) ?? undefined
        } catch { /* discovery is best-effort; the conservative defaults apply */ }
        if (seamMeta) await this.options.providers.persistModelMeta?.(this.currentModel, seamMeta)
      }
      const meta = seamMeta
      modelRuntime.registerProvider(piProviderId, {
        name: piProviderId,
        baseUrl: this.provider.baseUrl,
        apiKey: this.provider.apiKey,
        api: this.provider.api as PiProviderApi,
        headers: this.provider.headers,
        models: [{
          id: this.provider.modelId,
          name: this.provider.modelId,
          api: this.provider.api as PiProviderApi,
          baseUrl: this.provider.baseUrl,
          // reasoning defaults TRUE, not false: when neither settings nor the
          // discovery digest knows this model, a false default silently
          // discarded the user's thinking level (the wire params are gated on
          // this flag downstream). A model that truly rejects reasoning
          // params fails loudly at request time, which is recoverable; the
          // silent no-op was not. Settings-declared meta still wins.
          reasoning: meta?.reasoning ?? true,
          input: meta?.input ?? ['text'],
          cost: meta?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: meta?.contextWindow ?? 128_000,
          maxTokens: meta?.maxTokens ?? 8_192,
        }],
      })
      model = modelRuntime.getModel(piProviderId, this.provider.modelId)
    }
    if (!model) throw new Error(`Unable to configure Pi model ${this.provider.providerId}/${this.provider.modelId}`)
    this.supportsImages = (model.input ?? ['text']).includes('image')
    // The ONE capability seam: precedence (settings → verified correction →
    // card → standard) plus the thinking ceiling live in model-capabilities.
    model = normalizeModelCard(model, seamMeta)
    // Effective per-token rates for usage accounting, resolved ONCE at bind.
    // pi's native catalog (deepseek, anthropic, …) is the only place cost
    // exists for key-only configs — settings modelMeta is undefined there, so
    // without this handoff every costTotal landed null (observers' settings
    // fallback alone can never see the pi catalog).
    this.modelCost = model.cost

    const extension = createTDEaseExtension({
      binding: this.options.binding,
      store: this.options.store,
      prompt: this.options.prompt,
      approvals: this.options.approvals,
      observers: this.options.observers,
      activeRun: () => this.activeRun,
      activeModel: () => this.currentModel,
      activeThinkingLevel: () => this.currentThinking,
      actionForTool: this.options.actionForTool,
      ambient: this.options.ambient,
      isBlockedReport: (name) => this.options.toolNames.toCanonical(name) === 'tdease.session.reportBlocked',
      isTodoWrite: (name) => this.options.toolNames.toCanonical(name) === 'todo_write',
      append: (event) => this.enqueueAppend(event),
      costGuard: this.options.costGuard,
    })
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.binding.workspaceRoot,
      agentDir: this.options.agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [extension],
      systemPrompt: 'TDEase initializes the run prompt in before_agent_start.',
    })
    await resourceLoader.reload()

    let sessionManager: SessionManager
    try {
      this.resumed = this.options.store.hasTranscript(this.options.binding.sessionId)
      sessionManager = this.resumed
        ? SessionManager.continueRecent(this.options.binding.workspaceRoot, this.options.store.modelSessionDir(this.options.binding.sessionId))
        : SessionManager.create(this.options.binding.workspaceRoot, this.options.store.modelSessionDir(this.options.binding.sessionId))
    } catch (error) {
      this.resumeError = error instanceof Error ? error.message : String(error)
      this.resumed = false
      // Quarantine, don't overwrite: the unreadable transcript stays on disk
      // (renamed aside, the corrupt-run.json discipline) instead of being
      // left in place — a corrupt model-session/ left where it is would trip
      // every future bind into this same silent fresh-start, and a fresh
      // session written into the same dir would bury the evidence.
      this.quarantineCorruptTranscript()
      sessionManager = SessionManager.create(this.options.binding.workspaceRoot, this.options.store.modelSessionDir(this.options.binding.sessionId))
    }

    const created = await createAgentSession({
      cwd: this.options.binding.workspaceRoot,
      agentDir: this.options.agentDir,
      modelRuntime,
      model,
      // Ceiling semantics: the requested level is resolved DOWNWARD against
      // the normalized model HERE, so Pi's own (upward-walking) clamp has
      // nothing left to change — the UI selection can only lower effort,
      // never raise it.
      thinkingLevel: resolveThinkingLevel(model, this.currentThinking) as PiThinkingLevel,
      settingsManager: SettingsManager.inMemory({
        defaultProvider: this.provider.providerId,
        defaultModel: this.provider.modelId,
        ...(this.options.compactionSettings ? { compaction: this.options.compactionSettings } : {}),
      }),
      sessionManager,
      resourceLoader,
      tools: [...this.options.activeToolNames],
      customTools: [...this.options.tools],
    })
    this.session = created.session
    this.unsubscribe = created.session.subscribe((event) => this.observe(event))
    // Resume-safe initial reading: a continued session has a real transcript,
    // so the gauge populates immediately without waiting for the first turn.
    this.scheduleContextUsage(true)

    return {
      ok: true,
      generation: this.options.binding.generation,
      resumed: this.resumed,
      resumeError: this.resumeError,
      modelMeta: {
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
      provider: {
        providerId: this.provider.providerId,
        displayName: this.provider.providerId,
        models: [this.provider.modelId],
        configured: true,
      },
    }
  }

  async prompt(message: string, mindset: AgentRunDefinition['mindset'], inlineVisualization = false): Promise<PromptResult> {
    const session = this.requiredSession()
    if (this.prompting) throw new Error('This Agent session already has a prompt in flight')
    this.prompting = true
    try {
      return await this.promptInner(message, mindset, session, inlineVisualization)
    } finally {
      this.activeRun = null
      this.turnCards = null
      this.prompting = false
    }
  }

  private async promptInner(message: string, mindset: AgentRunDefinition['mindset'], session: AgentSession, inlineVisualization: boolean): Promise<PromptResult> {
    this.observedEvents = 0
    this.options.events.reset?.()
    this.abortRequested = false
    const startedAt = Date.now()
    const turnId = randomUUID()
    this.turnCards = new TurnCardCollector()
    const references = await this.options.prompt.resolveReferences(message)
    const referencedAssetsDigest = sha256(canonicalJson(references))
    const definition = deepFreeze<AgentRunDefinition>({
      turnId,
      userMessage: message,
      mindset,
      budgets: DEFAULT_TURN_BUDGETS,
      referencedAssetsDigest,
      initialModel: this.currentModel,
      initialThinkingLevel: this.currentThinking,
      inlineVisualization,
    })
    const canonicalPrompt = await this.options.prompt.assembleForRun(this.options.binding, definition, references)
    const assembled = rewritePromptForProvider(canonicalPrompt, this.options.toolNames)
    await this.options.store.writeSnapshot(this.options.binding.sessionId, assembled.digest, assembled.systemPrompt)
    this.activeRun = { definition, prompt: assembled, requestSeq: 0, toolCalls: 0, blocked: null }
    // F1: handled fire-and-forget — surfaced via flushPersistence below.
    this.enqueueAppend({
      type: 'turn.started',
      turn_id: turnId,
      user_message: message,
      prompt_snapshot_digest: assembled.digest,
      model: `${this.currentModel.providerId}/${this.currentModel.modelId}`,
      mindset,
      authority: this.options.binding.authority,
    }).catch(() => undefined)

    const usageHandle = this.options.observers.startUsage({ model: this.currentModel, provider: this.provider, cost: this.modelCost })
    let outcome: PromptResult['outcome'] = 'resolved'
    let failureTerminal: EventInput | null = null
    // The caught error, kept for the ledger settlement below — settled.usage
    // only exists after the collector finishes, so the error must survive to
    // the single settlement point.
    let failure: unknown = null
    // The wall-clock budget's only enforcement point. Firing aborts the
    // in-flight prompt through the same path as a user stop (pending approvals
    // are cancelled too); the catch below reads `halted` and settles the turn
    // as `halted` — budget exhausted, distinct from `cancelled` (AGENT-LOOP.md
    // §3-4). Cleared the moment the prompt settles, so it can never leak into
    // a later turn of this session.
    //
    // Delegation carve-out (harness_5a5857d4 lesson): a parent that dispatched
    // deep-research children may spend most of its budget legitimately WAITING
    // on them; aborting mid-wait orphans their results the moment they settle
    // (the 30-minute budget expired on 26-minute children and the merge never
    // ran). So when the deadline fires with subagents still running, the abort
    // HOLDS until the registry empties, then grants one short merge grace for
    // the settlement drain to reach the parent model, then aborts. A hard
    // deferral cap keeps a wedged child from stretching the turn forever; a
    // turn without active subagents aborts exactly as before.
    let halted = false
    const MERGE_GRACE_MS = 120_000
    const MAX_DEFERRAL_MS = 15 * 60_000
    let holdInterval: ReturnType<typeof setInterval> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const issueHalt = () => {
      halted = true
      void this.abort().catch(() => undefined)
    }
    const deadline = setTimeout(() => {
      if (!this.options.ambient.hasActiveSubagents()) {
        issueHalt()
        return
      }
      const exhaustedAt = Date.now()
      holdInterval = setInterval(() => {
        if (!this.options.ambient.hasActiveSubagents()) {
          clearInterval(holdInterval)
          holdInterval = undefined
          graceTimer = setTimeout(issueHalt, MERGE_GRACE_MS)
        } else if (Date.now() - exhaustedAt >= MAX_DEFERRAL_MS) {
          clearInterval(holdInterval)
          holdInterval = undefined
          issueHalt()
        }
      }, 5_000)
    }, definition.budgets.wallClockMs)
    try {
      const images = await resolvePromptImages({
        message,
        supportsImages: this.supportsImages,
        readBytes: (relative) => this.options.ambient.readWorkspaceBytes(relative),
        sizeOf: async (relative) => await this.options.ambient.workspaceFileSize?.(relative) ?? null,
      })
      await session.prompt(message, images && images.length > 0 ? { images } : undefined)
      // Pi may resolve prompt() normally after abort instead of throwing. The
      // deadline remains authoritative regardless of that provider/runtime
      // detail; a turn stopped by the lifecycle guard is never resolved.
      if (halted) outcome = 'halted'
      // Same for a user stop: the flag is the truth (see abortRequested), and
      // an assistant error observed under abort is the abort's wake, not a
      // provider failure worth reporting as 'failed'.
      else if (this.abortRequested) {
        outcome = 'cancelled'
        failureTerminal = { type: 'turn.cancelled', turn_id: turnId }
      } else {
        throwIfAssistantFailed(session.messages.at(-1))
      }
    } catch (error) {
      failure = error
      if (halted) {
        outcome = 'halted'
      } else {
        const cancelled = isAbort(error)
        outcome = cancelled ? 'cancelled' : 'failed'
        failureTerminal = cancelled
          ? { type: 'turn.cancelled', turn_id: turnId }
          : { type: 'turn.failed', turn_id: turnId, error: toSessionError(error) }
      }
    } finally {
      clearTimeout(deadline)
      if (holdInterval) clearInterval(holdInterval)
      if (graceTimer) clearTimeout(graceTimer)
    }

    // Finalize — identical for every outcome. The stream is flushed FIRST,
    // then the collector's unflushed tail (a failed/cancelled turn still said
    // things), and ONLY THEN the terminal event. Writing the terminal event
    // ahead of the acts, or dropping the collector tail, is how a conversation
    // silently loses its end.
    await this.flushPersistence()
    const settled = this.options.events.finish()
    for (const event of settled.events.slice(this.observedEvents)) {
      this.turnCards?.observe(event)
      this.enqueueAppendAct(turnId, event)
    }
    // A successfully completed reportBlocked call settles the turn as blocked
    // (AGENT-LOOP.md §3) — recorded on the active run by the tool_result hook.
    if (outcome === 'resolved' && this.activeRun?.blocked) outcome = 'blocked'
    // Resolved, blocked and halted turns did real work and keep their token
    // counts; cancelled and failed turns report zero, as before.
    const counted = outcome === 'resolved' || outcome === 'blocked' || outcome === 'halted'
    const usage = {
      input_tokens: counted ? settled.usage.input_tokens : 0,
      output_tokens: counted ? settled.usage.output_tokens : 0,
      tool_calls: this.activeRun?.toolCalls ?? 0,
      wall_clock_ms: Date.now() - startedAt,
    }
    // Ledger settlement — exactly one path per turn, after the collector
    // finish() so partial usage of the LLM calls that did complete rides the
    // entry even when the turn failed. Skipping settlement for any outcome
    // (the former halted-resolved path) leaked the pending handle and erased
    // the turn's real consumption from every statistic.
    if (outcome === 'resolved' || outcome === 'blocked') {
      this.options.observers.finishUsage(usageHandle, settled.usage)
    } else if (outcome === 'failed') {
      this.options.observers.errorUsage(usageHandle, failure ?? new Error('agent turn failed'), 'error', settled.usage)
    } else {
      // halted (wall-clock budget) and cancelled (user stop) settle as
      // aborted — their completed calls were billed like anyone else's.
      this.options.observers.errorUsage(usageHandle, failure ?? new Error('aborted'), 'aborted', settled.usage)
    }
    let terminal: EventInput
    if (outcome === 'resolved' || outcome === 'blocked' || outcome === 'halted') {
      // Inline narrowing: outcome is now the vocabulary's three-value
      // TurnOutcome ('resolved' | 'blocked' | 'halted'). The runtime
      // TurnOutcome also admits 'cancelled' | 'failed', but those never reach
      // this branch — `counted` above guarded the same set for token counts.
      terminal = { type: 'turn.completed', turn_id: turnId, outcome, usage }
    } else {
      terminal = failureTerminal!
    }
    this.enqueueAppend(terminal).catch(() => undefined)
    await this.flushPersistence()
    // The turn card rides the same append queue AFTER the terminal event, so
    // turns.jsonl can never claim a turn settled before events.jsonl says so.
    // Every outcome gets a card — a failed or cancelled turn is exactly what a
    // retrospective needs. A card that cannot be written must never fail the
    // turn it only summarizes.
    await this.writeTurnCard(turnId, message, startedAt, outcome, usage)
    // Force-emit before the terminal so the gauge settles on the final reading
    // instead of waiting on a throttled timer that may never fire.
    this.scheduleContextUsage(true)
    this.options.sink.turnTerminal(this.options.binding.sessionId, turnId, outcome, usage)
    return { ok: true, generation: this.options.binding.generation, turnId, outcome, usage }
  }

  /**
   * Move an unreadable Pi transcript aside as `model-session.corrupt-<ts>/`
   * and recreate the empty dir, so the fresh start that follows cannot bury
   * the corrupt original (kept for diagnosis) and the next bind does not trip
   * over it again. Best-effort: a rename failure must not block the fresh
   * start — it only means the old files stay in place.
   */
  private quarantineCorruptTranscript(): void {
    const dir = this.options.store.modelSessionDir(this.options.binding.sessionId)
    try {
      renameSync(dir, `${dir}.corrupt-${Date.now()}`)
    } catch (error) {
      console.warn('[session-host] corrupt transcript quarantine failed', error)
      return
    }
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      console.warn('[session-host] transcript dir recreation failed', error)
    }
  }

  async abort(): Promise<void> {
    this.abortRequested = true
    this.options.approvals.cancelSession(this.options.binding.sessionId)
    await this.session?.abort()
  }

  async compact(): Promise<void> {
    await this.requiredSession().compact()
    // Pi's getContextUsage returns tokens:null right after a compaction (the
    // last usage predates it), so force-emit so the gauge flips to "—" now.
    this.scheduleContextUsage(true)
    // The compaction_end marker was enqueued by observeCompaction() while
    // session.compact() ran; flush the append track so a renderer
    // re-projection issued right after compact() resolves already sees it.
    await this.flushPersistence()
  }

  async fork(targetSessionId: string): Promise<void> {
    // F12: refuse a fork onto an occupied target. Failure scenario: a fork
    // into a session id that already has a transcript silently merges two
    // conversations (cloneConversation appends/overwrites artifacts) and
    // desyncs the UI from events.jsonl.
    if (this.options.store.hasTranscript(targetSessionId)) {
      throw new Error(`Cannot fork: target session ${targetSessionId} already has a transcript`)
    }
    const session = this.requiredSession()
    const manager = session.sessionManager
    const leaf = manager.getLeafId()
    if (!leaf) throw new Error('Cannot fork an empty Pi session')
    // Flush first: the fork must copy the conversation's full current state,
    // not whatever happened to be on disk when the UI asked.
    await this.flushPersistence()
    await this.options.store.cloneConversation(this.options.binding.sessionId, targetSessionId)
    const temporary = manager.createBranchedSession(leaf)
    if (!temporary) throw new Error('Pi session is not persisted')
    SessionManager.forkFrom(temporary, this.options.binding.workspaceRoot, this.options.store.modelSessionDir(targetSessionId))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.contextUsageTimer) {
      clearTimeout(this.contextUsageTimer)
      this.contextUsageTimer = null
    }
    await this.abort().catch(() => undefined)
    this.unsubscribe?.()
    this.unsubscribe = null
    this.session?.dispose()
    this.session = null
  }

  private observe(raw: unknown): void {
    const transient = this.options.events.transientDelta(raw)
    if (transient?.kind === 'text') this.options.sink.textDelta(this.options.binding.sessionId, transient.text)
    if (transient?.kind === 'thinking') this.options.sink.thinkingDelta(this.options.binding.sessionId, transient.text)
    // Compaction is session-scoped, so it is recorded BEFORE the active-run
    // gate: manual /compact runs between turns, where `activeRun` is null.
    this.observeCompaction(raw)
    const active = this.activeRun
    if (!active) return
    const events = this.options.events.observe(raw)
    this.observedEvents += events.length
    for (const event of events) {
      this.turnCards?.observe(event)
      this.enqueueAppendAct(active.definition.turnId, event)
    }
  }

  /**
   * A completed compaction is a settled fact — the context above it was
   * summarized away — so it enters the ONE append track as `context.compacted`
   * and the transcript's compacted divider projects from it, surviving reload
   * like every other event. Pi emits `compaction_end` for the manual /compact
   * path AND for automatic threshold/overflow compaction mid-turn; an aborted
   * or failed compaction changed nothing, so it records nothing. The enqueue
   * is fire-and-forget like the act path: a manual compact flushes right
   * after (compact()), an automatic one rides the turn's own flush, so a
   * persistence failure is still surfaced loudly, not dropped.
   */
  private observeCompaction(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return
    const event = raw as { type?: unknown; reason?: unknown; aborted?: unknown; result?: unknown }
    if (event.type !== 'compaction_end' || event.aborted === true) return
    if (typeof event.result !== 'object' || event.result === null) return
    const result = event.result as { tokensBefore?: unknown; estimatedTokensAfter?: unknown }
    const reason = event.reason === 'threshold' || event.reason === 'overflow' ? event.reason : 'manual'
    // F1: handled fire-and-forget — a manual compact flushes right after, an
    // automatic one rides its turn's flush; both rethrow via flushPersistence.
    this.enqueueAppend({
      type: 'context.compacted',
      reason,
      ...(typeof result.tokensBefore === 'number' && Number.isFinite(result.tokensBefore)
        ? { tokens_before: Math.max(0, Math.round(result.tokensBefore)) }
        : {}),
      ...(typeof result.estimatedTokensAfter === 'number' && Number.isFinite(result.estimatedTokensAfter)
        ? { tokens_after: Math.max(0, Math.round(result.estimatedTokensAfter)) }
        : {}),
    }).catch(() => undefined)
  }

  /**
   * The ONE append track. Every canonical event — turn lifecycle, streamed
   * acts, extension approvals — enters the same per-session queue, so the
   * on-disk order always matches the order facts happened. Returns the queue
   * position so callers that must await the commit (e.g. the extension before
   * blocking on an approval) can.
   *
   * Failure model (F1 recovery): each append chains onto the previous
   * append's SETTLEMENT (either outcome), so one transient append failure can
   * neither poison the tail — silently skipping every later append for the
   * binding's life — nor leak its rejection into the utility child, where an
   * unhandled rejection terminates the process (utility-host.ts exit(1)).
   * Persistence errors stay LOUD instead: the first failure is recorded and
   * rethrown by the next flushPersistence(), failing the turn; the queue
   * itself stays armed for the turn after.
   */
  private enqueueAppend(event: EventInput): Promise<void> {
    const run = () => this.append(event).catch((error: unknown) => {
      if (!this.persistenceFailure) this.persistenceFailure = error
      throw error
    })
    const next = this.persistenceTail.then(run, run)
    // The tail never rejects: it only sequences, so an unsettled caller
    // rejection can never become an unhandled one downstream.
    this.persistenceTail = next.then(() => undefined, () => undefined)
    return next
  }

  private enqueueAppendAct(turnId: string, event: import('../../src/agent/events').ActEvent): void {
    // Fire-and-forget, but HANDLED (F1): the rejection is re-surfaced loudly
    // by flushPersistence() at the turn boundary via persistenceFailure.
    this.enqueueAppend({ ...event, turn_id: turnId } as EventInput).catch(() => undefined)
  }

  /**
   * Append this turn's TurnCard to turns.jsonl through the ONE append track.
   * Best-effort by contract: the index seeding read and the write are both
   * allowed to fail without affecting the turn — the card is a roadmap aid,
   * not part of the conversation's truth (that is events.jsonl's job).
   */
  private async writeTurnCard(
    turnId: string,
    userMessage: string,
    startedAt: number,
    outcome: PromptResult['outcome'],
    usage: { input_tokens: number; output_tokens: number; wall_clock_ms: number },
  ): Promise<void> {
    try {
      if (this.nextTurnIndex < 0) {
        this.nextTurnIndex = (await this.options.store.readTurnCards(this.options.binding.sessionId)).length
      }
      const collector = this.turnCards ?? new TurnCardCollector()
      const card = buildTurnCard({
        turnId,
        sessionId: this.options.binding.sessionId,
        index: this.nextTurnIndex,
        startedAt,
        userMessage,
        outcome,
        usage,
      }, collector)
      this.nextTurnIndex += 1
      // F1: chain onto the tail's settlement (either outcome) so a previously
      // failed append cannot skip the card write, and keep the tail non-rejecting.
      const next = this.persistenceTail.then(
        () => this.options.store.appendTurnCard(this.options.binding.sessionId, card),
        () => this.options.store.appendTurnCard(this.options.binding.sessionId, card),
      )
      this.persistenceTail = next.then(() => undefined, () => undefined)
      await this.flushPersistence()
    } catch {
      // A turn never fails because its roadmap card could not be written.
    }
  }

  private async append(event: EventInput): Promise<void> {
    const committed = await this.options.store.appendEvent(this.options.binding.sessionId, event)
    this.options.sink.eventCommitted(this.options.binding.sessionId, committed)
    // Pi mutates session.messages synchronously before the canonical event is
    // emitted, so by the time we commit, getContextUsage() reflects the new
    // state. Throttled — the gauge settles at the turn boundary regardless.
    this.scheduleContextUsage()
  }

  private async flushPersistence(): Promise<void> {
    // Wait for every queued append to settle; the tail itself never rejects
    // (F1), so this await cannot throw — the failure is delivered explicitly.
    await this.persistenceTail
    const failure = this.persistenceFailure
    this.persistenceFailure = null
    if (failure !== null) throw failure
  }

  private requiredSession(): AgentSession {
    if (this.disposed) throw new Error('Agent session is disposed')
    if (!this.session) throw new Error('Agent session is not initialized')
    return this.session
  }

  /**
   * Context-usage emission, throttled to ~200ms. `force` bypasses the throttle
   * (turn terminal / compact / initialize) so the gauge settles promptly at
   * boundaries instead of waiting on a timer that never fires.
   */
  private scheduleContextUsage(force = false): void {
    if (force) {
      if (this.contextUsageTimer) {
        clearTimeout(this.contextUsageTimer)
        this.contextUsageTimer = null
      }
      this.emitContextUsageNow()
      return
    }
    if (this.contextUsageTimer) return
    this.contextUsageTimer = setTimeout(() => {
      this.contextUsageTimer = null
      this.emitContextUsageNow()
    }, 200)
  }

  private emitContextUsageNow(): void {
    const session = this.session
    if (!session) return
    // `?.` everywhere: the test harness injects plain session stubs without
    // getContextUsage/sessionManager, and a context read must never break a turn.
    const context: ContextUsage | undefined = (session as { getContextUsage?(): ContextUsage }).getContextUsage?.()
    const branch: SessionEntry[] = (session as { sessionManager?: { getBranch?(): SessionEntry[] } }).sessionManager?.getBranch?.() ?? []
    const snapshot = toContextSnapshot(context, branch)
    if (!snapshot) return
    if (snapshot.tokens === this.lastContextTokens) return
    this.lastContextTokens = snapshot.tokens
    this.options.ambient.emitContextUsage(this.options.binding.sessionId, snapshot)
  }
}

// ── Thinking-level card corrections ──────────────────────────────────────────
//
// Moved to model-capabilities.ts: the correction table was one symptom of a
// layering problem — capability sources (settings metadata, catalog cards,
// register defaults, API-verified facts) each guessed on their own, and Pi's
// clamp promoted on mismatch. normalizeModelCard owns the precedence chain
// and resolveThinkingLevel owns the DOWNWARD resolution of the user's
// selection; both apply here, at the one crossing into a session.

function rewritePromptForProvider(prompt: AssembledPrompt, names: ToolNameProtocol): AssembledPrompt {
  const fragments = prompt.fragments.map((fragment) => {
    const content = names.rewriteForProvider(fragment.content)
    return { ...fragment, content, digest: sha256(content) }
  })
  const systemPrompt = names.rewriteForProvider(prompt.systemPrompt)
  return Object.freeze({
    systemPrompt,
    digest: sha256(systemPrompt),
    fragments: Object.freeze(fragments),
  })
}

function throwIfAssistantFailed(message: unknown): void {
  if (!message || typeof message !== 'object') throw new Error('Pi completed without an assistant message')
  const assistant = message as Record<string, unknown>
  if (assistant.role !== 'assistant') throw new Error('Pi completed without an assistant message')
  if (assistant.stopReason !== 'error') return
  const detail = typeof assistant.errorMessage === 'string' && assistant.errorMessage.trim()
    ? assistant.errorMessage.trim()
    : 'Provider returned an assistant error'
  throw new Error(detail)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isAbort(error: unknown): boolean {
  return /abort|cancel/i.test(`${(error as Error)?.name ?? ''} ${(error as Error)?.message ?? ''}`)
}

function toSessionError(error: unknown): { code: string; message: string } {
  const value = error instanceof Error ? error : new Error(String(error))
  return { code: value.name || 'AGENT_RUNTIME_ERROR', message: value.message || String(error) }
}
