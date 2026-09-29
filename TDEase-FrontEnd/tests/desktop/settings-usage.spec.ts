import { expect, test, openAgentPage, closeAgentPage } from './desktop-app'
import type { Page } from '@playwright/test'

/**
 * Settings usage statistics + custom provider lifecycle, against the REAL
 * Electron app and the REAL settings.json write path.
 *
 * The statistics half rides a settled fixture turn (usage total 17 tokens) and
 * asserts the full-ledger aggregation IPC end to end: hero numbers, the range
 * switch, the recent-requests table, then two-step clear → empty state.
 *
 * The custom-provider half exercises the whole CRUD loop over settings.json:
 * create through the dialog (synthetic catalog entry appears), detail shows
 * the settings.json display name, two-step delete removes the entry — the
 * same "whole-key delete" IPC the product ships, not a test backdoor.
 */

/** Opens the Settings document through the side-bar rail button and waits for
 *  the section body. Settings opens on the Providers section by design. */
async function openSettings(page: Page) {
  await page.locator('.side-bar__btn[aria-label="Settings"]').click()
  await expect(page.locator('.settings-section-title')).toHaveText('Providers')
}

test('usage statistics and custom provider lifecycle', async ({ page, openWorkspace, configureProvider, provider }) => {
  test.setTimeout(240_000)
  // Pin the UI language: detectLocale() follows navigator.language, which on a
  // developer machine is not necessarily en-US — every assertion below reads
  // English UI text, so the journey must not depend on the host OS.
  await page.evaluate(() => localStorage.setItem('locale', 'en-US'))
  await configureProvider()
  // The Agent composer exists only once a Workspace is attached.
  await openWorkspace()

  // ── One settled Agent turn seeds the ledger (fixture usage: 17 tokens). ──
  await openAgentPage(page)
  const composer = page.locator('.agent-page:visible textarea:visible')
  await composer.fill('hello statistics')
  await composer.press('Enter')
  await expect(page.locator('.agent-page:visible').getByText('FIXTURE_OK', { exact: false })).toBeVisible({ timeout: 60_000 })

  // ── Statistics: full-ledger aggregates over IPC ──
  await closeAgentPage(page)
  await openSettings(page)
  await page.locator('.nav-item', { hasText: 'Statistics' }).click()
  const hero = page.locator('.stats-hero')
  await expect(hero).toBeVisible()
  await expect(hero.locator('.stats-card').first()).toContainText('17')
  // Scope line counts the attempt, not just the settled request.
  await expect(page.locator('.stats-scope').first()).toContainText('1')
  // The settled request shows in the recent table with an OK verdict.
  await expect(page.locator('.req-row', { hasText: 'e2e-model' }).first()).toBeVisible()

  // Range switch re-queries; the same data answers "All time".
  await page.locator('.stats-range', { hasText: 'All time' }).click()
  await expect(hero).toBeVisible()
  await expect(hero.locator('.stats-card').first()).toContainText('17')
  // The 5h window is a first-class tab too — the same hourly bucketing the
  // composer panel's 5h window rides.
  await page.locator('.stats-range', { hasText: '5 hours' }).click()
  await expect(hero).toBeVisible()
  await expect(hero.locator('.stats-card').first()).toContainText('17')

  // Two-step clear wipes the ledger — first click arms only.
  await page.getByRole('button', { name: 'Clear data' }).click()
  await expect(page.getByRole('button', { name: 'Really clear?' })).toBeVisible()
  await page.getByRole('button', { name: 'Really clear?' }).click()
  await expect(page.locator('.settings-tab-content[data-tab="statistics"]')).toContainText('No usage data yet')

  // ── Custom provider: create → appears → delete (two-step) → gone ──
  await page.locator('.nav-item', { hasText: 'Providers' }).click()
  await expect(page.locator('.settings-section-title')).toHaveText('Providers')
  await page.locator('.pv-list-add').click()
  const dialog = page.locator('.el-dialog', { hasText: 'Add custom provider' })
  await expect(dialog).toBeVisible()
  await dialog.locator('input').nth(0).fill('E2E Relay')
  // The pasted operation endpoint (the form a vendor's curl example hands
  // out) must be trimmed to the service root — visibly, before saving.
  await dialog.locator('input').nth(1).fill('http://127.0.0.1:9/v1/chat/completions')
  await expect(dialog.getByText('saved as http://127.0.0.1:9/v1')).toBeVisible()
  await dialog.locator('input').nth(2).fill('sk-e2e-relay')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  // The synthetic catalog entry is in the list with its badge, already
  // selected, and the detail reads the settings.json display name back.
  const row = page.locator('.pv-list-item', { hasText: 'E2E Relay' })
  await expect(row).toBeVisible()
  await expect(row.locator('.pv-custom-badge')).toHaveText('Custom')
  await expect(page.locator('.pv-detail-title')).toHaveText('E2E Relay')
  await expect(row.locator('.pv-status-dot.on')).toBeVisible()
  // The stored (normalized) Base URL is what the detail echoes.
  await expect(page.locator('.pv-cred-url-row input')).toHaveValue('http://127.0.0.1:9/v1')

  // ── Explicit connection test: typed verdicts against real endpoints ──
  // The persisted URL is a closed port: the probe fails on the wire and the
  // TYPED network verdict renders (never a raw exception string). The probe
  // reads the persisted config — nothing was saved since, so this verdict
  // belongs to the :9 URL above.
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.locator('.pv-test-verdict.fail')).toContainText('Network error', { timeout: 15_000 })

  // Retarget the saved endpoint at the fixture server (its /v1/models serves
  // two ids) and save: the same button now succeeds with the parsed count.
  await page.locator('.pv-cred-url-row input').fill(provider.baseUrl)
  await page.getByRole('button', { name: 'Save configuration' }).click()
  await expect(page.locator('.pv-cred-url-row input')).toHaveValue(provider.baseUrl)
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.locator('.pv-test-verdict.ok')).toContainText('Connection OK · 2 models', { timeout: 15_000 })

  // Two-step delete: first click arms, second removes the whole entry.
  await page.getByRole('button', { name: 'Delete provider' }).click()
  await expect(page.getByRole('button', { name: 'Really delete?' })).toBeVisible()
  await page.getByRole('button', { name: 'Really delete?' }).click()
  await expect(page.locator('.pv-list-item', { hasText: 'E2E Relay' })).toHaveCount(0)
  // Selection falls back to the active provider — which here is the fixture
  // id outside the catalog, so the honest post-state is the empty hint. What
  // matters: nothing keeps browsing the deleted id.
  await expect(page.locator('.pv-empty')).toBeVisible()

  // ── Permissions section renders real labels, never raw key paths ──
  // The decision labels once shipped missing from ALL locales (a dynamically
  // built key no audit could see), so every table cell showed
  // `workbench.settingsPermissions.decision*` raw. check:i18n now gates the
  // data; this step pins the rendered outcome.
  await page.locator('.nav-item', { hasText: 'Permissions' }).click()
  const permissionsBody = page.locator('.settings-tab-content[data-tab="permissions"]')
  await expect(permissionsBody.locator('.decision-chip', { hasText: 'Allow' }).first()).toBeVisible()
  await expect(permissionsBody.locator('.decision-chip', { hasText: 'Deny' }).first()).toBeVisible()
  await expect(permissionsBody).not.toContainText('workbench.settings')

  // ── Workspace overrides editor: the runtime's real read/write path ──
  // A workspace IS attached (openWorkspace above), so the editor is live:
  // add a deny rule for shell.exec, read the effective merge, save through
  // the gated workspace-file IPC, and prove persistence by remounting the
  // section (fresh load from .tdease/permissions.json).
  const overrides = permissionsBody.locator('[data-testid="workspace-overrides"]')
  await expect(overrides).toBeVisible()
  await expect(overrides.locator('.rules-empty')).toBeVisible()
  await overrides.getByRole('button', { name: 'Add rule' }).click()
  const ruleRow = overrides.locator('.rule-row:not(.rule-head)').first()
  await ruleRow.locator('select.rule-action').selectOption('shell.exec')
  // The deny override outranks every baseline decision (strictest wins):
  // BOTH effective columns must flip to Deny.
  await expect(ruleRow.locator('.decision-chip').first()).toHaveText('Deny')
  await expect(ruleRow.locator('.decision-chip').nth(1)).toHaveText('Deny')
  await overrides.getByRole('button', { name: 'Save' }).click()
  await expect(overrides.locator('.apply-note.saved')).toBeVisible()
  // Persistence: leave the section and come back — the editor re-reads the
  // file it just wrote.
  await page.locator('.nav-item', { hasText: 'Providers' }).click()
  await page.locator('.nav-item', { hasText: 'Permissions' }).click()
  const reloaded = page.locator('[data-testid="workspace-overrides"] .rule-row .rule-action')
  await expect(reloaded).toHaveValue('shell.exec')

  // ── General: remote token field, unified proxy, diagnostics row ──
  await page.locator('.nav-item', { hasText: 'General' }).click()
  const generalBody = page.locator('.settings-tab-content[data-tab="general"]')
  // Remote backend: the bearer-token password field appears (empty = keep
  // the persisted one — never a silent wipe). The backend select is located
  // by its remote option — the section's FIRST select is the provider picker.
  const backendSelect = generalBody.locator('.settings-select', { has: page.locator('option[value="remote"]') })
  await backendSelect.selectOption('remote')
  const tokenInput = generalBody.locator('input[type="password"]')
  await expect(tokenInput).toBeVisible()
  await expect(tokenInput).toHaveAttribute('placeholder', 'Bearer token (optional)')
  // Back to local: the write-through must not clobber anything the app needs.
  await backendSelect.selectOption('local')
  // Unified proxy: an invalid URL normalizes to OFF (empty) on its way back
  // through the real read-modify-write IPC — garbage never reaches the env.
  const proxySection = generalBody.locator('.section', { hasText: 'Network proxy' })
  await expect(proxySection).toBeVisible()
  await proxySection.locator('input').first().fill('not a url')
  await proxySection.getByRole('button', { name: 'Save' }).click()
  await expect(proxySection.locator('input').first()).toHaveValue('')
  // Diagnostics: the logs-folder entry point (openLogs IPC) is reachable.
  await expect(generalBody.getByRole('button', { name: 'Open logs folder' })).toBeVisible()

  // ── The palette reaches a Settings SECTION, not just the document ──
  // Ctrl+K → "stat" must land on "Settings: Statistics" and focus that
  // section — before the per-section entries existed, Statistics was
  // searchable-but-unreachable from the palette.
  await page.keyboard.press('Control+k')
  const paletteInput = page.locator('.command-palette__input')
  await expect(paletteInput).toBeVisible()
  // Full word, not a fragment: a subsequence scorer ranks by quality, and a
  // short 'stat' also matches unrelated command ids like runs.status. The
  // row is clicked rather than Enter-ed — the commands group precedes
  // documents in §7.4 order, so the first Enter target is not deterministic
  // from the query alone.
  await paletteInput.fill('statistics')
  await page.getByRole('option', { name: 'Settings: Statistics' }).click()
  // A closed native <dialog> keeps its children in the DOM (hidden, not
  // detached) — assert hiddenness, not node count.
  await expect(paletteInput).toBeHidden()
  // Settings is already open from the steps above — the section entry must
  // re-focus it, which is exactly the "already open" branch of the wiring.
  await expect(page.locator('.settings-tab-content[data-tab="statistics"]')).toBeVisible()
  await expect(page.locator('.stats-toolbar')).toBeVisible()
})
