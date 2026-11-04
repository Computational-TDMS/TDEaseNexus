import { JsonlSessionLog, type SessionLogTextFile } from '@/agent/events'
import { assertSha256, type PromptSnapshotStore, type Sha256 } from '@/agent/prompt'
import type { MindsetId } from '@/agent/prompt'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

export interface WorkspaceTextBridge {
  exists?(root: string, relative: string): Promise<boolean>
  readText(root: string, relative: string): Promise<string>
  appendText(root: string, relative: string, content: string): Promise<void>
  writeTextAtomic(root: string, relative: string, content: string): Promise<void>
  listDir?(root: string, relative: string): Promise<ReadonlyArray<{ name: string; isDir: boolean }>>
}

export class AgentSessionStorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentSessionStorageError'
  }
}

export interface WorkspaceSessionMetadata {
  version: 1
  id: string
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  mindset: MindsetId
  /** Present on a side-chat child: the parent session id it hangs off. */
  sideOf?: string
}

export async function listWorkspaceSessionMetadata(
  workspace: WorkspaceTextBridge,
  workspaceRoot: string,
): Promise<ReadonlyArray<WorkspaceSessionMetadata>> {
  if (!workspace.listDir) throw new AgentSessionStorageError('Workspace session listing is unavailable')
  let entries: ReadonlyArray<{ name: string; isDir: boolean }>
  try {
    entries = await workspace.listDir(workspaceRoot, '.tdease/sessions')
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
  const parsed = await Promise.all(entries
    .filter((entry) => entry.isDir && /^[A-Za-z0-9_-]+$/.test(entry.name))
    .map(async (entry) => {
      try {
        // No `exists` pre-check: the ENOENT catch below already covers a
        // session dir outliving its metadata, and the pre-check doubled the
        // IPC round trips (2N serialized awaits before the list rendered).
        const raw = await workspace.readText(workspaceRoot, `${sessionRoot(entry.name)}/session.json`)
        return parseSessionMetadata(JSON.parse(raw), entry.name)
      } catch (error) {
        if (isNotFound(error)) return null
        // One malformed metadata file (a torn write, a hand-edited id) must not
        // blind the WHOLE session surface — it used to throw here, killing the
        // listing and, with it, every conversation's boot. Name it, skip it.
        console.warn(`[agent] skipping unreadable session metadata for ${entry.name}:`, error)
        return null
      }
    }))
  const records = parsed.filter((record): record is WorkspaceSessionMetadata => record !== null)
  return records.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function writeWorkspaceSessionMetadata(
  workspace: WorkspaceTextBridge,
  workspaceRoot: string,
  metadata: WorkspaceSessionMetadata,
): Promise<void> {
  const record = parseSessionMetadata(metadata, metadata.id)
  await workspace.writeTextAtomic(
    workspaceRoot,
    `${sessionRoot(record.id)}/session.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  )
}

/** Renderer-side adapter for `<workspace>/.tdease/sessions/<session>/events.jsonl`. */
export function createWorkspaceSessionLog(
  workspace: WorkspaceTextBridge,
  workspaceRoot: string,
  sessionId: string,
  options: { readOnly?: boolean } = {},
): JsonlSessionLog {
  return new JsonlSessionLog(
    createSessionTextFile(workspace, workspaceRoot, sessionId, 'events.jsonl'),
    options,
  )
}

/** Content-addressed frozen prompt snapshots beside the append-only log. */
export function createWorkspacePromptSnapshotStore(
  workspace: WorkspaceTextBridge,
  workspaceRoot: string,
  sessionId: string,
): PromptSnapshotStore {
  const base = sessionRoot(sessionId)
  return {
    async write(digest: Sha256, content: string): Promise<void> {
      assertSha256(digest)
      await workspace.writeTextAtomic(workspaceRoot, `${base}/snapshots/${digest}.md`, content)
    },
    async read(digest: Sha256): Promise<string | undefined> {
      assertSha256(digest)
      try {
        return await workspace.readText(workspaceRoot, `${base}/snapshots/${digest}.md`)
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw error
      }
    },
  }
}

export function desktopWorkspaceTextBridge(): WorkspaceTextBridge {
  const workspace = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspace
  if (!workspace) throw new AgentSessionStorageError('Desktop Workspace text bridge is unavailable')
  return workspace
}

function createSessionTextFile(
  workspace: WorkspaceTextBridge,
  workspaceRoot: string,
  sessionId: string,
  filename: string,
): SessionLogTextFile {
  const relative = `${sessionRoot(sessionId)}/${filename}`
  return {
    async readText(): Promise<string | null> {
      try {
        // A newly-created session legitimately has no append-only log yet.
        // Avoid invoking readFile for that normal empty state: Electron logs a
        // rejected IPC handler even though the renderer subsequently handles
        // ENOENT and converts it to null.
        if (workspace.exists && !(await workspace.exists(workspaceRoot, relative))) return null
        return await workspace.readText(workspaceRoot, relative)
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    appendText: (content) => workspace.appendText(workspaceRoot, relative, content),
    replaceText: (content) => workspace.writeTextAtomic(workspaceRoot, relative, content),
  }
}

function sessionRoot(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new AgentSessionStorageError('Agent session id may contain only letters, digits, underscores, and hyphens')
  }
  return `.tdease/sessions/${sessionId}`
}

/** Validate + normalize one session metadata record (also the write path's
 *  gate — `writeWorkspaceSessionMetadata` round-trips through it). */
export function parseSessionMetadata(value: unknown, expectedId: string): WorkspaceSessionMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentSessionStorageError(`Session ${expectedId} metadata must be an object`)
  }
  const record = value as Partial<WorkspaceSessionMetadata>
  if (record.version !== 1 || record.id !== expectedId) {
    throw new AgentSessionStorageError(`Session ${expectedId} metadata identity is invalid`)
  }
  if (typeof record.title !== 'string') throw new AgentSessionStorageError(`Session ${expectedId} title is invalid`)
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
    throw new AgentSessionStorageError(`Session ${expectedId} timestamps are invalid`)
  }
  if (typeof record.archived !== 'boolean') throw new AgentSessionStorageError(`Session ${expectedId} archived flag is invalid`)
  // Retired mindset names are normalized so legacy session records still open,
  // rather than hard-failing on history: `general` was a read-only
  // conversational mode and a strict subset of analysis (read-only
  // investigation); `explorer`/`executor` are the pre-rename spellings of
  // analysis/workflow. record.mindset is asserted to string because it is
  // deserialized from disk and may carry legacy values the MindsetId union no
  // longer includes.
  const legacyMindsetMap: Record<string, MindsetId> = {
    general: 'analysis',
    explorer: 'analysis',
    executor: 'workflow',
  }
  const storedMindset = record.mindset as string | undefined
  const rawMindset = storedMindset !== undefined ? legacyMindsetMap[storedMindset] ?? storedMindset : undefined
  if (rawMindset !== 'analysis' && rawMindset !== 'workflow') {
    throw new AgentSessionStorageError(`Session ${expectedId} mindset is invalid`)
  }
  // Side-chat lineage is optional; when present it must be a non-empty id —
  // an empty string would silently detach the child from cascade deletion.
  let sideOf: string | undefined
  if (record.sideOf !== undefined) {
    if (typeof record.sideOf !== 'string' || !/^[A-Za-z0-9_-]+$/.test(record.sideOf)) {
      throw new AgentSessionStorageError(`Session ${expectedId} sideOf is invalid`)
    }
    sideOf = record.sideOf
  }
  return {
    version: 1,
    id: record.id,
    title: record.title,
    createdAt: record.createdAt as number,
    updatedAt: record.updatedAt as number,
    archived: record.archived,
    mindset: rawMindset,
    ...(sideOf ? { sideOf } : {}),
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  // Electron IPC retains Node's ENOENT text but not its `code` property.
  return code === 'ENOENT' || (typeof message === 'string' && /\bENOENT\b/.test(message))
}
