/**
 * Jobs store — the renderer projection of a parent session's background-job
 * records (mirrors `stores/subagents.ts`).
 *
 * The store follows the active Agent session: it subscribes to `job:changed`
 * once per bound parent and stores the live snapshot keyed by parentSessionId,
 * so switching sessions restores the previously observed list without a
 * re-fetch. The Jobs panel and the ActivityCapsule running-count chip both
 * read this single source — there is no second data path.
 *
 * First-principles: this store holds NO truth of its own. The JobRegistry in
 * Node owns the records; this is a read-only mirror that re-subscribes when
 * the active session changes. Cancelling forwards to the registry's `cancel`
 * primitive; the registry pushes the updated snapshot back through `onChanged`,
 * so the UI never optimistically mutates a record's state.
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useAgentStore } from './agent'
import type { JobSnapshot, JobBridge } from '@/contracts/job-runtime'
import { desktopJobBridge } from '@/services/desktop/desktopBridge'
import type { JobPeek, JobStatus } from '@/studio/commands/registry'

function bridge(): JobBridge | undefined {
  return desktopJobBridge()
}

export const useJobsStore = defineStore('jobs', () => {
  /** Per-parent-session snapshots. Keyed by parent sessionId. */
  const snapshots = ref<Record<string, JobSnapshot>>({})
  /** True while the initial list() for the active session is in flight. */
  const loading = ref(false)
  /** Last error from list()/cancel(); surfaced in the inspector. */
  const error = ref<string | null>(null)

  let activeUnsubscribe: (() => void) | null = null

  const agentStore = useAgentStore()
  const activeSessionId = computed(() => agentStore.active?.id ?? null)

  /** The snapshot for the currently active parent session (empty array if none). */
  const active = computed<JobSnapshot>(() => {
    const id = activeSessionId.value
    return id ? snapshots.value[id] ?? [] : []
  })

  /** Count of jobs currently in the `running` state for the active session. */
  const runningCount = computed(() => active.value.filter((r) => r.state === 'running').length)

  /** Cached peek results keyed by jobId (panel's stdout/stderr tail view). */
  const peeks = ref<Record<string, JobPeek>>({})

  /**
   * Bind to a parent session: pull the initial snapshot, then subscribe to
   * `onChanged` so every registry mutation (start / settle / cancel) lands
   * without polling. Safe to call when no bridge is present (web/demo builds):
   * the store simply reports empty lists.
   */
  async function bind(parentSessionId: string): Promise<void> {
    const api = bridge()
    if (!api) return
    // Tear down any previous subscription before opening a new one — the
    // registry pushes per-parent, and a stale listener would shadow the new
    // one's snapshots.
    teardown()
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

  /**
   * Cancel a job by id. The registry pushes the updated snapshot through
   * `onChanged`; the store does NOT optimistically mutate — a cancel that
   * fails would otherwise desync the UI from Node truth.
   */
  async function cancel(jobId: string): Promise<void> {
    const api = bridge()
    const parentSessionId = activeSessionId.value
    if (!api || !parentSessionId) return
    try {
      await api.cancel(parentSessionId, jobId)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** Drop a session's snapshot (call when the session itself is disposed). */
  function forget(parentSessionId: string): void {
    if (activeUnsubscribe && activeSessionId.value === parentSessionId) teardown()
    const next = { ...snapshots.value }
    delete next[parentSessionId]
    snapshots.value = next
  }

  // Follow the active Agent session: bind on change, teardown on unmount/switch.
  watch(activeSessionId, (id, prev) => {
    if (prev && prev !== id) teardown()
    if (id) void bind(id)
    else teardown()
  }, { immediate: true })

  /** Lookup helper for inline rendering. */
  function byId(jobId: string): JobStatus | undefined {
    return active.value.find((r) => r.jobId === jobId)
  }

  /**
   * Peek a job's recent stdout/stderr (panel tail view). Best-effort: if the
   * bridge has no `peek` the cache stays empty and the panel shows nothing for
   * that job — it never blocks.
   */
  async function peek(jobId: string, lines?: number): Promise<void> {
    const api = bridge()
    const parentSessionId = activeSessionId.value
    if (!api || !parentSessionId || !api.peek) return
    try {
      const result = await api.peek(parentSessionId, jobId, lines)
      peeks.value = { ...peeks.value, [jobId]: result }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  return {
    snapshots,
    active,
    runningCount,
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
