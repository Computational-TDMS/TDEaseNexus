/**
 * RunProgress — live job accounting for the Runs dock's rows.
 *
 * A run row that only says "Running" answers "is it alive?" but not "how far
 * along?" — the one number a user watching a long analysis actually wants.
 * The data already flows to the renderer: the run event stream replays the
 * workflow's graph (total jobs, and which nodes were already up-to-date) and
 * then one event per job transition. This tracker subscribes per live run and
 * reduces that stream to `{ total, finished, failed }`; it holds no truth of
 * its own (the stream is the truth) and publishes nothing for settled runs —
 * the row's status label carries the outcome.
 *
 * Injected as a `subscribe` seam so the reduction is testable without a
 * backend: `useRunProgress()` binds the real store, tests feed fake events.
 */
import { ref, type Ref } from 'vue'
import { useDocumentsStore } from '@/stores/documents'
import type { RunEvent } from '@/studio/domain/run'

export interface RunProgress {
  /** Jobs the Run's workflow graph declares. */
  total: number
  /** Jobs finished: graph-declared up-to-date + succeeded + failed. */
  finished: number
  /** Jobs that failed. */
  failed: number
}

export type RunEventSource = (runId: string, onEvent: (event: RunEvent) => void) => () => void

interface RunBooks {
  total: number
  /** Jobs the graph declared up-to-date — finished work the job stream never reports. */
  base: number
  succeeded: Set<number>
  failed: Set<number>
}

export function createRunProgressTracker(subscribe: RunEventSource) {
  const progress = ref<Record<string, RunProgress>>({})
  const stops = new Map<string, () => void>()
  const books = new Map<string, RunBooks>()

  function publish(runId: string): void {
    const book = books.get(runId)
    if (!book) return
    progress.value = {
      ...progress.value,
      [runId]: {
        total: book.total,
        finished: book.base + book.succeeded.size + book.failed.size,
        failed: book.failed.size,
      },
    }
  }

  function track(runId: string): void {
    books.set(runId, { total: 0, base: 0, succeeded: new Set(), failed: new Set() })
    progress.value = { ...progress.value, [runId]: { total: 0, finished: 0, failed: 0 } }
    const stop = subscribe(runId, (event) => {
      const book = books.get(runId)
      if (!book) return
      if (event.type === 'workflow.graph') {
        // A (re)declared graph resets the books; up-to-date nodes are finished
        // work the job stream will never report as events.
        const nodes = (event.data.nodes as ReadonlyArray<{ id: number; initial_status?: string }> | undefined) ?? []
        book.total = nodes.length
        book.base = nodes.filter((node) => node.initial_status === 'up_to_date').length
        book.succeeded = new Set()
        book.failed = new Set()
        publish(runId)
        return
      }
      const jobId = event.data.job_id
      if (typeof jobId !== 'number') return
      // Sets, not counters: a replayed transition must not double-count.
      if (event.type === 'job.succeeded') { book.succeeded.add(jobId); book.failed.delete(jobId) }
      else if (event.type === 'job.failed') { book.failed.add(jobId); book.succeeded.delete(jobId) }
      else return
      publish(runId)
    })
    stops.set(runId, stop)
  }

  function untrack(runId: string): void {
    stops.get(runId)?.()
    stops.delete(runId)
    books.delete(runId)
    const next = { ...progress.value }
    delete next[runId]
    progress.value = next
  }

  return {
    progress: progress as Readonly<Ref<Record<string, RunProgress>>>,
    /** Reconcile the live subscriptions with the set of live run ids. */
    sync(ids: ReadonlyArray<string>): void {
      const wanted = new Set(ids)
      for (const id of [...stops.keys()]) if (!wanted.has(id)) untrack(id)
      for (const id of ids) if (!stops.has(id)) track(id)
    },
    stop(): void {
      for (const id of [...stops.keys()]) untrack(id)
    },
  }
}

/** The ActivityDock's binding: one tracker over the documents store's run
 *  event subscriptions. Call inside a component setup; `stop()` on unmount. */
export function useRunProgress() {
  const documents = useDocumentsStore()
  return createRunProgressTracker((runId, onEvent) => documents.subscribeRunEvents(runId, onEvent))
}
