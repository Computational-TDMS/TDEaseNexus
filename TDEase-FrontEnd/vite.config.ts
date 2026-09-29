import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import ElementPlusOnDemand from 'unplugin-element-plus/vite'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import loglevel from 'loglevel'
import { katexCssText } from './vite-plugins'

// katex.min.css declares each font as woff2 → woff → ttf, and a browser only
// ever downloads the first format it supports — every target here (Electron
// Chromium included) takes woff2, so the woff/ttf copies are pure deploy
// weight. Drop them after the bundle is written instead of rewriting the
// vendored CSS: the leftover `src:` entries are fallbacks a woff2-capable
// engine never fetches.
function katexWoff2Only(): Plugin {
  let outRoot = ''
  return {
    name: 'katex-woff2-only',
    apply: 'build',
    configResolved(config) {
      outRoot = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      let removedFiles = 0
      let removedBytes = 0
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (/^KaTeX_.+\.(woff|ttf)$/.test(entry.name)) {
            removedBytes += fs.statSync(full).size
            fs.unlinkSync(full)
            removedFiles += 1
          }
        }
      }
      try {
        if (fs.existsSync(outRoot)) walk(outRoot)
      } catch (error) {
        console.warn('[katex-woff2-only] cleanup skipped:', error)
        return
      }
      if (removedFiles === 0) {
        console.log('[katex-woff2-only] no KaTeX woff/ttf fonts found — nothing to remove')
        return
      }
      console.log(
        `[katex-woff2-only] removed ${removedFiles} KaTeX woff/ttf fonts `
        + `(${(removedBytes / 1024).toFixed(0)} KB saved; woff2 copies kept)`,
      )
    },
  }
}

// @ts-expect-error process is a nodejs global
const devHost = process.env.TDEASE_FRONTEND_HOST;
// Electron dev polls 127.0.0.1 — bind loopback by default so the orchestrator's
// health check actually connects (Windows routes 0.0.0.0 listeners inconsistently
// for loopback). Set TDEASE_FRONTEND_HOST only when you need LAN/external access.
const devBindHost = devHost || '127.0.0.1';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const proxyLogger = loglevel.getLogger('vite-proxy')
  proxyLogger.setLevel(mode === 'development' ? 'info' : 'warn')

  return {
    // Electron packaged mode loads via file://, so a relative base is required
    // (otherwise /assets/... resolves to the filesystem root).
    // The dev server works fine with a relative base too.
    base: './',
    plugins: [
      vue(),
      // Injects each named `element-plus` import's styles (see main.ts); the
      // full `element-plus/dist/index.css` is no longer bundled.
      ElementPlusOnDemand(),
      VueI18nPlugin({
        include: path.resolve(__dirname, 'src/locales/**/*.json'),
      }),
      katexWoff2Only(),
      // Shared with vitest.config.ts (vite-plugins.ts) — keep both lists in
      // sync when a plugin must behave identically in tests and production.
      katexCssText(),
    ].filter(Boolean),
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    build: {
      chunkSizeWarningLimit: 5000,
      rollupOptions: {
        output: {
          // Split the heavy vendors that are STATICALLY reachable from the
          // entry chunk so the app shell parses and mounts without first
          // downloading Element Plus or AG Grid. Rules must stay an
          // exact-package match: pnpm hoists every dep of a package under
          // `.pnpm/<pkg>@<ver>/node_modules/<dep>/`, so a loose substring
          // like `id.includes('mermaid')` also captures everything hoisted
          // BESIDE mermaid (cytoscape, d3, katex, …) — and claiming a
          // package that is only DYNAMICALLY imported (mermaid) forces
          // Rollup to break the resulting entry/chunk overlap with facade
          // re-exports in the entry, re-coupling the whole 3MB chunk to the
          // first load (measured 2026-09-04: 2.27MB gzip of plotly+mermaid
          // in the entry). Mermaid and plotly are therefore NOT listed:
          // every call site is a dynamic import, so Rollup already emits
          // them as lazy chunks behind those imports. Match on the path
          // segment directly after the LAST node_modules/ so
          // `.pnpm/mermaid@x/node_modules/cytoscape` classifies as
          // cytoscape, not mermaid.
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            const pkg = id
              .slice(id.lastIndexOf('node_modules') + 'node_modules'.length + 1)
              .split(/[\\/]/)[0]
            if (pkg === 'element-plus' || pkg === '@element-plus') return 'vendor-element-plus'
            if (pkg.startsWith('ag-grid')) return 'vendor-ag-grid'
            if (pkg === 'vue' || pkg === '@vue' || pkg === 'pinia') return 'vendor-vue'
          },
        },
      },
    },

    // Keep the dev port fixed so local backend/proxy and Electron dev mode stay deterministic.
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true, // must hold 1420; fail outright otherwise, so a second Vite never drifts to 1421 and pollutes HMR
      host: devBindHost, // defaults to 127.0.0.1; only exposed externally when TDEASE_FRONTEND_HOST is set
      open: '/', // explicitly open the root path
      hmr: devHost
        ? {
          protocol: "ws",
          host: devHost,
          port: 1421,
        }
        : undefined,
      watch: {
        ignored: [],
      },
      proxy: {
        '/health': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
          secure: false,
        },
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
          secure: false,
          ws: true, // WebSocket support
          configure: (proxy, _options) => {
            proxy.on('error', (err, _req, _res) => {
              proxyLogger.error('Proxy error', err)
            });
            proxy.on('proxyReq', (proxyReq, req, _res) => {
              proxyLogger.info('Proxying request', {
                method: req.method,
                url: req.url,
                path: proxyReq.path,
              })
            });
          },
        },
        '/ws': {
          target: 'http://127.0.0.1:8000',
          ws: true,
          changeOrigin: true,
        },
      }
    },

  }
});
