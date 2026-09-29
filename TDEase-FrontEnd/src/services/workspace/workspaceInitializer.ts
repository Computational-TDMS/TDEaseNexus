import type { WorkspaceIdentity } from '../backend/client-contracts'

export interface WorkspaceFileSystem {
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  readText(path: string): Promise<string>
  writeTextAtomic(path: string, content: string): Promise<void>
}

export interface WorkspaceInitializer {
  initialize(root: string, opts?: { id?: string; name?: string }): Promise<WorkspaceIdentity>
}

/**
 * The Workspace directory set, from `docs/spec/FILE-LAYOUT.md` §4's layout block.
 *
 * Per §4, source data and Run outputs live **inside** each Run folder
 * (`runs/<run-name>/`, flat layout — input mzML/raw, fasta, Snakefile,
 * intermediate and output files all at the Run root). The Workspace root
 * therefore does **not** carry `raw/`, `fasta/`, or `results/` as active
 * data directories; a user who wants a root-level staging area can create
 * them by hand, but initialization does not force them into existence.
 *
 * `runs/` is created so a freshly opened Workspace can immediately hold Run
 * drafts. Run workflow files are created only when a Run is instantiated from
 * a template; they never belong at the Workspace root.
 */
export const WORKSPACE_DIRECTORIES = [
  '.tdease', '.tdease/skills', '.tdease/agents', '.tdease/commands', '.tdease/sessions',
  'runs',
] as const

/**
 * The minimal Scaffold files written into a freshly picked Workspace, from
 * `docs/spec/FILE-LAYOUT.md` §4.1. Existing user files are never overwritten;
 * `.tdease/permissions.json` is also created when an older Workspace lacks the
 * required canonical policy file.
 *
 * Every entry is written behind the same `exists`-then-skip guard as
 * `workspace.json`. Runtime and product settings are JSON owned by the Client.
 */
export const WORKSPACE_SCAFFOLD_FILES: ReadonlyArray<{
  path: string
  content: (name: string) => string
}> = [
  {
    path: '.tdease/settings.json',
    content: () => `${JSON.stringify({ version: 1 }, null, 2)}\n`,
  },
  {
    path: '.tdease/permissions.json',
    content: () => `${JSON.stringify({ version: 1, rules: [] }, null, 2)}\n`,
  },
]

export function createWorkspaceInitializer(fs: WorkspaceFileSystem): WorkspaceInitializer {
  return {
    async initialize(root, opts = {}) {
      const identityPath = `${root}/.tdease/workspace.json`
      // mkdir is recursive/idempotent in every adapter. Re-open also runs this
      // so an older Workspace acquires newly required structural directories.
      for (const directory of WORKSPACE_DIRECTORIES) await fs.mkdir(`${root}/${directory}`)
      // Idempotency rule #1: an initialized Workspace is read, not recreated.
      // The existing file is validated, not just cast: a foreign `.tdease/`
      // layout that predates FILE-LAYOUT §4 (e.g. a hand-authored dev workspace
      // whose `workspace.json` carries an unrelated schema) must not be silently
      // reinterpreted as a `WorkspaceIdentity`. Per §4.1 the file is never
      // overwritten either, so a foreign identity is a stop condition — thrown
      // so the caller keeps the provisional id rather than spreading a corrupt
      // one into localStorage and the registry.
      if (await fs.exists(identityPath)) {
        const parsed = JSON.parse(await fs.readText(identityPath))
        if (!isWorkspaceIdentity(parsed)) {
          throw new Error(
            `${identityPath} exists but is not a WorkspaceIdentity (id/name/createdAt). ` +
              'Refusing to overwrite or reinterpret it; see docs/spec/FILE-LAYOUT.md §4.',
          )
        }
        for (const file of WORKSPACE_SCAFFOLD_FILES) {
          const filePath = `${root}/${file.path}`
          if (!(await fs.exists(filePath))) await fs.writeTextAtomic(filePath, file.content(parsed.name))
        }
        return parsed
      }
      const name = opts.name ?? root.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
      const id = opts.id ?? mintWorkspaceId()
      const identity: WorkspaceIdentity = { id, name, createdAt: new Date().toISOString() }
      await fs.writeTextAtomic(identityPath, `${JSON.stringify(identity, null, 2)}\n`)

      // Idempotency rule #2: Client metadata files are written only when absent.
      for (const file of WORKSPACE_SCAFFOLD_FILES) {
        const filePath = `${root}/${file.path}`
        if (!(await fs.exists(filePath))) await fs.writeTextAtomic(filePath, file.content(name))
      }

      return identity
    },
  }
}

/** Narrow an unknown parsed value to a valid `WorkspaceIdentity` without trusting the cast.
 *
 * Validates shape, not id format: the id field just has to be a non-empty
 * string. A caller may legitimately override the minted id (tests, an external
 * integrator), and the format check belongs at the mint boundary
 * (`mintWorkspaceId`), not on every read-back. What this guard rejects is a
 * foreign `.tdease/workspace.json` that carries an unrelated schema — the
 * `workspace_id` / `samples` / `workflow` shape of a pre-FILE-LAYOUT dev
 * workspace — which would otherwise be silently reinterpreted as identity.
 */
function isWorkspaceIdentity(value: unknown): value is WorkspaceIdentity {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' && v.id.length > 0 &&
    typeof v.name === 'string' && v.name.length > 0 &&
    typeof v.createdAt === 'string'
  )
}

/**
 * Mint a fresh Workspace id without touching the filesystem.
 *
 * The registry upsert must run BEFORE the initializer, because the Electron
 * main process gates every `workspace:*` IPC on the root being registered
 * (`workspacePath()` in `electron/main.ts`). That means the id has to exist
 * before any filesystem call, so it is minted here and threaded in via
 * `initialize(root, { id })`. The initializer still wins on an already-
 * initialized Workspace — it reads the persisted identity back and the caller
 * reconciles if the registered provisional id differs.
 */
export function mintWorkspaceId(): string {
  return `ws_${randomHex(12)}`
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2))
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length)
}
