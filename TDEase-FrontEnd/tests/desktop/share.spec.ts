import { expect, test } from './desktop-app'

/**
 * The invitation-based sharing model, end to end against the REAL Electron
 * app and its REAL share server: enable the share, create a named view-tier
 * invitation, sign in over HTTP with that invitation's token, watch the
 * tier gate refuse a prompt, revoke the guest from the UI, and watch the
 * guest's cookie die — with the audit trail naming every step.
 *
 * The guest side is plain `fetch` from the test process, which is the whole
 * point: everything a guest can do is HTTP against one port, exactly like a
 * colleague's browser.
 */
test('invitation-based web sharing: create, sign in, tier gate, revoke', async ({ page, openWorkspace }) => {
  test.setTimeout(180_000)
  await page.evaluate(() => localStorage.setItem('locale', 'en-US'))
  // The locale is read at boot; the evaluate above must be followed by a
  // reload for it to take effect (same pin every English-asserting spec does).
  await page.reload()
  await page.waitForSelector('.side-bar', { timeout: 30_000 })
  await openWorkspace()

  // Reach the Sharing section through the palette's per-section entry.
  await page.keyboard.press('Control+k')
  await page.locator('.command-palette__input').fill('sharing')
  await page.getByRole('option', { name: 'Settings: Sharing' }).click()
  const sharing = page.locator('.settings-tab-content[data-tab="sharing"]')
  await expect(sharing).toBeVisible()

  // Enable: pick the workspace, flip the switch. Enabling with zero live
  // invitations seeds one "Link" guest (the legacy auto-token flow's shape).
  await sharing.locator('select.settings-select').first().selectOption({ index: 0 })
  await sharing.locator('.el-switch').click()
  await expect(sharing.getByText('Sharing at:')).toBeVisible({ timeout: 20_000 })
  const shareUrl = (await sharing.locator('code').first().textContent())?.trim() ?? ''
  expect(shareUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

  // Create a named VIEW-tier invitation; the full token shows exactly once.
  await sharing.locator('input.invite-name').fill('E2E Guest')
  await sharing.getByRole('button', { name: 'Create' }).click()
  const fresh = sharing.locator('.fresh-token')
  await expect(fresh).toBeVisible()
  const token = (await fresh.locator('.token-input').textContent())?.trim() ?? ''
  expect(token.length).toBeGreaterThanOrEqual(20)
  await expect(fresh).toContainText('E2E Guest')
  await fresh.getByRole('button', { name: 'Done' }).click()
  await expect(fresh).toBeHidden()
  // The stored invitation reads back REDACTED — never the full token again.
  await expect(sharing.locator('.invite-row', { hasText: 'E2E Guest' })).toBeVisible()
  await expect(sharing.locator('.invite-row', { hasText: 'E2E Guest' })).not.toContainText(token)

  // ── Guest over plain HTTP ──
  const login = await fetch(`${shareUrl}collab/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    redirect: 'manual',
  })
  expect(login.status).toBe(303)
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  expect(cookie).toContain('tdease_share_session=')

  const collab = await fetch(`${shareUrl}collab`, { headers: { cookie } })
  expect(collab.status).toBe(200)
  expect(await collab.text()).toContain('协作对话')

  // View tier: watching yes, prompting no.
  const denied = await fetch(`${shareUrl}collab/prompt`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'hello from the guest' }),
  })
  expect(denied.status).toBe(403)

  // The forged-Origin POST never reaches a handler.
  const forged = await fetch(`${shareUrl}collab/prompt`, {
    method: 'POST',
    headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'csrf' }),
  })
  expect(forged.status).toBe(403)

  // ── Revoke from the host UI (two-step) ──
  const guestRow = sharing.locator('.invite-row', { hasText: 'E2E Guest' })
  await guestRow.getByRole('button', { name: 'Revoke' }).click()
  await guestRow.getByRole('button', { name: 'Really revoke?' }).click()
  await expect(guestRow).toContainText('revoked')

  // The guest's cookie dies on their next request — hot, no server restart.
  const after = await fetch(`${shareUrl}collab`, { headers: { cookie } })
  expect(after.status).toBe(200)
  expect(await after.text()).toContain('协作对话')
  // ...but it is the LOGIN page now, not the chat: an unauthenticated guest
  // gets 200 + sign-in form on pages and 401 on the stream/prompt APIs.
  const stream = await fetch(`${shareUrl}collab/events`, { headers: { cookie } })
  expect(stream.status).toBe(401)
  const prompt = await fetch(`${shareUrl}collab/prompt`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'anyone there?' }),
  })
  expect(prompt.status).toBe(401)

  // ── The audit trail names the whole visit ──
  await expect(sharing.locator('.audit-list')).toBeVisible()
  const audit = sharing.locator('.audit-list')
  await expect(audit).toContainText('E2E Guest')
  await expect(audit).toContainText('revoked')
})

test('a forged-Origin login POST is refused outright', async ({ page, openWorkspace }) => {
  test.setTimeout(120_000)
  await page.evaluate(() => localStorage.setItem('locale', 'en-US'))
  // The locale is read at boot; the evaluate above must be followed by a
  // reload for it to take effect (same pin every English-asserting spec does).
  await page.reload()
  await page.waitForSelector('.side-bar', { timeout: 30_000 })
  await openWorkspace()
  await page.keyboard.press('Control+k')
  await page.locator('.command-palette__input').fill('sharing')
  await page.getByRole('option', { name: 'Settings: Sharing' }).click()
  const sharing = page.locator('.settings-tab-content[data-tab="sharing"]')
  await expect(sharing).toBeVisible()
  await sharing.locator('select.settings-select').first().selectOption({ index: 0 })
  await sharing.locator('.el-switch').click()
  await expect(sharing.getByText('Sharing at:')).toBeVisible({ timeout: 20_000 })
  const shareUrl = (await sharing.locator('code').first().textContent())?.trim() ?? ''

  const forged = await fetch(`${shareUrl}login`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'anything' }).toString(),
    redirect: 'manual',
  })
  expect(forged.status).toBe(403)
  // Disable again: this spec's share must not linger into other specs.
  await sharing.getByRole('button', { name: 'Turn off & revoke' }).click()
  await expect(sharing.getByText('Sharing is off')).toBeVisible()
})
