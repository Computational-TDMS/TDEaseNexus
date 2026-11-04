import { createFileWatcher, type FileEvent } from './fileWatcher'
import { computeTreeHash } from './tree-hash'
import { asRelativePath, asSha256, type RelativePath } from '@/studio/domain/identity'
import type { WorkspaceFileRole, WorkspaceRef } from '@/studio/domain/workspace'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'
import type {
  SnapshotSelection,
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceRepository,
} from '@/studio/ports/workspace-repository'

export interface WorkspaceBridge {
  listFiles(root: string): Promise<string[]>
  readText(root: string, relative: string): Promise<string>
  fileSize(root: string, relative: string): Promise<number>
  writeTextAtomic(root: string, relative: string, content: string): Promise<void>
  writeBytesAtomic(root: string, relative: string, bytes: Uint8Array): Promise<void>
  sha256(root: string, relative: string): Promise<string>
}

export interface WorkspaceWatcher {
  start(): Promise<void>
  stop(): Promise<void>
  on(listener: (event: FileEvent) => void): () => void
}

export class DesktopWorkspaceRepository implements WorkspaceRepository {
  constructor(
    private readonly workspace: WorkspaceRef,
    private readonly root: string,
    private readonly bridge: WorkspaceBridge = desktopBridge(),
    private readonly createWatcher: (root: string) => WorkspaceWatcher = createFileWatcher,
    private readonly scope: RelativePath | null = null,
  ) {}

  async inspect(): Promise<WorkspaceRef> { return this.workspace }

  async snapshot(selection: SnapshotSelection) {
    const paths = (await this.bridge.listFiles(this.root))
      .map((path) => this.fromWorkspacePath(path))
      .filter((path): path is RelativePath => path !== null)
      .filter(selection.include)
      .sort()
    const files = await Promise.all(paths.map(async (path) => {
      const [digest, size] = await Promise.all([
        this.bridge.sha256(this.root, this.toWorkspacePath(path)),
        this.bridge.fileSize(this.root, this.toWorkspacePath(path)),
      ])
      return { path, digest: asSha256(digest), size, role: classifyRole(path) }
    }))
    const treeHash = await computeTreeHash(files.map((file) => ({
      path: file.path, blob_hash: file.digest, size: file.size,
    })))
    return { treeHash: asSha256(treeHash), files }
  }

  readText(path: RelativePath): Promise<string> { return this.bridge.readText(this.root, this.toWorkspacePath(path)) }
  writeText(path: RelativePath, content: string): Promise<void> {
    return this.bridge.writeTextAtomic(this.root, this.toWorkspacePath(path), content)
  }
  writeBytes(path: RelativePath, bytes: Uint8Array): Promise<void> {
    return this.bridge.writeBytesAtomic(this.root, this.toWorkspacePath(path), bytes)
  }
  async sha256(path: RelativePath): Promise<string | undefined> {
    try {
      return await this.bridge.sha256(this.root, this.toWorkspacePath(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async list(path?: RelativePath): Promise<ReadonlyArray<WorkspaceEntry>> {
    const prefix = path ? `${path}/` : ''
    return (await this.bridge.listFiles(this.root))
      .map((candidate) => this.fromWorkspacePath(candidate))
      .filter((candidate): candidate is RelativePath => candidate !== null)
      .filter((candidate) => candidate.startsWith(prefix))
      .map((candidate) => ({ path: candidate, kind: 'file' as const }))
  }

  watch(listener: (change: WorkspaceChange) => void): () => void {
    const watcher = this.createWatcher(this.root)
    const off = watcher.on((event) => {
      const type = mapChangeType(event.type)
      if (!type) return
      try {
        const path = this.fromWorkspacePath(event.path)
        if (path) listener({ type, path })
      } catch { /* ignore paths outside the workspace contract */ }
    })
    void watcher.start()
    return () => { off(); void watcher.stop() }
  }

  private toWorkspacePath(path: RelativePath): RelativePath {
    return this.scope ? asRelativePath(`${this.scope}/${path}`) : path
  }

  private fromWorkspacePath(path: string): RelativePath | null {
    const normalized = asRelativePath(path)
    if (!this.scope) return normalized
    const prefix = `${this.scope}/`
    return normalized.startsWith(prefix) ? asRelativePath(normalized.slice(prefix.length)) : null
  }
}

function classifyRole(path: RelativePath): WorkspaceFileRole {
  const lower = path.toLowerCase()
  if (lower === 'snakefile' || lower.endsWith('.smk') || lower.endsWith('.snakefile')) return 'workflow'
  if (lower.startsWith('scripts/') || /\.(py|r|rmd|ipynb)$/.test(lower)) return 'script'
  if (/\.(ya?ml|json|toml|ini|cfg)$/.test(lower)) return 'config'
  if (/\.(raw|mzml|mzxml|fasta|fa|tsv|csv)$/.test(lower)) return 'input'
  return 'other'
}

function mapChangeType(type: FileEvent['type']): WorkspaceChange['type'] | undefined {
  if (type === 'add') return 'add'
  if (type === 'change') return 'change'
  if (type === 'unlink') return 'remove'
  return undefined
}

function desktopBridge(): WorkspaceBridge {
  const value = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspace
  if (!value) throw new Error('TDEase desktop workspace bridge is unavailable')
  return value
}
