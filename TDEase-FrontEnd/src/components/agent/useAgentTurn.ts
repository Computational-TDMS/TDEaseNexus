import { computed, reactive, ref, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'

import type { MindsetId } from '@/agent/prompt'

import { DEFAULT_TURN_BUDGETS, type RuntimeEvent, type TurnOutcome } from '@/contracts/agent-runtime'
import { createWorkspaceSessionLog, desktopWorkspaceTextBridge } from '@/services/agent/agentSessionStorage'
import { desktopAgentBridge, desktopSystemBridgeOptionally, desktopWorkspaceBridgeOptionally } from '@/services/desktop/desktopBridge'
import { sharedLocalSkillCatalog, type LocalSkillEntry } from '@/services/catalog/localSkillCatalog'
import { createTurnPhaseTracker, type TurnPhaseSnapshot } from '@/agent/turn-phase'
import { toolSubject } from '@/utils/tool-identity'
import { StreamBuffer } from '@/stores/streamBuffer'
import { useAgentStore } from '@/stores/agent'
import { useSettingsStore } from '@/stores/settings'
import type { TurnHudState } from './TurnHud.vue'

export type AgentTurnState = 'idle' | 'acting' | 'suspended' | 'halted' | 'failed'

/**
 * The status line's thought tail: the last slice of the LIVE reasoning segment,
 * single-line. This is the intent line's content while the model thinks — real
 * thought, never canned labels (a rotating status word is decoration, not
 * information). The HUD tick (250ms) reads it, so deltas never cause per-event
 * reactive writes.
 */
const THOUGHT_TAIL_CHARS = 80

function thoughtTailOf(text: string): string | undefined {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  if (oneLine.length <= THOUGHT_TAIL_CHARS) return oneLine
  return `…${oneLine.slice(-THOUGHT_TAIL_CHARS)}`
}

export interface UseAgentTurnOptions {
  workspacePath: Ref<string>
  workspaceId: Ref<string>
}

export function useAgentTurn(options: UseAgentTurnOptions) {
  const agentStore = useAgentStore()
  const settingsStore = useSettingsStore()
  const bridge = () => desktopAgentBridge()

  const mindset = ref<MindsetId>('workflow')
  /**
   * Turn preferences live on the agent store (the agent domain's runtime
   * truth). The settings store keeps only the persistence FILE: boot hydrates
   * the store once (one-way), and `bindTurnPreferencePersistence` writes every
   * UI change back into it. The old local-ref + watch-back mirror made value
   * ownership a four-file scavenger hunt.
   */
  agentStore.hydrateTurnPrefs(settingsStore.readTurnPrefs())
  agentStore.bindTurnPreferencePersistence(settingsStore.writeTurnPrefs)
  // storeToRefs keeps the reactivity link (a bare `agentStore.permissionMode`
  // would snapshot the primitive and the Composer binding would go dead).
  const { permissionMode, thinkingLevel } = storeToRefs(agentStore)
  const suspended = computed(() => agentStore.pendingApprovals.length > 0)
  const skills = ref<LocalSkillEntry[]>([])
  const modelContextWindow = ref<number | undefined>()
  /** The bound model declares image input (`input` includes 'image'). */
  const modelSupportsImages = ref(false)

  // Per-session reactive turn state lives on the store (active.turn.*); these
  // computeds are the active-session view the Composer/edge/HUD bind to.
  // Routing them through the store — instead of a single-instance ref — is what
  // lets a second session send while the first is still prompting: each
  // session's `sending` is its own, so one session's in-flight turn can no
  // longer refuse another's `send`.
  const sending = computed(() => agentStore.active?.turn.sending ?? false)
  const streaming = computed(() => agentStore.active?.turn.streaming ?? false)
  const turnState = computed<AgentTurnState>(() => agentStore.active?.turn.state ?? 'idle')
  const lastOutcome = computed(() => agentStore.active?.turn.lastOutcome ?? null)

  // The HUD is a single-instance active-session view (phase/elapsed/calls). It
  // is display-only transient state that reflects whichever session the user is
  // looking at, reset when the active session changes. Per-session HUD state
  // would add a timer per session for no visible gain — a session the user is
  // not viewing does not need a live clock.
  const hud = reactive<TurnHudState>({
    phase: 'waiting',
    phaseElapsedMs: 0,
    act: 1,
    calls: 0,
    elapsedMs: 0,
    deadlineMs: DEFAULT_TURN_BUDGETS.wallClockMs,
    waiting: false,
  })

  // The single phase controller for the ACTIVE session's live turn. Phase is
  // a presentation state derived from runtime events (src/agent/turn-phase.ts):
  // send() opens the waiting window, each runtime event folds in, and only
  // active-session events move the HUD (the HUD is a view, like the clock).
  const phaseTracker = createTurnPhaseTracker()

  function syncPhase(snapshot: TurnPhaseSnapshot): void {
    hud.phase = snapshot.phase
    hud.activity = snapshot.activity
    hud.subject = snapshot.subject
    hud.phaseElapsedMs = Date.now() - snapshot.phaseStartedAt
  }

  const boundKeys = new Map<string, string>()
  const generations = new Map<string, number>()
  const unsubscribers = new Map<string, () => void>()

  // The HUD's fact numbers are a VIEW of the store's single-writer turn facts
  // (`noteTurnFact`): the old hud.calls had three writers (send reset, event
  // increment, terminal overwrite) and could drift from the log. `act` is the
  // request count the atoms themselves carry (model.request.prepared), not a
  // hand-maintained counter.
  watch(
    () => [agentStore.active?.id, agentStore.active?.turn.toolCalls ?? 0, agentStore.active?.turn.requests ?? 0] as const,
    ([, calls, requests]) => {
      hud.calls = calls
      hud.act = Math.max(1, requests)
    },
    { immediate: true },
  )
  // Per-session live context-usage subscriptions (`context:changed`). Kept
  // parallel to `unsubscribers` — it is a separate read-side channel, not part
  // of the runtimeEvent stream, so its teardown mirrors but stays distinct.
  const contextUnsubscribers = new Map<string, () => void>()

  /**
   * Per-session non-reactive runtime: the stream buffer (RAF-coalesced, lives
   * outside reactivity by design), the in-flight assistant message id, and the
   * elapsed-clock timer. Keyed by sessionId so a turn's stream keeps its own
   * accumulator even after the user switches the active view — the old
   * single-instance buffer crossed sessions' streams the moment `active`
   * changed mid-turn (its flush wrote to whichever session was `active`,
   * not the one whose turn was streaming).
   */
  interface SessionRuntime {
    streamBuffer: StreamBuffer
    liveAssistantId: string | null
    elapsedTimer: ReturnType<typeof setInterval> | undefined
    startedAt: number
  }
  const runtimes = new Map<string, SessionRuntime>()
  function ensureRuntime(sessionId: string): SessionRuntime {
    let rt = runtimes.get(sessionId)
    if (!rt) {
      rt = { streamBuffer: new StreamBuffer(agentStore, sessionId), liveAssistantId: null, elapsedTimer: undefined, startedAt: 0 }
      runtimes.set(sessionId, rt)
    }
    return rt
  }

  watch(() => agentStore.active, (session) => {
    mindset.value = session?.mindset ?? 'workflow'
    // Reset the single-instance HUD to reflect the newly-active session's turn
    // state. Without this, switching to a session mid-turn would keep showing
    // the previous session's phase/elapsed — the HUD is a view, not per-session
    // state (which lives on `session.turn` in the store).
    resetHudForActive()
  }, { immediate: true })
  watch(mindset, (value) => {
    if (agentStore.active) agentStore.active.mindset = value
  })
  watch(suspended, (value) => { hud.waiting = value })

  /** Sync the single-instance HUD from the active session's turn state. */
  function resetHudForActive(): void {
    const turn = agentStore.active?.turn
    // A session switched into mid-turn has no replayed events to re-derive a
    // phase from, so the window reopens at waiting; a store already streaming
    // seeds `responding` (the common live delta). The next live event moves it.
    syncPhase(phaseTracker.start())
    if (turn?.sending && turn.streaming) syncPhase(phaseTracker.apply({ type: 'text_delta' }))
    hud.waiting = suspended.value
    hud.thoughtTail = undefined
  }

  async function refreshLocalSkills(): Promise<void> {
    skills.value = await sharedLocalSkillCatalog(options.workspacePath.value, {
      system: desktopSystemBridgeOptionally(),
      workspace: desktopWorkspaceBridgeOptionally(),
    }).list()
  }

  async function loadHistory(sessionId: string): Promise<boolean> {
    if (!options.workspacePath.value) {
      // Nothing will ever load without a Workspace; an eternal skeleton would
      // be a worse lie than the empty state.
      agentStore.markHistoryHydrated(sessionId)
      return false
    }
    const log = createWorkspaceSessionLog(desktopWorkspaceTextBridge(), options.workspacePath.value, sessionId)
    // A failed read is a settled answer too (the skeleton must retire), but it
    // must never masquerade as an empty session: the welcome empty state over
    // an unreadable record tells the user their history is GONE. Record the
    // failure on the session so the transcript's empty slot can say what
    // actually happened, then settle.
    const loaded = await log.readWithPresence().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[agent] history read failed for ${sessionId}:`, error)
      agentStore.markHistoryError(sessionId, message)
      return { exists: false, events: [] as never[] }
    })
    // Every path below settles "is history still pending?" — a missing log or
    // a failed read is a settled answer too, so the skeleton must retire.
    agentStore.markHistoryHydrated(sessionId)
    if (!loaded.exists) {
      agentStore.markHistoryError(sessionId, null)
      return false
    }
    agentStore.markHistoryError(sessionId, null)
    agentStore.replaceSessionProjection(sessionId, loaded.events)
    return true
  }

  /**
   * Settle-time projection: apply only the events the turn committed — the
   * log's suffix past the already-projected prefix — instead of re-reading
   * and re-projecting the whole history every turn (O(suffix), not O(full)).
   * The store swaps the live StreamBuffer tail for the canonical replay and
   * keeps the settled prefix by reference, so the transcript re-renders the
   * settled turn, not the whole conversation.
   *
   * The disk re-read stays: the event log is the one source of truth, and the
   * log is flushed before the terminal event — so the re-read always sees the
   * settled turn, whatever the live stream dropped or reordered. Any anomaly
   * (read failure, rewritten/shrunken log, sequence divergence, fold error)
   * falls back to the full `loadHistory`, which realigns everything.
   */
  async function settleHistory(sessionId: string): Promise<void> {
    if (!options.workspacePath.value) {
      await loadHistory(sessionId)
      return
    }
    const horizon = agentStore.atomsOf(sessionId).length
    const log = createWorkspaceSessionLog(desktopWorkspaceTextBridge(), options.workspacePath.value, sessionId)
    const loaded = await log.readWithPresence().catch(() => undefined)
    if (!loaded?.exists) {
      await loadHistory(sessionId)
      return
    }
    const suffix = loaded.events.slice(horizon)
    if (suffix.length === 0 && loaded.events.length === horizon) return
    // The first suffix event must continue the projected sequence exactly;
    // anything else means the log was rewritten under us (compaction) and
    // only a full re-projection can realign atoms with disk.
    const first = suffix[0]
    if (!first || first.seq !== horizon + 1) {
      await loadHistory(sessionId)
      return
    }
    const settled = agentStore.settleSessionProjection(sessionId, suffix)
    if (!settled) await loadHistory(sessionId)
  }

  function ensureSubscription(sessionId: string): void {
    if (unsubscribers.has(sessionId)) return
    const desktop = bridge()
    if (!desktop) throw new Error('TDEase Agent requires the Electron desktop runtime')
    unsubscribers.set(sessionId, desktop.subscribe(sessionId, (event) => onRuntimeEvent(sessionId, event)))
  }

  /** Subscribe to live context-usage snapshots (`context:changed`) for one
   *  session, patching the store. Optional on the bridge: web/demo builds have
   *  no desktop runtime, so the gauge simply stays "—" (unknown). */
  function ensureContextSubscription(sessionId: string): void {
    if (contextUnsubscribers.has(sessionId)) return
    const desktop = bridge()
    if (!desktop?.onContextChanged) return
    contextUnsubscribers.set(sessionId, desktop.onContextChanged(sessionId, (usage) => {
      agentStore.patchContextUsage(sessionId, usage)
    }))
  }

  function onRuntimeEvent(sessionId: string, event: RuntimeEvent): void {
    if (event.generation !== generations.get(sessionId)) return
    // NOTE: no `active` guard. Events route by the sessionId they carry, so a
    // turn keeps settling (streaming, tools, terminal) even after the user has
    // switched the active view to another session. The old `active` guard is
    // what lost turn_terminal/approvals for a backgrounded session and left it
    // stuck in `sending` forever. The HUD — a view-only singleton — is still
    // gated on active so it reflects only the session the user is looking at.
    const isActive = agentStore.active?.id === sessionId
    const rt = ensureRuntime(sessionId)
    if (event.type === 'text_delta' || event.type === 'thinking_delta') {
      ensureLiveAssistant(sessionId, rt)
      agentStore.patchTurn(sessionId, { streaming: true })
      if (isActive) syncPhase(phaseTracker.apply(event))
      if (event.type === 'text_delta') rt.streamBuffer.appendText(event.text)
      else rt.streamBuffer.appendThinking(event.text)
      return
    }
    if (event.type === 'approval_requested') {
      // Approvals are global: a pending approval blocks its session's turn
      // regardless of which session the user is viewing, so it MUST reach the
      // queue even when the owning session is not active — otherwise the turn
      // waits forever for a decision the UI never shows.
      agentStore.pushApproval({
        id: event.approvalId,
        action: event.action,
        reason: event.basis,
        args: event.args ? { ...event.args } : undefined,
        resolve: (decision) => {
          void bridge()?.resolveApproval({
            sessionId,
            approvalId: event.approvalId,
            decision,
          })
        },
      })
      return
    }
    if (event.type === 'event_committed') {
      // Fold committed events into the phase tracker too (active sessions only,
      // like the deltas): `tool.requested` is what opens the executing window —
      // without this fold the HUD never left the model-stream phases. The
      // tracker's default branch keeps every other event type unchanged.
      if (isActive) {
        syncPhase(phaseTracker.apply({
          type: 'event_committed',
          event: event.event.type === 'tool.requested'
            ? { type: event.event.type, name: event.event.name, subject: toolSubject(event.event.name, event.event.args) }
            : { type: event.event.type },
        }))
      }
      if (event.event.type === 'turn.started') {
        agentStore.noteTurnFact(sessionId, { type: 'turn.started' })
        return
      }
      if (event.event.type === 'model.request.prepared') {
        agentStore.noteTurnFact(sessionId, { type: 'model.request.prepared', requestSeq: event.event.request_seq })
        return
      }
      if (event.event.type === 'context.compacted') {
        // Session-scoped event (owns no turn): surface the divider NOW, not at
        // the next reload — otherwise the context gauge drops mid-turn while
        // the transcript carries no explanation. The store mirrors the replay
        // projection's message shape exactly, so the settle swap is a no-op.
        agentStore.appendCompactionDivider(sessionId, event.event)
        return
      }
      if (event.event.type === 'tool.requested') {
        ensureLiveAssistant(sessionId, rt)
        agentStore.noteTurnFact(sessionId, { type: 'tool.requested' })
        rt.streamBuffer.upsertTool({
          id: event.event.call_id,
          name: event.event.name,
          args: { ...event.event.args },
          done: false,
          success: false,
          status: 'running',
        }, `event:${event.event.seq}`)
      } else if (event.event.type === 'tool.completed') {
        ensureLiveAssistant(sessionId, rt)
        // No `name` here: tool.completed carries only id/done/success/status
        // (see vocabulary.ts `ToolCompletedEvent`). The real name was set by
        // the preceding tool.requested patch and is preserved by StreamBuffer's
        // merge — stamping a literal here would overwrite it once flushed.
        rt.streamBuffer.upsertTool({
          id: event.event.call_id,
          done: true,
          success: event.event.ok,
          status: event.event.ok ? 'succeeded' : 'failed',
          error: event.event.ok ? undefined : event.event.error.message,
        })
      }
      return
    }
    if (event.type === 'turn_terminal') {
      const state: AgentTurnState = event.outcome === 'failed' ? 'failed' : event.outcome === 'halted' ? 'halted' : 'idle'
      // Mark unread when the turn settled on a session the user is not viewing:
      // the result landed, but they have not seen it. The store clears this the
      // moment the session becomes active (watch on activeId).
      //
      // The settlement itself is NOT recorded here: the event log is its one
      // source of truth, and send()'s settleHistory() re-projects the suffix
      // (messages + settlements atomically) right after prompt() resolves —
      // the log is flushed before the terminal event, so the re-read always
      // sees it.
      agentStore.patchTurn(sessionId, { lastOutcome: event.outcome, state, streaming: false, unreadSettlement: !isActive })
      // The log's own usage record is the settlement truth for the call count.
      agentStore.noteTurnFact(sessionId, { type: 'settled', toolCalls: event.usage.tool_calls })
      if (isActive) {
        hud.elapsedMs = event.usage.wall_clock_ms
        hud.thoughtTail = undefined
      }
    }
  }

  function ensureLiveAssistant(sessionId: string, rt: SessionRuntime): void {
    if (rt.liveAssistantId) return
    const message = agentStore.addMessage(sessionId, 'assistant', '')
    rt.liveAssistantId = message.id
    rt.streamBuffer.attach(message.id)
  }

  async function bind(sessionId: string): Promise<void> {
    const desktop = bridge()
    if (!desktop) throw new Error('TDEase Agent requires the Electron desktop runtime')
    const key = JSON.stringify({
      workspaceId: options.workspaceId.value,
      mindset: mindset.value,
      authority: permissionMode.value,
      provider: settingsStore.provider,
      model: settingsStore.model,
      thinking: thinkingLevel.value,
      tools: settingsStore.agentTools,
      // A credential swap changes nothing else here — without the fingerprint
      // the session stayed bound on the OLD apiKey until a restart.
      credential: settingsStore.providerSummary(settingsStore.provider)?.credentialFingerprint ?? null,
    })
    if (boundKeys.get(sessionId) === key) return
    // Drop the stale generation up front: Node disposes the old binding before
    // creating the new one, so old-generation events may already be in flight.
    generations.delete(sessionId)
    ensureSubscription(sessionId)
    // Subscribe BEFORE bindSession resolves so the initialize()-time initial
    // context emit (resume case) is captured, not missed by a race.
    ensureContextSubscription(sessionId)
    const result = await desktop.bindSession({
      workspaceId: options.workspaceId.value,
      sessionId,
      mindset: mindset.value,
      authority: permissionMode.value,
      model: { providerId: settingsStore.provider, modelId: settingsStore.model },
      thinkingLevel: thinkingLevel.value,
      agentTools: settingsStore.agentTools,
      ptcEnabled: settingsStore.ptcEnabled === true,
    })
    if (!result.ok) throw new Error(result.message)
    generations.set(sessionId, result.generation)
    boundKeys.set(sessionId, key)
    modelContextWindow.value = result.modelMeta.contextWindow
    modelSupportsImages.value = result.modelMeta.input?.includes('image') ?? false
  }

  /**
   * The send entry point: an idle session starts a turn now; a busy one
   * ENQUEUES the message (typed-ahead) instead of silently swallowing it —
   * the old `if (sending) return` dropped whatever the user typed mid-turn.
   * Draining is `runTurn`'s job, so the queue works identically for a session
   * the user has switched away from.
   */
  async function send(message: string, _workspaceId: string, sessionId?: string): Promise<void> {
    if (!message.trim()) return
    // An explicit sessionId routes the turn to THAT session (the side chat
    // panel sends while the main session stays active); the default remains
    // the active view, falling back to creating a session for the very first
    // message.
    let session = sessionId
      ? agentStore.allSessions.find(s => s.id === sessionId)
      : agentStore.active
    if (!session) session = agentStore.active ?? agentStore.createSession()
    if (session.turn.sending) {
      agentStore.enqueuePrompt(session.id, message.trim())
      return
    }
    await runTurn(session.id, message)
  }

  /**
   * One full turn against an EXPLICIT session (never the implicit `active` —
   * a queued drain must run on its owning session even while the user views
   * another). When the turn settles at rest BY ITS OWN COURSE (resolved or
   * blocked), the session's queue drains one message into the next turn. A
   * user stop settles as `halted`/`cancelled` and a failure as `failed` —
   * starting another turn behind any of those would fight the user, so the
   * queue stays for them to send or drop. The drain gate reads the raw
   * outcome, not the derived `idle` state: a cancelled turn projects to an
   * idle-looking state pill (it is at rest) but is precisely NOT a turn the
   * queue may continue.
   */
  async function runTurn(sessionId: string, message: string): Promise<void> {
    const rt = ensureRuntime(sessionId)
    const isActive = () => agentStore.active?.id === sessionId
    agentStore.patchTurn(sessionId, { sending: true, streaming: false, state: 'acting', lastOutcome: null })
    agentStore.addMessage(sessionId, 'user', message)
    rt.liveAssistantId = null
    startClock(sessionId)
    if (isActive()) syncPhase(phaseTracker.start())
    let outcome: TurnOutcome | 'error' = 'error'
    try {
      if (!options.workspacePath.value || !options.workspaceId.value) throw new Error('An Agent turn requires an attached Workspace')
      await bind(sessionId)
      const result = await bridge()!.prompt({
        sessionId,
        message,
        // Read at dispatch: the toggle's state freezes into THIS turn's prompt.
        inlineVisualization: useSettingsStore().inlineVisualization,
      })
      if (!result.ok) throw new Error(result.message)
      outcome = result.outcome
      await rt.streamBuffer.flushNow()
      await settleHistory(sessionId)
      const settled: AgentTurnState = outcome === 'failed' ? 'failed' : outcome === 'halted' ? 'halted' : 'idle'
      agentStore.patchTurn(sessionId, { lastOutcome: outcome, state: settled, streaming: false })
      agentStore.noteTurnFact(sessionId, { type: 'settled', toolCalls: result.usage.tool_calls })
      if (isActive()) {
        hud.elapsedMs = result.usage.wall_clock_ms
        hud.thoughtTail = undefined
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      ensureLiveAssistant(sessionId, rt)
      rt.streamBuffer.appendText(reason)
      await rt.streamBuffer.flushNow()
      agentStore.patchTurn(sessionId, { lastOutcome: 'failed', state: 'failed' })
    } finally {
      agentStore.patchTurn(sessionId, { sending: false, streaming: false })
      rt.liveAssistantId = null
      rt.streamBuffer.reset()
      stopClock(sessionId)
    }
    if (outcome === 'resolved' || outcome === 'blocked') {
      const next = agentStore.dequeuePrompt(sessionId)
      if (next) await runTurn(sessionId, next)
    }
  }

  function stop(): void {
    const sessionId = agentStore.active?.id
    if (sessionId) void bridge()?.abort(sessionId)
  }

  async function compact(): Promise<void> {
    const sessionId = agentStore.active?.id
    if (!sessionId) throw new Error('This session has not started yet.')
    // Session selection is persisted; the live binding is not. A restored
    // session has no owner in a fresh main process until bind() runs —
    // compacting it without binding is exactly the "Agent session is not
    // owned by this renderer" rejection. Bind first, exactly like send();
    // bind() is a no-op when the binding key is unchanged.
    await bind(sessionId)
    // A compaction is a seconds-long model call, so the session visibly acts
    // while it runs; the divider (a settled `context.compacted` event) is the
    // completion marker, and a failure flips the session's state pill.
    // `compacting` rides the session's own turn state — as the old
    // single-instance ref it showed the live divider on whichever session the
    // user switched to mid-compact.
    agentStore.patchTurn(sessionId, { sending: true, state: 'acting', compacting: true })
    try {
      await bridge()!.compact(sessionId)
      // Deliberately the FULL projection, not settleHistory(): compaction is
      // the one operation that can REWRITE the log rather than append to it,
      // so the suffix-vs-horizon check cannot distinguish a compacted file
      // from a diverged one. Re-projecting the whole log realigns atoms with
      // disk unconditionally. Re-project so the divider appears now, not at
      // the next turn.
      await loadHistory(sessionId)
      agentStore.patchTurn(sessionId, { state: 'idle', lastOutcome: null })
    } catch (error) {
      agentStore.patchTurn(sessionId, { state: 'failed', lastOutcome: 'failed' })
      throw error
    } finally {
      agentStore.patchTurn(sessionId, { sending: false, streaming: false, compacting: false })
    }
  }

  async function fork(): Promise<string | null> {
    const source = agentStore.active
    if (!source) return null
    // Refuse to fork mid-turn. The parent's event stream is still being
    // written; forking it now hands the child a truncated/garbled log and the
    // two turns then share runtime singletons (clock, streamBuffer). Wait for
    // the turn to settle, then fork.
    if (sending.value) return null
    // Same ownership rule as compact(): the parent may be a restored id with
    // no live binding in this main process — bind before forking it.
    await bind(source.id)
    const branch = agentStore.createSession()
    await bridge()?.fork(source.id, branch.id)
    return branch.id
  }

  async function disposeAll(): Promise<void> {
    const desktop = bridge()
    for (const sessionId of boundKeys.keys()) {
      stopClock(sessionId)
      await desktop?.dispose(sessionId).catch(() => undefined)
    }
    for (const unsubscribe of unsubscribers.values()) unsubscribe()
    for (const unsubscribe of contextUnsubscribers.values()) unsubscribe()
    boundKeys.clear()
    generations.clear()
    unsubscribers.clear()
    contextUnsubscribers.clear()
    runtimes.clear()
  }

  function startClock(sessionId: string): void {
    const rt = ensureRuntime(sessionId)
    stopClock(sessionId)
    rt.startedAt = Date.now()
    if (agentStore.active?.id === sessionId) { hud.elapsedMs = 0; hud.phaseElapsedMs = 0 }
    rt.elapsedTimer = setInterval(() => {
      if (suspended.value) return
      // Only the active session's clock is mirrored into the HUD; the others
      // keep ticking silently so their elapsed is right if the user switches.
      if (agentStore.active?.id === sessionId) {
        hud.elapsedMs = Date.now() - rt.startedAt
        const snapshot = phaseTracker.snapshot()
        hud.phaseElapsedMs = Date.now() - snapshot.phaseStartedAt
        // The thought tail lives only inside the thinking phase — real reasoning
        // text from the session's own stream buffer, refreshed at tick cadence.
        hud.thoughtTail = snapshot.phase === 'thinking' ? thoughtTailOf(rt.streamBuffer.thinkingText) : undefined
      }
    }, 250)
  }

  function stopClock(sessionId: string): void {
    const rt = runtimes.get(sessionId)
    if (rt?.elapsedTimer) clearInterval(rt.elapsedTimer)
    if (rt) rt.elapsedTimer = undefined
  }

  // Context occupancy is a live push from Node (`context:changed`) landing in
  // the store per session; `null` = unknown (post-compaction / never bound).
  // The window is a binding fact (bindSession's modelMeta) that belongs to this
  // composable. `undefined` until a model is bound — consumers must show an
  // unknown total, not invent a denominator. Pre-bind there is no Node host, so
  // a resumed session shows an unknown occupancy until its first send binds it.
  const contextTokensUsed = computed<number | null>(() => agentStore.contextTokensUsed)
  const contextCacheHitRate = computed<number | null>(() => agentStore.contextCacheHitRate)
  const contextWindow = computed<number | undefined>(() => modelContextWindow.value)

  return {
    mindset,
    permissionMode,
    thinkingLevel,
    sending,
    streaming,
    turnState,
    suspended,
    lastOutcome,
    hud,
    skills,
    contextTokensUsed,
    contextCacheHitRate,
    contextWindow,
    modelSupportsImages,
    refreshLocalSkills,
    loadHistory,
    send,
    stop,
    fork,
    compact,
    disposeAll,
  }
}
