import type { PlanRef, RelativePath, RunId, WorkspaceId } from './identity'
import type { ResultRef } from './result'

/**
 * seven variants. `components/documents/definitions.ts`
 * maps every one of them to a component; that table is a mapped type over this
 * union, so adding a variant here without registering it fails to compile.
 *
 * `settings` (§5.7) carries no fields on purpose: the section is view state
 * inside the document, not identity, so a user switching from Providers to MCP
 * stays in one tab instead of opening a second.
 */
export type DocumentKey =
  | { kind: 'run-index'; workspaceId: WorkspaceId }
  | { kind: 'run'; runId: RunId }
  | { kind: 'result'; ref: ResultRef }
  /**
   * The Workspace-wide PROV Evidence DAG (`evidence.graph`), one surface per
   * Workspace: the projection covers every `*.prov.json` claim
   * file, so there is nothing per-file to key on. Single files keep opening
   * through `file`.
   */
  | { kind: 'evidence-graph' }
  | { kind: 'file'; workspaceId: WorkspaceId; path: RelativePath }
  /**
   * One wiki page. `page` is wiki-root-relative (`method/TopFD.md`), and the
   * scope decides the root: `system` is the Client System wiki (cross-
   * workspace knowledge), `workspace` is the attached workspace's `wiki/`
   * directory. No workspaceId on the key — the workspace scope always names
   * the attached workspace, the same implicit binding as `evidence-graph`.
   */
  | { kind: 'wiki'; scope: 'system' | 'workspace'; page: string }
  /** The wiki index: both scopes listed, searched, and new pages created. App-scoped, one tab. */
  | { kind: 'wiki-index' }
  | { kind: 'analysis-review'; planRef: PlanRef }
  | { kind: 'settings' }

export interface OpenDocument {
  key: DocumentKey
  id: string
  title: string
  pinned: boolean
  dirty: boolean
  lastActiveAt: number
}
