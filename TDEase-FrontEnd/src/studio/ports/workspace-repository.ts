import type { RelativePath } from '../domain/identity'
import type { WorkspaceRef, WorkspaceRevision } from '../domain/workspace'

export type Unsubscribe = () => void

export interface SnapshotSelection {
  include: (path: RelativePath) => boolean
}

export interface WorkspaceEntry {
  path: RelativePath
  kind: 'file' | 'directory'
  size?: number
}

export interface WorkspaceChange {
  type: 'add' | 'change' | 'remove'
  path: RelativePath
}

export interface WorkspaceRepository {
  inspect(): Promise<WorkspaceRef>
  snapshot(selection: SnapshotSelection): Promise<WorkspaceRevision>
  readText(path: RelativePath): Promise<string>
  writeText(path: RelativePath, content: string): Promise<void>
  writeBytes(path: RelativePath, bytes: Uint8Array): Promise<void>
  list(path?: RelativePath): Promise<ReadonlyArray<WorkspaceEntry>>
  watch(listener: (change: WorkspaceChange) => void): Unsubscribe
}
