/**
 * File-drag payload registry — bridges HTML5 drag-and-drop with our tree.
 *
 * The browser's DataTransfer only exposes string-typed data; we stash a
 * structured payload keyed by a UUID, write the UUID into DataTransfer, and
 * look it up on drop. Mirrors openhanako's app-file-drag.ts.
 *
 * The payload also survives across DataTransfer reads (which are normally
 * cleared after the first read in some browsers) because we keep a module-
 * level map. Cleared on dragend.
 */

export type FileDragSource = 'workspace'

export interface DraggedFile {
  /** Workspace-relative path. */
  path: string
  name: string
  /** Absolute path if available (Electron native). */
  absPath?: string
  isDirectory: boolean
}

export interface FileDragPayload {
  source: FileDragSource
  files: DraggedFile[]
}

export const FILE_DRAG_MIME = 'application/x-tdease-file-drag'

interface ActivePayload {
  payload: FileDragPayload
  dragId: string
}

let active: ActivePayload | null = null

export interface WriteResult { dragId: string }

/** Write a payload into DataTransfer (and remember it). */
export function writeFileDragPayload(
  dt: DataTransfer,
  payload: FileDragPayload,
): WriteResult {
  const dragId = (crypto?.randomUUID?.() ?? `drag-${Date.now()}-${Math.random()}`)
  active = { payload, dragId }
  try {
    dt.setData(FILE_DRAG_MIME, dragId)
    dt.effectAllowed = 'move'
  } catch {
    // DataTransfer can throw if the drag has already ended — best effort.
  }
  return { dragId }
}

/** Read the payload associated with this DataTransfer (or the active one). */
export function readFileDragPayload(dt: DataTransfer): FileDragPayload | null {
  let dragId: string | null = null
  try { dragId = dt.getData(FILE_DRAG_MIME) || null } catch { /* noop */ }
  if (dragId && active?.dragId === dragId) return active.payload
  // Fall back to the active payload even without a matching id (some browsers
  // don't surface custom MIME on dragover, only on drop).
  return active?.payload ?? null
}

/** Clear the active payload (call on dragend). */
export function clearFileDragPayload(_dragId?: string): void {
  active = null
}
