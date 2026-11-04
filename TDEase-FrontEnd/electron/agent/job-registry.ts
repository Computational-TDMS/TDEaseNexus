/**
 * Job registry — Node-side implementation of `JobCommandPort`
 * (src/studio/commands/registry.ts).
 *
 * Long shell commands run async: `start` returns a jobId immediately, the child
 * process runs fire-and-forget, and completion settles the record. The context
 * hook (tdease-extension.ts) injects a summary of newly-settled jobs into the
 * next provider request, so the model never `bash sleep + status` polls.
 *
 * Sibling of `subagent-registry.ts` over the shared `task-records.ts`
 * bookkeeping: the only kind-specific parts are the driver
 * (`child_process.spawn` instead of `runtime.prompt`), the status projection,
 * and the revive rules. A 2026-07 note here deliberately kept the two
 * registries apart so a bug in one could not break the other; the 2026-08-16
 * architecture review superseded it — the ~120 duplicated lines were exactly
 * the machinery whose semantics must match in both, and composition (this
 * file owns its record type and driver; task-records owns persist / restore /
 * subscribe / drain) keeps the drivers as isolated as before.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import type {
  JobCommandPort,
  JobPeek,
  JobStartInput,
  JobState,
  JobStatus,
  JobWaitInput,
} from '../../src/studio/commands/registry'
import type { PermissionGateway } from './contracts'
import { createTaskRecords } from './task-records'

const DEFAULT_TIMEOUT_S = 600
/** Cap the in-memory stdout/stderr tail so a chatty command cannot grow a
 *  record without bound. The full stream is also appended to `<jobId>.log`. */
const MAX_TAIL_BYTES = 64 * 1024

export type JobRecordsSnapshot = ReadonlyArray<JobStatus>
export type JobRecordsListener = (snapshot: JobRecordsSnapshot) => void

export interface JobRegistryOptions {
  workspaceRoot: string
  parentSessionId: string
  /** Shell environment — the same `resolveBashEnv` the bash tool uses. */
  resolveEnv: () => NodeJS.ProcessEnv
  /** Unbypassable command/cwd preflight (same PermissionGateway as bash). */
  permission: PermissionGateway
  /** Override the shell/args auto-detection (defaults to ComSpec/cmd on Win,
   *  $SHELL/sh elsewhere). */
  resolveShell?: () => { shell: string; args: string[] }
}

interface JobRecord {
  readonly jobId: string
  readonly command: string
  state: JobState
  readonly createdAt: number
  settledAt?: number
  pid?: number
  exitCode?: number
  /** Trailing stdout/stderr kept in-memory for `peek` without re-reading the log. */
  stdoutTail?: string
  stderrTail?: string
  error?: { code: string; message: string }
}

