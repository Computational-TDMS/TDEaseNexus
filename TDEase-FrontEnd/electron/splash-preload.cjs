// splash-preload.cjs — the minimal preload for the splash window.
//
// The splash used to run with nodeIntegration:true / contextIsolation:false /
// sandbox:false because its inline script called require("electron"). It needs
// exactly seven IPC touchpoints, so this preload exposes only those, via
// contextBridge, and the window itself is now a plain sandboxed renderer.
// Built beside main.bundle.cjs by electron/build-main.mjs (same recipe as
// preload.cjs) so `path.join(__dirname, "splash-preload.cjs")` resolves in dev
// and packaged builds alike.

const { contextBridge, ipcRenderer } = require("electron");

const SEND_CHANNELS = new Set(["splash:closing-done", "splash:retry", "splash:quit"]);
const INVOKE_CHANNELS = new Set(["desktop:open-logs", "desktop:open-uv-docs"]);
const EVENT_CHANNELS = new Set(["splash:progress", "splash:reset", "splash:error"]);

contextBridge.exposeInMainWorld("tdeaseSplash", {
  send(channel, ...args) {
    if (!SEND_CHANNELS.has(channel)) throw new Error(`splash send not allowed: ${channel}`);
    ipcRenderer.send(channel, ...args);
  },
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.has(channel)) throw new Error(`splash invoke not allowed: ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, listener) {
    if (!EVENT_CHANNELS.has(channel)) throw new Error(`splash event not allowed: ${channel}`);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
