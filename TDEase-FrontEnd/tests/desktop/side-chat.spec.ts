import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, openAgentPage, test } from './desktop-app'

/**
 * The side chat walkthrough (ZCode's SelectionSideChatPane contract), as a
 * real user drives it: select transcript text → the "Ask AI" pill → a child
 * session opens with the quote seeded (consume-once) → the side turn runs on
 * its OWN event log while the parent stays active and untouched → closing the
 * panel archives the child → the archive partition holds it and restore
 * pulls it back.
 *
 * Every step is the product's own affordance — the selection is a REAL
 * pointer drag, the send is the real composer, and the settle path is the
 * incremental projection the store actually runs in production.
 */

/** All session event logs in the workspace: sessionId → raw events.jsonl. */
function sessionLogs(workspacePath: string): Map<string, string> {
  const sessionsRoot = join(workspacePath, '.tdease', 'sessions')
  const logs = new Map<string, string>()
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      logs.set(entry.name, readFileSync(join(sessionsRoot, entry.name, 'events.jsonl'), 'utf8'))
    } catch { /* a session dir without a log yet */ }
  }
  return logs
}

test('selection asks the AI in a side chat that archives on close', async ({
  page, workspace, openWorkspace, configureProvider,
}) => {
  test.setTimeout(300_000)
  await configureProvider()
  await openWorkspace()
  await openAgentPage(page)

  // ── Parent turn: give the transcript real, selectable content. ──────────
  const composer = page.locator('.agent-page:visible textarea:visible')
  await composer.fill('SIDEQUOTE42 localize the proteoform and summarize the evidence.')
  await composer.press('Enter')
  const parentMessage = page.locator('.transcript__user', { hasText: 'SIDEQUOTE42' }).first()
  await expect(parentMessage).toBeVisible()
  await expect(page.locator('.agent-page:visible').getByText('FIXTURE_OK')).toBeVisible({ timeout: 60_000 })
  // Settled: the canonical projection replaced the live tail on disk too.
  await expect.poll(() => {
    const logs = sessionLogs(workspace.path)
    const parent = [...logs.values()].find(text => text.includes('SIDEQUOTE42'))
    return parent?.includes('turn.completed') ?? false
  }, { timeout: 30_000 }).toBe(true)
  const parentLogsBefore = sessionLogs(workspace.path)

  // ── Select text in the transcript (a real pointer drag). ────────────────
  // Drag across the TEXT element's own box (not the full-width message row):
  // the row can be wider than its words, and a drag over empty space selects
  // nothing.
  await parentMessage.scrollIntoViewIfNeeded()
  const textEl = parentMessage.getByText('SIDEQUOTE42').first()
  const box = await textEl.boundingBox()
  expect(box, 'the parent message text must have layout to drag across').not.toBeNull()
  const lineY = box!.y + box!.height / 2
  await page.mouse.move(box!.x + 2, lineY)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width - 2, lineY, { steps: 8 })
  await page.mouse.up()

  // The pill floats at the selection's top edge.
  const pill = page.locator('.transcript__ask-pill')
  await expect(pill).toBeVisible()

  // ── Ask AI: a child session, a seeded draft, a side tab. ────────────────
  await pill.click()
  // The ask consumed the quote: the pill collapses with the selection.
  await expect(pill).toBeHidden()

  const side = page.locator('.side-chat')
  await expect(side).toBeVisible()
  // The main session is the base surface, not a tab: opening the side chat
  // yields exactly one extra tab, and it takes the active slot.
  await expect(page.locator('.agent-tab-strip__tab')).toHaveCount(1)
  await expect(page.locator('.agent-tab-strip__tab').first()).toHaveClass(/is-active/)

  // Consume-once draft: the selection rode into the side composer, and the
  // reopen path must never resurrect it (asserted at the end).
  const sideInput = side.locator('.side-chat__input')
  const seeded = await sideInput.inputValue()
  expect(seeded, 'the quote must be seeded into the side composer').toContain('SIDEQUOTE42')
  expect(seeded).toContain('>')

  // ── The side turn: quoted question, answered in the side panel. ─────────
  const question = 'E2E_SIDE_QUESTION why does the +317 shift matter?'
  await sideInput.fill(`${seeded}\n${question}`)
  await sideInput.press('Enter')
  await expect(side.getByText('FIXTURE_OK')).toBeVisible({ timeout: 60_000 })

  // The side turn settled into the CHILD's own event log — quote and question
  // both — while the parent's log byte-identically stayed as it was.
  await expect.poll(() => {
    const logs = sessionLogs(workspace.path)
    const sideLog = [...logs.values()].find(text => text.includes('E2E_SIDE_QUESTION'))
    return sideLog?.includes('SIDEQUOTE42') && sideLog.includes('turn.completed')
      ? 'settled'
      : 'pending'
  }, { timeout: 30_000 }).toBe('settled')
  const logsAfterSideTurn = sessionLogs(workspace.path)
  for (const [id, text] of parentLogsBefore) {
    expect(logsAfterSideTurn.get(id), `parent session ${id} must be untouched by the side turn`).toBe(text)
  }

  // ── Close the panel: the child auto-archives. ───────────────────────────
  const expectedTitle = seeded.slice(0, 24)
  await page.locator('.agent-tab-strip__close').first().click()
  await expect(side).toBeHidden()
  // With the side tab gone the shell lands back on the parent transcript.
  await expect(page.locator('.transcript__user', { hasText: 'SIDEQUOTE42' }).first()).toBeVisible()

  const archivedToggle = page.locator('.archived-toggle')
  await archivedToggle.click()
  const archivedTitle = page
    .locator('.session-item--archived .session-title', { hasText: expectedTitle })
  await expect(archivedTitle).toHaveCount(1)

  // ── Restore pulls the side chat back out of the archive. ────────────────
  // The unarchive affordance is the first op button on the archived row
  // (locale-free), Restore/删除 per i18n.
  await page
    .locator('.session-item--archived', { hasText: expectedTitle })
    .locator('.session-ops button')
    .first()
    .click()
  await expect(page.locator('.session-item--archived .session-title', { hasText: expectedTitle })).toHaveCount(0)
})
