import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { asRunId, asWorkspaceId } from '@/studio/domain/identity'
import { CommandRegistry } from '@/studio/commands/registry'
import { RunRepository } from '@/studio/runtime/run-repository'
import { useWorkspaceStore } from './workspace'
import { useSettingsStore } from './settings'
import { projectRunCollections, useRunsStore } from './runs'

describe('Run store projection', () => {
  it('passes the domain RunSummary through unchanged — one representation past the gateway seam', () => {
    const run = {
      id: asRunId('run-1'), workspaceId: asWorkspaceId('ws'), title: 'Example', status: 'FAILED' as const,
      cores: 8, error: 'engine failed', rerunMode: 'resume' as const, labels: { sample: 'A' },
      createdAt: 'created', finishedAt: 'finished', resultCount: 3, lastEventSeq: 9,
    }
    const projected = projectRunCollections({
      runs: new Map([[run.id, run]]), ranges: new Map(), trash: [],
      total: 1, offset: 0, limit: 50, hasMore: false,
    }, 'ws')
    expect(projected.history[0]).toBe(run)
  })

  it('moves a rerun from active to history when the repository publishes its terminal snapshot', () => {
    const queued = {
      id: asRunId('run-1'), workspaceId: asWorkspaceId('ws'), title: 'Example', status: 'QUEUED' as const,
      cores: 8, rerunMode: 'resume' as const, labels: {}, createdAt: 'created', resultCount: 0, lastEventSeq: 5,
    }
    const queuedProjection = projectRunCollections({
      runs: new Map([[queued.id, queued]]), ranges: new Map(), trash: [],
      total: 1, offset: 0, limit: 50, hasMore: false,
    }, 'ws')
    expect(queuedProjection.active.get('run-1')?.status).toBe('QUEUED')

    const succeeded = { ...queued, status: 'SUCCEEDED' as const, lastEventSeq: 7 }
    const terminalProjection = projectRunCollections({
      runs: new Map([[succeeded.id, succeeded]]), ranges: new Map(), trash: [],
      total: 1, offset: 0, limit: 50, hasMore: false,
    }, 'ws')
    expect(terminalProjection.active.has('run-1')).toBe(false)
    expect(terminalProjection.history).toEqual([expect.objectContaining({ id: 'run-1', status: 'SUCCEEDED' })])
  })
})

describe('Run store mutations route through the command registry, never the repository', () => {
  let invokeSpy: ReturnType<typeof vi.spyOn>
  let cancelSpy: ReturnType<typeof vi.spyOn>
  let rerunSpy: ReturnType<typeof vi.spyOn>
  let trashSpy: ReturnType<typeof vi.spyOn>
  let restoreSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    setActivePinia(createPinia())
    invokeSpy = vi.spyOn(CommandRegistry.prototype, 'invoke').mockResolvedValue(undefined)
    cancelSpy = vi.spyOn(RunRepository.prototype, 'cancel').mockResolvedValue(undefined)
    rerunSpy = vi.spyOn(RunRepository.prototype, 'rerun').mockResolvedValue({} as never)
    trashSpy = vi.spyOn(RunRepository.prototype, 'trash').mockResolvedValue(undefined)
    restoreSpy = vi.spyOn(RunRepository.prototype, 'restore').mockResolvedValue({} as never)
    // RunRepository.load fires from init(); stub it so it resolves instead of
    // reaching a real backend in the test environment.
    vi.spyOn(RunRepository.prototype, 'load').mockResolvedValue({
      runs: new Map(), ranges: new Map(), trash: [], total: 0, offset: 0, limit: 50, hasMore: false,
    })

    const workspaceStore = useWorkspaceStore()
    await workspaceStore.setWorkspace('demo', { id: 'ws-1' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes cancel through registry.invoke("runs.cancel") and never calls the repository directly', async () => {
    const store = useRunsStore()
    await store.cancel('run-1')

    expect(invokeSpy).toHaveBeenCalledWith('runs.cancel', { runId: 'run-1' }, expect.anything())
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('does not contact the Backend merely because a local Workspace is attached', async () => {
    const load = vi.spyOn(RunRepository.prototype, 'load')
    useRunsStore()

    expect(load).not.toHaveBeenCalled()
  })

  it('does not contact the Backend when the Runs panel opens before a connection is configured', async () => {
    const load = vi.spyOn(RunRepository.prototype, 'load')
    const store = useRunsStore()

    await store.ensureLoaded()

    expect(load).not.toHaveBeenCalled()
  })

  it('reloads the current Workspace when Electron invalidates the Run index', async () => {
    let invalidate: ((event: { workspaceId: string }) => void) | undefined
    ;(window as any).tdeaseDesktop = {
      runs: {
        subscribe: vi.fn((listener: (event: { workspaceId: string }) => void) => {
          invalidate = listener
          return () => {}
        }),
      },
    }
    useSettingsStore().backendConnected = true
    const load = vi.spyOn(RunRepository.prototype, 'load')
    useRunsStore()
    await vi.waitFor(() => expect(load).toHaveBeenCalled())
    load.mockClear()

    invalidate?.({ workspaceId: 'ws-other' })
    await Promise.resolve()
    expect(load).not.toHaveBeenCalled()

    invalidate?.({ workspaceId: 'ws-1' })
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith({ workspaceId: 'ws-1', offset: 0, limit: 50 }))
  })

  it('routes resume through registry.invoke("runs.resume")', async () => {
    const store = useRunsStore()
    await store.rerun('run-1', 'resume')

    expect(invokeSpy).toHaveBeenCalledWith('runs.resume', { runId: 'run-1' }, expect.anything())
    expect(rerunSpy).not.toHaveBeenCalled()
  })

  it('routes overwrite through registry.invoke("runs.overwrite")', async () => {
    const store = useRunsStore()
    await store.rerun('run-1', 'overwrite')

    expect(invokeSpy).toHaveBeenCalledWith('runs.overwrite', { runId: 'run-1' }, expect.anything())
    expect(rerunSpy).not.toHaveBeenCalled()
  })

  it('routes trash through registry.invoke("runs.trash")', async () => {
    const store = useRunsStore()
    await store.trash('run-1')

    expect(invokeSpy).toHaveBeenCalledWith('runs.trash', { runId: 'run-1' }, expect.anything())
    expect(trashSpy).not.toHaveBeenCalled()
  })

  it('routes restore through registry.invoke("runs.restore")', async () => {
    const store = useRunsStore()
    await store.restore('run-1')

    expect(invokeSpy).toHaveBeenCalledWith('runs.restore', { runId: 'run-1' }, expect.anything())
    expect(restoreSpy).not.toHaveBeenCalled()
  })

  it('carries the current workspaceId without a provenance-ledger actor', async () => {
    const store = useRunsStore()
    await store.cancel('run-1')

    const context = invokeSpy.mock.calls[0]?.[2] as { workspaceId: string; actor?: string }
    expect(context.workspaceId).toBe('ws-1')
    expect(context).not.toHaveProperty('actor')
  })

  it('surfaces a registry rejection through the store error, not a thrown UI crash path', async () => {
    invokeSpy.mockRejectedValueOnce(new Error('Permission denied: run.cancel'))
    const store = useRunsStore()

    await expect(store.cancel('run-1')).rejects.toThrow('Permission denied')
    expect(store.error).toBe('Permission denied: run.cancel')
  })
})
