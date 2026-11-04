/**
 * useLiveSessionProjection — the live, streaming projection of ANY session's
 * conversation, reused from the main turn's design.
 *
 * A subagent IS a session: its `sessionId` equals its `subagentId`, its events
 * persist to the same `events.jsonl` the parent uses, and (after the main-
 * process routing fix) its live `agent:event` stream reaches this renderer via
 * the parent's owner. So there is exactly ONE way to view a conversation — read
 * the committed history off disk, then fold in live `event_committed` events as
 * they arrive — and this composable is it. `SubagentConversation` and the main
 * turn both bottom out in `projectSessionEvents`; this is the read-side twin of
 * `useAgentTurn.loadHistory` + `ensureSubscription`, stripped of the
 * composer/approval/turn-lifecycle baggage that a read-only viewer does not
 * need.
 *
 * Contiguity: `projectSessionEvents` requires contiguous `seq` (it throws on a
 * gap). The subscription is opened BEFORE the disk read, so every live event is
 * captured; the seq guard then keeps the accumulated array contiguous — an
 * event with `seq === lastSeq + 1` appends, `seq <= lastSeq` is a duplicate of
 * the disk history (skipped), and `seq > lastSeq + 1` means the disk read raced
 * ahead of the live stream, so a single coalesced re-read of the authoritative
 * log restores contiguity. Streaming text/thinking deltas (`text_delta` /
 * `thinking_delta`) ARE mirrored here: they accumulate into a synthetic
 * in-flight assistant message appended past the canonical projection, so a
 * child agent is seen thinking/talking as it happens instead of going silent
 * until its message commits. The committing `message.completed` clears the
 * synthetic content and lets the canonical projection (which carries the full
 * final text) take over — tool calls and other act events arrive via
 * `event_committed` and project in real time.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { createWorkspaceSessionLog, desktopWorkspaceTextBridge } from '@/services/agent/agentSessionStorage'
import { projectSessionEvents, type SessionEvent, type TurnSettlement } from '@/agent/events'
import { desktopAgentBridge } from '@/services/desktop/desktopBridge'
import type { RuntimeEvent } from '@/contracts/agent-runtime'
import type { AgentChatMessage, ContentBlock, TextBlock, ThinkingBlock } from '@/stores/chat-types'
import { createLiveStreamSegments } from './live-stream-segments'
import { useWorkspaceStore } from '@/stores/workspace'

/**
 * Module-level wrapper with an explicit return type. `projectSessionEvents`
 * returns `SessionProjection`, whose `messages`/`events` carry the large
 * `AgentChatMessage` / `SessionEvent` discriminated unions; calling it through
 * a function whose signature is pinned by an annotation lets the call sites
 * use the truncated shape instead of re-walking the unions on every read
 * (TS2589 "excessively deep"). This is the standard workaround — the wrapper
 * is the type-checking boundary.
 */
function projectAndCollect(events: ReadonlyArray<SessionEvent>): {
  messages: ReadonlyArray<AgentChatMessage>
  settlements: ReadonlyMap<string, TurnSettlement>
} {
  // Both ends cast through `unknown` (TS2589 escape hatch): the large
  // `SessionEvent` / `AgentChatMessage` unions make `projectSessionEvents`'s
  // `SessionProjection` return type pathologically deep to instantiate, and
  // even reading `.messages` / `.events` off it re-walks the unions. The data
  // genuinely is a `SessionEvent[]` (built from the session log + live
  // `event_committed` payloads), so the assertion carries no lie — it only
  // truncates the inference, exactly what `useAgentTurn.loadHistory` avoids by
  // binding the result to a plain local in a non-generic async path.
  type NarrowProjection = { messages: ReadonlyArray<AgentChatMessage>; events: ReadonlyArray<SessionEvent>; settlements: ReadonlyMap<string, TurnSettlement> }
  const projection = projectSessionEvents(events as unknown as ReadonlyArray<SessionEvent>) as unknown as NarrowProjection
  return { messages: projection.messages, settlements: projection.settlements }
}

export type LiveSessionStatus = 'loading' | 'ready' | 'missing' | 'error'

