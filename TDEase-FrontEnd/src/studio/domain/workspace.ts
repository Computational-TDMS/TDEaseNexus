import type { RelativePath, Sha256, WorkspaceId } from './identity'

export interface WorkspaceRef {
  id: WorkspaceId
  name: string
}

export type WorkspaceFileRole = 'workflow' | 'script' | 'config' | 'input' | 'other'

export interface WorkspaceFile {
  path: RelativePath
  digest: Sha256
  size: number
  role: WorkspaceFileRole
}

export interface WorkspaceRevision {
  treeHash: Sha256
  files: ReadonlyArray<WorkspaceFile>
}
