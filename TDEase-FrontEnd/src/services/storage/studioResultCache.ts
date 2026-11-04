import { canOverwrite } from '../backend/fileTransfer'
import type { PublishedResult, ResultRef } from '@/studio/domain/result'
import type { RelativePath } from '@/studio/domain/identity'
import type { BackendGateway } from '@/studio/ports/backend-gateway'
import type { ResultCache, ResultResource } from '@/studio/ports/result-cache'

export interface ResultCacheStorage {
  digest(path: string): Promise<string | undefined>
  read(path: string): Promise<Blob>
  writeAtomic(path: string, blob: Blob): Promise<void>
  remove(path: string): Promise<void>
}

export interface PublishedResultResolver {
  resolve(ref: ResultRef): Promise<PublishedResult>
}

export class PublishedResultCache implements ResultCache {
  constructor(
    private readonly backend: BackendGateway,
    private readonly resolver: PublishedResultResolver,
    private readonly cache: ResultCacheStorage,
    private readonly workspace: ResultCacheStorage,
  ) {}

  async availability(ref: ResultRef) {
    const localDigest = await this.cache.digest(cacheKey(ref))
    return canOverwrite(localDigest, ref.digest) === 'skip'
      ? 'cached'
      : localDigest ? 'conflict' : 'remote'
  }

  async open(ref: ResultRef): Promise<ResultResource> {
    const result = await this.resolver.resolve(ref)
    const key = cacheKey(ref)
    const state = canOverwrite(await this.cache.digest(key), ref.digest)
    if (state === 'conflict') throw new Error(`Result cache digest conflict: ${ref.resultId}`)
    if (state === 'write') {
      await this.cache.writeAtomic(key, await this.backend.fetchRunFile(ref.runId, result.technicalPath))
    }
    return { ref, blob: await this.cache.read(key), mediaType: result.mediaType }
  }

  async materialize(ref: ResultRef, destination: RelativePath): Promise<void> {
    const resource = await this.open(ref)
    const state = canOverwrite(await this.workspace.digest(destination), ref.digest)
    if (state === 'conflict') throw new Error(`Workspace materialization conflict: ${destination}`)
    if (state === 'write') await this.workspace.writeAtomic(destination, resource.blob)
  }

  evict(ref: ResultRef): Promise<void> { return this.cache.remove(cacheKey(ref)) }
}

function cacheKey(ref: ResultRef): string {
  return `${ref.workspaceId}/${ref.runId}/${ref.resultId}/${ref.digest}`
}

/**
 * A `PublishedResultResolver` backed by `BackendGateway.listResults` --
 * `GET /api/v2/runs/{run_id}/results` (docs/design/CORE-ARCHITECTURE.md 3.2).
 *
 * Resolving a `ResultRef` is exactly "find the entry whose `resultId` and
 * `digest` match in the current Published Result projection". Every `ResultRef`
 * reaching this class carries a concrete `digest` (the domain type requires
 * one), so a miss means the pinned value is no longer current -- superseded by
 * a later Recompute, or never materialized -- which CORE-ARCHITECTURE.md 3.4
 * calls out explicitly: "unavailable, with reason superseded. This is not an
 * error to be papered over."
 */
export class BackendResultResolver implements PublishedResultResolver {
  constructor(private readonly backend: BackendGateway) {}

  async resolve(ref: ResultRef): Promise<PublishedResult> {
    const results = await this.backend.listResults(ref.runId)
    const match = results.find((result) => result.ref.resultId === ref.resultId && result.ref.digest === ref.digest)
    if (!match) {
      throw new Error(
        `Published Result ${ref.resultId}@${ref.digest} is unavailable (not yet materialized, or superseded by a later Recompute)`,
      )
    }
    return match
  }
}

/** Wires a `PublishedResultCache` to a real Backend via `BackendResultResolver`. */
export function createPublishedResultCache(
  backend: BackendGateway,
  cache: ResultCacheStorage,
  workspace: ResultCacheStorage,
): ResultCache {
  return new PublishedResultCache(backend, new BackendResultResolver(backend), cache, workspace)
}
