/**
 * Subagents store — the renderer projection of parent sessions' subagent
 * run records (palot inspector migration, Phase B).
 *
 * The store keeps a LIVE snapshot for every session it has observed — not
 * just the active one. The subscription is per-parent-session
 * (`subagent:onChanged`), so a session's children keep updating after the
 * user switches away; the SessionList's per-session working indicator and the
 * inspector's Subagents tab read this single source — there is no second
 * data path.
 *
 * First-principles: this store holds NO truth of its own. The
 * `SubagentRegistry` in Node owns the records; this is a read-only mirror
 * that re-subscribes when the active session changes. Cancelling forwards
 * to the registry's `cancel` primitive; the registry pushes the updated
 * snapshot back through `onChanged`, so the UI never optimistically mutates
 * a record's state.
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useAgentStore } from './agent'
import type { SubagentSnapshot, SubagentBridge } from '@/contracts/subagent-runtime'
import { desktopSubagentBridge } from '@/services/desktop/desktopBridge'
import type { SubagentPeek, SubagentStatus } from '@/studio/commands/registry'

function bridge(): SubagentBridge | undefined {
  return desktopSubagentBridge()
}

export const useSubagentsStore = defineStore('subagents', () => {
  /** Per-parent-session snapshots. Keyed by parent sessionId. */
  const snapshots = ref<Record<string, SubagentSnapshot>>({})
  /** True while the initial list() for the active session is in flight. */
  const loading = ref(false)
  /** Last error from list()/cancel(); surfaced in the inspector. */
  const error = ref<string | null>(null)

  /**
   * Live `onChanged` subscriptions, one per observed parent session. Kept
   * alive across active-session switches (only `teardown`/`forget` drop them):
   * a backgrounded session's children keep settling, and per-session consumers
   * (SessionList's working indicator) must see it.
   */
  const unsubscribers = new Map<string, () => void>()

  const agentStore = useAgentStore()
  const activeSessionId = computed(() => agentStore.active?.id ?? null)

  /** The snapshot for the currently active parent session (empty array if none). */
  const active = computed<SubagentSnapshot>(() => {
    const id = activeSessionId.value
    return id ? snapshots.value[id] ?? [] : []
  })

  /** Count of subagents currently in the `running` state for the active session. */
  const runningCount = computed(() => active.value.filter((r) => r.state === 'running').length)

  /**
   * Records grouped by `groupId` (parallel fan-out). Each entry is one group:
   * its id and the member records (sorted running-first). Records without a
   * groupId are omitted — they are single spawns, shown flat in the list. The
   * panel renders a group as one unit ("3 evidence runs: 2 returned, 1 running").
   */
  const groups = computed(() => {
    const byGroup = new Map<string, SubagentStatus[]>()
    for (const record of active.value) {
      if (!record.groupId) continue
      const list = byGroup.get(record.groupId)
      if (list) list.push(record)
      else byGroup.set(record.groupId, [record])
    }
    return [...byGroup.entries()].map(([groupId, members]) => ({
      groupId,
      members: [...members].sort((a, b) => Number(a.state === 'running') - Number(b.state === 'running')),
    }))
  })

  /** Cached peek results keyed by subagentId (panel's conversation peek). */
  const peeks = ref<Record<string, SubagentPeek>>({})

  /**
   * Bind to a parent session: pull the initial snapshot, then keep an
   * `onChanged` subscription alive for it (see `unsubscribers`). Safe to call
   * when no bridge is present (web/demo builds): the store simply reports
   * empty lists.
   */
  async function bind(parentSessionId: string): Promise<void> {
    const api = bridge()
    if (!api) return
    if (!unsubscribers.has(parentSessionId)) {
      unsubscribers.set(parentSessionId, api.onChanged(parentSessionId, (snapshot) => {
        snapshots.value = { ...snapshots.value, [parentSessionId]: snapshot }
      }))
    }
    loading.value = true
    error.value = null
    try {
      const snapshot = await api.list(parentSessionId)
      snapshots.value = { ...snapshots.value, [parentSessionId]: snapshot }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  /** Drop every subscription (app teardown). Keeps accumulated snapshots. */
  function teardown(): void {
    for (const unsubscribe of unsubscribers.values()) unsubscribe()
    unsubscribers.clear()
  }

  /**
   * Cancel a subagent by id. The registry pushes the updated snapshot through
   * `onChanged`; the store does NOT optimistically mutate — a cancel that
   * fails or partials-out would otherwise desync the UI from Node truth.
   */
  async function cancel(subagentId: string): Promise<void> {
    const api = bridge()
    const parentSessionId = activeSessionId.value
    if (!api || !parentSessionId) return
    try {
      await api.cancel(parentSessionId, subagentId)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** Drop a session's snapshot and subscription (call when the session itself is disposed). */
  function forget(parentSessionId: string): void {
    unsubscribers.get(parentSessionId)?.()
    unsubscribers.delete(parentSessionId)
    const next = { ...snapshots.value }
    delete next[parentSessionId]
    snapshots.value = next
  }

  // Follow the active Agent session: bind on change so its snapshot is fresh.
  // Existing subscriptions for other sessions stay alive (see `unsubscribers`)
  // — a backgrounded session's children keep settling into its snapshot.
  watch(activeSessionId, (id) => {
    if (id) void bind(id)
  }, { immediate: true })

  // A session dropped from the agent store (hydrate removed it — deleted on
  // disk) releases its subscription and snapshot: nothing can update it and
  // nothing reads it, so keeping the channel alive is a pure leak.
  const liveSessionIds = computed(() => new Set(agentStore.allSessions.map((session) => session.id)))
  watch(liveSessionIds, (live) => {
    for (const id of [...unsubscribers.keys()]) {
      if (!live.has(id)) forget(id)
    }
  })

  /** Lookup helper for the transcript's inline SubAgentCard (Phase B step 11). */
  function byId(subagentId: string): SubagentStatus | undefined {
    return active.value.find((r) => r.subagentId === subagentId)
  }

  /**
   * Peek a child's recent activity (panel §conversation peek). Best-effort:
   * if the bridge has no `peek` (older host) the cache stays empty and the
   * panel shows nothing for that child — it never blocks.
   */
  async function peek(subagentId: string, lines?: number): Promise<void> {
    const api = bridge()
    const parentSessionId = activeSessionId.value
    if (!api || !parentSessionId || !api.peek) return
    try {
      const result = await api.peek(parentSessionId, subagentId, lines)
      peeks.value = { ...peeks.value, [subagentId]: result }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  return {
    snapshots,
    active,
    runningCount,
    groups,
    peeks,
    loading,
    error,
    bind,
    teardown,
    cancel,
    peek,
    forget,
    byId,
  }
})
