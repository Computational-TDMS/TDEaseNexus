import type { PlanRef, RelativePath, RunId, WorkspaceId } from './identity'
import type { ResultRef } from './result'

/**
 * The tab-identity union. `components/documents/definitions.ts`
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
  | { kind: 'file'; workspaceId: WorkspaceId; path: RelativePath }
  /**
   * One Backend Run's file — bytes the Backend owns under `runs/<run_id>/`
   * (AGENTS.md's three-tier layout), never inside the Workspace. A separate
   * variant from `file` because the two have different sources of truth for
   * both bytes and path semantics: `path` here is Run-relative.
   *
   * `workspaceId` stays on the key so the serialized document id remains
   * byte-identical to the former convention of encoding a Run file as a
   * `file` path (`file:<workspaceId>:run-files/<runId>/<path>`) — persisted
   * tabs, MRU entries and group layouts reference that exact string, and
   * `documents.ts` normalizes such legacy keys back to this variant on
   * restore. It also scopes the tab to the attached Workspace, the same
   * restore rule `file` follows.
   */
  | { kind: 'runFile'; workspaceId: WorkspaceId; runId: RunId; path: RelativePath }
  /**
   * One wiki page. `page` is wiki-root-relative (`method/TopFD.md`), and the
   * scope decides the root: `system` is the Client System wiki (cross-
   * workspace knowledge), `workspace` is the attached workspace's `wiki/`
   * directory. No workspaceId on the key — the workspace scope always names
   * the attached workspace.
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