export function useLiveSessionProjection(getSessionId: () => string) {
  const workspaceStore = useWorkspaceStore()
  const status = ref<LiveSessionStatus>('loading')

  /**
   * The accumulated SessionEvent log — PLAIN, not a ref. Reactivity for the
   * template flows from `messages`/`settlements` (refs `reproject()` rewrites);
   * the events array is internal accumulator state and never binds in a
   * template. Keeping it plain matches `useAgentTurn` (which binds
   * `projectSessionEvents`'s result to a plain local) and — practically —
   * avoids TS2589: a `ref<ReadonlyArray<SessionEvent>>` makes the deep
   * `SessionEvent` union walk through Vue's ref-unwrapping type machinery on
   * every access, which tips the checker into "excessively deep".
   */
  let events: SessionEvent[] = []
  /** seq of the last event folded into `events` (0 before any event). */
  let lastSeq = 0
  let unsubscribe: (() => void) | undefined
  /** Guards against overlapping resync reads; only one disk re-read in flight. */
  let resyncInFlight = false
  /** Token to ignore a disk read superseded by a sessionId change / remount. */
  let loadToken = 0

  // The canonical projection off `events` (disk + committed). These are only
  // rewritten when `events` mutates — NOT on every text delta — so a streaming
  // child does not re-walk the whole event log per token.
  const baseMessages = ref<ReadonlyArray<AgentChatMessage>>([])
  const baseSettlements = ref<ReadonlyMap<string, TurnSettlement>>(new Map())
  // In-flight streaming text/thinking — accumulated directly from `text_delta`
  // / `thinking_delta`, ahead of the commits that will canonicalize them, in
  // one ORDERED segment buffer (live-stream-segments.ts): thinking segments
  // drop the moment their `thinking.recorded` commit lands (the canonical
  // projection then carries them — keeping the synthetic copy rendered the
  // same reasoning twice), text clears on `message.completed`. While
  // non-empty, `messages` appends one synthetic assistant message carrying the
  // segments in arrival order, so a child agent is seen thinking/talking as it
  // happens instead of going silent (the old behaviour dropped every delta and
  // only showed the final committed text).
  const live = createLiveStreamSegments()
  /** Why the last disk read failed, when it did ('error' status). */
  const loadError = ref<string | null>(null)

  function reproject(): void {
    if (events.length === 0) { baseMessages.value = []; baseSettlements.value = new Map(); return }
    const collected = projectAndCollect(events)
    baseMessages.value = collected.messages
    baseSettlements.value = collected.settlements
  }

  const messages = computed<ReadonlyArray<AgentChatMessage>>(() => {
    if (!live.hasContent.value) return baseMessages.value
    const blocks: ContentBlock[] = live.segments.value.map((segment): ContentBlock => {
      if (segment.kind === 'thinking') {
        return { type: 'thinking', id: segment.id, text: segment.text, sealed: segment.sealed } as ThinkingBlock
      }
      return { type: 'text', id: segment.id, text: segment.text } as TextBlock
    })
    return [...baseMessages.value, { id: '__live_assistant__', role: 'assistant', blocks }]
  })
  const settlements = computed(() => baseSettlements.value)

  function onRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === 'text_delta') {
      live.appendTextDelta(event.text)
      if (status.value !== 'ready') status.value = 'ready'
      return
    }
    if (event.type === 'thinking_delta') {
      live.appendThinkingDelta(event.text)
      if (status.value !== 'ready') status.value = 'ready'
      return
    }
    if (event.type !== 'event_committed') return
    const se = event.event
    if (se.type === 'message.completed') {
      // The committed message now carries the full text in the canonical
      // projection: drop every synthetic segment or it renders twice.
      live.commitMessage()
    } else if (se.type === 'thinking.recorded') {
      // The canonical projection now owns this reasoning verbatim — the
      // synthetic copy must go, not linger beside it until message.completed.
      live.commitThinking()
    } else {
      // Any other act commit ends an open reasoning segment (the collector
      // flushes reasoning before every act event).
      live.sealOpenThinking()
    }
    if (se.seq === lastSeq + 1) {
      // Expected next event — append, contiguity preserved.
      events = [...events, se]
      lastSeq = se.seq
      if (status.value !== 'ready') status.value = 'ready'
      reproject()
    } else if (se.seq <= lastSeq) {
      // Duplicate of a disk event whose live signal arrived after the read —
      // the subscription started before the read, so this overlap is expected.
      return
    } else {
      // Gap: the disk read returned fewer events than the live stream has
      // already moved past. Re-read the authoritative log once; further gaps
      // while that read is pending are absorbed by it.
      void resync()
    }
  }

  async function loadFromDisk(): Promise<void> {
    const root = workspaceStore.workspacePath
    const sid = getSessionId()
    if (!root) { status.value = 'missing'; return }
    const token = ++loadToken
    try {
      // Read-only: the viewer must not repair (rewrite) the append-only log.
      const log = createWorkspaceSessionLog(desktopWorkspaceTextBridge(), root, sid, { readOnly: true })
      const loaded = await log.readWithPresence()
      if (token !== loadToken) return
      if (!loaded.exists || loaded.events.length === 0) {
        // No history yet: a child may still be running before its first commit.
        // Stay in a non-"ready" state; live events will flip it to "ready".
        if (status.value === 'loading') status.value = 'missing'
        return
      }
      events = [...loaded.events]
      lastSeq = loaded.events[loaded.events.length - 1]?.seq ?? 0
      status.value = 'ready'
      reproject()
    } catch (error) {
      // A FAILED read is not the same fact as an ABSENT log: 'missing' renders
      // "not on disk", which lies when the log exists but is unreadable. The
      // 'error' status keeps the distinction honest (and the message visible).
      if (token === loadToken && status.value === 'loading') {
        loadError.value = error instanceof Error ? error.message : String(error)
        status.value = 'error'
      }
    }
  }

  async function resync(): Promise<void> {
    if (resyncInFlight) return
    resyncInFlight = true
    try {
      await loadFromDisk()
    } finally {
      resyncInFlight = false
    }
  }

  function start(): void {
    const bridge = desktopAgentBridge()
    const sid = getSessionId()
    // Subscribe BEFORE the disk read so no live event is missed; the seq guard
    // dedups the overlap with the history the read returns.
    if (bridge?.subscribe) unsubscribe = bridge.subscribe(sid, onRuntimeEvent)
    void loadFromDisk()
  }

  function stop(): void {
    unsubscribe?.()
    unsubscribe = undefined
    // Invalidate any in-flight read so it cannot flip state after a switch.
    loadToken++
  }

  // Re-start when the target session changes (the host mounts this composable
  // once per tab; a session change is a remount in practice, but the watch keeps
  // it honest if the prop ever swaps).
  watch(
    () => getSessionId(),
    () => {
      stop()
      events = []
      lastSeq = 0
      live.clear()
      loadError.value = null
      status.value = 'loading'
      start()
    },
  )

  start()
  onBeforeUnmount(stop)

  return { messages, settlements, status, loadError, reload: loadFromDisk }
}
