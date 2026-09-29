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

  let activeUnsubscribe: (() => void) | null = null

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

  /** Bind to a parent session: pull the initial snapshot, then subscribe.
   *  Safe without a bridge (web/demo builds) — the store reports empty. */
  async function bind(parentSessionId: string): Promise<void> {
    const api = bridge()
    if (!api) return
    teardown()
    try {
      const snapshot = await api.list(parentSessionId)
      snapshots.value = { ...snapshots.value, [parentSessionId]: snapshot }
    } catch {
      // The initial fill is best-effort; the push channel keeps it current.
    }
    activeUnsubscribe = api.onChanged(parentSessionId, (snapshot) => {
      snapshots.value = { ...snapshots.value, [parentSessionId]: snapshot }
    })
  }

  /** Drop the active subscription. Keeps accumulated snapshots (switch-back restore). */
  function teardown(): void {
    if (activeUnsubscribe) {
      activeUnsubscribe()
      activeUnsubscribe = null
    }
  }

  /** Drop a session's snapshot (call when the session itself is disposed). */
  function forget(parentSessionId: string): void {
    if (activeUnsubscribe && activeSessionId.value === parentSessionId) teardown()
    const next = { ...snapshots.value }
    delete next[parentSessionId]
    snapshots.value = next
  }

  // Follow the active Agent session: bind on change, teardown on switch.
  watch(activeSessionId, (id, prev) => {
    if (prev && prev !== id) teardown()
    if (id) void bind(id)
    else teardown()
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
