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

  /**
   * Live `onChanged` subscriptions, one per observed parent session (mirrors
   * `subagents.ts`). Subscribing BEFORE `await list()` means no registry
   * mutation can land in the gap between the initial fill and the push
   * channel opening; keeping one per session means an interleaved switch
   * never clobbers another session's unsubscribe handle.
   */
  const unsubscribers = new Map<string, () => void>()

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
   * Store a fresh snapshot, dropping peek cache entries whose record no
   * longer appears — a peek outliving its job is stale output the panel
   * would keep rendering as if the job still existed.
   */
  function recordSnapshot(parentSessionId: string, snapshot: JobSnapshot): void {
    snapshots.value = { ...snapshots.value, [parentSessionId]: snapshot }
    const live = new Set(snapshot.map((r) => r.jobId))
    const stalePeeks = Object.keys(peeks.value).filter((id) => !live.has(id))
    if (stalePeeks.length > 0) {
      const next = { ...peeks.value }
      for (const id of stalePeeks) delete next[id]
      peeks.value = next
    }
  }

  /**
   * Bind to a parent session: open the `onChanged` subscription FIRST (see
   * `unsubscribers`), then pull the initial snapshot. Safe to call when no
   * bridge is present (web/demo builds): the store simply reports empty lists.
   */
  async function bind(parentSessionId: string): Promise<void> {
    const api = bridge()
    if (!api) return
    if (!unsubscribers.has(parentSessionId)) {
      unsubscribers.set(parentSessionId, api.onChanged(parentSessionId, (snapshot) => {
        recordSnapshot(parentSessionId, snapshot)
      }))
    }
    loading.value = true
    error.value = null
    try {
      const snapshot = await api.list(parentSessionId)
      recordSnapshot(parentSessionId, snapshot)
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

  /** Drop a session's snapshot and subscription (call when the session itself is disposed). */
  function forget(parentSessionId: string): void {
    unsubscribers.get(parentSessionId)?.()
    unsubscribers.delete(parentSessionId)
    const snapshot = snapshots.value[parentSessionId]
    const next = { ...snapshots.value }
    delete next[parentSessionId]
    snapshots.value = next
    if (snapshot) {
      const gone = new Set(snapshot.map((r) => r.jobId))
      const nextPeeks = { ...peeks.value }
      let changed = false
      for (const id of Object.keys(nextPeeks)) {
        if (gone.has(id)) { delete nextPeeks[id]; changed = true }
      }
      if (changed) peeks.value = nextPeeks
    }
  }

  // Follow the active Agent session: bind on change so its snapshot is fresh.
  // Existing subscriptions for other sessions stay alive (see `unsubscribers`).
  watch(activeSessionId, (id) => {
    if (id) void bind(id)
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
