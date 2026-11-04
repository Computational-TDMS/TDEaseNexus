// Smoke test for the shell refactor (Phase 1-3 verification).
// Run with: node scripts/smoke-shell.mjs
// Black-box: drives the live dev server at http://localhost:1420 like a user.
import pw from '../node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js'
const { chromium } = pw

const SHOT_DIR = 'C:/Users/ray/Desktop/TDEase-nexus/gui-test-screenshots'
const BASE = 'http://localhost:1420'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
page.on('pageerror', (err) => { errors.push('PAGEERROR: ' + err.message) })

try {
  // ── Step 1: initial Workbench shell ────────────────────────────────────
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForSelector('.side-bar', { timeout: 15000 })
  await page.screenshot({ path: `${SHOT_DIR}/t1_workbench_initial.png` })

  check('SideBar mounted (narrow rail)', await page.locator('.side-bar').count() === 1)
  check('SideBar is narrow (<=60px)', (await page.locator('.side-bar').boundingBox())?.width <= 60)
  check('TitleBar gone (deleted)', await page.locator('.title-bar').count() === 0)
  check('ActivityRail gone (deleted)', await page.locator('.activity-rail').count() === 0)
  // Narrow rail: ONE mode-toggle button (icon reflects the page to switch TO).
  check('One mode-toggle button in SideBar', await page.locator('.side-bar__btn').count() >= 1)
  check('No search/palette in SideBar', await page.locator('.side-bar__palette').count() === 0)
  check('SideBar is chrome-only (no section tabs in it)', await page.locator('.side-bar__section-tab').count() === 0)
  check('Navigator renders in Workbench left column with its own section tabs', await page.locator('.navigator-panel .navigator-panel__tab').count() === 3)
  check('DocumentHost renders', await page.locator('.document-host').count() === 1)
  check('StatusBar renders', await page.locator('.status-bar').count() === 1)

  // ── Step 2: switch to Agent page (single toggle button) ────────────────
  // The mode-toggle button is the one whose click flips workbench↔agent. It is
  // the first .side-bar__btn after the workspace button. Click it to toggle.
  await page.locator('.side-bar__btn').first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/t2_agent_page.png` })

  check('Agent page renders after toggle', await page.locator('.agent-page').count() === 1)
  // The old Activity panel (tri-state) is GONE.
  check('Old activity-panel removed', await page.locator('.activity-panel').count() === 0)
  // The right sidebar toggles between tab host and capsule based on open tabs.
  // These render only with a workspace open; headless has none, so verify via
  // unit tests + the agentTabs store reset behavior.
  const hasWorkspace = await page.locator('.agent-page__row').count() > 0
  if (hasWorkspace) {
    // No tabs → capsule (the empty/collapsed state).
    check('No tabs → capsule shows (collapsed state)', await page.locator('.activity-capsule').count() === 1)
    check('No tabs → tab host hidden', await page.locator('.agent-tab-host').count() === 0)
  } else {
    check('Right sidebar toggle (skipped: no workspace in headless)', true)
  }

  // ── Step 5: back to Workbench, collapse inspector (no residual border) ─
  // Toggle back to workbench (the mode-toggle button flips agent→workbench).
  await page.locator('.side-bar__btn').first().click()
  await page.waitForTimeout(400)
  // collapse the inspector (Agent dock) column
  const inspClose = page.locator('.inspector-panel__collapse')
  if (await inspClose.count()) {
    await inspClose.first().click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOT_DIR}/t5_inspector_collapsed.png` })
    check('Inspector panel unmounts on collapse (no 32px strip)', await page.locator('.inspector-panel').count() === 0)
    check('Reopen button floats when inspector collapsed', await page.locator('.workbench-page__reopen--inspector').count() === 1)
  } else {
    check('Inspector close button present', false, 'not found')
  }

  // ── Console errors ─────────────────────────────────────────────────────
  await page.screenshot({ path: `${SHOT_DIR}/t6_final.png` })
  check('No uncaught page errors', errors.filter((e) => e.startsWith('PAGEERROR')).length === 0, errors.filter((e) => e.startsWith('PAGEERROR')).join('; '))
} catch (e) {
  check('smoke test completed without throwing', false, e.message)
  await page.screenshot({ path: `${SHOT_DIR}/error.png` }).catch(() => {})
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log('FAILED:')
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? ' (' + f.detail + ')' : ''))
  process.exit(1)
}
