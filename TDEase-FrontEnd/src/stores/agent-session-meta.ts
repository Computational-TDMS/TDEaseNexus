/**
 * The agent store's session-metadata slice: the session list (main, archived,
 * side), the active-slot bookkeeping, the session lifecycle
 * (create/select/bind/hydrate/archive/delete), and projection intake — how a
 * session's on-disk history enters the store. Composed by agent.ts; sibling
 * slices resolve sessions through the internal `sessionOf`.
 *
 * CORE-ARCHITECTURE.md §2: the session event log is the one durable record of
 * a conversation; this slice holds metadata and the settled projection of
 * that log — never a second, independently persisted copy.
 */

import { computed, ref, shallowRef, shallowReactive, watch } from 'vue'
import type { AgentChatMessage } from './chat-types'
import { useWorkspaceStore } from './workspace'
import type { SessionEvent, TurnSettlement } from '@/agent/events'
import { createSessionProjector, type SessionProjector } from '@/agent/events'
import type { MindsetId } from '@/agent/prompt'
import type { ContextUsageSnapshot } from '@/contracts/agent-runtime'
import type { WorkspaceSessionMetadata } from '@/services/agent/agentSessionStorage'
import { createLogger } from '@/utils/logger'
import { nextSessionId } from './agent-id'
import { createTurnRuntime, type SessionTurnRuntime } from './agent-turn-runtime'

const log = createLogger('agent-store')

