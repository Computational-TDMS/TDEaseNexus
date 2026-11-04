import { describe, expect, it, vi } from 'vitest'
import { asRelativePath, asResultId, asRunId, asSha256, asWorkspaceId } from '@/studio/domain/identity'
import type { PublishedResult } from '@/studio/domain/result'
import type { BackendGateway } from '@/studio/ports/backend-gateway'
import { PublishedResultCache, type ResultCacheStorage } from './studioResultCache'

describe('PublishedResultCache', () => {
  const ref = {
    workspaceId: asWorkspaceId('ws'), runId: asRunId('run-1'), resultId: asResultId('result-1'),
    digest: asSha256('a'.repeat(64)),
  }
  const published: PublishedResult = {
    ref, title: 'Features', kind: 'feature-table', size: 3,
    technicalPath: asRelativePath('results/features.tsv'), metadata: {},
  }

  function storage(digest?: string): ResultCacheStorage {
    return {
      digest: vi.fn().mockResolvedValue(digest), read: vi.fn().mockResolvedValue(new Blob(['tsv'])),
      writeAtomic: vi.fn(), remove: vi.fn(),
    }
  }

  it('fetches by the published technical path while caching by Result identity', async () => {
    const cache = storage()
    const backend = { fetchRunFile: vi.fn().mockResolvedValue(new Blob(['tsv'])) } as unknown as BackendGateway
    const subject = new PublishedResultCache(backend, { resolve: vi.fn().mockResolvedValue(published) }, cache, storage())
    await subject.open(ref)
    expect(backend.fetchRunFile).toHaveBeenCalledWith(ref.runId, published.technicalPath)
    expect(cache.writeAtomic).toHaveBeenCalledWith(`ws/run-1/result-1/${ref.digest}`, expect.any(Blob))
  })

  it('never overwrites a conflicting Workspace destination', async () => {
    const workspace = storage('b'.repeat(64))
    const subject = new PublishedResultCache(
      { fetchRunFile: vi.fn().mockResolvedValue(new Blob(['tsv'])) } as unknown as BackendGateway,
      { resolve: vi.fn().mockResolvedValue(published) }, storage(ref.digest), workspace,
    )
    await expect(subject.materialize(ref, asRelativePath('results/features.tsv'))).rejects.toThrow('conflict')
    expect(workspace.writeAtomic).not.toHaveBeenCalled()
  })
})
