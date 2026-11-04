import type { RunId } from '../domain/identity'
import type { ExecutionRange, RunSummary, RunWaitResult, TrashedRunSummary } from '../domain/run'
import type { BackendGateway, Page, RunDefinitionContent, RunDefinitionRevision, RunQuery, Unsubscribe } from '../ports/backend-gateway'
import { applyRunEvent, type RunProjection } from '../projections/run-projector'
import { RunSubscriptions } from './run-subscriptions'

export interface RunRepositorySnapshot {
  runs: ReadonlyMap<RunId, RunSummary>
  ranges: ReadonlyMap<RunId, ReadonlyArray<ExecutionRange>>
  trash: ReadonlyArray<TrashedRunSummary>
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

const EMPTY: RunRepositorySnapshot = {
  runs: new Map(), ranges: new Map(), trash: [], total: 0, offset: 0, limit: 50, hasMore: false,
}

export const DEFAULT_RUN_WAIT_DEADLINE_MS = 120_000
/** Aligned with the bash tool's 300s cap — the longest single tool call this
 *  harness has already proven safe. Scientific runs run longer than one wait
 *  call; the settle announcement (drainSettledRuns) covers the rest. */
export const MAX_RUN_WAIT_DEADLINE_MS = 300_000

export class RunRepository {
  private snapshotValue: RunRepositorySnapshot = EMPTY
  private readonly listeners = new Set<(snapshot: RunRepositorySnapshot) => void>()
  private readonly observations = new Map<RunId, Unsubscribe>()
  private readonly journalProjections = new Map<RunId, RunProjection>()
  /** Runs that transitioned non-terminal → terminal here and have not been
   *  drained yet (see drainSettledRuns). Bounded: drained entries leave, and
   *  a run already terminal on first sight never enters — only live watching
   *  produces an announcement, mirroring jobs/subagents settle semantics. */
  private readonly settledUnannounced = new Map<RunId, RunSummary>()
  private workspaceId: string | undefined
  private query: RunQuery = {}
  private loadInFlight: Promise<RunRepositorySnapshot> | null = null
  private loadInFlightQuery: RunQuery | null = null
  private loadMoreInFlight: Promise<RunRepositorySnapshot> | null = null

  constructor(
    private readonly backend: BackendGateway,
    private readonly subscriptions: RunSubscriptions,
  ) {}

  snapshot(): RunRepositorySnapshot { return this.snapshotValue }

  onChange(listener: (snapshot: RunRepositorySnapshot) => void, emitCurrent = true): Unsubscribe {
    this.listeners.add(listener)
    if (emitCurrent) listener(this.snapshotValue)
    return () => this.listeners.delete(listener)
  }

  // Same in-flight guard as loadMore(): the runs store watcher and
  // ActivityDock's onMounted can both trigger a full reload, and without the
  // guard each concurrent caller double-fetches /runs + /runs/trash. Coalesced
  // only for an identical query — a different query (workspace switch reuses
  // the same repository instance) must still run and win, as it did unguarded.
  async load(query: RunQuery = {}): Promise<RunRepositorySnapshot> {
    if (this.loadInFlight && sameQuery(this.loadInFlightQuery, query)) return this.loadInFlight
    const inFlight = this.fetchAll(query)
    this.loadInFlight = inFlight
    this.loadInFlightQuery = query
    try { return await inFlight }
    finally {
      if (this.loadInFlight === inFlight) {
        this.loadInFlight = null
        this.loadInFlightQuery = null
      }
    }
  }

  private async fetchAll(query: RunQuery): Promise<RunRepositorySnapshot> {
    this.stopObservations()
    this.workspaceId = query.workspaceId
    this.query = { ...query }
    const [page, trash] = await Promise.all([this.backend.listRuns(query), this.backend.listTrash()])
    this.snapshotValue = fromPage(page, trash.filter((run) => !query.workspaceId || run.workspaceId === query.workspaceId))
    for (const run of page.items) if (!isTerminal(run)) this.observe(run)
    this.emit()
    return this.snapshotValue
  }

