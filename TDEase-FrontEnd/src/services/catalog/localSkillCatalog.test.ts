import { describe, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { sharedLocalSkillCatalog } from './localSkillCatalog'

// System assets live in the tdease-ai-capability toolkit submodule.
function systemAssetsRoot(): string {
  if (process.env.TDEASE_SYSTEM_ASSETS) return path.resolve(process.env.TDEASE_SYSTEM_ASSETS)
  return path.resolve(process.cwd(), '..', 'tdease-ai-capability', 'system')
}

describe('local Skill catalog', () => {
  it('lists names without reading SKILL.md and loads only the requested skill', async () => {
    const systemRead = vi.fn(async (path: string) => `content:${path}`)
    const workspaceRead = vi.fn(async (_root: string, path: string) => `content:${path}`)
    const catalog = sharedLocalSkillCatalog('C:/skill-catalog-fixture-a', {
      system: {
        listFiles: async () => ['alpha/SKILL.md', 'beta/SKILL.md'],
        readText: systemRead,
      },
      workspace: {
        listDir: async () => [{ name: 'local', isDir: true }],
        readText: workspaceRead,
      },
    })

    await expect(catalog.list()).resolves.toEqual([
      { name: 'system:alpha', scope: 'system' },
      { name: 'system:beta', scope: 'system' },
      { name: 'workspace:local', scope: 'workspace' },
    ])
    expect(systemRead).not.toHaveBeenCalled()
    expect(workspaceRead).not.toHaveBeenCalled()

    await expect(catalog.read('system:beta')).resolves.toMatchObject({
      id: 'system:beta', scope: 'system', content: 'content:skills/beta/SKILL.md',
    })
    expect(systemRead).toHaveBeenCalledTimes(1)
    expect(workspaceRead).not.toHaveBeenCalled()
  })

  it('requires a scoped id when System and Workspace contain the same name', async () => {
    const catalog = sharedLocalSkillCatalog('C:/skill-catalog-fixture-b', {
      system: { listFiles: async () => ['qc/SKILL.md'], readText: async () => 'system' },
      workspace: {
        listDir: async () => [{ name: 'qc', isDir: true }],
        readText: async () => 'workspace',
      },
    })

    await expect(catalog.read('qc')).rejects.toThrow('ambiguous')
    await expect(catalog.collisions()).resolves.toEqual([{ name: 'qc', sources: ['system', 'workspace'] }])
  })

  // Recursive-readdir over the full shipped System assets (~1.2s bare) can
  // exceed vitest's 5s default under parallel-suite load — the recurring
  // one-flake full-run failure — so the budget is explicit.
  it('discovers and reads the shipped TopPIC Suite skill from System assets', { timeout: 20_000 }, async () => {
    const systemRoot = systemAssetsRoot()
    const catalog = sharedLocalSkillCatalog('C:/skill-catalog-real-system', {
      system: {
        async listFiles(relative) {
          const files = await readdir(path.join(systemRoot, relative), { recursive: true })
          return files.map((entry) => entry.replaceAll('\\', '/'))
        },
        readText: (relative) => readFile(path.join(systemRoot, relative), 'utf8'),
      },
    })

    await expect(catalog.list()).resolves.toContainEqual({
      name: 'system:toppic-suite',
      scope: 'system',
    })
    await expect(catalog.read('system:toppic-suite')).resolves.toMatchObject({
      id: 'system:toppic-suite',
      scope: 'system',
      content: expect.stringContaining('name: toppic-suite'),
    })
  })
})
