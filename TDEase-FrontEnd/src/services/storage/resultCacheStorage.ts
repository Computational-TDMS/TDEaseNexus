/**
 * The two Electron-backed `ResultCacheStorage` implementations
 * `studioResultCache.ts` declared but never got: a local cache under
 * Electron's userData directory, and a Workspace-rooted store for
 * `ResultCache.materialize()`. Both talk to `electron/main.ts` /
 * `electron/preload.cjs` over IPC; see the "Published Result cache" section
 * there for why the local one is a separate root from the Workspace.
 *
 * ## Wiring status -- connected 2026-07-26
 *
 * `desktopResultCache()` below is the one real composition point, and it is
 * now called: `src/stores/documents.ts`'s `resultCache()` builds a cache from
 * the attached Workspace root, and `describeResult` / `openResultContent` /
 * `materializeResult` / `evictResult` are the store surface
 * `components/documents/ResultDocument.vue` renders. That store function is
 * the *only* caller by design -- a component never constructs a storage by
 * hand, exactly as it never constructs a gateway.
 *
 * Before that, this module had two complete implementations and zero
 * production importers: `ResultCache.open()` was never called anywhere in the
 * codebase, which is why `DocumentKey`'s `result` variant had an id in
 * `documentId()` and no surface to open.
 */

import { studioInfrastructure } from '../backend/studioInfrastructure'
import type { ResultCacheStorage } from './studioResultCache'
import type { ResultCache } from '@/studio/ports/result-cache'
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

/**
 * The `result-cache:*` bridge `electron/preload.cjs` exposes, typed locally
 * rather than added to `src/global.d.ts` -- every existing IPC-backed
 * service in this codebase (see `desktopWorkspace.ts`'s
 * `DesktopWorkspaceBridge`) types its own slice of `tdeaseDesktop` instead of
 * growing one shared global surface.
 */
interface ResultCacheBridge {
  exists(path: string): Promise<boolean>
  sha256(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  writeBytesAtomic(path: string, content: number[]): Promise<void>
  remove(path: string): Promise<void>
}

/** The slice of `tdeaseDesktop.workspace` the Workspace-rooted storage reuses. */
interface WorkspaceBridge {
  exists(root: string, relative: string): Promise<boolean>
  sha256(root: string, relative: string): Promise<string>
  readBytes(root: string, relative: string): Promise<Uint8Array>
  writeBytesAtomic(root: string, relative: string, content: number[]): Promise<void>
  trash(root: string, relative: string): Promise<void>
}

function resultCacheBridge(): ResultCacheBridge {
  const value = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.resultCache
  if (!value) throw new Error('TDEase desktop result-cache bridge is unavailable')
  return value
}

function workspaceBridge(): WorkspaceBridge {
  const value = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop?.workspace
  if (!value) throw new Error('TDEase desktop workspace bridge is unavailable')
  return value
}

/**
 * `ResultCacheStorage.digest` is composed here from two primitives (`exists`
 * then `sha256`) rather than being one opaque IPC round trip that already
 * returns `string | undefined`. Two consequences:
 *
 * - Both storages below share one definition of "digest of a missing path is
 *   `undefined`", instead of the Electron main process encoding that policy
 *   twice (once per IPC namespace) with room for the two copies to drift.
 * - This function -- unlike the raw IPC handlers in `electron/main.ts`, which
 *   import `electron` and so cannot run under plain Node/vitest -- is real
 *   production code this module's tests exercise directly, with a fake
 *   `exists`/`sha256` pair standing in for the bridge.
 */
async function digestVia(exists: () => Promise<boolean>, sha256: () => Promise<string>): Promise<string | undefined> {
  return (await exists()) ? sha256() : undefined
}

/**
 * TDEase's own Published Result cache: the `cache` half of
 * `PublishedResultCache`, rooted at Electron's userData directory
 * (`electron/main.ts`'s `resultCacheRoot()`) via the `result-cache:*` IPC
 * namespace. Never the user's Workspace -- see the module doc in
 * `electron/main.ts` for why.
 */
export function localResultCacheStorage(): ResultCacheStorage {
  return {
    digest: (path) => digestVia(() => resultCacheBridge().exists(path), () => resultCacheBridge().sha256(path)),
    read: async (path) => new Blob([new Uint8Array(await resultCacheBridge().readBytes(path))]),
    writeAtomic: async (path, blob) =>
      resultCacheBridge().writeBytesAtomic(path, Array.from(new Uint8Array(await blob.arrayBuffer()))),
    remove: (path) => resultCacheBridge().remove(path),
  }
}

/**
 * The Workspace half of `PublishedResultCache`: `ResultCache.materialize()`
 * writes into the user's registered Workspace, so this reuses the existing
 * `workspace:*` IPC handlers every other Workspace-writing service in this
 * codebase goes through (`desktopWorkspace.ts`) instead of adding a parallel
 * path, per this change's brief to prefer reuse over new IPC.
 *
 * `remove` maps to `workspace:trash`, not a hard delete: this is the user's
 * own Workspace, where every other mutating handler in `electron/main.ts`
 * goes through the OS trash so a mistaken removal is recoverable. The local
 * cache's `remove` above is a hard delete for the opposite reason -- it is
 * derived state the OS trash has no reason to protect.
 */
export function workspaceResultCacheStorage(root: string): ResultCacheStorage {
  if (!root) throw new Error('workspaceResultCacheStorage requires a Workspace root')
  return {
    digest: (path) => digestVia(() => workspaceBridge().exists(root, path), () => workspaceBridge().sha256(root, path)),
    read: async (path) => new Blob([new Uint8Array(await workspaceBridge().readBytes(root, path))]),
    writeAtomic: async (path, blob) =>
      workspaceBridge().writeBytesAtomic(root, path, Array.from(new Uint8Array(await blob.arrayBuffer()))),
    remove: (path) => workspaceBridge().trash(root, path),
  }
}

/**
 * The one real composition point: a working `ResultCache` wired to the two
 * storages above and `studioInfrastructure()`. See this file's module doc
 * for what still needs to call it, and from where.
 */
export function desktopResultCache(workspaceRoot: string, actor?: 'user' | 'ai'): ResultCache {
  return studioInfrastructure().resultCache(localResultCacheStorage(), workspaceResultCacheStorage(workspaceRoot), actor)
}
