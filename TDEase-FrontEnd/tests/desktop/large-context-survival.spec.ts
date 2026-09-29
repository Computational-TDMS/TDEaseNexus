import { expect, test, openAgentPage, fixtureTuning } from './desktop-app'
import type { Page } from '@playwright/test'

/**
 * Regression pin for the recorded STATUS defect: "the app closes ~25 s after a
 * failed turn whose context carries a >100 KB message". Seeds ~250 KB of
 * assistant bloat — including one >100 KB single message — WITHOUT compaction
 * (wide context window, high keepRecent), reloads, settles a failed turn, then
 * watches every death channel (page close/crash, app exit) for 45 s.
 *
 * Both repro shapes recorded 2026-09-11 no longer reproduce on main (pinned
 * here 2026-09-13). The merged journey cannot host this because its
 * keepRecentTokens: 10 compacts the bloat away before the failed turn, which
 * is exactly how the defect originally hid there.
 */

// Mirror the real product's wide window so the bloat stays resident — set
// for THIS suite only and restored after (module state, restored in afterAll,
// so a shared worker process cannot leak the override into another spec).
const defaultTuning = { ...fixtureTuning }
test.beforeAll(() => {
  fixtureTuning.keepRecentTokens = 200000
  fixtureTuning.contextWindow = 200000
})
test.afterAll(() => {
  Object.assign(fixtureTuning, defaultTuning)
})

async function send(page: Page, message: string) {
  let composer = page.locator('.agent-page:visible textarea:visible')
  if (!(await composer.isVisible().catch(() => false))) {
    await openAgentPage(page)
    composer = page.locator('.agent-page:visible textarea:visible')
  }
  await expect(composer).toBeVisible()
  await composer.fill(message)
  await composer.press('Enter')
}

async function ensureIdle(page: Page) {
  await expect(page.locator('.composer__send').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.composer__queued')).toBeHidden()
}

test('a failed turn over a large uncompacted context must not close the app', async ({
  app, page, openWorkspace, configureProvider,
}) => {
  test.setTimeout(300_000)
  await configureProvider()
  await openWorkspace()
  await openAgentPage(page)

  const transcript = page.locator('.agent-page__transcript')

  for (const marker of ['E2E_BLOAT_A', 'E2E_BLOAT_B', 'E2E_BLOAT_BIG']) {
    await test.step(`${marker} streams large assistant bloat`, async () => {
      await send(page, marker)
      await expect(transcript).toContainText('BLOAT_TURN_DONE', { timeout: 120_000 })
      await ensureIdle(page)
    })
  }

  await test.step('reload with the bloat resident in the session', async () => {
    await page.reload()
    await expect(page.locator('.side-bar')).toBeVisible({ timeout: 30_000 })
  })

  const deaths: string[] = []
  page.on('close', () => deaths.push('page:close'))
  page.on('crash', () => deaths.push('page:crash'))
  app.process().on('exit', (code) => deaths.push(`app:exit:${code}`))

  await test.step('a provider-error turn settles failed', async () => {
    await send(page, 'E2E_STOP_ERROR')
    await expect(page.locator('.agent-page__edge')).toHaveClass(
      /agent-page__edge--failed/, { timeout: 120_000 },
    )
  })

  await test.step('the app survives the 45 s window after the failed turn', async () => {
    await page.waitForTimeout(45_000)
    expect(deaths, `the app died through: ${deaths.join(', ')}`).toEqual([])
    await expect(page.locator('.side-bar')).toBeVisible()
  })
})
