import type { RelativePath, ResultId, RunId, Sha256, WorkspaceId } from './identity'

export interface ResultRef {
  workspaceId: WorkspaceId
  runId: RunId
  resultId: ResultId
  digest: Sha256
}

export interface PublishedResult {
  ref: ResultRef
  title: string
  kind: string
  mediaType?: string
  size: number
  technicalPath: RelativePath
  metadata: Readonly<Record<string, unknown>>
}

export interface TechnicalArtifactRef {
  runId: RunId
  path: RelativePath
  digest: Sha256
  kind: 'workflow' | 'log' | 'dag' | 'report' | 'archive' | 'intermediate'
}
