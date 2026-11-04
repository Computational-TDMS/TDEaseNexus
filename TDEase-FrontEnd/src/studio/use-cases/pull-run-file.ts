import { asRelativePath, type RelativePath, type RunId } from '../domain/identity'
import { workspacePathForManifestEntry } from '@/services/workspace/run-file-status'
import { bufferToHex } from '@/utils/hex'
import type { StudioRuntimeDependencies } from '../runtime/studio-runtime'

/** The trusted provenance record for one Backend-sourced analysis input.
 *  Every value comes from Backend responses — the model picks objects and
 *  files, never composing identity or digests itself. */
export interface RunFileSource {
  runId: RunId
  workspaceRunPath: string
  /** The result revision the bytes were resolved against — what was read,
   *  distinct from any definition revision that explains what ran. */
  resultRevisionId: string | null
  path: RelativePath
  sha256: string | null
  localPath: RelativePath
}

export interface PullRunFileOptions {
  /** Bind the pull to one result revision; absent means the current published
   *  results. A named revision whose file is missing fails explicitly — it
   *  never falls back to the latest revision. */
  revision?: string
  /** The kebab-case slug of the analysis question. Given, every pull appends
   *  its source record to `runs/<run>/analysis/<slug>/sources.json`, and a
   *  version conflict lands the requested revision beside the local copy
   *  under that analysis directory instead of refusing. */
  analysisSlug?: string
}

export interface PullRunFileConflict {
  localPath: RelativePath
  localSha256: string | undefined
  expectedSha256: string | null
  resolution: 'kept-local'
  nextAction: string
}

export type PullRunFileResult =
  | { status: 'reused'; written: RelativePath; source: RunFileSource }
  | { status: 'downloaded'; written: RelativePath; source: RunFileSource }
  | { status: 'isolated'; written: RelativePath; source: RunFileSource; beside: RelativePath }
  | { status: 'conflict'; source: RunFileSource; conflict: PullRunFileConflict }

/**
 * Ensure one Run result file is reliably present in the Workspace and return
 * its readable path plus the trusted source record. The whole data-closure
 * contract lives here:
 *
 *  - local digest matches the revision manifest → reuse, write nothing;
 *  - local content differs → structured conflict, the original file stays;
 *    with an analysisSlug the requested revision is isolated under
 *    `runs/<run>/analysis/<slug>/sources/<rev>/<path>` instead;
 *  - no local copy → download, verify the digest BEFORE anything is written,
 *    then publish atomically (both repository implementations back
 *    writeBytes with temp-file + rename);
 *  - a named revision with no such file → explicit unavailability, never a
 *    silent fall-forward to the latest revision.
 *
 * Concurrent pulls of the same destination are serialized through an
 * in-flight lock, and the local-digest probe runs inside the lock so the
 * second pull re-checks what the first actually landed.
 */