export function createJobRegistry(options: JobRegistryOptions): JobCommandPort {
  const jobsDir = path.join(options.workspaceRoot, '.tdease', 'sessions', options.parentSessionId, 'jobs')
  const tasks = createTaskRecords<JobRecord, JobStatus>({
    kind: '[jobs]',
    persistDir: jobsDir,
    idOf: (record) => record.jobId,
    toStatus,
    isRunning: (record) => record.state === 'running',
    revive: reviveJob,
    settleAnnouncement: (record) => ({
      ...toStatus(record),
      // Carry a short tail so the context-hook summary shows what the command
      // printed, not just its exit code — the model otherwise has to peek.
      stdoutTail: tailLines(record.stdoutTail ?? '', 20),
      stderrTail: tailLines(record.stderrTail ?? '', 20),
    }),
  })
  const records = tasks.records
  // Restore synchronously at construction so the first `list()` reflects history.
  tasks.restore()

  /** Live child handles so `cancel` can signal the process tree. */
  const children = new Map<string, ChildProcess>()

  function appendLog(jobId: string, chunk: string): void {
    try {
      appendFileSync(path.join(jobsDir, `${jobId}.log`), chunk, 'utf8')
    } catch { /* best-effort — the in-memory tail still feeds peek */ }
  }

  // Completion dedupe: the timeout path and the exit-settle path are both
  // guarded by `record.state !== 'running'` (single-threaded synchronous state
  // mutation), so the second path to fire is a no-op. No separate seen-set.
  return {
    async start(input: JobStartInput) {
      const command = input.command
      if (!command || !command.trim()) throw new Error('job.start command must be a non-empty string')
      options.permission.assertShellCommand(command)
      const cwd = options.permission.assertCommandCwd(input.cwd)

      const jobId = `job_${randomUUID()}`
      const record: JobRecord = { jobId, command, state: 'running', createdAt: Date.now() }
      records.set(jobId, record)
      tasks.announce()

      const { shell, args } = (options.resolveShell ?? defaultShell)()
      const acc = { stdout: '', stderr: '' }
      let child: ChildProcess
      try {
        child = spawn(shell, [...args, command], {
          cwd,
          env: options.resolveEnv(),
          windowsHide: true,
        })
      } catch (error) {
        record.state = 'failed'
        record.settledAt = Date.now()
        record.error = { code: 'JOB_SPAWN_FAILED', message: messageOf(error) }
        tasks.announce()
        return { jobId, waitable: true as const }
      }
      children.set(jobId, child)
      if (child.pid !== undefined) record.pid = child.pid

      child.stdout?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        acc.stdout = appendTail(acc.stdout, text)
        // The live tail IS the record's tail: peek/status read the record, so
        // the bounded buffer must land there per chunk — not only at settle.
        record.stdoutTail = acc.stdout
        appendLog(jobId, text)
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        acc.stderr = appendTail(acc.stderr, text)
        record.stderrTail = acc.stderr
        appendLog(jobId, text)
      })

      const timeoutS = input.timeoutS ?? DEFAULT_TIMEOUT_S
      // unref() so a lingering timer never holds the process open after a
      // settle that never arrives (tests, abrupt exit).
      const timer = setTimeout(() => {
        if (record.state !== 'running') return
        killJob(child)
        record.state = 'failed'
        record.settledAt = Date.now()
        record.error = { code: 'JOB_TIMEOUT', message: `Job exceeded ${timeoutS}s` }
        record.stdoutTail = acc.stdout
        record.stderrTail = acc.stderr
        tasks.announce()
      }, timeoutS * 1000)
      timer.unref?.()

      // Background settle — fire-and-forget. The parent command returned
      // `{ jobId }` below; this only updates the run record.
      void (async () => {
        try {
          const { code } = await waitForExit(child)
          if (record.state !== 'running') return // timeout/cancel already settled
          record.exitCode = code ?? -1
          const ok = code === 0
          record.state = ok ? 'succeeded' : 'failed'
          record.settledAt = Date.now()
          if (!ok && record.error === undefined) {
            record.error = { code: 'JOB_NONZERO_EXIT', message: `Command exited with code ${code}` }
          }
        } catch (error) {
          if (record.state !== 'running') return
          record.state = 'failed'
          record.settledAt = Date.now()
          record.error = { code: 'JOB_SETTLE_FAILED', message: messageOf(error) }
        } finally {
          clearTimeout(timer)
          children.delete(jobId)
          record.stdoutTail = acc.stdout
          record.stderrTail = acc.stderr
          tasks.announce()
        }
      })()

      // The start response tells the model the job is waitable and how long
      // the command is expected to run — `job.wait` is the follow-up call, the
      // anti-polling contract's positive form.
      return { jobId, waitable: true as const, suggestedWaitS: timeoutS }
    },

    async status(jobId: string) {
      const record = records.get(jobId)
      if (!record) throw new Error(`No job: ${jobId}`)
      return toStatus(record)
    },

    async peek(jobId: string, lines = 40): Promise<JobPeek> {
      const record = records.get(jobId)
      if (!record) throw new Error(`No job: ${jobId}`)
      return {
        jobId,
        stdoutTail: tailLines(record.stdoutTail ?? '', lines),
        stderrTail: tailLines(record.stderrTail ?? '', lines),
        state: record.state,
      }
    },

    async cancel(jobId: string) {
      const record = records.get(jobId)
      if (!record) throw new Error(`No job: ${jobId}`)
      if (record.state === 'running') {
        const child = children.get(jobId)
        if (child) killJob(child)
        record.state = 'cancelled'
        record.settledAt = Date.now()
        children.delete(jobId)
        tasks.announce()
      }
      return { ok: true as const }
    },

    /** Kill every running job's process tree and settle it cancelled — the
     *  owner-sweep primitive. Called by `AgentRuntime.abort`/`dispose` and
     *  the app-quit path; idempotent (settled records are skipped). Resolves
     *  once the killed trees CONFIRMED their exit (bounded), so a quit never
     *  races the OS kill into orphaning grandchildren. */
    async cancelAll(): Promise<void> {
      if (children.size === 0) return
      const targets = [...children.values()]
      for (const [jobId, child] of [...children]) {
        const record = records.get(jobId)
        if (record && record.state === 'running') {
          killJob(child)
          record.state = 'cancelled'
          record.settledAt = Date.now()
        }
        children.delete(jobId)
      }
      tasks.announce()
      const KILL_CONFIRM_TIMEOUT_MS = 5_000
      await Promise.race([
        Promise.all(targets.map((child) => waitForExit(child))),
        new Promise<void>((resolve) => { const timer = setTimeout(resolve, KILL_CONFIRM_TIMEOUT_MS); timer.unref?.() }),
      ])
    },

    /**
     * Block until the selected jobs settle (or the first one does, for the
     * scoped first-completion form) and return their statuses — the positive
     * form of the no-polling contract. Terminal statuses ride the SAME
     * bounded-output projection the context hook announces, so the model gets
     * state AND output in one response. Waiting rides the task-records settle
     * kernel (shared flush per record, waiter dispose on abandon); a signal
     * already cancelled at entry returns the snapshot at once instead of
     * parking the tool call for the whole job.
     */
    async wait(input: JobWaitInput, signal?: AbortSignal) {
      const explicitIds = input.jobIds ? [...input.jobIds] : null
      if (explicitIds?.length === 0) throw new Error('job.wait jobIds must not be empty')
      const selected = explicitIds
        ? explicitIds.map((id) => {
            const record = records.get(id)
            if (!record) throw new Error(`No job: ${id}`)
            return record
          })
        : [...records.values()]
      const all = explicitIds !== null ? input.all === true : true
      const statusOf = (record: JobRecord): JobStatus =>
        record.state === 'running' ? toStatus(record) : tasks.announcementOf(record)

      if (signal?.aborted) return selected.map(statusOf)

      const runningAtEntry = selected.filter((record) => record.state === 'running')
      const handles = runningAtEntry.map((record) => tasks.whenSettled(record.jobId))
      if (handles.length > 0) {
        // Scoped selector: default first-completion so an early result is not
        // held behind the slowest job; all:true waits for every selected job.
        // The unscoped form is the "collect everything" call and waits for all.
        const settle = all
          ? Promise.all(handles.map((handle) => handle.promise))
          : Promise.race(handles.map((handle) => handle.promise))
        await new Promise<void>((resolve) => {
          let finished = false
          const finish = (): void => {
            if (finished) return
            finished = true
            signal?.removeEventListener('abort', onAbort)
            for (const handle of handles) handle.dispose()
            resolve()
          }
          const onAbort = (): void => finish()
          signal?.addEventListener('abort', onAbort, { once: true })
          void settle.then(finish, finish)
        })
      }
      // Hand the terminal statuses to the model — mark them notified so the
      // context hook does not re-announce what the model just read. Still-
      // running selections (the abort path) stay unmarked for a later drain.
      const statuses = selected.map(statusOf)
      for (const record of selected) {
        if (record.state !== 'running') tasks.markNotified(record.jobId)
      }
      return statuses
    },

    list(): JobRecordsSnapshot { return tasks.snapshot() },

    drainSettled(): JobRecordsSnapshot { return tasks.drainSettled() },

    subscribe(listener: JobRecordsListener): () => void { return tasks.subscribe(listener) },
  }
}

