// Type-only declaration for the esbuild-aliased Pi HTTP dispatcher
// (electron/build-main.mjs maps '@tdease/pi-http-dispatcher' to Pi's bundled
// dist/core/http-dispatcher.js — the package's exports map does not expose
// the subpath, and a separate undici dependency would install a SECOND
// global-dispatcher registry that Pi's vendor calls ignore).
declare module '@tdease/pi-http-dispatcher' {
  export function applyHttpProxySettings(httpProxy: string | undefined): void
  export function configureHttpDispatcher(timeoutMs?: number): void
}
