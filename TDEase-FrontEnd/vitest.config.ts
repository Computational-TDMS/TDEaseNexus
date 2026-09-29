import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import { katexCssText } from './vite-plugins'

export default defineConfig({
  plugins: [vue(), katexCssText()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    // Exclude build artifacts, release output, and electron-side tests —
    // these either ship stale copies of test files or require the electron
    // runtime (node:test based .cjs specs), neither of which belongs in the
    // vitest dev suite.
    //
    // Exception: `electron/agent/**/*.test.ts` and `electron/share-server.test.ts`
    // are pure-TypeScript locks for Node-side runtime code. They import no
    // Electron runtime (node built-ins only), so they run in the jsdom dev
    // suite like any other unit test. The `.cjs` Electron specs under
    // electron/ stay excluded (they need node:test), as does electron/dist.
    // Any NEW root-level electron/*.test.ts must meet the same no-electron
    // bar — otherwise give it a .cjs node:test spec.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release/**',
      '**/build/**',
      '**/electron/dist/**',
      '**/electron/**/*.cjs',
      '**/scripts/**/*.test.cjs',
      // Playwright owns the Electron specs. File-backed Agent eval fixtures stay
      // under tests/agent-eval and run in Vitest without a browser or model.
      'tests/desktop/**',
      '**/.{idea,git,cache,output,temp}/**',
    ],
    coverage: {
      provider: 'v8',
      thresholds: {
        branches: 30,
        functions: 40,
        lines: 45,
        statements: 45,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
