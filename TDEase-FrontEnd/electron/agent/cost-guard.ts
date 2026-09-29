import { stat } from 'node:fs/promises'

/**
 * The cost guard — TDEase's cost-constrained take on oh-my-pi's
 * time-traveling stream rules. A rule stays dormant until a tool call trips
 * it; the trip aborts the call at the last moment before cost is paid (the
 * tool never executes) and hands the model the rule as guidance, so its retry
 * inside the SAME turn takes the cheap path. The tripped rule is then
 * promoted to a session-scoped list the TDEaseExtension re-announces at each
 * loop's opening request — the `[plan]` mechanism — which is what makes the
 * rule survive compaction: it is re-pinned from state every loop, not carried
 * as transcript ballast.
 *
 * Two cost shapes are guarded (both native to this domain, where a single
 * acquisition file can weigh gigabytes):
 *
 *   1. WHOLE-FILE READS of oversized files. A read of a multi-GB mzML floods
 *      the context once and then keeps costing: the model pages through it in
 *      bounded slices, each slice a full provider request.
 *   2. SLICE PAGING. Even under the read cap, looping 400-line slices through
 *      a large file is a turn mill. After N slices of one file in a turn the
 *      guard stops the loop and demands a decision from what is already read.
 *
 * Everything else expensive is already bounded elsewhere (bash output, grep
 * matches, ls/find caps — tool-gateway constants), so the guard stays small
 * on purpose: it owns the two shapes nothing else measured.
 */

// ── Options & surface ────────────────────────────────────────────────────────

export interface CostGuardOptions {
  /** Size probe, injectable for tests. Null (unreadable) always allows. Defaults to node:fs stat. */
  readonly statSize?: (path: string) => Promise<number | null>
  /** Whole-file reads at or above this size are denied. Default: 8 MB — the same threshold the FASTA viewer switches to streaming at. */
  readonly maxReadFileBytes?: number
  /** Slices of one file within a turn before paging is denied. Default: 5 (5 × the 400-line read cap). */
  readonly maxReadSlicesPerFile?: number
  /** Promoted rules kept in circulation (FIFO beyond this). Default: 4. */
  readonly maxRules?: number
}

export interface CostGuard {
  /** Pre-execution gate for one `read` call (resolved absolute path). Throws the model-facing denial when oversized. */
  checkReadSize(resolvedPath: string): Promise<void>
  /** Per-turn slice budget for one `read` call. Throws the model-facing denial when the loop trips. */
  checkReadSlice(resolvedPath: string): void
  /** Session rules in promotion order — the extension announces these once per loop. */
  rules(): readonly string[]
  /** Per-turn ledgers reset. Promoted rules are session-scoped and survive. */
  beginTurn(): void
}

// Raw acquisitions (mzML and friends) are binary/complex vendor formats: the
// model must never page through them as text. The cheap path is the toolbox —
// `inspect` for the file summary, `select`/`spectrum` for targeted queries —
// so denials for these files hand over the domain path, not generic grep
// advice (which would just invite a slice mill the next rule has to stop).
const ACQUISITION_PATTERN = /\.(mzml|mzxml|raw)(\.gz)?$/i

export function createCostGuard(options: CostGuardOptions = {}): CostGuard {
  const statSize = options.statSize ?? defaultStatSize
  const maxReadFileBytes = options.maxReadFileBytes ?? 8 * 1024 * 1024
  const maxReadSlicesPerFile = options.maxReadSlicesPerFile ?? 5
  const maxRules = options.maxRules ?? 4

  // Session-scoped promoted rules; the transcript may compact, this list may not.
  const promoted: string[] = []
  // Per-turn slice ledger: resolved path → slices attempted this turn.
  let slicesThisTurn = new Map<string, number>()

  function promote(rule: string): void {
    if (promoted.includes(rule)) return
    promoted.push(rule)
    if (promoted.length > maxRules) promoted.splice(0, promoted.length - maxRules)
  }

  async function checkReadSize(resolvedPath: string): Promise<void> {
    const size = await statSize(resolvedPath)
    if (size === null || size <= maxReadFileBytes) return
    const readable = formatBytes(size)
    promote(
      ACQUISITION_PATTERN.test(resolvedPath)
        ? `${shortPath(resolvedPath)} is ${readable} raw acquisition — tdeasenexus-toolbox (inspect/select) through bash; never open as text`
        : `${shortPath(resolvedPath)} is ${readable} — query it (grep, byte ranges, workspace viewers); whole-file reads are blocked`,
    )
    const guidance = ACQUISITION_PATTERN.test(resolvedPath)
      ? 'Raw acquisition data is never opened as text — get its summary and queries through tdeasenexus-toolbox in bash (inspect, then select/spectrum).'
      : 'Query it instead: grep for targeted matches, or read bounded slices with offset/limit.'
    throw new Error(
      `[cost] Blocked: ${shortPath(resolvedPath)} is ${readable} — reading it whole would flood the context. ` +
      `${guidance} This rule now holds for the rest of the session.`,
    )
  }

  function checkReadSlice(resolvedPath: string): void {
    const count = (slicesThisTurn.get(resolvedPath) ?? 0) + 1
    slicesThisTurn.set(resolvedPath, count)
    if (count < maxReadSlicesPerFile) return
    const acquired = ACQUISITION_PATTERN.test(resolvedPath)
    promote(
      acquired
        ? `paging ${shortPath(resolvedPath)}: budget spent this turn — tdeasenexus-toolbox (inspect/select/spectrum) is the way in`
        : `paging ${shortPath(resolvedPath)}: ${maxReadSlicesPerFile} slices read this turn — decide from what is read or grep for the exact line`,
    )
    // The budget stays spent: every further slice of this file in this turn
    // is denied, so a weak model cannot page around the rule by retrying.
    if (count === maxReadSlicesPerFile) {
      throw new Error(
        `[cost] Blocked: ${maxReadSlicesPerFile} slices of ${shortPath(resolvedPath)} read this turn (~${maxReadSlicesPerFile * 400} lines). ` +
        (acquired
          ? 'Raw acquisition data is not for paging — tdeasenexus-toolbox (inspect / select / spectrum) is the way in.'
          : 'Stop paging — decide from what you have, or grep for the specific content you need.'),
      )
    }
    throw new Error(`[cost] Still blocked: the slice budget for ${shortPath(resolvedPath)} is spent this turn.`)
  }

  return {
    checkReadSize,
    checkReadSlice,
    rules: () => [...promoted],
    beginTurn: () => { slicesThisTurn = new Map() },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function defaultStatSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

/** Model-facing path: tail of the absolute path is enough to disambiguate and keeps denials short. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/')
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}