function defaultShell(): { shell: string; args: string[] } {
  // The agent's command language is bash (`$VAR`, `$(...)`, pipes) — the
  // synchronous bash tool runs Git Bash, so background jobs must run the
  // SAME shell: cmd.exe does not expand `$VAR` and turns a correct bash
  // command into a literal filename (job.start failed that way). Fall back
  // to the bash tool's Git Bash resolution on Windows.
  if (process.platform === 'win32') {
    const bash = resolveGitBash()
    if (bash) return { shell: bash, args: ['-c'] }
    return { shell: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c'] }
  }
  return { shell: process.env.SHELL ?? '/bin/sh', args: ['-c'] }
}

/** Git Bash known locations on Windows (same search the bash tool uses). */
function resolveGitBash(): string | null {
  for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (!root) continue
    const cand = path.join(root, 'Git', 'bin', 'bash.exe')
    if (existsSync(cand)) return cand
  }
  return null
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }))
    child.once('error', () => resolve({ code: -1, signal: null }))
  })
}

function killJob(child: ChildProcess): void {
  try {
    if (process.platform === 'win32' && child.pid !== undefined) {
      // taskkill /T takes the whole process tree. The 'error' listener is
      // not optional: a failed spawn emits asynchronously, past this try's
      // reach, and would surface as an uncaughtException instead.
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true })
        .once('error', () => undefined)
    } else {
      child.kill('SIGTERM')
    }
  } catch { /* best-effort — the close handler still settles the record */ }
}

function appendTail(buffer: string, chunk: string): string {
  const next = buffer + chunk
  return next.length > MAX_TAIL_BYTES ? next.slice(-MAX_TAIL_BYTES) : next
}

function tailLines(text: string, lines: number): string {
  return text.split('\n').slice(-lines).join('\n')
}

function toStatus(record: JobRecord): JobStatus {
  const now = Date.now()
  return {
    jobId: record.jobId,
    command: record.command,
    state: record.state,
    createdAt: record.createdAt,
    elapsedS: Math.max(0, Math.round(((record.settledAt ?? now) - record.createdAt) / 1000)),
    ...(record.pid !== undefined ? { pid: record.pid } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
  }
}

/** Revive a persisted job status: a still-running record orphaned at process
 *  restart settles as failed with JOB_ORPHANED, keeping history and output. */
function reviveJob(status: unknown, wasRunning: boolean): JobRecord | null {
  const stored = status as JobStatus
  const orphaned: JobState = wasRunning ? 'failed' : stored.state
  return {
    jobId: stored.jobId,
    command: stored.command,
    state: orphaned,
    createdAt: stored.createdAt,
    ...(stored.elapsedS !== undefined ? { settledAt: stored.createdAt + stored.elapsedS * 1000 } : {}),
    ...(stored.pid !== undefined ? { pid: stored.pid } : {}),
    ...(stored.exitCode !== undefined ? { exitCode: stored.exitCode } : {}),
    ...(wasRunning
      ? { error: { code: 'JOB_ORPHANED', message: 'Job was running when the session process restarted' } }
      : stored.error !== undefined ? { error: stored.error } : {}),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
