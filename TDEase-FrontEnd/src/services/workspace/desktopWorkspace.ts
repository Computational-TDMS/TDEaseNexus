import type { TreeEntry } from '../backend/client-contracts'
import type { WorkspaceFileSystem } from './workspaceInitializer'
import { isSubmissionPathIncluded } from '@/studio/domain/workspace-snapshot-policy'
import { mediaMimeType } from '@/services/visualization/fileTypes'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

interface DesktopWorkspaceBridge {
  exists(root: string, relative: string): Promise<boolean>
  mkdir(root: string, relative: string): Promise<void>
  listFiles(root: string): Promise<string[]>
  readText(root: string, relative: string): Promise<string>
  readBytes(root: string, relative: string): Promise<Uint8Array>
  readByteRange(root: string, relative: string, start: number, end: number): Promise<Uint8Array | null>
  fileSize(root: string, relative: string): Promise<number>
  writeTextAtomic(root: string, relative: string, content: string): Promise<void>
  writeBytesAtomic(root: string, relative: string, content: number[]): Promise<void>
  sha256(root: string, relative: string): Promise<string>
}

function bridge(): DesktopWorkspaceBridge {
  const value = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspace
  if (!value) throw new Error('TDEase desktop workspace bridge is unavailable')
  return value
}

/**
 * Optional workspace bridge access — returns `undefined` when the preload is
 * absent (browser dev), instead of throwing. For callers like run-file-status
 * that degrade gracefully without digests, so they do not reach into
 * `globalThis.tdeaseDesktop` directly.
 */
export function desktopWorkspaceBridgeOptionally(): DesktopWorkspaceBridge | undefined {
  return (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspace
}

export function desktopWorkspaceFileSystem(root: string): WorkspaceFileSystem {
  return {
    exists: (path) => bridge().exists(root, relative(root, path)),
    mkdir: (path) => bridge().mkdir(root, relative(root, path)),
    readText: (path) => bridge().readText(root, relative(root, path)),
    writeTextAtomic: (path, content) => bridge().writeTextAtomic(root, relative(root, path), content),
  }
}

export async function scanWorkspace(root: string, include: (path: string) => boolean = defaultInclude): Promise<TreeEntry[]> {
  const api = bridge()
  const paths = (await api.listFiles(root)).filter(include)
  return Promise.all(paths.map(async (path) => {
    const [blobHash, size] = await Promise.all([api.sha256(root, path), api.fileSize(root, path)])
    return { path, blob_hash: blobHash, size, mode: 'file' as const, executable: false }
  }))
}

/**
 * Trusted digests for the provenance ledger.
 *
 * SHA-256 is computed in the Electron main process, streaming, so a 150 MB
 * mzML never crosses into the renderer and the Agent can never author a digest
 * -- it can only report one that is then checked against the file.
 */
export function workspaceFileDigests(root: string) {
  return {
    async digest(relativePath: string): Promise<{ sha256: string; size: number } | null> {
      const api = bridge()
      const normalized = relative(root, relativePath)
      if (!await api.exists(root, normalized)) return null
      const [sha256, size] = await Promise.all([api.sha256(root, normalized), api.fileSize(root, normalized)])
      return { sha256, size }
    },
  }
}

export async function readWorkspaceText(root: string, path: string): Promise<string> {
  return bridge().readText(root, path)
}

export async function readWorkspaceBlob(root: string, path: string): Promise<Blob> {
  // MIME from the extension: a type-aware consumer (<iframe src=blob-url>,
  // native drag) renders an untyped blob as plain text / opaque bytes.
  return new Blob([new Uint8Array(await bridge().readBytes(root, path))], { type: mediaMimeType(path) })
}

export function desktopResultFileSystem(root: string) {
  return {
    async digest(path: string): Promise<string | undefined> {
      const relativePath = relative(root, path)
      return await bridge().exists(root, relativePath) ? bridge().sha256(root, relativePath) : undefined
    },
    async writeBlobAtomic(path: string, blob: Blob): Promise<void> {
      await bridge().writeBytesAtomic(root, relative(root, path), Array.from(new Uint8Array(await blob.arrayBuffer())))
    },
  }
}

const defaultInclude = isSubmissionPathIncluded

// ── DeskTree file-ops bridge (rename / trash / move / copy / listDir) ──────────

/** A single directory entry with metadata, returned by `listDir`. */
export interface DeskDirEntry {
  name: string
  isDir: boolean
  size: number
  mtime: number
}

interface DesktopFileOpsBridge {
  rename(root: string, oldRel: string, newRel: string): Promise<void>
  trash(root: string, rel: string): Promise<void>
  move(root: string, srcRels: string[], destDirRel: string): Promise<void>
  copyInto(root: string, absSrcPaths: string[], destDirRel: string): Promise<void>
  listDir(root: string, rel: string): Promise<DeskDirEntry[]>
  showInFolder(absPath: string): Promise<void>
  openExternal(absPath: string): Promise<string>
  revealPath(root: string, rel: string): Promise<void>
  startNativeDrag(filePaths: string[]): void
  getPathForFile(file: File): string | null
}

function fileOpsBridge(): DesktopFileOpsBridge {
  const ws = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspace
  if (!ws) throw new Error('TDEase desktop workspace bridge is unavailable')
  return ws
}

export function isDesktopFileOpsAvailable(): boolean {
  return !!(globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspace
}

export function getDesktopFileOps(): DesktopFileOpsBridge {
  return fileOpsBridge()
}


function relative(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '')
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith(`${normalizedRoot}/`) ? normalized.slice(normalizedRoot.length + 1) : normalized
}
