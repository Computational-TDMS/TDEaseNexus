/**
 * SessionRuns store — the renderer projection of the runs a single Agent
 * session DISPATCHED (mirrors `stores/jobs.ts`).
 *
 * First principles: `stores/runs.ts` is the workspace's run truth ("what runs
 * exist here"); THIS store answers "what runs did this conversation start".
 * It holds no truth of its own — the Node session-scoped index seeds
 * membership at dispatch (`onRunDispatched`) and pushes live status through
 * `session-run:changed`; this is a read-only mirror keyed by parentSessionId.
 * The ActivityCapsule's Runs row reads this single source, so the list shows
 * only the current conversation's runs, never the workspace's history.
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useAgentStore } from './agent'
import { desktopSessionRunBridge } from '@/services/desktop/desktopBridge'
import type { SessionRunSnapshot } from '@/contracts/session-run-runtime'

function bridge() {
  return desktopSessionRunBridge()
}

export const useSessionRunsStore = defineStore('sessionRuns', () => {
  /** Per-parent-session snapshots. Keyed by parent sessionId. */
  const snapshots = ref<Record<string, SessionRunSnapshot>>({})

  /**
   * Live `onChanged` subscriptions, one per observed parent session (mirrors
   * `subagents.ts` / `jobs.ts`). Subscribing BEFORE `await list()` means no
   * status change can land in the gap between the initial fill and the push
   * channel opening; keeping one per session means an interleaved switch
   * never clobbers another session's unsubscribe handle.
   */
  const unsubscribers = new Map<string, () => void>()

  const agentStore = useAgentStore()
  const activeSessionId = computed(() => agentStore.active?.id ?? null)

  /** The snapshot for the currently active parent session (empty if none). */
  const active = computed<SessionRunSnapshot>(() => {
    const id = activeSessionId.value
    return id ? snapshots.value[id] ?? [] : []
  })

  /** Count of dispatched runs currently RUNNING/QUEUED for the active session. */
  const runningCount = computed(() =>
    active.value.filter((run) => run.status === 'RUNNING' || run.status === 'QUEUED').length)

  /** Bind to a parent session: open the `onChanged` subscription FIRST (see
   *  `unsubscribers`), then pull the initial snapshot.
   *  Safe without a bridge (web/demo builds) — the store reports empty. */
  async function bind(parentSessionId: string): Promise<void> {
    const api = bridge()
    if (!api) return
    if (!unsubscribers.has(parentSessionId)) {
      unsubscribers.set(parentSessionId, api.onChanged(parentSessionId, (snapshot) => {
        snapshots.value = { ...snapshots.value, [parentSessionId]: snapshot }
      }))
    }
    try {
      const snapshot = await api.list(parentSessionId)
      snapshots.value = { ...snapshots.value, [parentSessionId]: snapshot }
    } catch {
      // The initial fill is best-effort; the push channel keeps it current.
    }
  }

  /** Drop every subscription (app teardown). Keeps accumulated snapshots. */
  function teardown(): void {
    for (const unsubscribe of unsubscribers.values()) unsubscribe()
    unsubscribers.clear()
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
  // Existing subscriptions for other sessions stay alive (see `unsubscribers`).
  watch(activeSessionId, (id) => {
    if (id) void bind(id)
  }, { immediate: true })

  return {
    snapshots,
    active,
    runningCount,
    bind,
    teardown,
    forget,
  }
})
