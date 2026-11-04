import { defineConfig } from '@playwright/test'

/**
 * One real Electron scenario. It covers the preload, Pi runtime, local
 * Workspace filesystem, Electron-supervised Backend and Agent turn in one app
 * process; a browser-only mount test cannot cover those desktop boundaries.
 *
 * Vite is the only Playwright-owned server. Electron starts and stops the real
 * local Backend API + Worker pair through BackendManager, exactly as Desktop
 * does outside the test suite.
 */
const VITE_PORT = 1430

export default defineConfig({
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',

  use: {
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  // Release-E2E (TDEASE_E2E_MAIN_BUNDLE): the packaged app serves its own
  // renderer — no vite dev server is needed or wanted.
  ...(process.env.TDEASE_E2E_MAIN_BUNDLE ? {} : { webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${VITE_PORT} --strictPort`,
    url: `http://127.0.0.1:${VITE_PORT}`,
    reuseExistingServer: true,
    timeout: 90_000,
  } }),

  projects: [
    {
      name: 'desktop',
      testDir: './tests/desktop',
      // Electron is launched by the fixture, so no `devices` entry applies.
      workers: 1,
    },
  ],
})
