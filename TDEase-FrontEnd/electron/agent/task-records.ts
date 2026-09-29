/**
 * Task records — the shared bookkeeping behind the session-scoped background
 * task registries (subagents, jobs).
 *
 * A background task record is the same shape everywhere: an id, a small state
 * machine, a createdAt/settledAt pair, an optional error — mirrored to one
 * `<id>.json` per record under the session dir, pushed to subscribers on every
 * transition, and drained exactly once per settlement so the context hook can
 * inject completions without re-announcing them. What differs per kind is the
 * DRIVER (a child session vs a child process) and the status projection; the
 * bookkeeping below is the part whose semantics must match anyway — a bug in
 * persist/restore/drain semantics was always a bug in BOTH registries.
 *
 * This is composition, not a base class: each registry owns its record type,
 * its revive rules, and its driver; this module never knows how a task runs.
 * (Supersedes the 2026-07 note in job-registry.ts that deliberately kept two
 * parallel implementations — fault isolation is preserved because the drivers
 * stay independent; only the identical machinery is shared.)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The record shape every background task carries. `state` is the kind's own
 *  union (running + terminals); the id accessor is kind-specific (`subagentId`
 *  vs `jobId`), so records keep their natural field names. */
export interface TaskRecordBase {
  state: string
  readonly createdAt: number
  settledAt?: number
  error?: { code: string; message: string }
}

export interface TaskRecordsOptions<Record extends TaskRecordBase, Status> {
  /** Console-warn label ('[subagents]' / '[jobs]') — degraded-history warnings
   *  name their registry. */
  kind: string
  /** One `<id>.json` per record; null = in-memory only (no workspace root). */
  persistDir: string | null
  idOf(record: Record): string
  toStatus(record: Record): Status
  isRunning(record: Record): boolean
  /** Revive a persisted status JSON into a record, or null to skip it.
   *  `wasRunning` says the stored state was `running`: the driver died with
   *  the previous process, so the kind settles the record into its orphan
   *  state (subagent `blocked`, job `failed`) with its orphan error code. */
  revive(status: unknown, wasRunning: boolean): Record | null
  /** Optional decoration of what drainSettled announces (e.g. jobs attach a
   *  short output tail so the context-hook summary shows what printed). */
  settleAnnouncement?(record: Record): Status
}

