import { afterEach, describe, expect, it, vi } from 'vitest'
import { getViewsFS, setViewsFSWorkspaceReady, setViewsFSWorkspaceRoot } from './views-fs'

describe('Electron ViewsFS workspace readiness', () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { tdeaseDesktop?: unknown }).tdeaseDesktop
    setViewsFSWorkspaceReady(async () => {})
    setViewsFSWorkspaceRoot('')
  })

  it('waits for Workspace registration before issuing IPC', async () => {
    let release!: () => void
    const registration = new Promise<void>((resolve) => { release = resolve })
    const listDir = vi.fn().mockResolvedValue([])
    ;(globalThis as typeof globalThis & { tdeaseDesktop?: unknown }).tdeaseDesktop = {
      workspace: { listDir, readBytes: vi.fn() },
    }
    setViewsFSWorkspaceRoot('C:\\workspace')
    setViewsFSWorkspaceReady(() => registration)

    const pending = getViewsFS().listDir('C:\\workspace')
    await Promise.resolve()
    expect(listDir).not.toHaveBeenCalled()

    release()
    await pending
    expect(listDir).toHaveBeenCalledWith('C:\\workspace', '')
  })
})

describe('Electron ViewsFS listFiles glob', () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { tdeaseDesktop?: unknown }).tdeaseDesktop
    setViewsFSWorkspaceReady(async () => {})
    setViewsFSWorkspaceRoot('')
  })

  // The recursive file set the bridge returns, workspace-relative. Includes a
  // Run artifact at depth so the glob contract — `**` recurses, `*` does not —
  // is observable.
  const RECURSIVE = [
    'README.md',
    'runs/run-1/output.tsv',
    'runs/run-1/results/rev-2/proteoform.tsv',
  ]

  function wire() {
    const listFilesMock = vi.fn().mockResolvedValue(RECURSIVE)
    ;(globalThis as typeof globalThis & { tdeaseDesktop?: unknown }).tdeaseDesktop = {
      workspace: { listFiles: listFilesMock },
    }
    setViewsFSWorkspaceRoot('C:\\workspace')
    setViewsFSWorkspaceReady(async () => {})
    return listFilesMock
  }

  it('`**` recurses and returns files at every depth', async () => {
    wire()
    const out = await getViewsFS().listFiles('**', 'C:\\workspace')
    expect(out.sort()).toEqual(RECURSIVE)
  })

  it('`**/*` recurses — the glob the @-mention picker actually uses', async () => {
    wire()
    const out = await getViewsFS().listFiles('**/*', 'C:\\workspace')
    expect(out.sort()).toEqual(RECURSIVE)
  })

  it('`*` does not cross `/` — only root-level files match', async () => {
    // This is exactly why the picker must use `**`, not `*`: a bare `*` compiles
    // to `[^/]*` and would silently hide every Run artifact (`runs/run-1/…`).
    wire()
    const out = await getViewsFS().listFiles('*', 'C:\\workspace')
    expect(out).toEqual(['README.md'])
  })
})
