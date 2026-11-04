import { describe, expect, it } from 'vitest'
import {
  createWorkspaceInitializer,
  WORKSPACE_DIRECTORIES,
  WORKSPACE_SCAFFOLD_FILES,
  type WorkspaceFileSystem,
} from './workspaceInitializer'

/** Guards the Client-owned Workspace layout in FILE-LAYOUT.md §3. */

function recordingFs(existing = new Set<string>()) {
  const made: string[] = []
  const written = new Map<string, string>()
  const fs: WorkspaceFileSystem = {
    async exists(path) { return existing.has(path) },
    async mkdir(path) { made.push(path) },
    async readText(path) { return written.get(path) ?? '' },
    async writeTextAtomic(path, content) { written.set(path, content) },
  }
  return { fs, made, written }
}

describe('createWorkspaceInitializer', () => {
  it('creates the runs directory where Run drafts live (flat layout, §4)', async () => {
    const { fs, made } = recordingFs()
    await createWorkspaceInitializer(fs).initialize('/ws')

    // FILE-LAYOUT.md §4: source data and outputs live inside each
    // `runs/<run-name>/` folder (flat). The Workspace root must create `runs/`
    // so a freshly opened Workspace can immediately hold Run drafts.
    expect(made).toContain('/ws/runs')
    // Conversely, the root no longer force-creates raw/fasta/results — those
    // are staging areas a user may create by hand, not init-time guarantees.
    expect(made).not.toContain('/ws/raw')
    expect(made).not.toContain('/ws/fasta')
    expect(made).not.toContain('/ws/results')
  })

  it('creates exactly the declared Workspace directory set, rooted at the given path', async () => {
    const { fs, made } = recordingFs()
    await createWorkspaceInitializer(fs).initialize('/ws')

    // Equality, not containment: an undeclared directory is as much a drift from
    // FILE-LAYOUT.md as a missing one, and `wiki/` is deliberately not created.
    expect(made).toEqual(WORKSPACE_DIRECTORIES.map((directory) => `/ws/${directory}`))
    expect(made).not.toContain('/ws/wiki')
  })

  it('writes an identity and returns it', async () => {
    const { fs, written } = recordingFs()
    const identity = await createWorkspaceInitializer(fs).initialize('/ws', { name: 'My Study' })

    expect(identity.name).toBe('My Study')
    expect(identity.id).toMatch(/^ws_[0-9a-f]{12}$/)
    expect(JSON.parse(written.get('/ws/.tdease/workspace.json')!)).toEqual(identity)
  })

  it('derives a name from the root when none is given', async () => {
    const { fs } = recordingFs()
    expect((await createWorkspaceInitializer(fs).initialize('C:\\studies\\chlamy')).name).toBe('chlamy')
  })

  it('is idempotent: an initialized Workspace is read while required directories are ensured', async () => {
    const existing = { id: 'ws_abcdef123456', name: 'Existing', createdAt: '2026-01-01T00:00:00.000Z' }
    const { fs, made, written } = recordingFs(new Set(['/ws/.tdease/workspace.json']))
    written.set('/ws/.tdease/workspace.json', JSON.stringify(existing))

    expect(await createWorkspaceInitializer(fs).initialize('/ws')).toEqual(existing)
    expect(made).toEqual(WORKSPACE_DIRECTORIES.map((directory) => `/ws/${directory}`))
  })

  it('writes every Scaffold file declared in WORKSPACE_SCAFFOLD_FILES', async () => {
    const { fs, written } = recordingFs()
    await createWorkspaceInitializer(fs).initialize('/ws', { name: 'My Study' })

    // Equality of the path set, not containment: a Scaffold file silently going
    // unwritten is the same drift as a missing directory, and FILE-LAYOUT §4.1
    // names exactly these four files.
    expect(WORKSPACE_SCAFFOLD_FILES.map((f) => `/ws/${f.path}`).sort()).toEqual(
      Array.from(written.keys()).filter((p) => p !== '/ws/.tdease/workspace.json').sort(),
    )
  })

  it('writes Client settings as JSON and no Run files at the Workspace root', async () => {
    const { fs, written } = recordingFs()
    await createWorkspaceInitializer(fs).initialize('/ws')

    expect(JSON.parse(written.get('/ws/.tdease/settings.json')!)).toEqual({ version: 1 })
    expect(JSON.parse(written.get('/ws/.tdease/permissions.json')!)).toEqual({ version: 1, rules: [] })
    expect(written.has('/ws/Snakefile')).toBe(false)
    expect(written.has('/ws/config.yaml')).toBe(false)
    expect(written.has('/ws/pyproject.toml')).toBe(false)
  })

  it('never overwrites Client metadata the user already authored', async () => {
    const { fs, made, written } = recordingFs(new Set(['/ws/.tdease/settings.json']))
    written.set('/ws/.tdease/settings.json', '{"version":1,"theme":"dark"}\n')

    await createWorkspaceInitializer(fs).initialize('/ws')

    expect(written.get('/ws/.tdease/settings.json')).toBe('{"version":1,"theme":"dark"}\n')
    expect(made).toEqual(WORKSPACE_DIRECTORIES.map((directory) => `/ws/${directory}`))
    expect(written.get('/ws/.tdease/workspace.json')).toBeDefined()
    expect(written.get('/ws/.tdease/permissions.json')).toBeDefined()
  })

  it('honours an explicit id when provided (deterministic identity for tests and re-open)', async () => {
    const { fs, written } = recordingFs()
    const identity = await createWorkspaceInitializer(fs).initialize('/ws', { id: 'ws_fixed_test' })

    expect(identity.id).toBe('ws_fixed_test')
    expect(JSON.parse(written.get('/ws/.tdease/workspace.json')!).id).toBe('ws_fixed_test')
  })

  it('treats Scaffold files as no-ops on re-open, alongside the identity read', async () => {
    // Fully initialized Workspace: identity + every Scaffold file present.
    const existing = { id: 'ws_abcdef123456', name: 'Existing', createdAt: '2026-01-01T00:00:00.000Z' }
    const preExisting = new Set([
      '/ws/.tdease/workspace.json',
      ...WORKSPACE_SCAFFOLD_FILES.map((f) => `/ws/${f.path}`),
    ])
    const { fs, made, written } = recordingFs(preExisting)
    written.set('/ws/.tdease/workspace.json', JSON.stringify(existing))
    for (const f of WORKSPACE_SCAFFOLD_FILES) written.set(`/ws/${f.path}`, 'pre-existing content')

    await createWorkspaceInitializer(fs).initialize('/ws')

    // mkdir remains idempotent; no metadata file is touched and identity is preserved.
    expect(made).toEqual(WORKSPACE_DIRECTORIES.map((directory) => `/ws/${directory}`))
    for (const f of WORKSPACE_SCAFFOLD_FILES) {
      expect(written.get(`/ws/${f.path}`)).toBe('pre-existing content')
    }
  })

  it('rejects a foreign .tdease/workspace.json schema instead of reinterpreting it', async () => {
    // A pre-FILE-LAYOUT dev workspace carries an unrelated schema under the
    // same filename (`workspace_id` / `samples` / `workflow`, no `id`). The
    // initializer must not silently cast it to a WorkspaceIdentity — that
    // would spread `{id: undefined, ...}` into localStorage and the registry.
    const foreign = {
      workspace_id: 'ws-dev-001',
      name: 'Dev Workspace',
      samples: { chlamy_h4: { species: 'Chlamydomonas' } },
      workflow: 'wf_toppic_only',
    }
    const { fs, written } = recordingFs(new Set(['/ws/.tdease/workspace.json']))
    written.set('/ws/.tdease/workspace.json', JSON.stringify(foreign))

    await expect(createWorkspaceInitializer(fs).initialize('/ws')).rejects.toThrow(
      /not a WorkspaceIdentity/,
    )
    // The foreign file is left untouched (FILE-LAYOUT §4.1: never overwrite).
    expect(written.get('/ws/.tdease/workspace.json')).toBe(JSON.stringify(foreign))
  })
})
