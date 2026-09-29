import type { RelativePath } from './identity'

export const SUBMISSION_EXCLUDED_PATHS = [
  '.git/',
  '.venv/',
  '.tdease/events.jsonl',
  '.tdease/sessions/',
  'results/',
  'views/assets/',
  'evidence/',
  'analysis/',
  'runs/*/analysis/',
  'runs/*/evidence/',
  'node_modules/',
  '.snakemake/',
  '.tdease-runtime/',
] as const

/**
 * Match one contract exclusion against a Workspace-relative path. A literal
 * entry ends with `/` (a whole subtree) or is an exact file. A `*` entry
 * matches exactly one path segment (`runs/<run>/analysis/` → any single run
 * name) — run-local control-plane subtrees never enter an execution snapshot
 * or invalidate a plan, whichever run they belong to.
 */
function isExcludedPath(path: string, excluded: string): boolean {
  if (!excluded.includes('*')) {
    return excluded.endsWith('/') ? path.startsWith(excluded) : path === excluded
  }
  const pattern = new RegExp(
    `^${excluded.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}`,
  )
  return pattern.test(path)
}

export function isSubmissionPathIncluded(path: RelativePath | string): boolean {
  return !SUBMISSION_EXCLUDED_PATHS.some((excluded) => isExcludedPath(path, excluded))
}

/**
 * Ignore entries that belong to the *file watcher* and to nothing else.
 *
 * A watcher may ignore more than submission excludes — `__pycache__` is pure
 * churn no UI wants change events for — but never less, or the live view and
 * the snapshot disagree about what a Workspace contains. These live in their
 * own named constant so a reader can always tell which entries come from the
 * layout contract and which are watcher-local noise suppression; an entry that
 * belongs to the contract must never be added here.
 */
export const WATCHER_ONLY_IGNORED_PATHS = ['__pycache__/'] as const

/**
 * The chokidar `ignored` globs for the Electron Workspace watcher, derived from
 * `SUBMISSION_EXCLUDED_PATHS` plus `WATCHER_ONLY_IGNORED_PATHS`.
 *
 * This is the single construction site for that list. `electron/main.ts`
 * imports it rather than restating it, so the watcher cannot drift from the
 * layout contract (docs/spec/FILE-LAYOUT.md §4.2) by editing one list and
 * forgetting the other — the drift is no longer expressible.
 *
 * Agent session and runtime audit state are Client control-plane files: they
 * must never enter an execution snapshot or invalidate a plan merely because
 * a tool was observed.
 */
// The glob shapes live in line comments on purpose: a block comment cannot
// contain the sequence `*/`, and every rendering of these globs contains it.
// (The committed text used to hide a zero-width space between the two stars
// and the slash — an editor scrubbed it as invisible garbage and broke the
// parse; wording that depends on invisible characters is not robust.)
// Directory entries (`results/`) become `**/results/**`; file entries
// (`.tdease/events.jsonl`) become `**/.tdease/events.jsonl`.
export function workspaceWatchIgnoreGlobs(): string[] {
  return [...SUBMISSION_EXCLUDED_PATHS, ...WATCHER_ONLY_IGNORED_PATHS].map((excluded) =>
    excluded.endsWith('/') ? `**/${excluded}**` : `**/${excluded}`,
  )
}