  async loadMore(query: RunQuery = {}): Promise<RunRepositorySnapshot> {
    if (this.loadMoreInFlight) return this.loadMoreInFlight
    this.loadMoreInFlight = this.fetchMore(query)
    try { return await this.loadMoreInFlight }
    finally { this.loadMoreInFlight = null }
  }

  private async fetchMore(query: RunQuery): Promise<RunRepositorySnapshot> {
    const page = await this.backend.listRuns({
      ...this.query,
      ...query,
      offset: this.snapshotValue.offset + this.snapshotValue.limit,
    })
    const runs = new Map(this.snapshotValue.runs)
    const ranges = new Map(this.snapshotValue.ranges)
    for (const run of page.items) {
      runs.set(run.id, run)
      if (!ranges.has(run.id)) ranges.set(run.id, [])
      if (!isTerminal(run)) this.observe(run)
    }
    this.snapshotValue = {
      ...this.snapshotValue, runs, ranges, total: page.total, offset: page.offset,
      limit: page.limit, hasMore: page.hasMore,
    }
    this.emit()
    return this.snapshotValue
  }

  /**
   * The Run's immutable definition history: every submitted definition with its
   * outcome (SUCCEEDED/FAILED/CANCELLED/QUEUED/RUNNING) and the results
   * revision it produced, if any. Read-only — this answers "what was changed,
   * when, and which run produced the current results", never mutates state.
   */
  async listDefinitions(runId: RunId): Promise<ReadonlyArray<RunDefinitionRevision>> {
    return this.backend.listRunDefinitions(runId)
  }

  /** One revision's frozen content — the exact Snakefile/config/nodes it ran.
   *  The self-correction primitive: diff a planned edit against what an
   *  earlier revision actually executed. */
  async readDefinition(runId: RunId, definitionRevisionId: string): Promise<RunDefinitionContent> {
    return this.backend.readDefinition(runId, definitionRevisionId)
  }

  async refresh(runId: RunId): Promise<RunSummary> {
    const run = await this.backend.getRun(runId)
    if (!this.upsert(run)) return this.snapshotValue.runs.get(runId) ?? run
    if (isTerminal(run)) this.stopObservation(runId)
    else this.observe(run)
    return run
  }

  /**
   * Resolve a run identifier that may be either a backend RunId or a Workspace
   * run folder name — the data concept the user/agent actually sees. `runs.*`
   * commands receive whatever the caller typed (`soybean-all`, `runs/soybean-all`,
   * or `run_<hash>`); this maps the folder name to the backend RunId whose
   * `workspaceRunPath` matches, so a run is addressed by its data folder, not by
   * an internal workflow id. Read-only: a name lookup never mutates the snapshot.
   *
   * Falls through to the candidate unchanged when it already looks like a
   * backend id or matches nothing by workspace path — the backend then validates
   * it (and rejects genuinely unknown values itself).
   */
  async resolveRunId(candidate: RunId): Promise<RunId> {
    if (this.snapshotValue.runs.has(candidate)) return candidate
    const raw = candidate as string
    if (BACKEND_RUN_ID.test(raw)) return candidate
    const target = raw.startsWith('runs/') ? raw : `runs/${raw}`
    const cached = [...this.snapshotValue.runs.values()].filter((run) => run.workspaceRunPath === target)
    if (cached.length > 0) return mostRecentRun(cached).id
    // Cold start: the snapshot may not have been loaded yet (the agent path
    // does not pre-load runs the way the UI store does). One bounded listing is
    // enough to find the run without caching side effects.
    const page = await this.backend.listRuns({ workspaceId: this.workspaceId })
    const fresh = page.items.filter((run) => run.workspaceRunPath === target)
    if (fresh.length > 0) return mostRecentRun(fresh).id
    return candidate
  }

