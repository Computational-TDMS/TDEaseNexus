import { describe, expect, it, vi } from 'vitest'
import { asRelativePath, asWorkspaceId } from '@/studio/domain/identity'
import { DesktopWorkspaceRepository, type WorkspaceBridge } from './studioWorkspaceRepository'

describe('DesktopWorkspaceRepository', () => {
  const bridge: WorkspaceBridge = {
    listFiles: vi.fn().mockResolvedValue(['Snakefile', 'scripts/analyse.py', 'notes.txt']),
    readText: vi.fn(), writeTextAtomic: vi.fn(), writeBytesAtomic: vi.fn(),
    fileSize: vi.fn().mockResolvedValue(10), sha256: vi.fn().mockResolvedValue('a'.repeat(64)),
  }

  it('builds a stable selected revision with classified files', async () => {
    const repository = new DesktopWorkspaceRepository(
      { id: asWorkspaceId('ws'), name: 'Workspace' }, 'C:/workspace', bridge,
    )
    const revision = await repository.snapshot({ include: (path) => path !== asRelativePath('notes.txt') })
    expect(revision.files.map(({ path, role }) => ({ path, role }))).toEqual([
      { path: 'Snakefile', role: 'workflow' }, { path: 'scripts/analyse.py', role: 'script' },
    ])
    expect(revision.treeHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('passes only validated relative paths to the desktop bridge', async () => {
    const repository = new DesktopWorkspaceRepository(
      { id: asWorkspaceId('ws'), name: 'Workspace' }, 'C:/workspace', bridge,
    )
    await repository.readText(asRelativePath('Snakefile'))
    expect(bridge.readText).toHaveBeenCalledWith('C:/workspace', 'Snakefile')
  })

  it('scopes a Run snapshot while keeping every bridge call on the registered Workspace root', async () => {
    const scopedBridge: WorkspaceBridge = {
      listFiles: vi.fn().mockResolvedValue([
        'runs/chlamy-h4/Snakefile',
        'runs/chlamy-h4/sample.mzML',
        'runs/other/Snakefile',
      ]),
      readText: vi.fn().mockResolvedValue('rule all:'),
      writeTextAtomic: vi.fn(), writeBytesAtomic: vi.fn(),
      fileSize: vi.fn().mockResolvedValue(10),
      sha256: vi.fn().mockResolvedValue('b'.repeat(64)),
    }
    const repository = new DesktopWorkspaceRepository(
      { id: asWorkspaceId('ws'), name: 'chlamy-h4' },
      'C:/workspace',
      scopedBridge,
      undefined,
      asRelativePath('runs/chlamy-h4'),
    )

    const revision = await repository.snapshot({ include: () => true })
    expect(revision.files.map((file) => file.path)).toEqual(['Snakefile', 'sample.mzML'])
    expect(scopedBridge.sha256).toHaveBeenCalledWith('C:/workspace', 'runs/chlamy-h4/Snakefile')
    await repository.readText(asRelativePath('Snakefile'))
    expect(scopedBridge.readText).toHaveBeenCalledWith('C:/workspace', 'runs/chlamy-h4/Snakefile')
  })
})
