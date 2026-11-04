import { describe, expect, it, vi } from 'vitest'
import { asRelativePath, asRunId, asWorkspaceId, type RunId, type RelativePath } from '../domain/identity'
import type { RunSummary } from '../domain/run'
import type { BackendGateway } from '../ports/backend-gateway'
import type { WorkspaceRepository } from '../ports/workspace-repository'
import { StudioRuntime } from './studio-runtime'
import { pullRunFile } from '../use-cases/pull-run-file'
import type { RunRepository } from './run-repository'
import type { RunSubscriptions } from './run-subscriptions'

/** A minimal RunSummary that only carries what pullRunFile reads. */
function runSummary(over: Partial<RunSummary>): RunSummary {
  return {
    id: asRunId('run_1'), workspaceId: asWorkspaceId('ws'), title: 'run',
    status: 'SUCCEEDED', cores: 1, rerunMode: 'resume', labels: {},
    createdAt: '2026-07-28T00:00:00.000Z', resultCount: 0, lastEventSeq: 0,
    ...over,
  }
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A workspace fake with an explicit local-digest table and write capture. */
function fakeWorkspace(localDigests: Record<string, string | undefined> = {}) {
  const byteWrites: Array<[RelativePath, Uint8Array]> = []
  const texts = new Map<string, string>()
  const workspace = {
    sha256: vi.fn(async (path: RelativePath) => localDigests[path]),
    writeBytes: vi.fn(async (path: RelativePath, bytes: Uint8Array) => { byteWrites.push([path, bytes]) }),
    readText: vi.fn(async (path: RelativePath) => {
      const text = texts.get(path)
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    }),
    writeText: vi.fn(async (path: RelativePath, content: string) => { texts.set(path, content) }),
  } as unknown as WorkspaceRepository
  return { workspace, byteWrites, texts }
}

function fakeBackend(over: {
  run?: Partial<RunSummary>
  entries?: ReadonlyArray<{ path: string; digest?: string }>
  bytes?: Blob
} = {}) {
  const run = runSummary({ labels: { source_run: 'chlamy-h4' }, currentRevision: 'rev-9', ...over.run })
  return {
    backend: {
      getRun: vi.fn().mockResolvedValue(run),
      listRunFiles: vi.fn().mockResolvedValue([...(over.entries ?? [])]),
      fetchRunFile: vi.fn().mockResolvedValue(over.bytes ?? new Blob([new Uint8Array([1, 2, 3, 4])])),
    } as unknown as BackendGateway,
    run,
  }
}

/**
 * The data-closure contract: a Run's Backend artifact lands in its owning
 * Workspace Run directory with digest verification, reuse, structured
 * conflict, version isolation, and the trusted source record.
 */
describe('StudioRuntime pullRunFile', () => {
  const PEAKS = 'results/peaks.json'
  const DEST = 'runs/chlamy-h4/results/peaks.json'

  it('downloads to runs/<source_run>/results/<path>, verifying the manifest digest before writing', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const digest = await sha256Of(bytes)
    const { backend } = fakeBackend({ entries: [{ path: PEAKS, digest }], bytes: new Blob([bytes]) })
    const { workspace, byteWrites } = fakeWorkspace()

    const result = await pullRunFile(asRunId('run_1'), asRelativePath(PEAKS), { backend, workspace })

    expect(result).toMatchObject({ status: 'downloaded', written: DEST })
    expect(result.source).toMatchObject({ resultRevisionId: 'rev-9', path: PEAKS, sha256: digest, localPath: DEST })
    expect(byteWrites).toHaveLength(1)
    expect(byteWrites[0][0]).toBe(DEST)
    expect(Array.from(byteWrites[0][1])).toEqual([1, 2, 3, 4])
  })

  it('reuses the local copy without writing when its digest matches the manifest', async () => {
    const digest = await sha256Of(new Uint8Array([1, 2, 3, 4]))
    const { backend } = fakeBackend({ entries: [{ path: PEAKS, digest }] })
    const { workspace, byteWrites } = fakeWorkspace({ [DEST]: digest })

    const result = await pullRunFile(asRunId('run_1'), asRelativePath(PEAKS), { backend, workspace })

    expect(result).toMatchObject({ status: 'reused', written: DEST })
    expect(byteWrites).toHaveLength(0)
  })

  it('reports a structured conflict and keeps the differing local copy', async () => {
    const digest = await sha256Of(new Uint8Array([1, 2, 3, 4]))
    const { backend, run } = fakeBackend({ entries: [{ path: PEAKS, digest }] })
    const { workspace, byteWrites } = fakeWorkspace({ [DEST]: 'deadbeef' })

    const result = await pullRunFile(asRunId('run_1'), asRelativePath(PEAKS), { backend, workspace })

    expect(result.status).toBe('conflict')
    if (result.status !== 'conflict') return
    expect(result.conflict).toMatchObject({
      localPath: DEST, localSha256: 'deadbeef', expectedSha256: digest, resolution: 'kept-local',
    })
    expect(result.source.resultRevisionId).toBe(run.currentRevision)
    expect(byteWrites).toHaveLength(0)
  })

  it('isolates a differing revision under the analysis directory and records the source ledger', async () => {
    const bytes = new Uint8Array([9, 9, 9])
    const digest = await sha256Of(bytes)
    const { backend } = fakeBackend({
      entries: [{ path: PEAKS, digest }],
      bytes: new Blob([bytes]),
      run: { currentRevision: 'rev-2' },
    })
    const { workspace, byteWrites, texts } = fakeWorkspace({ [DEST]: 'deadbeef' })

    const result = await pullRunFile(
      asRunId('run_1'), asRelativePath(PEAKS), { backend, workspace },
      { revision: 'rev-1', analysisSlug: 'ms1-envelope' },
    )

    const isolated = 'runs/chlamy-h4/analysis/ms1-envelope/sources/rev-1/results/peaks.json'
    expect(result).toMatchObject({ status: 'isolated', written: isolated, beside: DEST })
    expect(byteWrites.map(([path]) => path)).toEqual([isolated])
    const ledger = JSON.parse(texts.get('runs/chlamy-h4/analysis/ms1-envelope/sources.json')!) as Array<Record<string, unknown>>
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ resultRevisionId: 'rev-1', path: PEAKS, sha256: digest, localPath: isolated })
  })

  it('replaces the ledger row when the same revision+path is pulled again', async () => {
    const digest = await sha256Of(new Uint8Array([1, 2, 3, 4]))
    const { backend } = fakeBackend({ entries: [{ path: PEAKS, digest }] })
    const { workspace, texts } = fakeWorkspace({ [DEST]: digest })

    await pullRunFile(asRunId('run_1'), asRelativePath(PEAKS), { backend, workspace }, { analysisSlug: 'qc' })
    await pullRunFile(asRunId('run_1'), asRelativePath(PEAKS), { backend, workspace }, { analysisSlug: 'qc' })

    const ledger = JSON.parse(texts.get('runs/chlamy-h4/analysis/qc/sources.json')!) as unknown[]
    expect(ledger).toHaveLength(1)
  })

  it('writes nothing when the downloaded bytes fail the digest check', async () => {
    const digest = await sha256Of(new Uint8Array([1, 2, 3, 4]))
    const { backend } = fakeBackend({
      entries: [{ path: PEAKS, digest }],
      bytes: new Blob([new Uint8Array([7, 7, 7])]),
    })
    const { workspace, byteWrites } = fakeWorkspace()

    await expect(pullRunFile(asRunId('run_1'), asRelativePath(PEAKS), { backend, workspace }))
      .rejects.toThrow(/digest to .*but the revision manifest says/)
    expect(byteWrites).toHaveLength(0)
  })

  it('fails explicitly when a named revision has no such file, never falling back to latest', async () => {
    const { backend } = fakeBackend({ entries: [] })
    const { workspace } = fakeWorkspace()

    await expect(pullRunFile(asRunId('run_1'), asRelativePath(PEAKS), { backend, workspace }, { revision: 'rev-old' }))
      .rejects.toThrow(/revision rev-old .* has no file at .* Refusing to fall back/)
  })

  it('prefers workspaceRunPath over the labels.source_run fallback', async () => {
    const bytes = new Uint8Array([9])
    const digest = await sha256Of(bytes)
    const { backend } = fakeBackend({
      run: { workspaceRunPath: 'runs/renamed-run' },
      entries: [{ path: 'ms2.msalign', digest }],
      bytes: new Blob([bytes]),
    })
    const { workspace } = fakeWorkspace()

    const result = await pullRunFile(asRunId('run_1'), asRelativePath('ms2.msalign'), { backend, workspace })

    expect(result).toMatchObject({ status: 'downloaded', written: 'runs/renamed-run/ms2.msalign' })
  })

  it('rejects a non-kebab-case analysisSlug before any backend call beyond getRun', async () => {
    const { backend } = fakeBackend({ entries: [{ path: PEAKS }] })
    const { workspace } = fakeWorkspace()

    await expect(pullRunFile(asRunId('run_1'), asRelativePath(PEAKS), { backend, workspace }, { analysisSlug: '../escape' }))
      .rejects.toThrow(/kebab-case slug/)
  })

  it('rejects when the Run has neither a workspace path nor a source_run label', async () => {
    const backend = { getRun: vi.fn().mockResolvedValue(runSummary({ labels: {} })) } as unknown as BackendGateway
    const workspace = {} as unknown as WorkspaceRepository

    await expect(pullRunFile(asRunId('run_1'), asRelativePath('x.tsv'), { backend, workspace }))
      .rejects.toThrow(/no workspace destination path/)
  })
})

describe('StudioRuntime Run invalidation', () => {
  it('notifies the owning client only after a Run mutation succeeds', async () => {
    const changed = vi.fn()
    const rerun = vi.fn().mockResolvedValue(runSummary({ status: 'QUEUED' }))
    const runtime = new StudioRuntime({
      backend: {} as BackendGateway,
      workspace: {
        watch: () => () => {},
        inspect: vi.fn().mockResolvedValue({ id: asWorkspaceId('ws'), name: 'Workspace' }),
      } as unknown as WorkspaceRepository,
      snapshotSelection: {} as never,
      templates: { list: vi.fn().mockResolvedValue([]), get: vi.fn() },
      runRepository: { rerun, resolveRunId: vi.fn((id: RunId) => Promise.resolve(id)) } as unknown as RunRepository,
      runSubscriptions: { dispose: vi.fn() } as unknown as RunSubscriptions,
      onRunsChanged: changed,
    })

    await runtime.runs.rerun(asRunId('run_1'), 'resume')

    expect(rerun).toHaveBeenCalledWith('run_1', 'resume')
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