export async function pullRunFile(
  runId: RunId,
  path: RelativePath,
  dependencies: Pick<StudioRuntimeDependencies, 'backend' | 'workspace'>,
  options: PullRunFileOptions = {},
): Promise<PullRunFileResult> {
  const run = await dependencies.backend.getRun(runId)
  const runPath = run.workspaceRunPath ?? (run.labels.source_run ? `runs/${run.labels.source_run}` : undefined)
  if (!runPath) throw new Error(`Run ${runId} has no workspace destination path`)
  const slug = options.analysisSlug
  if (slug !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`analysisSlug must be the kebab-case slug of the analysis question, got ${JSON.stringify(slug)}`)
  }
  const revision = options.revision
  const entries = await dependencies.backend.listRunFiles(runId, path, revision)
  const entry = entries.find((candidate) => candidate.path === path)
  if (!entry) {
    throw new Error(revision !== undefined
      ? `Result revision ${revision} of Run ${runId} has no file at ${path} — the retained bytes may have been cleaned. Refusing to fall back to the latest revision.`
      : `Run ${runId} has no result file at ${path}`)
  }
  const expectedSha256 = entry.digest ?? null
  const resultRevisionId = revision ?? run.currentRevision ?? null
  const destination = asRelativePath(workspacePathForManifestEntry(runPath, path))
  const source: RunFileSource = { runId, workspaceRunPath: runPath, resultRevisionId, path, sha256: expectedSha256, localPath: destination }

  return withPullLock(`${runPath}/${destination}`, async () => {
    const localSha256 = await dependencies.workspace.sha256(destination)
    if (expectedSha256 !== null && localSha256 === expectedSha256) {
      if (slug !== undefined) await recordSource(dependencies, runPath, slug, source)
      return { status: 'reused', written: destination, source }
    }
    if (localSha256 !== undefined) {
      if (slug !== undefined) {
        const isolated = asRelativePath(`${runPath}/analysis/${slug}/sources/${resultRevisionId ?? 'current'}/${path}`)
        const isolatedSource = { ...source, localPath: isolated }
        await downloadVerified(dependencies, runId, path, revision, isolated, expectedSha256)
        await recordSource(dependencies, runPath, slug, isolatedSource)
        return { status: 'isolated', written: isolated, source: isolatedSource, beside: destination }
      }
      return {
        status: 'conflict',
        source,
        conflict: {
          localPath: destination,
          localSha256,
          expectedSha256,
          resolution: 'kept-local',
          nextAction: 'The local copy differs from this revision and was kept. Read it as-is, or pull again with an analysisSlug to land this revision beside it under that analysis directory.',
        },
      }
    }
    await downloadVerified(dependencies, runId, path, revision, destination, expectedSha256)
    if (slug !== undefined) await recordSource(dependencies, runPath, slug, source)
    return { status: 'downloaded', written: destination, source }
  })
}

/** Download one file and publish it only when its bytes match the expected
 *  digest — a mismatch throws before anything is written, so no partial or
 *  wrong-content file is ever visible at the destination. */
async function downloadVerified(
  dependencies: Pick<StudioRuntimeDependencies, 'backend' | 'workspace'>,
  runId: RunId,
  path: RelativePath,
  revision: string | undefined,
  destination: RelativePath,
  expectedSha256: string | null,
): Promise<void> {
  const blob = await dependencies.backend.fetchRunFile(runId, path, revision)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (expectedSha256 !== null) {
    const actual = await sha256Hex(bytes)
    if (actual !== expectedSha256) {
      throw new Error(
        `Downloaded bytes of ${path} (revision ${revision ?? 'current'}) digest to ${actual}, but the revision manifest says ${expectedSha256}. Nothing was written.`,
      )
    }
  }
  await dependencies.workspace.writeBytes(destination, bytes)
}

/** Append (or replace, keyed by revision+path) one source record in the
 *  analysis directory's `sources.json` ledger. */
async function recordSource(
  dependencies: Pick<StudioRuntimeDependencies, 'backend' | 'workspace'>,
  runPath: string,
  slug: string,
  source: RunFileSource,
): Promise<void> {
  const ledgerPath = asRelativePath(`${runPath}/analysis/${slug}/sources.json`)
  let records: ReadonlyArray<Record<string, unknown>> = []
  try {
    const parsed: unknown = JSON.parse(await dependencies.workspace.readText(ledgerPath))
    if (Array.isArray(parsed)) records = parsed.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
  } catch { records = [] }
  const keyOf = (record: Record<string, unknown>) => `${record.resultRevisionId ?? 'current'}:${record.path}`
  const merged = records.filter((record) => keyOf(record) !== `${source.resultRevisionId ?? 'current'}:${source.path}`)
  merged.push({ ...source, pulledAt: new Date().toISOString() })
  await dependencies.workspace.writeText(ledgerPath, `${JSON.stringify(merged, null, 2)}\n`)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bufferToHex(await crypto.subtle.digest('SHA-256', bytes))
}

/** One in-flight pull per destination: same-target pulls queue, and each
 *  re-probes the local digest only after its predecessor settled. */
const inFlightPulls = new Map<string, Promise<unknown>>()
function withPullLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const queued = (inFlightPulls.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
  inFlightPulls.set(key, queued)
  void queued.finally(() => {
    if (inFlightPulls.get(key) === queued) inFlightPulls.delete(key)
  }).catch(() => {})
  return queued
}
