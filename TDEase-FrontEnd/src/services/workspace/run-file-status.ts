/**
 * The `runs/<runId>/` convention, and the sync-status comparison built on it.
 *
 * Two things live here that were previously inlined in `stores/selection.ts`:
 *
 * 1. **The path convention.** A Run's outputs return through its public
 *    `workspace_run_path`, never through Backend `run_id`. Manifest paths are
 *    already Run-relative and are preserved exactly; `results/x.csv` remains
 *    `results/x.csv` inside the mapped Workspace Run.
 *
 * 2. **The comparison.** Deciding whether a Run's file is `cached`, in
 *    `conflict`, or still only in the `cloud` is real branching logic with a
 *    non-obvious fallback, and it was unreachable from a test: the store
 *    reached the Backend through a dynamic `import()` and the local digests
 *    through `globalThis.tdeaseDesktop`. Taking those two as an injected
 *    `RunFileStatusSources` makes the whole decision testable without a
 *    browser, an Electron bridge, or a server.
 *
 * This module deliberately imports nothing: it is the decision, not the
 * plumbing. `stores/selection.ts` supplies the plumbing.
 */

/**
 * `cached`   — the local copy's digest matches the Backend manifest.
 * `conflict` — a local copy exists and its digest does not match.
 * `cloud`    — the Backend has it and the Workspace does not.
 *
 * A file whose status cannot be determined is absent from the map rather than
 * guessed at; see `probeRunFileStatuses`.
 */
export type RunFileStatus = 'cached' | 'conflict' | 'cloud'

export interface RunManifestEntry {
  /** Run-root-relative, as the Backend reports it. */
  path: string
  sha256: string | null
}

export interface RunFileStatusSources {
  /** The Backend's manifest for this Run. */
  listRunFiles(runId: string): Promise<ReadonlyArray<RunManifestEntry>>

  /**
   * Digest of the Workspace copy, or `undefined` when there is no local copy
   * *or* no way to compute one (no desktop bridge). The two cases are
   * deliberately not distinguished here — see the fallback in
   * `probeRunFileStatuses`.
   */
  localDigest(workspaceRelativePath: string): Promise<string | undefined>

  /**
   * Whether the Workspace is known to hold this path, from already-loaded tree
   * state. Used only to tell "the file is missing" apart from "we could not
   * compute a digest".
   */
  isKnownLocally(workspaceRelativePath: string): boolean
}

/** The mapped Workspace Run directory; Backend identity is never used as a path. */
export function runResultsDir(workspaceRunPath: string): string {
  return workspaceRunPath.replace(/\\/g, '/').replace(/\/$/, '')
}

/**
 * The Run a Workspace path belongs to, or `undefined` when it is not under any
 * Run's folder. This is the file -> Run half of the bidirectional highlight.
 */
export function runIdFromWorkspacePath(path: string): string | undefined {
  const match = path.match(/^runs\/([^/]+)/)
  return match?.[1] || undefined
}

/**
 * Where a manifest entry lands in the mapped Workspace Run.
 */
export function workspacePathForManifestEntry(workspaceRunPath: string, entryPath: string): string {
  return `${runResultsDir(workspaceRunPath)}/${entryPath.replace(/\\/g, '/').replace(/^\//, '')}`
}

/**
 * Compare a Run's Backend manifest against the Workspace copies.
 *
 * Best-effort by contract: an unreachable Backend yields an empty map rather
 * than an error, because these statuses are badges on a file tree and must
 * never block or break a selection.
 *
 * The fallback when no digest can be computed is the subtle part. Not being
 * able to digest a file means either it is absent locally or the desktop
 * bridge is unavailable, and those demand opposite badges. So the file is
 * marked `cloud` only when the Workspace is known *not* to hold it; otherwise
 * it is left out of the map entirely and renders unbadged. Guessing would put
 * a download arrow on files the user already has.
 */
export async function probeRunFileStatuses(
  runId: string,
  workspaceRunPath: string,
  sources: RunFileStatusSources,
): Promise<Map<string, RunFileStatus>> {
  let manifest: ReadonlyArray<RunManifestEntry>
  try {
    manifest = await sources.listRunFiles(runId)
  } catch {
    return new Map()
  }

  const statuses = new Map<string, RunFileStatus>()
  for (const entry of manifest) {
    const path = workspacePathForManifestEntry(workspaceRunPath, entry.path)
    if (entry.sha256 === null) {
      if (!sources.isKnownLocally(path)) statuses.set(path, 'cloud')
      continue
    }
    const localDigest = await sources.localDigest(path)
    if (localDigest === undefined) {
      if (!sources.isKnownLocally(path)) statuses.set(path, 'cloud')
    } else if (localDigest === entry.sha256) {
      statuses.set(path, 'cached')
    } else {
      statuses.set(path, 'conflict')
    }
  }
  return statuses
}
