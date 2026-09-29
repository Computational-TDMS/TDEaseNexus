/**
 * Workflow journal — positional call-index cache for orchestration `agent()` calls.
 *
 * Purpose: make orchestration scripts resumable without re-spawning subagents.
 * Each completed `agent()` call is journaled as `{index, promptHash, result}`.
 * On `resumeFromRunId`, the runtime replays the unchanged prefix from cache and
 * re-runs only the changed tail — so editing one prompt in a 20-agent script no
 * longer re-pays for the other 19.
 *
 * Replay contract (mirrors pi-dynamic-workflows' positional semantics): the
 * cache matches by call execution order. The first `(index, promptHash)`
 * mismatch invalidates the remainder of the cache for that run — this lives in
 * the runtime (`replayBroken`), not here. The journal itself is a dumb
 * key-value store keyed by `(index, promptHash)`; it does not decide policy.
 *
 * Only `state === 'returned'` results are cached (blocked/cancelled calls never
 * enter the journal and always re-run) — matches pi-dynamic-workflows' "only a
 * call that finishes with a real result is journaled".
 *
 * Determinism does NOT come from a VM sandbox (TDEase has none). It comes from
 * this journal: even if a script reads `Date.now()`, the cached agent results
 * are reused verbatim, so the expensive part (the subagent spawn) is never
 * repeated for an unchanged prompt. The journal is the determinism boundary.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface JournalEntry {
  /** Execution order of the `agent()` call within one script run (from 0). */
  readonly index: number
  /** `hashAgentCall(prompt, options)` — the cache key suffix. */
  readonly promptHash: string
  /** The `SubagentResult` (§6 envelope) the call settled with. */
  readonly result: unknown
  /** Only `'returned'` results are cached by the runtime. */
  readonly state: 'returned' | 'blocked' | 'cancelled'
}

export interface WorkflowJournal {
  readonly runId: string
  /** Find a cached entry by exact `(index, promptHash)`. Read-only. */
  lookup(index: number, promptHash: string): JournalEntry | undefined
  /** Record a fresh result; persisted immediately when a persistPath is set. */
  append(entry: JournalEntry): void
  /** Entry count (prior reused + fresh). For status / diagnostics. */
  readonly size: number
}

/**
 * Build a journal for one orchestration run. When `resume` is set and
 * `persistPath` points at a prior run's file, prior entries are loaded as the
 * read-only cache the runtime consults; fresh appends overwrite that file in
 * place so the latest prefix is always what the next resume sees.
 */
export function createWorkflowJournal(options: {
  runId: string
  persistPath?: string
  /** When true, prior entries are loaded from `persistPath` for replay. */
  resume?: boolean
}): WorkflowJournal {
  const entries: JournalEntry[] = []
  if (options.resume && options.persistPath) {
    loadPrior(options.persistPath, entries)
  }

  function persist(): void {
    if (!options.persistPath) return
    try {
      mkdirSync(path.dirname(options.persistPath), { recursive: true })
      writeFileSync(
        options.persistPath,
        JSON.stringify({ runId: options.runId, entries }, null, 2),
        'utf8',
      )
    } catch (error) {
      // A persist failure is a degraded-history problem, never a turn failure:
      // the run still completes in-memory, it just cannot resume later.
      console.warn('[orchestrate] journal persist swallowed', error)
    }
  }

  return {
    runId: options.runId,
    lookup(index, promptHash) {
      return entries.find((entry) => entry.index === index && entry.promptHash === promptHash)
    },
    append(entry) {
      // Replace any prior entry at the same index (resume re-ran this call).
      const at = entries.findIndex((existing) => existing.index === entry.index)
      if (at >= 0) entries[at] = entry
      else entries.push(entry)
      entries.sort((a, b) => a.index - b.index)
      persist()
    },
    get size() {
      return entries.length
    },
  }
}

function loadPrior(persistPath: string, into: JournalEntry[]): void {
  try {
    const parsed = JSON.parse(readFileSync(persistPath, 'utf8')) as { entries?: JournalEntry[] }
    if (Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries) {
        if (entry && typeof entry.index === 'number' && typeof entry.promptHash === 'string') {
          into.push({ index: entry.index, promptHash: entry.promptHash, result: entry.result, state: entry.state })
        }
      }
    }
  } catch {
    // Missing / corrupt journal = no cache; the run proceeds as fresh.
  }
}

/**
 * Stable hash of an `agent()` call's prompt + options — the cache key suffix.
 * Options are canonicalized (sorted object keys) so key order does not change
 * the hash; `{role:'a'}` and `{role:'a',input:undefined}` would differ, so the
 * runtime strips `undefined`-valued options before hashing.
 */
export function hashAgentCall(prompt: string, options?: Record<string, unknown>): string {
  const hash = createHash('sha256')
  hash.update(prompt)
  if (options !== undefined) hash.update('\u0000' + canonicalStringify(options))
  return hash.digest('hex').slice(0, 16)
}

/** Stable JSON: object keys sorted ascending, arrays preserved in order. */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return (
      '{' +
      Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k]))
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}
