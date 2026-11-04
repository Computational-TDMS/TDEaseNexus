import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import { createNodeSkillCatalog } from './node-skill-catalog'
import type { NodeSystemAssets } from './node-system-assets'
import { createNodeWorkspaceBridge } from './node-workspace-bridge'

describe('Node Skill catalog resource discovery', () => {
  let root = ''

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  it('lists and directly reads contained System and Workspace skill resources', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-skill-resources-'))
    await fs.mkdir(path.join(root, '.tdease', 'skills', 'local', 'scripts'), { recursive: true })
    await fs.mkdir(path.join(root, '.tdease', 'skills', 'local', 'references'), { recursive: true })
    await fs.writeFile(path.join(root, '.tdease', 'skills', 'local', 'SKILL.md'), '---\nname: local\n---\n')
    await fs.writeFile(path.join(root, '.tdease', 'skills', 'local', 'scripts', 'run.py'), 'print("ok")\n')
    await fs.writeFile(path.join(root, '.tdease', 'skills', 'local', 'references', 'workflow.md'), '# Local workflow\n')

    const system = {
      listFiles: async (relative: string) => relative === 'skills'
        ? ['remote/SKILL.md', 'remote/references/workflow.md', 'remote/scripts/analyze.py']
        : relative === 'skills/remote'
          ? ['SKILL.md', 'references/workflow.md', 'scripts/__pycache__/analyze.pyc', 'scripts/analyze.py']
          : [],
      readText: async (relative: string) => relative.endsWith('references/workflow.md')
        ? '# System workflow\n'
        : '---\nname: remote\n---\n',
      resolvePath: async () => '',
    } satisfies NodeSystemAssets
    const catalog = createNodeSkillCatalog(root, createNodeWorkspaceBridge(root), system)

    await expect(catalog.read('system:remote')).resolves.toMatchObject({
      resources: ['references/workflow.md', 'scripts/analyze.py'],
    })
    await expect(catalog.read('workspace:local')).resolves.toMatchObject({
      resources: ['references/workflow.md', 'scripts/run.py'],
    })
    const reference = await catalog.read('system:remote', 'references/workflow.md')
    expect(reference).toMatchObject({
      resource: 'references/workflow.md', content: '# System workflow\n',
    })
    expect(reference).not.toHaveProperty('resources')
    await expect(catalog.read('workspace:local', 'references/workflow.md')).resolves.toMatchObject({
      resource: 'references/workflow.md', content: '# Local workflow\n',
    })
    await expect(catalog.read('system:remote', '../SKILL.md')).rejects.toThrow(/contained skill-relative path/)
  })

  it('index() reflects SKILL.md edits made after the catalog was first used', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tdease-skill-index-fresh-'))
    const skillDir = path.join(root, '.tdease', 'skills', 'local')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: local\ndescription: first\n---\n')
    const system = {
      listFiles: async () => [],
      readText: async () => '',
      resolvePath: async () => '',
    } satisfies NodeSystemAssets
    const catalog = createNodeSkillCatalog(root, createNodeWorkspaceBridge(root), system)

    const before = await catalog.index()
    expect(before.find((entry) => entry.name === 'workspace:local')?.description).toBe('first')

    // Edit on disk while the app keeps running: without per-index invalidation
    // the catalog serves the cached first description forever (lost in a
    // refactor once; this test pins the fix).
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: local\ndescription: second\n---\n')
    const after = await catalog.index()
    expect(after.find((entry) => entry.name === 'workspace:local')?.description).toBe('second')
  })
})
