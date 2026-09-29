/**
 * Workspace file tree types.
 * FRONTEND-ZERO: file tree nodes are loaded from local filesystem.
 */

/** A node in the workspace file tree. */
export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  mtime?: number
  /**
   * Sync status for files inside the selected Run's `results/<runId>/` directory
   * (§3.3). Undefined everywhere else = plain local file, no badge.
   *   - `cached`: local digest matches the server manifest ✓
   *   - `conflict`: local digest differs from the server manifest ⚠
   *   - `cloud`: server has it, local doesn't ⇩
   *   - `local`: legacy value retained for back-compat (local-only, no badge)
   */
  status?: 'local' | 'cached' | 'cloud' | 'conflict'
  /** Children for directory nodes (lazy-loaded). */
  children?: FileTreeNode[]
  /** Whether children have been loaded. */
  loaded?: boolean
}

/** Column schema entry for tabular data. Currently only passed through, never read field-by-field. */
export interface ColumnSchema {
  name: string
  type: string
}

/** Workspace identity stored in .tdease/workspace.json */
export interface WorkspaceIdentity {
  id: string
  name: string
  server?: string | null
  createdAt: string
}
