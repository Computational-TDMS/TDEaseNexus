import { BrowserWindow, ipcMain } from "electron";

/**
 * The update channel.
 *
 * Check in the background, download in the background (blockmap differential
 * — the installer carries the Python runtime and vendor tools, so a full
 * re-download between versions is not acceptable), and NEVER restart on the
 * app's own initiative: a running Run is never interrupted, the restart is
 * the user's decision. `autoInstallOnAppQuit` only acts on a quit the user
 * started anyway.
 *
 * State is pushed to the renderer on one channel; a check/download failure is
 * logged and reflected in the state object but must never raise a dialog on
 * its own — a user whose update host is unreachable (the publish URL is a
 * deployment decision, not a code one) sees a quiet "up to date" product.
 */

/** The slice of electron-updater's surface this module uses. Typed locally
 *  because the package is optional at runtime (dev checkouts may not have it
 *  installed); its types cannot be imported where they may be absent. */
interface AutoUpdaterHandle {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: "error", listener: (error: Error) => void): unknown
  on(event: "checking-for-update", listener: () => void): unknown
  on(event: "update-available", listener: (info: { version?: string }) => void): unknown
  on(event: "update-not-available", listener: () => void): unknown
  on(event: "download-progress", listener: (progress: { percent?: number }) => void): unknown
  on(event: "update-downloaded", listener: (info: { version?: string }) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
}

export type UpdatePhase =
  | "unavailable" // no updater / dev run / check says nothing new
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  progress: number | null;
  message: string | null;
}

const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function startUpdater(getWindow: () => BrowserWindow | null, isDev: boolean): void {
  let state: UpdateState = { phase: "unavailable", version: null, progress: null, message: null };
  let autoUpdater: AutoUpdaterHandle | null = null;

  if (!isDev) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional release dependency
      autoUpdater = require("electron-updater").autoUpdater as AutoUpdaterHandle;
    } catch {
      console.warn("[updater] electron-updater is not installed; updates are disabled.");
    }
  }

  const push = (next: Partial<UpdateState>): void => {
    state = { ...state, ...next };
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send("update:state", state);
    }
  };

  if (autoUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("error", (error) => {
      console.warn("[updater] failed:", error?.message || error);
      push({ phase: "error", message: error?.message || String(error) });
    });
    autoUpdater.on("checking-for-update", () => push({ phase: "checking" }));
    autoUpdater.on("update-available", (info) =>
      push({ phase: "available", version: info?.version ?? null, progress: null, message: null }));
    autoUpdater.on("update-not-available", () =>
      push({ phase: "unavailable", version: null, message: null }));
    autoUpdater.on("download-progress", (progress) =>
      push({ phase: "downloading", progress: progress?.percent ?? null }));
    autoUpdater.on("update-downloaded", (info) =>
      push({ phase: "downloaded", progress: 100, message: null, version: info?.version ?? state.version }));

    const check = (): void => {
      autoUpdater!.checkForUpdates().catch((error: unknown) => {
        // The 'error' event carries the detail; this catch only stops an
        // unhandled rejection from surfacing elsewhere.
        console.warn("[updater] check failed:", (error as Error)?.message || error);
      });
    };
    check();
    setInterval(check, RECHECK_INTERVAL_MS).unref();
  }

  ipcMain.handle("update:state:get", () => state);
  ipcMain.handle("update:check", () => {
    if (!autoUpdater) return state;
    push({ phase: "checking" });
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.warn("[updater] manual check failed:", (error as Error)?.message || error);
    });
    return state;
  });
  ipcMain.handle("update:restart", () => {
    if (autoUpdater && state.phase === "downloaded") autoUpdater.quitAndInstall();
    return state.phase;
  });
}