  /**
   * Resolves once the Run reaches a terminal status, or the deadline elapses,
   * or `signal` aborts (a user stop must not park the caller's turn until the
   * deadline). Registers its own listener directly against `this.listeners`
   * rather than through the `stop = this.onChange(cb)` pattern, where `cb`
   * itself calls `stop()`: that pattern is only safe because `onChange()`
   * happens not to invoke `cb` synchronously today (docs/STATUS.md, defect
   * #2). Managing the Set directly makes teardown correct regardless of
   * whether a future `onChange()` ever emits synchronously.
   */
  async wait(runId: RunId, deadlineMs = DEFAULT_RUN_WAIT_DEADLINE_MS, signal?: AbortSignal): Promise<RunWaitResult> {
    const boundedDeadline = normalizeWaitDeadline(deadlineMs)
    const startedAt = Date.now()
    const initial = await this.refresh(runId)
    if (signal?.aborted) return { status: initial.status, waitedMs: Date.now() - startedAt }
    if (isTerminal(initial)) return { status: initial.status, waitedMs: Date.now() - startedAt }
    const remainingMs = Math.max(0, boundedDeadline - (Date.now() - startedAt))
    if (remainingMs === 0) return { status: initial.status, waitedMs: Date.now() - startedAt }
    return new Promise<RunWaitResult>((resolve) => {
      let settled = false
      const settle = (run: RunSummary) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.listeners.delete(listener)
        signal?.removeEventListener('abort', onAbort)
        resolve({ status: run.status, waitedMs: Date.now() - startedAt })
      }
      const listener = (snapshot: RunRepositorySnapshot): void => {
        const run = snapshot.runs.get(runId)
        if (run && isTerminal(run)) settle(run)
      }
      const onAbort = (): void => {
        settle(this.snapshotValue.runs.get(runId) ?? initial)
      }
      this.listeners.add(listener)
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => settle(this.snapshotValue.runs.get(runId) ?? initial), remainingMs)
    })
  }

  /** Announce-and-forget: every Run that went terminal while this repository
   *  was watching it, drained exactly once. The Agent context hook injects
   *  these so a submitted run reaches the model without `runs.status` polling
   *  — the same seam jobs and subagents use. */
  drainSettledRuns(): ReadonlyArray<RunSummary> {
    const drained = [...this.settledUnannounced.values()]
    this.settledUnannounced.clear()
    return drained
  }

  track(run: RunSummary): void {
    this.upsert(run)
    if (isTerminal(run)) this.stopObservation(run.id)
    else this.observe(run)
  }

  async cancel(runId: RunId): Promise<void> {
    await this.backend.cancelRun(runId)
    await this.refresh(runId)
  }

  async rerun(runId: RunId, mode: 'resume' | 'overwrite'): Promise<RunSummary> {
    const run = await this.backend.rerun(runId, mode)
    this.stopObservation(runId)
    this.upsert(run, [])
    this.observe(run)
    return run
  }

  async trash(runId: RunId): Promise<void> {
    await this.backend.trashRun(runId)
    await this.reconcileManagementState()
  }

  async restore(runId: RunId): Promise<RunSummary> {
    const run = await this.backend.restoreRun(runId)
    await this.reconcileManagementState()
    return run
  }

  dispose(): void {
    this.stopObservations()
    this.listeners.clear()
    this.journalProjections.clear()
    this.snapshotValue = EMPTY
    this.workspaceId = undefined
    this.query = {}
    this.loadInFlight = null
    this.loadInFlightQuery = null
    this.loadMoreInFlight = null
  }

  private observe(run: RunSummary): void {
    if (this.observations.has(run.id)) return
    const visibleThroughSeq = run.lastEventSeq
    this.journalProjections.set(run.id, {
      run: { ...run, lastEventSeq: 0 },
      lifecycleStatus: null,
      currentRevisionId: null,
      queuedMode: null,
      queuedAtSeq: null,
      ranges: [],
    })
    // Replay the canonical Journal from seq 0. RunSummary deliberately does
    // not duplicate queue revision/mode/cursor facts, so an incremental
    // projector cannot be safely initialized from that DTO.
    let stop: Unsubscribe = () => {}
    const observation = () => stop()
    this.observations.set(run.id, observation)
    stop = this.subscriptions.subscribe(run.id, 0, (event) => {
      const current = this.journalProjections.get(run.id)
      if (!current) return
      const next = applyRunEvent(current, event)
      this.journalProjections.set(run.id, next)
      if (event.seq >= visibleThroughSeq) this.upsert(next.run, next.ranges)
    }, () => {
      if (this.observations.get(run.id) !== observation) return
      this.observations.delete(run.id)
      this.journalProjections.delete(run.id)
      // `done` is the stream's terminal checkpoint. Re-read the public Run
      // once for error/timestamps/results; if it is still non-terminal because
      // a rerun raced the old stream, refresh() establishes a fresh observer.
      void this.refresh(run.id).catch(() => {})
    })
    if (this.observations.get(run.id) !== observation) stop()
  }

  private stopObservation(runId: RunId): void {
    this.observations.get(runId)?.()
    this.observations.delete(runId)
    this.journalProjections.delete(runId)
  }

  private stopObservations(): void {
    for (const stop of this.observations.values()) stop()
    this.observations.clear()
    this.journalProjections.clear()
  }

  private upsert(run: RunSummary, ranges?: ReadonlyArray<ExecutionRange>): boolean {
    const existing = this.snapshotValue.runs.get(run.id)
    if (existing && run.lastEventSeq < existing.lastEventSeq) return false
    if (existing && !isTerminal(existing) && isTerminal(run)) this.settledUnannounced.set(run.id, run)
    const runs = new Map(this.snapshotValue.runs)
    runs.set(run.id, run)
    const rangesMap = new Map(this.snapshotValue.ranges)
    rangesMap.set(run.id, ranges ?? this.snapshotValue.ranges.get(run.id) ?? [])
    this.snapshotValue = { ...this.snapshotValue, runs, ranges: rangesMap }
    this.emit()
    return true
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshotValue)
  }

  private async reconcileManagementState(): Promise<void> {
    const loadedLimit = Math.max(
      this.snapshotValue.offset + this.snapshotValue.limit,
      this.snapshotValue.runs.size,
      50,
    )
    const query = { ...this.query, offset: 0, limit: loadedLimit }
    const [page, trash] = await Promise.all([this.backend.listRuns(query), this.backend.listTrash()])
    this.stopObservations()
    this.snapshotValue = fromPage(
      page,
      trash.filter((run) => !this.workspaceId || run.workspaceId === this.workspaceId),
    )
    for (const run of page.items) if (!isTerminal(run)) this.observe(run)
    this.emit()
  }
}

