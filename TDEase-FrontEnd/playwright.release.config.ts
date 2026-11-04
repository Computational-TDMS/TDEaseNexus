import { defineConfig } from '@playwright/test'

/**
 * Release-VM suite: key agent behaviors against the INSTALLED TDEaseNexus,
 * driven over CDP (chromium.connectOverCDP) instead of launching Electron.
 *
 * Prerequisites (run-release-vm.sh leaves the VM in exactly this state):
 *   - the installed app at the standard path, reachable with
 *     --remote-debugging-port (the suite restarts it through ssh/WMI)
 *   - `ssh <host>` reachable from this machine (default alias: tdease-win),
 *     with a local tunnel: ssh -N -L 9333:127.0.0.1:9333 tdease-win
 *
 * Provider selection (env):
 *   E2E_DEEPSEEK_API_KEY  set → the agent turn runs against the REAL DeepSeek
 *                         API (tests real streaming/tool-choosing behavior).
 *                         unset → the deterministic mock-llm-server smoke.
 *
 * Run: npx playwright test -c playwright.release.config.ts
 */

export default defineConfig({
  testDir: './tests/release',
  testMatch: /.*\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/release',
  use: {
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
})