const ACTIVE_SESSION_STORAGE_KEY = 'tdease.agent.active-session.v1'
function loadActiveSessions(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export interface AgentSession {
  id: string
  workspaceId: string
  title: string
  /**
   * True until the session is named. Replaces the old trick of comparing
   * `title` against localized literals (the legacy default title /
   * 'Recovered session'), which broke the moment the session was persisted
   * in one locale and reloaded in another. The display label lives in i18n;
   * this flag is the truth.
   */
  untitled?: boolean
  /**
   * Set when this session was reconstructed from an on-disk record rather than
   * created this session. Lets the list show the distinct "Recovered session"
   * label until the user names it; collapses to plain `untitled` once named.
   */
  recovered?: boolean
  createdAt: number
  updatedAt: number
  messages: AgentChatMessage[]
  /**
   * How each settled turn ended, keyed by turn id — the projection's own
   * settlement map (`SessionProjection.settlements`), replaced atomically
   * with `messages` by `replaceSessionProjection`. The transcript's
   * settle-fold and the context readout read it from here; there is no
   * second, composable-owned derivation of the same facts.
   */
  settlements: ReadonlyMap<string, TurnSettlement>
  /**
   * Live context occupancy pushed from Node over the `context:changed` side
   * channel (see ContextUsageSnapshot). In-memory view state like `turn` —
   * survives `replaceSessionProjection` (which only swaps messages/settlements)
   * and is carried through `hydrateWorkspaceSessions`. `tokens: null` means
   * unknown: post-compaction until the next response, or never bound yet.
   */
  contextUsage?: ContextUsageSnapshot
  /** Archived sessions are hidden from the main list but persisted. */
  archived?: boolean
  /**
   * Side chat (ZCode's SelectionSideChatPane): set on a CHILD session spawned
   * from a selection in its parent conversation. A side session never appears
   * in `sessions`/`archivedSessions` (it would steal a main-list slot and its
   * metadata would leak into the parent's history), never takes the active
   * slot on creation, and is cascade-deleted with its parent.
   */
  sideOf?: string
  /**
   * True once this session's on-disk event log has been read into `messages`
   * — or proven absent, which is also a settled answer (a genuinely empty
   * session). Only sessions restored from metadata alone start false; until
   * their first `loadHistory` lands, the transcript must show a loading
   * skeleton rather than the empty state, so an opened old session never
   * flashes "new conversation" before its history arrives.
   */
  historyHydrated?: boolean
  /**
   * Why the on-disk log could not be READ, when a read attempt failed. An
   * absent log is a clean empty session (`historyHydrated` + no error); a
   * failed read is neither empty nor loading — rendering the welcome empty
   * state over an unreadable record tells the user their history is gone
   * when it is merely unreadable. The transcript's empty slot shows this
   * message instead of the welcome state while set.
   */
  historyError?: string
  /**
   * Whether the session's LAST turn failed — the only fact the old
   * free-floating `runtimeStatus` field actually carried. It is derived from
   * the turn runtime (state + lastOutcome) instead of being written alongside
   * it: two writable fields for "is this session busy / did it fail" was two
   * sources of truth with different vocabularies, and every reader had to
   * guess which one wins. Consumers treat this as read-only; only
   * patchTurn inside the turn-runtime slice writes it. Not marked
   * `readonly` on the type: the store's own writers assign it, and the
   * Vue-reactive record is intentionally a plain mutable object.
   */
  runtimeStatus?: 'idle' | 'running' | 'failed'
  mindset: MindsetId
  /** Per-session turn runtime — see {@link SessionTurnRuntime}. */
  turn: SessionTurnRuntime
  /**
   * Messages typed ahead while a turn is in flight (send() enqueues instead
   * of refusing). In-memory view state like `turn`: the transcript only shows
   * a queued message once `useAgentTurn`'s settle-drain actually runs it as a
   * turn (the event log, not this queue, is the record), so the queue stays
   * out of persistence. FIFO: one drain per settled turn, and a failed or
   * user-halted turn deliberately leaves the queue for the user to decide.
   */
  queuedPrompts: string[]
}

/**
 * Install the shallow-reactivity cascade on a session record (see the
 * `allSessions` note): the record itself, its `messages` array, its
 * `queuedPrompts` array and its `turn` runtime become top-level reactive,
 * while everything nested deeper (message/block/tool-args payloads) stays
 * raw — replaced wholesale, never deep-proxied. Every session that enters
 * `allSessions` must pass through here.
 */
function makeSession(session: AgentSession): AgentSession {
  session.messages = shallowReactive(session.messages)
  session.queuedPrompts = shallowReactive(session.queuedPrompts)
  session.turn = shallowReactive(session.turn)
  return shallowReactive(session)
}

export function createSessionMetaSlice() {
  // SHALLOW by design (perf: long conversations). A deep `ref` here
  // deep-proxied every message / content-block / tool call — including the
  // potentially huge tool-args JSON — across ALL sessions, alive or archived,
  // for the process lifetime. Reactivity is instead carried in a deliberate
  // cascade of `shallowReactive` wrappers installed at the write sites:
  //
  //   • the session record itself (title / archived / messages / turn /
  //     contextUsage / … property writes trigger),
  //   • the `messages` array and each message (block-array pushes and
  //     in-place text appends trigger — see agent-live-blocks.ts),
  //   • the turn runtime and the queued-prompt array (agent-turn-runtime.ts).
  //
  // Anything BELOW those wrappers — a block's `tools` args JSON, a
  // settlement's payload — stays raw by construction: it is only ever
  // replaced wholesale, never mutated in place. Structural changes to the
  // session LIST itself replace the array (never in-place push/unshift), so
  // the list computeds re-run on the shallowRef alone.
  const allSessions = shallowRef<AgentSession[]>([])
  const workspaceId = ref('')
  /**
   * Session atoms — the settled canonical events each session's projection
   * was built from, held OUTSIDE the reactive session objects on purpose:
   * Vue's deep ref-unwrap cannot instantiate the recursive `SessionEvent`
   * JSON tree (TS2589), and atoms are immutable once written, so a shallow
   * map keyed by session id is all the storage they need. Swapped atomically
   * by `replaceSessionProjection`; the trajectory inspector and any future
   * derived map read this one copy.
   */
  const sessionAtoms = shallowRef<ReadonlyMap<string, ReadonlyArray<SessionEvent>>>(new Map())

  /** The settled atoms of one session (empty before its first projection). */
  function atomsOf(sessionId: string): ReadonlyArray<SessionEvent> {
    return sessionAtoms.value.get(sessionId) ?? []
  }

  /**
   * Per-session incremental projection state: the projector folded through
   * every atom above, and how many of the session's `messages` are the
   * projection's prefix (everything after that index is live StreamBuffer
   * assembly awaiting the settle swap). Kept beside the atoms because the
   * three must move in lockstep — atoms + projector fold the same events,
   * and the horizon indexes the messages that projection produced.
   */
  interface ProjectionState {
    projector: SessionProjector
    messageHorizon: number
  }
  const projectionStates = shallowRef<ReadonlyMap<string, ProjectionState>>(new Map())

  // Open side sessions (sideOf set) are absent from the main list: they hang
  // off their parent (sideSessionsOf) and would otherwise surface as phantom
  // switcher rows. CLOSED side chats are archived by their panel on unmount,
  // so the archived list deliberately does NOT re-exclude them — that is
  // where a side chat stays findable (restore/delete) after its tab is gone.
  const sessions = computed(() => allSessions.value.filter(s => s.workspaceId === workspaceId.value && !s.archived && !s.sideOf))
  const archivedSessions = computed(() => allSessions.value.filter(s => s.workspaceId === workspaceId.value && s.archived))
  const sideSessions = computed(() => allSessions.value.filter(s => s.workspaceId === workspaceId.value && s.sideOf))
  function sideSessionsOf(parentId: string): AgentSession[] {
    return sideSessions.value.filter(s => s.sideOf === parentId)
  }
  const activeId = ref<string | null>(null)
  const activeByWorkspace = ref<Record<string, string>>(loadActiveSessions())
  const active = computed(() => allSessions.value.find(s => s.workspaceId === workspaceId.value && s.id === activeId.value) ?? null)

  /**
   * Tokens the ACTIVE session's conversation occupies in the model's context
   * right now — the live value Node pushed over `context:changed` (Pi's
   * `getContextUsage()`: last valid assistant usage as baseline + estimated
   * trailing delta). `null` = unknown: post-compaction (until the next
   * response), or the session was never bound. Deliberately NOT derived from
   * settlements — the settlement usage is a turn-sum for cost accounting, and
   * reading it here would reintroduce the multi-round double-count the live
   * snapshot exists to fix.
   */
  const contextTokensUsed = computed<number | null>(() => active.value?.contextUsage?.tokens ?? null)

  /**
   * Cache hit rate of the last valid request for the ACTIVE session:
   * read / (read + write + uncached). `null` when there is no cache figure
   * (unknown occupancy, or a provider that reports no cache split).
   */
  const contextCacheHitRate = computed<number | null>(() => {
    const cache = active.value?.contextUsage?.cache
    if (!cache) return null
    const total = cache.read + cache.write + cache.uncached
    return total > 0 ? cache.read / total : null
  })

  // ── Session lifecycle ──────────────────────────────────────────────────────

  function createSession(): AgentSession {
    if (!workspaceId.value) throw new Error('A workspace must be bound before creating an agent session')
    const now = Date.now()
    const session: AgentSession = {
      id: nextSessionId(),
      workspaceId: workspaceId.value,
      title: '',
      untitled: true,
      createdAt: now,
      updatedAt: now,
      messages: [],
      settlements: new Map(),
      // A session created here is genuinely empty — there is no history the
      // transcript could still be waiting for.
      historyHydrated: true,
      mindset: 'workflow',
      turn: createTurnRuntime(),
      queuedPrompts: [],
    }
    // The reactive proxy is what enters the list AND what the caller gets:
    // mutating the raw target would bypass reactivity entirely.
    const reactive = makeSession(session)
    allSessions.value = [reactive, ...allSessions.value]
    activeId.value = session.id
    activeByWorkspace.value = { ...activeByWorkspace.value, [workspaceId.value]: session.id }
    return reactive
  }

  function selectSession(id: string) {
    if (allSessions.value.some(s => s.workspaceId === workspaceId.value && s.id === id)) {
      activeId.value = id
      activeByWorkspace.value = { ...activeByWorkspace.value, [workspaceId.value]: id }
    }
  }

  /**
   * A side chat child of `parentId` (ZCode's SelectionSideChatPane kernel):
   * an ordinary session in every runtime respect (own id, own event log, own
   * turn runtime, own sidecar binding) except three — it never takes the
   * active slot (the main transcript must not jump), it carries `sideOf` so
   * the lists exclude it and its metadata records the parent, and its
   * lifecycle is independent of the parent's (its panel archives it on
   * close; archiving the parent never touches it). The parent must itself be
   * a main session: side-of-side would make the pairing ambiguous for zero
   * product value.
   */
  function createSideSession(parentId: string): AgentSession {
    const parent = allSessions.value.find(s => s.id === parentId)
    if (!parent) throw new Error(`Cannot spawn a side chat of unknown session ${parentId}`)
    if (parent.sideOf) throw new Error('A side chat cannot itself have side chats')
    if (!workspaceId.value) throw new Error('A workspace must be bound before creating an agent session')
    const now = Date.now()
    const session: AgentSession = {
      id: nextSessionId(),
      workspaceId: workspaceId.value,
      sideOf: parentId,
      title: '',
      untitled: true,
      createdAt: now,
      updatedAt: now,
      messages: [],
      settlements: new Map(),
      historyHydrated: true,
      mindset: 'analysis',
      turn: createTurnRuntime(),
      queuedPrompts: [],
    }
    const reactive = makeSession(session)
    allSessions.value = [...allSessions.value, reactive]
    return reactive
  }

  function bindWorkspace(id: string) {
    workspaceId.value = id
    const remembered = activeByWorkspace.value[id]
    activeId.value = allSessions.value.some(s => s.workspaceId === id && s.id === remembered)
      ? remembered
      : sessions.value[0]?.id ?? archivedSessions.value[0]?.id ?? null
  }

  /**
   * Follow the Workspace the app is on, the way `documents.ts` and `runs.ts`
   * already do.
   *
   * Binding used to happen only when `AgentPage.vue` called `bindWorkspace`
   * from `ensureSession()`, so any other path that switched Workspaces left
   * `workspaceId` -- and with it `sessions`, `archivedSessions` and `active`,
   * every one of which filters on it -- pointing at the previous Workspace.
   * `bindWorkspace` stays exported and idempotent, so that existing call is
   * still correct; this only removes the requirement that someone remembers to
   * make it.
   */
  const workspaceStore = useWorkspaceStore()
  watch(
    () => workspaceStore.workspaceId,
    (id) => { if (id && id !== workspaceId.value) bindWorkspace(id) },
  )

  function hydrateWorkspaceSessions(records: ReadonlyArray<WorkspaceSessionMetadata>): void {
    const retained = allSessions.value.filter(session => session.workspaceId !== workspaceId.value)
    const currentById = new Map(
      allSessions.value.filter(session => session.workspaceId === workspaceId.value).map(session => [session.id, session]),
    )
    const hydrated = records.map((record): AgentSession => {
      const current = currentById.get(record.id)
      return {
        id: record.id,
        workspaceId: workspaceId.value,
        title: record.title,
        untitled: !record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messages: current?.messages ?? [],
        settlements: current?.settlements ?? new Map(),
        // Metadata carries no messages: a restored session waits for its first
        // `loadHistory` unless this very process already read it.
        historyHydrated: current?.historyHydrated ?? false,
        contextUsage: current?.contextUsage,
        archived: record.archived,
        sideOf: record.sideOf,
        mindset: record.mindset,
        // Typed-ahead prompts survive a metadata re-hydration for an
        // in-process session, exactly like `messages`/`turn`.
        queuedPrompts: current?.queuedPrompts ?? [],
        // A restored turn is always idle: an in-process prompt died with the
        // previous process, so whatever `turn` carried is stale. Keep the
        // current turn only if it is still idle (a cross-reload live view is
        // impossible); otherwise reset to a clean idle slate.
        turn: current?.turn && current.turn.state === 'idle' ? current.turn : createTurnRuntime(),
      }
    })
    allSessions.value = [...retained, ...hydrated.map(makeSession)]
    // Session-keyed view state follows the session list: when hydrate drops
    // sessions (deleted on disk), their atoms go with them — otherwise the
    // map keeps every event log ever viewed for the process lifetime.
    const liveIds = new Set(allSessions.value.map((session) => session.id))
    const keptAtoms = new Map<string, ReadonlyArray<SessionEvent>>()
    for (const [id, atoms] of sessionAtoms.value) if (liveIds.has(id)) keptAtoms.set(id, atoms)
    sessionAtoms.value = keptAtoms
    // Incremental projection state follows the same rule as the atoms: an
    // in-process session keeps its projector (its messages survived above),
    // a dropped session takes its fold state with it, and a restored one
    // starts projector-less (its first settle falls back to the full path).
    const keptStates = new Map<string, ProjectionState>()
    for (const [id, state] of projectionStates.value) if (liveIds.has(id)) keptStates.set(id, state)
    projectionStates.value = keptStates
    bindWorkspace(workspaceId.value)
  }

  function archiveSession(id: string) {
    const s = allSessions.value.find(s => s.id === id)
    if (s) { s.archived = true; s.updatedAt = Date.now() }
    if (activeId.value === id) {
      activeId.value = sessions.value[0]?.id ?? null
      activeByWorkspace.value = { ...activeByWorkspace.value, [workspaceId.value]: activeId.value ?? '' }
    }
  }

  /**
   * Resolve a session by id within the current workspace. The message-assembly
   * methods take an explicit `sessionId` (not the implicit `active`) so a
   * turn's stream keeps writing to its own session even after the user has
   * switched the active view to another — the single-instance model that routed
   * everything through `active` is what stalled parallel sessions.
   */
  function sessionOf(sessionId: string): AgentSession | undefined {
    return allSessions.value.find(s => s.id === sessionId && s.workspaceId === workspaceId.value)
  }

  function unarchiveSession(id: string) {
    const s = allSessions.value.find(s => s.id === id)
    if (s) { s.archived = false; s.updatedAt = Date.now() }
  }

  // Deliberately NO deleteSession. Archive is the only exit from the list and
  // the terminal state of a conversation: the event log is work the user can
  // never reproduce, and the one path that could destroy it end-to-end (trash
  // the directory, drop the state) was removed product-wide — the UI offers
  // archive/restore only.

  function updateSessionTitle(id: string, title: string) {
    const s = allSessions.value.find(s => s.id === id)
    if (s) { s.title = title.slice(0, 48); s.updatedAt = Date.now() }
  }

  /**
   * Replace a session's view with the FULL canonical log projection — the
   * open/restore path and the fallback for every incremental-settle anomaly.
   * Rebuilds the session's projector from scratch, so after this the next
   * settle can fold a suffix again. Throws when the log violates the
   * projector's invariants: a freshly validated file failing here is a real
   * defect and must surface (the caller's turn fails, as it always has).
   */
  function replaceSessionProjection(id: string, events: ReadonlyArray<SessionEvent>): boolean {
    const session = allSessions.value.find(s => s.id === id && s.workspaceId === workspaceId.value)
    if (!session || events.length === 0) return false
    const projector = createSessionProjector()
    for (const event of events) projector.fold(event)
    const projection = projector.snapshot()
    // shallowReactive: the swap itself triggers via the session proxy, but the
    // NEXT live turn pushes onto this array in place (addMessage) — a raw
    // array would swallow that.
    session.messages = shallowReactive(projection.messages.map(cloneProjectedMessage))
    // Settlements travel with the messages they summarize — one atomic swap,
    // never a merge: the projection is the whole truth of the settled log.
    session.settlements = projection.settlements
    // The atoms themselves ride the same atomic swap into the shallow map:
    // derived views (trajectory inspector, future projections) read this one
    // copy, never a second log.
    const nextAtoms = new Map(sessionAtoms.value)
    nextAtoms.set(id, projection.events)
    sessionAtoms.value = nextAtoms
    const nextState = new Map(projectionStates.value)
    nextState.set(id, { projector, messageHorizon: projection.messages.length })
    projectionStates.value = nextState
    if (session.untitled) {
      const firstUser = session.messages.find(message => message.role === 'user')
      const name = firstUser?.content?.slice(0, 24) ?? ''
      if (name) {
        session.title = name
        session.untitled = false
      }
    }
    return true
  }

  /**
   * Settle-time incremental projection: fold the log's NEW events (everything
   * past the last projection) into the retained projector and swap only the
   * message TAIL — the live StreamBuffer assembly this turn produced — for the
   * canonical replay of those events. The prefix is kept by reference, so the
   * transcript re-renders the settled turn, not the whole history; the fold,
   * the clone and the swap are all O(suffix), not O(full history).
   *
   * Returns false without touching state when there is nothing to build on
   * (no session, no retained projector, empty suffix) or when the fold threw
   * (sequence divergence) — the caller must then fall back to the full
   * `replaceSessionProjection`, which rebuilds everything from the log.
   */
  function settleSessionProjection(id: string, suffix: ReadonlyArray<SessionEvent>): boolean {
    const session = allSessions.value.find(s => s.id === id && s.workspaceId === workspaceId.value)
    const state = projectionStates.value.get(id)
    if (!session || !state || suffix.length === 0) return false
    const horizon = state.messageHorizon
    try {
      for (const event of suffix) state.projector.fold(event)
    } catch (error) {
      // Half-folded: the projector's state is dead weight now. Discard it so
      // nothing folds into a corrupt fold; the caller rebuilds from the log.
      log.warn('incremental settle failed, falling back to full projection', id, error)
      const nextState = new Map(projectionStates.value)
      nextState.delete(id)
      projectionStates.value = nextState
      return false
    }
    const projection = state.projector.snapshot()
    // shallowReactive for the same reason as replaceSessionProjection above.
    session.messages = shallowReactive([...session.messages.slice(0, horizon), ...projection.messages.slice(horizon).map(cloneProjectedMessage)])
    session.settlements = projection.settlements
    const nextAtoms = new Map(sessionAtoms.value)
    nextAtoms.set(id, projection.events)
    sessionAtoms.value = nextAtoms
    state.messageHorizon = projection.messages.length
    if (session.untitled) {
      const firstUser = session.messages.find(message => message.role === 'user')
      const name = firstUser?.content?.slice(0, 24) ?? ''
      if (name) {
        session.title = name
        session.untitled = false
      }
    }
    return true
  }

  /**
   * Mark a session's history as read from disk. `loadHistory` calls this on
   * every terminal path — log read, log absent, read error — because each one
   * settles the question the transcript's loading skeleton is asking: there is
   * nothing left to wait for.
   */
  function markHistoryHydrated(id: string): void {
    const session = allSessions.value.find(s => s.id === id && s.workspaceId === workspaceId.value)
    if (session) session.historyHydrated = true
  }

  /**
   * Record (or clear, with no message) a failed history read for the session.
   * A successful read always clears it — the error describes exactly one read
   * attempt, never a permanent property of the session.
   */
  function markHistoryError(id: string, message: string | null): void {
    const session = allSessions.value.find(s => s.id === id && s.workspaceId === workspaceId.value)
    if (session) session.historyError = message ?? undefined
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  watch(activeByWorkspace, (val) => {
    try {
      localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(val))
    } catch {
      /* quota */
    }
  }, { deep: true })

  return {
    // internal — injected into the sibling slices, not part of the store's
    // public surface.
    sessionOf,
    // session state
    sessions,
    archivedSessions,
    allSessions,
    workspaceId,
    activeId,
    active,
    contextTokensUsed,
    contextCacheHitRate,
    // session lifecycle
    createSession,
    selectSession,
    bindWorkspace,
    hydrateWorkspaceSessions,
    archiveSession,
    unarchiveSession,
    createSideSession,
    sideSessionsOf,
    sideSessions,
    updateSessionTitle,
    replaceSessionProjection,
    settleSessionProjection,
    markHistoryHydrated,
    markHistoryError,
    atomsOf,
  }
}

function cloneProjectedMessage(message: AgentChatMessage): AgentChatMessage {
  return {
    ...message,
    blocks: message.blocks?.map((block) => {
      if (block.type === 'tool_group') {
        return {
          ...block,
          tools: block.tools.map((tool) => ({
            ...tool,
            args: tool.args ? { ...tool.args } : undefined,
            detail: tool.detail ? { ...tool.detail } : undefined,
          })),
        }
      }
      if (block.type === 'permission') return { ...block, args: block.args ? { ...block.args } : undefined }
      return { ...block }
    }),
  }
}