function fromPage(page: Page<RunSummary>, trash: ReadonlyArray<TrashedRunSummary>): RunRepositorySnapshot {
  return {
    runs: new Map(page.items.map((run) => [run.id, run])),
    ranges: new Map(page.items.map((run) => [run.id, []])),
    trash, total: page.total, offset: page.offset, limit: page.limit, hasMore: page.hasMore,
  }
}

/** Key-order-sensitive JSON compare — deliberately conservative: it may miss a
 *  same-query match spelled with different key order (no coalescing, harmless),
 *  but never coalesces two genuinely different queries. */
function sameQuery(a: RunQuery | null, b: RunQuery): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b)
}

function isTerminal(run: RunSummary): boolean {
  return run.status === 'SUCCEEDED' || run.status === 'FAILED' || run.status === 'CANCELLED'
}

/** Backend RunIds produced by `stableRunId` are `run_<hex>`; a Workspace run
 *  folder name never matches this shape, so it cleanly separates the two. */
const BACKEND_RUN_ID = /^run_[a-f0-9]{8,}$/i

/** One Workspace run folder maps to ONE backend run (`stableRunId` is
 *  deterministic over workspace id + run path). Legacy installs may still hold
 *  random-era duplicates; the newest is the live run for that data folder. */
function mostRecentRun(runs: ReadonlyArray<RunSummary>): RunSummary {
  return runs.reduce((latest, run) => (run.createdAt > latest.createdAt ? run : latest))
}

function normalizeWaitDeadline(deadlineMs: number): number {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error('Run wait deadline must be a positive integer')
  }
  return Math.min(deadlineMs, MAX_RUN_WAIT_DEADLINE_MS)
}
