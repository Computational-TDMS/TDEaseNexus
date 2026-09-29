/**
 * Global type augmentations for the TDEase frontend.
 *
 * The Electron bridge shape is NOT declared here: the ONE exhaustive contract
 * is `TDEaseDesktop` in `@/services/desktop/desktopBridge` (mirrors
 * `electron/preload.cjs`), referenced below via an import type so every
 * tsconfig that sees this file sees the same interface.
 */

declare global {
  interface Window {
    /** WebSocket URL for event streaming (injected by backend config) */
    __WS_URL__?: string

    /** Runtime env config injected by public/env-config.js (rewritten per
     *  deployment by docker-entrypoint.sh); lets Docker repoint the API. */
    __RUNTIME_CONFIG__?: { VITE_API_BASE_URL?: string; VITE_WS_URL?: string }

    /** Locale translation helper (injected by i18n system) */
    __t?: (key: string, vars?: Record<string, unknown>) => string

    /** Folder picker the preload exposes beside the bridge (workspace:pick-directory). */
    __tdease_fs?: { pickDirectory(): Promise<string | null> }

    /** Chokidar watcher factory the preload installs (see fileWatcher.ts).
     *  `opts` passes through to the main-process chokidar watch call. */
    __tdease_fs_watch?: (
      root: string,
      opts: { ignoreInitial?: boolean } & Record<string, unknown>,
    ) => {
      on(name: 'all', fn: (event: string, path: string) => void): unknown
      once(name: 'ready', fn: () => void): unknown
      close(): Promise<void>
    }

    /** Desktop bridge for Electron IPC. */
    tdeaseDesktop?: import('@/services/desktop/desktopBridge').TDEaseDesktop
  }
}

export {}