export function createTaskRecords<Record extends TaskRecordBase, Status>(
  options: TaskRecordsOptions<Record, Status>,
) {
  const records = new Map<string, Record>()
  const listeners = new Set<(snapshot: ReadonlyArray<Status>) => void>()
  /**
   * The settle-wait kernel: per-record resolver SETS so every waiter on one
   * task is settled by ONE transition (the next `announce` flush). Waiters do
   * not multiply subscriptions or polls; a waiter that loses a race or is
   * aborted disposes its resolver immediately instead of lingering until the
   * task settles. Entries are removed the moment they resolve or dispose.
   */
  const settleWaiters = new Map<string, Set<(record: Record) => void>>()
  /** Ids whose settlement the context hook already announced — drainSettled
   *  skips these so a completion is injected exactly once. Kinds that hand a
   *  result to the model through another path (wait/status) mark their records
   *  here too; followup-style re-runs clear the entry so the new completion
   *  is announced fresh. */
  const notified = new Set<string>()

  const { persistDir, kind, idOf, toStatus } = options

  function persistOne(record: Record): void {
    if (!persistDir) return
    try {
      mkdirSync(persistDir, { recursive: true })
      writeFileSync(path.join(persistDir, `${idOf(record)}.json`), JSON.stringify(toStatus(record)), 'utf8')
    } catch (error) {
      // A persist failure is a degraded-history problem, never a turn failure.
      console.warn(`${kind} persist swallowed`, error)
    }
  }

  function persistAll(): void {
    for (const record of records.values()) persistOne(record)
  }

  function snapshot(): ReadonlyArray<Status> {
    return [...records.values()].map(toStatus)
  }

  function emit(): void {
    if (listeners.size === 0) return
    const current = snapshot()
    for (const listener of listeners) {
      try { listener(current) } catch { /* a UI listener must not abort the transition */ }
    }
  }

  /** Announce a transition: with a record, mirror THAT record; without one,
   *  mirror every record (a kind whose records mutate out-of-band — job
   *  output tails — persists wholesale). Then notify subscribers and settle
   *  any waiters whose record reached a terminal state. */
  function announce(record?: Record): void {
    if (record) persistOne(record)
    else if (persistDir) persistAll()
    emit()
    if (settleWaiters.size > 0) {
      for (const [id, waiters] of [...settleWaiters]) {
        const current = records.get(id)
        if (!current || options.isRunning(current)) continue
        settleWaiters.delete(id)
        for (const waiter of waiters) waiter(current)
      }
    }
  }

  /** Restore history from the persist dir. A still-running record is
   *  orphaned — the driver died with the previous process — and settles
   *  immediately with the orphan error, keeping whatever it had captured. */
  function restore(): void {
    if (!persistDir || !existsSync(persistDir)) return
    let files: string[]
    try {
      files = readdirSync(persistDir).filter((name) => name.endsWith('.json'))
    } catch (error) {
      console.warn(`${kind} restore swallowed`, error)
      return
    }
    for (const file of files) {
      try {
        const status: unknown = JSON.parse(readFileSync(path.join(persistDir, file), 'utf8'))
        const wasRunning = (status as { state?: unknown }).state === 'running'
        const record = options.revive(status, wasRunning)
        if (record) records.set(idOf(record), record)
      } catch (error) {
        console.warn(`${kind} restore skipped ${file}`, error)
      }
    }
  }

  function drainSettled(): ReadonlyArray<Status> {
    const fresh: Status[] = []
    for (const record of records.values()) {
      const id = idOf(record)
      if (options.isRunning(record) || notified.has(id)) continue
      notified.add(id)
      fresh.push(options.settleAnnouncement ? options.settleAnnouncement(record) : toStatus(record))
    }
    return fresh
  }

  function subscribe(listener: (snapshot: ReadonlyArray<Status>) => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /**
   * Resolve when the record leaves its running state — the shared settle
   * flush. Terminal at call time resolves immediately; unknown ids reject.
   * `dispose()` removes the waiter when its caller abandons the wait (abort,
   * lost race), so cancelled waiters never linger on the record.
   */
  function whenSettled(id: string): { promise: Promise<Record>; dispose(): void } {
    const current = records.get(id)
    if (!current) {
      return { promise: Promise.reject(new Error(`${kind} no task record: ${id}`)), dispose: () => undefined }
    }
    if (!options.isRunning(current)) {
      return { promise: Promise.resolve(current), dispose: () => undefined }
    }
    let waiter!: (record: Record) => void
    const promise = new Promise<Record>((resolve) => { waiter = resolve })
    let waiters = settleWaiters.get(id)
    if (!waiters) {
      waiters = new Set()
      settleWaiters.set(id, waiters)
    }
    waiters.add(waiter)
    return {
      promise,
      dispose(): void {
        const set = settleWaiters.get(id)
        if (!set) return
        set.delete(waiter)
        if (set.size === 0) settleWaiters.delete(id)
      },
    }
  }

  /** The announcement projection of one record — what the context hook
   *  injects on settlement (kinds may attach bounded output; jobs attach
   *  tails). Wait tools return THIS shape so the model never needs a
   *  follow-up peek for what it already waited on. */
  function announcementOf(record: Record): Status {
    return options.settleAnnouncement ? options.settleAnnouncement(record) : toStatus(record)
  }

  return {
    /** The live record store — the owning registry reads and mutates it
     *  directly and calls `announce` after each transition. */
    records,
    announce,
    snapshot,
    restore,
    drainSettled,
    subscribe,
    whenSettled,
    announcementOf,
    markNotified(id: string): void { notified.add(id) },
    clearNotified(id: string): void { notified.delete(id) },
  }
}
