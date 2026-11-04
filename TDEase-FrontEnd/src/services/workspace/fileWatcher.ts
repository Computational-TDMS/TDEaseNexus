/**
 * File watcher — native fs watching (chokidar) to detect file changes in the
 * workspace, driving canvas refresh and staleness.
 *
 * FRONTEND-ZERO §6:
 *   file watcher drives all refresh: results pull, Agent writes assets,
 *   external file edits — one unified mechanism.
 *
 * In Electron: uses chokidar (native fs events).
 * In browser dev: delivers NO events — the watcher is Electron-only; the
 * store relies on explicit refresh instead.
 */
import type { TDEaseDesktop } from '@/services/desktop/desktopBridge'

export type FileEvent =
  | { type: 'add'; path: string }
  | { type: 'change'; path: string }
  | { type: 'unlink'; path: string }
  | { type: 'addDir'; path: string }
  | { type: 'unlinkDir'; path: string }

export type FileEventHandler = (event: FileEvent) => void

export interface FileWatcher {
  /** Start watching. Idempotent. */
  start(): Promise<void>
  /** Stop watching and release resources. */
  stop(): Promise<void>
  /** Register a handler for file events. Returns unsubscribe function. */
  on(handler: FileEventHandler): () => void
  /** The root directory being watched. */
  readonly root: string
}

/**
 * Create a file watcher for a workspace directory.
 *
 * In Electron with full Node access, uses chokidar.
 * In browser-only environments there is no fs access to watch — the fallback
 * below is an honest no-op that never emits events.
 */
export function createFileWatcher(workspaceRoot: string, patterns?: string[]): FileWatcher {
  // Check if we're in Electron with Node access. The desktop preload exposes
  // __installFsWatch which installs __tdease_fs_watch lazily — call it first
  // so the detection below succeeds without each caller having to bootstrap.
  const desktop = (globalThis as { tdeaseDesktop?: TDEaseDesktop }).tdeaseDesktop
  if (desktop?.__installFsWatch && typeof window.__tdease_fs_watch !== 'function') {
    try { desktop.__installFsWatch() } catch { /* best effort */ }
  }
  if (typeof window.__tdease_fs_watch === 'function') {
    return createNativeWatcher(workspaceRoot, patterns)
  }
  return createPollingWatcher(workspaceRoot, patterns)
}

// ── Native watcher (chokidar via Electron preload) ────────────────────────────

function createNativeWatcher(workspaceRoot: string, _patterns?: string[]): FileWatcher {
  const handlers = new Set<FileEventHandler>()
  let watcher: { on(event: 'all', handler: (event: string, path: string) => void): void; close?(): Promise<void> | void } | null = null
  let started = false

  return {
    root: workspaceRoot,

    async start() {
      if (started) return
      started = true
      try {
        if (typeof window.__tdease_fs_watch !== 'function') {
          throw new Error('[fileWatcher] watcher factory missing — falling back to polling')
        }
        const nativeWatch = window.__tdease_fs_watch
        // No `ignored` here. This used to restate a four-entry fragment of the
        // submission exclusion contract -- a third copy, already stale against
        // it. The list is now derived once by workspaceWatchIgnoreGlobs() and
        // applied in electron/main.ts. `opts.ignored` reaches the watcher and
        // is unioned onto that floor, so it is for genuinely watcher-local
        // extras only; contract entries belong in the policy module.
        const installed = nativeWatch(workspaceRoot, { ignoreInitial: true })
        if (!installed || typeof installed.on !== 'function') {
          throw new Error('[fileWatcher] watcher factory returned nothing — falling back to polling')
        }
        watcher = installed
        watcher.on('all', (event: string, path: string) => {
          const mapped = mapNativeEvent(event)
          if (mapped) {
            for (const h of handlers) h({ type: mapped, path })
          }
        })
      } catch (err) {
        console.warn('[fileWatcher] Native watch failed, falling back to poll:', err)
        started = false
      }
    },

    async stop() {
      if (watcher?.close) await watcher.close()
      watcher = null
      started = false
    },

    on(handler: FileEventHandler): () => void {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}

// ── Browser fallback (no events) ──────────────────────────────────────────────

function createPollingWatcher(workspaceRoot: string, _patterns?: string[]): FileWatcher {
  const handlers = new Set<FileEventHandler>()

  return {
    root: workspaceRoot,

    async start() {
      // Browser dev has no fs access to watch or poll; the store refreshes
      // explicitly. Handlers registered here will simply never fire.
      console.debug('[fileWatcher] Browser dev mode — no events; explicit refresh only')
    },

    async stop() {},

    on(handler: FileEventHandler): () => void {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}

export function mapNativeEvent(event: string): FileEvent['type'] | null {
  switch (event) {
    case 'add': return 'add'
    case 'change': return 'change'
    case 'unlink': return 'unlink'
    case 'addDir': return 'addDir'
    case 'unlinkDir': return 'unlinkDir'
    default: return null
  }
}
