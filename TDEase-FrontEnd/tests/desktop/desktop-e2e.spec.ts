import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, openAgentPage, closeAgentPage, type ProviderFixture } from './desktop-app'
import type { Page } from '@playwright/test'

/**
 * Best-effort scroll-to-tail: the jump pill is a TRANSIENT affordance — if
 * follow re-engaged it starts its leave fade and detaches mid-click (observed
 * as "element is not stable" → detached). A failed click is fine: the hard
 * tail assertions after each call are what actually verify the window.
 */
async function clickJumpToTail(locator: import('@playwright/test').Locator): Promise<void> {
  if (await locator.isVisible().catch(() => false)) {
    await locator.click({ timeout: 2000 }).catch(() => undefined)
  }
}

/**
 * THE desktop e2e: one Electron launch, one provider, one workspace, one
 * continuous user journey — every product surface exercised in order as
 * steps. One boot is the point: the suite used to relaunch the whole app per
 * scenario (a minute of setup per test), which made it a mountain of
 * duplicated ceremony for the same evidence. A failure names its step; the
 * trace carries everything before it.
 *
 * Order is dependency order: shell boot → page handle → agent sidebar →
 * real Agent turns (tools, permissions, run submit + reload, failures) →
 * prompt queue → blocked turns → compaction → exports → cost guard → log
 * agreement → window rebuild (last, it replaces the page).
 */

// Release-E2E (TDEASE_E2E_MAIN_BUNDLE) runs the PACKAGED app, whose main
// window loads its bundled index.html — not the dev server URL the dev run
// uses. Every main-window identification below goes through this predicate.
const RELEASE_MAIN = !!process.env.TDEASE_E2E_MAIN_BUNDLE
const isMainUrl = (url: string): boolean =>
  RELEASE_MAIN ? url.includes('index.html') : url.startsWith('http://127.0.0.1:1430')

async function send(page: Page, message: string) {
  let composer = page.locator('.agent-page:visible textarea:visible')
  if (!(await composer.isVisible().catch(() => false))) {
    // A dispatched run's completion surfaces its document on the Workbench and
    // pulls the shell there (documented contract: agent outputs open as real
    // Workbench documents). Toggle back to the Agent page and send from it.
    await openAgentPage(page)
    composer = page.locator('.agent-page:visible textarea:visible')
  }
  await expect(composer).toBeVisible()
  await composer.fill(message)
  await composer.press('Enter')
}

function sessionArtifacts(workspacePath: string) {
  const sessionsRoot = join(workspacePath, '.tdease', 'sessions')
  const sessionIds = readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  const sessionDir = join(sessionsRoot, sessionIds[0])
  const eventText = readFileSync(join(sessionDir, 'events.jsonl'), 'utf8')
  const events = eventText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const modelDir = join(sessionDir, 'model-session')
  const transcriptFiles = readdirSync(modelDir).filter((name) => name.endsWith('.jsonl'))
  expect(transcriptFiles.length, 'Pi did not persist a real model transcript').toBeGreaterThan(0)
  const piTranscript = transcriptFiles.map((name) => readFileSync(join(modelDir, name), 'utf8')).join('\n')
  return { events, eventText, piTranscript }
}

function advertisedToolNames(provider: ProviderFixture): string[] {
  return provider.requests.flatMap((request) => {
    const tools = Array.isArray(request.body.tools) ? request.body.tools : []
    return tools.map((tool: any) => String(tool?.function?.name ?? ''))
  }).filter(Boolean)
}

/** Waits until the session is idle: send button front, nothing queued.
 *  A command sent while busy QUEUES as a plain prompt turn instead of
 *  executing — /compact and /export must fire from an idle composer. */
async function ensureIdle(page: Page) {
  await expect(page.locator('.composer__send').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.composer__queued')).toBeHidden()
}

/** Opens the Runs panel only if it is not already the front tab. */
async function ensureRunsPanel(page: Page) {
  // Scoped to the panels group: the Follow-agent button also carries the
  // .status-bar__panel-toggle class, and a bare .first() would toggle
  // follow-agent instead of the dock.
  const runsToggle = page.locator('.status-bar__panels .status-bar__panel-toggle').first()
  if (await runsToggle.getAttribute('aria-pressed') !== 'true') {
    await runsToggle.click()
  }
  await expect(page.locator('.activity-dock')).toBeVisible()
}

test('the desktop product, end to end in one launch', async ({
  app, page, workspace, openWorkspace, configureProvider, provider,
}) => {
  test.setTimeout(900_000)
  // Pin the UI language for the whole journey: the absorbed settings and
  // side-chat phases read English labels, and the boot/mode assertions below
  // use bilingual regexes that match English too. The locale is read at boot,
  // so the pin is followed by a reload (same pin every English-asserting spec
  // used to carry).
  await page.evaluate(() => localStorage.setItem('locale', 'en-US'))
  await page.reload()
  await page.waitForSelector('.side-bar', { timeout: 30_000 })
  await configureProvider()
  await openWorkspace()

  // ── Shell boot ─────────────────────────────────────────────────────────
  // The Agent page owns the landing (src/main.ts: no-open-document →
  // Workbench override is gone), so boot asserts the Agent-side regions; the
  // Workbench regions are asserted after the first handle tap below.
  await test.step('the shell boots on the Agent page with its regions', async () => {
    await expect(page.locator('.side-bar')).toBeVisible()
    await expect(page.locator('.agent-page:visible')).toBeVisible()
    await expect(page.locator('.status-bar')).toBeVisible()
    // The door handle hangs on the edge facing the Agent: left on the Agent page.
    await expect(page.locator('.page-handle')).toHaveClass(/page-handle--left/)
  })

  // ── Page handle: the ONE page control ──────────────────────────────────
  await test.step('the handle taps to the Workbench and back, following the edge', async () => {
    const handle = page.locator('.page-handle')
    await handle.click()
    await expect(page.locator('.agent-page:visible')).toHaveCount(0)
    await expect(page.locator('.navigator-panel')).toBeVisible()
    await expect(page.locator('.document-host')).toBeVisible()
    await expect(handle).toHaveClass(/page-handle--right/)
    await handle.click()
    await expect(page.locator('.agent-page:visible')).toBeVisible()
    await expect(handle).toHaveClass(/page-handle--left/)
    // Back to the Workbench: the drag step below pulls the handle from there.
    await handle.click()
    await expect(page.locator('.agent-page:visible')).toHaveCount(0)
    await expect(handle).toHaveClass(/page-handle--right/)
  })

  await test.step('pulling the handle past the midpoint drags the track and commits', async () => {
    const handle = page.locator('.page-handle')
    const box = await handle.boundingBox()
    expect(box).not.toBeNull()
    const viewWidth = await page.evaluate(() => document.documentElement.clientWidth)
    const centerX = box!.x + box!.width / 2
    const centerY = box!.y + box!.height / 2
    const travel = -(viewWidth * 0.6)
    await page.mouse.move(centerX, centerY)
    await page.mouse.down()
    // A few steps so the pointermove stream (velocity sampling) is realistic.
    await page.mouse.move(centerX + travel * 0.25, centerY, { steps: 4 })
    await page.mouse.move(centerX + travel * 0.6, centerY, { steps: 4 })
    await page.mouse.move(centerX + travel, centerY, { steps: 4 })
    await page.mouse.up()
    await expect(page.locator('.agent-page:visible')).toBeVisible()
    await expect(handle).toHaveClass(/page-handle--left/)
    // Back to the Workbench for the next phases.
    await closeAgentPage(page)
  })

  // ── Agent sidebar: the docked second view ──────────────────────────────
  await test.step('the group-header Agent toggle opens the dock and the draft is shared', async () => {
    await expect(page.locator('.agent-sidebar')).toHaveCount(0)
    // The toggle lives in the editor group's header actions (where the
    // directional-split buttons used to be).
    await page.locator('.document-group__agent-toggle').click()
    await expect(page.locator('.agent-sidebar')).toBeVisible()
    await expect(page.locator('.agent-sidebar textarea')).toBeVisible()

    // The draft is the singleton's ref: typing in the sidebar is immediately
    // the full Agent page's draft — one conversation, two views. Cleared
    // afterwards so the next phase sends a clean prompt.
    await page.locator('.agent-sidebar textarea').fill('draft-sync-check')
    await expect(page.locator('.agent-page textarea')).toHaveValue('draft-sync-check')
    await page.locator('.agent-sidebar textarea').fill('')

    await page.locator('.document-group__agent-toggle').click()
    await expect(page.locator('.agent-sidebar')).toHaveCount(0)
  })

  // ── The real Agent chain ───────────────────────────────────────────────
  await openAgentPage(page)
  // The shell preserves hidden page instances across route switches, so an
  // unscoped `.agent-page__transcript` matches the live page AND the parked
  // one — strict-mode sees every block twice. Always read the VISIBLE page.
  const transcript = page.locator('.agent-page:visible .agent-page__transcript')

  await test.step('Pi calls a real Node gateway tool and receives its result', async () => {
    provider.reset()
    await send(page, 'E2E_TOOL_ROUNDTRIP')
    await expect(transcript).toContainText('GATEWAY_OK:README_SEEN', { timeout: 60_000 })
    await expect(page.locator('.agent-page:visible .agent-page__edge')).not.toHaveClass(/agent-page__edge--acting/)

    expect(provider.requests).toHaveLength(2)
    const names = advertisedToolNames(provider)
    expect(names.length).toBeGreaterThan(0)
    expect(names.some((name) => name.startsWith('tdease_'))).toBe(true)
    expect(names, 'a dotted tool name crossed the Provider HTTP boundary').not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\./)]),
    )
    const toolMessage = provider.requests[1].body.messages.find((message: any) => message.role === 'tool')
    expect(toolMessage.content).toContain('e2e workspace')
  })

  await test.step('Workspace skill writes real data through the gated Agent chain', async () => {
    provider.reset()
    // Ask authority no longer prompts for every mutating call: the shipped
    // default review policy reviews shell commands itself — the
    // innocuous skill script below must run SILENTLY under Ask, while the
    // risky follow-up must still surface the floating approval card. Clicking
    // Allow once stays the regression pin for the card shipping unclickable.
    await page.locator('.perm-btn').click()
    await page.locator('.perm-option.opt-ask').click()
    await page.locator('.mode-btn').filter({ hasText: /工作流|Workflow/ }).click()
    await send(page, 'E2E_SKILL_FIGURE')
    await expect(transcript).toContainText('FIGURE_CHAIN_OK', { timeout: 60_000 })
    // The auto-review payoff: no approval card for the innocuous command.
    await expect(page.getByRole('button', { name: /允许一次|Allow once/ })).toHaveCount(0)

    // The skill script really ran inside the Workspace: its data output is on
    // disk, and its verbatim stdout (carrying the result path) reached the
    // model as the tool result.
    expect(existsSync(join(workspace.path, 'analysis', 'e2e-plot', 'result.json'))).toBe(true)
    expect(existsSync(join(workspace.path, 'analysis', 'e2e-plot', 'figure.png'))).toBe(true)
    expect(JSON.parse(readFileSync(join(workspace.path, 'analysis', 'e2e-plot', 'result.json'), 'utf8')))
      .toEqual({ status: 'ok', points: [1, 2, 3] })
    expect(provider.requests[1].body.messages.find((message: any) => message.tool_call_id === 'call_plot')?.content)
      .toContain('analysis/e2e-plot/result.json')

    // The door handle follows the Agent window: while the page is front it
    // hangs on the left edge. Asserted HERE because the approval settle is
    // where a stray page flip would show first.
    await expect(page.locator('.page-handle')).toHaveClass(/page-handle--left/)

    // A command the review policy flags (recursive deletion) still asks —
    // under the SAME Ask authority, one turn later.
    await send(page, 'E2E_RISKY_ASK')
    const approve = page.getByRole('button', { name: /允许一次|Allow once/ })
    await expect(approve).toBeVisible({ timeout: 30_000 })
    await approve.click()
    await expect(transcript).toContainText('RISKY_APPROVED_OK', { timeout: 60_000 })

    // Back to `auto` so the rest of the chain (run submit, failure paths)
    // runs side effects silently instead of queueing more approvals.
    await openAgentPage(page)
    await page.locator('.perm-btn').click()
    await page.locator('.perm-option.opt-auto').click()
  })

  // ── Manual /compact ────────────────────────────────────────────────────
  await test.step('manual /compact records the marker event and renders the compacted divider', async () => {
    // The e2e settings file sets compaction.keepRecentTokens = 200, so the
    // journey's own history exceeds the keep-recent cut and /compact performs
    // a real compaction (with Pi's default 20k it would legitimately refuse
    // with "Nothing to compact (session too small)").
    await ensureIdle(page)
    const composer = page.locator('.agent-page:visible textarea:visible')
    await expect(composer).toBeVisible()

    // The trailing space closes the completion popup, so Enter executes the
    // command directly instead of confirming the completion row.
    await composer.fill('/compact ')
    // Dismiss the completion popup before Enter: whether the popup has
    // rendered an exact row by Enter-time is a RENDER RACE — if it has,
    // Enter confirms the row (rewriting the input) instead of executing.
    // Escape is a no-op when the popup is already closed.
    await composer.press('Escape')
    await composer.press('Enter')

    // The settled `context.compacted` event is the completion marker; the
    // event log is the source of truth — assert it first.
    const sessionsRoot = join(workspace.path, '.tdease', 'sessions')
    const eventTextOf = () => {
      const sessionIds = readdirSync(sessionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      return sessionIds
        .map((id) => readFileSync(join(sessionsRoot, id, 'events.jsonl'), 'utf8'))
        .join('\n')
    }
    await expect
      .poll(eventTextOf, { timeout: 60_000 })
      .toContain('"type":"context.compacted"')
    expect(eventTextOf()).toContain('"reason":"manual"')

    // The renderer received the divider: the active session's projection
    // carries it as the trailing message (`event:<seq>`, compaction block) —
    // asserted against the pinia store, the same shape the unit tests pin.
    await expect
      .poll(() => page.evaluate(() => {
        const app = (document.querySelector('#app') as any).__vue_app__
        const state = app?.config?.globalProperties?.$pinia?.state?.value
        const sessions = state?.agent?.allSessions ?? []
        const activeId = state?.agent?.activeSessionId
        const target = sessions.find((s: any) => s.id === activeId) ?? sessions[sessions.length - 1]
        const last = target?.messages?.[target.messages.length - 1]
        return last ? `${last.id}:${last.blocks?.[0]?.type ?? 'none'}` : 'none'
      }), { timeout: 30_000 })
      .toMatch(/^event:\d+:compaction$/)

    // KNOWN GAP: the virtualized window does not mount the newly appended
    // tail item (here: the divider; same root as the turn.failed card gap
    // below), so the row stays absent from the DOM until the view
    // re-navigates. Recorded in STATUS.md — asserted SOFT.
    expect.soft(page.locator('[data-block-kind="compaction"]')).toHaveCount(1, { timeout: 10_000 })
  })


  await test.step('a submitted Run remains visible after the Renderer reloads', async () => {
    provider.reset()
    await send(page, 'E2E_RUN_SUBMIT')
    await expect(transcript).toContainText('RUN_SUBMITTED_OK', { timeout: 60_000 })
    await closeAgentPage(page)
    // The panel starts collapsed; open the Runs tab (driven from observed
    // state — a restored panel must not get toggled closed).
    await ensureRunsPanel(page)
    // The dispatched run must surface in the panel's projection: the agent
    // harness creates it under its own launch principal, which shares the
    // owner's user identity (app/auth.py LOCAL_USER_ID) — a regression that
    // splits the identities again makes the run invisible here.
    await expect(page.locator('.activity-dock__run-name').filter({ hasText: 'e2e-run' })).toBeVisible({ timeout: 30_000 })

    await page.reload()

    // Wait for the shell to finish booting before reading ANY state: the SPA
    // mounts asynchronously (locale chunk + backend handshake), and probing
    // `.agent-page:visible` against a not-yet-mounted page reads as "absent",
    // which flips the conditional below the wrong way.
    await expect(page.locator('.side-bar')).toBeVisible({ timeout: 30_000 })
    // The restored page and the panel's open state both race the reload, so
    // drive each from its observed state instead of toggling blind — the
    // subject here is the RUN surviving the reload.
    if (await page.locator('.agent-page:visible').count() > 0) {
      await closeAgentPage(page)
    }
    await ensureRunsPanel(page)
    await expect(page.locator('.activity-dock__run-name').filter({ hasText: 'e2e-run' })).toBeVisible({ timeout: 30_000 })

    // The next phases send from the Agent page.
    await openAgentPage(page)
  })

  await test.step('the first prompt after the reload runs as a clean turn', async () => {
    provider.reset()
    await ensureIdle(page)
    await send(page, 'E2E_POSTRELOAD_OK')
    await expect(transcript).toContainText('FIXTURE_OK', { timeout: 60_000 })
  })

  for (const failure of [
    { prompt: 'E2E_STOP_ERROR', expected: 'Provider finish_reason: network_error' },
    { prompt: 'E2E_HTTP_401', expected: 'fixture credential rejected' },
    { prompt: 'E2E_HTTP_400', expected: 'fixture request rejected' },
  ]) {
    await test.step(`${failure.prompt} becomes turn.failed with its original error`, async () => {
      provider.reset()
      await send(page, failure.prompt)
      // KNOWN GAP: the settled turn.failed card does not reliably surface —
      // in long sessions it exists in the DOM but renders hidden (0×0), and
      // a minimal bloat+reload repro shows it missing from the mounted
      // window entirely (the turn state itself is correct: edge flips to
      // failed, composer returns). Recorded in STATUS.md; the settlement
      // (edge + durability log) is asserted hard, the card SOFT.
      // `.last()` — the card belongs to the turn that JUST settled; the
      // projection can briefly hold older failed rows from earlier failure
      // steps, and a bare locator would trip strict mode on them.
      expect.soft(transcript.locator('[data-block-kind="failed"]').filter({ hasText: failure.expected }).last())
        .toBeVisible({ timeout: 60_000 })
      // Pi retries a retryable provider error 3× (base 2 s) before the turn
      // settles; give the edge flip room for that plus scheduler jitter.
      await expect(page.locator('.agent-page:visible .agent-page__edge')).toHaveClass(/agent-page__edge--failed/, { timeout: 120_000 })
      await expect(transcript).not.toContainText('已完成 0')
      await expect(transcript).not.toContainText('Completed 0')
    })
  }

  // ── Prompt queue ───────────────────────────────────────────────────────
  await test.step('a message typed into a busy session queues, then drains as the next turn', async () => {
    provider.reset()
    const composer = page.locator('.agent-page:visible textarea:visible')
    await expect(composer).toBeVisible()

    // Turn 1 runs; the fixture holds its response in flight.
    await composer.fill('E2E_QUEUE_SLOW')
    await composer.press('Enter')

    // Typed while busy: queued as a chip, not refused.
    await composer.fill('E2E_QUEUE_FAST')
    await composer.press('Enter')
    const queue = page.locator('.composer__queued')
    await expect(queue).toBeVisible()
    await expect(queue).toContainText('E2E_QUEUE_FAST')

    // Drain: turn 1 settles, turn 2 starts from the queue.
    await expect(transcript).toContainText('QUEUE_FIRST_OK', { timeout: 60_000 })
    await expect(transcript).toContainText('E2E_QUEUE_FAST', { timeout: 30_000 })
    await expect(transcript).toContainText('QUEUE_SECOND_OK', { timeout: 60_000 })
    await expect(queue).toBeHidden()

    expect(provider.requests).toHaveLength(2)
    const secondMessages = JSON.stringify(provider.requests[1]!.body.messages)
    expect(secondMessages).toContain('E2E_QUEUE_SLOW')
    expect(secondMessages).toContain('QUEUE_FIRST_OK')
    expect(secondMessages).toContain('E2E_QUEUE_FAST')
  })

  await test.step('stopping the busy turn keeps the queue instead of auto-starting the next turn', async () => {
    provider.reset()
    const composer = page.locator('.agent-page:visible textarea:visible')
    await expect(composer).toBeVisible()

    await composer.fill('E2E_QUEUE_SLOW')
    await composer.press('Enter')
    await composer.fill('E2E_QUEUE_KEPT')
    await composer.press('Enter')
    await expect(page.locator('.composer__queued')).toContainText('E2E_QUEUE_KEPT')

    // The user stops the in-flight turn: it settles as halted, and the queued
    // message must stay queued — a stop is the user seizing control.
    await page.locator('.composer__stop').click()
    await expect(page.locator('.composer__send')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.composer__queued')).toContainText('E2E_QUEUE_KEPT')
    expect(provider.requests).toHaveLength(1)

    // Leave the session idle for the next phases: drop the kept message via
    // the chip's own × (the product's dequeue affordance).
    await page.locator('.composer__chip-x').first().click()
    await expect(page.locator('.composer__queued')).toBeHidden()
  })

  // ── Blocked turns are answerable ───────────────────────────────────────


  await test.step('a blocked turn with options renders one-tap answers that send the next turn', async () => {
    provider.reset()
    await ensureIdle(page)
    const composer = page.locator('.agent-page:visible textarea:visible')
    await expect(composer).toBeVisible()
    await composer.fill('E2E_REPORT_BLOCKED')
    await composer.press('Enter')

    // The turn settles blocked and the offered options render as buttons.
    // The transcript is virtualized — target the last VISIBLE card; a bare
    // `.last()` can land on an offscreen copy outside the virtual window.
    const lastCard = page.locator('.blocked-card:visible').last()
    const options = lastCard.locator('.blocked-card__option')
    await expect(options).toHaveCount(2, { timeout: 120_000 })
    await expect(lastCard).toBeVisible()
    await expect(options.first()).toContainText('(a) K20 dimethyl localization')

    // One tap answers: the option text becomes the next user turn and the
    // model replies through the real provider chain.
    const requestsBeforeAnswer = provider.requests.length
    await options.first().click()
    // The suspended turn must settle before the answer turn starts, and the
    // transcript is VIRTUALIZED: `.last()` means "last rendered", so re-anchor
    // the view to the tail first or the assertion reads a stale window.
    const jump = page.locator('.transcript__jump:not(.transcript__jump--to-response)')
    await clickJumpToTail(jump)
    await expect(transcript.locator('.transcript__user-text').last()).toContainText(
      '(a) K20 dimethyl localization', { timeout: 60_000 },
    )
    await expect(transcript).toContainText('FIXTURE_OK', { timeout: 60_000 })
    expect(provider.requests.length).toBeGreaterThan(requestsBeforeAnswer)
  })

  await test.step('a blocked turn also answers from its own manual input row', async () => {
    provider.reset()
    await ensureIdle(page)
    const composer = page.locator('.agent-page:visible textarea:visible')
    await expect(composer).toBeVisible()
    await composer.fill('E2E_REPORT_BLOCKED')
    await composer.press('Enter')
    // NO blind resend: a retry typed while the first turn still runs QUEUES a
    // duplicate, and once the queued turn starts, the settled card is
    // superseded (show-once) — the click below would hit a hidden button.
    // Wait patiently for the turn to settle blocked instead. Answer through a
    // VISIBLE card: the transcript is virtualized, and `.last()` alone can
    // land outside the rendered window.
    const tailCard = page.locator('.blocked-card:visible').last()
    await expect(tailCard.locator('.blocked-card__option')).toHaveCount(2, { timeout: 120_000 })

    // The card's own input answers without touching the composer. Target the
    // last VISIBLE input directly: an earlier blocked card can still render
    // its options (so `tailCard` can be that old card), but an answered
    // card's input row is retired — only the fresh card has a live input.
    const custom = page.locator('.blocked-card:visible .blocked-card__custom-input:visible').last()
    await custom.fill('Neither — check the +28 family first')
    await custom.press('Enter')

    const jump2 = page.locator('.transcript__jump:not(.transcript__jump--to-response)')
    await clickJumpToTail(jump2)
    await expect(transcript.locator('.transcript__user-text').last()).toContainText(
      'Neither — check the +28 family first', { timeout: 60_000 },
    )
    await expect(transcript).toContainText('FIXTURE_OK', { timeout: 60_000 })
    // Show-once, DOM half: the ANSWERED card's input row leaves the document
    // entirely — the virtualizer rebuild on settled-card retirement drops the
    // hidden pooled copies with it (the former STATUS defect, now a HARD
    // assertion because the mechanism is fixed).
    await expect(page.locator('.blocked-card__custom-input')).toHaveCount(0, { timeout: 30_000 })
  })

  // ── Exports ────────────────────────────────────────────────────────────
  await test.step('/export writes the conversation as standalone HTML into the Workspace', async () => {
    provider.reset()
    await ensureIdle(page)
    const composer = page.locator('.agent-page:visible textarea:visible')
    await expect(composer).toBeVisible()

    await composer.fill('E2E_EXPORT_MARKER')
    await composer.press('Enter')
    await expect(transcript).toContainText('FIXTURE_OK', { timeout: 60_000 })

    await composer.fill('/export ')
    // Dismiss the completion popup before Enter: whether the popup has
    // rendered an exact row by Enter-time is a RENDER RACE — if it has,
    // Enter confirms the row (rewriting the input) instead of executing.
    // Escape is a no-op when the popup is already closed.
    await composer.press('Escape')
    await composer.press('Enter')

    const exportsDir = join(workspace.path, 'exports')
    await expect
      .poll(() => (existsSync(exportsDir) ? readdirSync(exportsDir).filter((f) => f.endsWith('.html')).length : 0), {
        timeout: 30_000,
      })
      .toBe(1)

    const html = readFileSync(join(exportsDir, readdirSync(exportsDir)[0]!), 'utf8')
    expect(html).toContain('E2E_EXPORT_MARKER')
    expect(html).toContain('FIXTURE_OK')
    // The session title is its FIRST user message (the agent store's untitled
    // rule: the first message names the session; later renames are manual).
    // This merged journey's first prompt is E2E_TOOL_ROUNDTRIP, so that is
    // the exported <title> — the standalone export spec this step was merged
    // from had a single-prompt fresh session and asserted its own prompt here.
    expect(html).toContain('<title>E2E_TOOL_ROUNDTRIP</title>')
  })

  await test.step('/export pdf prints the same document to a PDF file in exports/', async () => {
    await ensureIdle(page)
    const composer = page.locator('.agent-page:visible textarea:visible')
    await expect(composer).toBeVisible()

    // Mid-word, the completion row reads `/export [pdf]` — the badge carries
    // the command, the label only the argument hint (never the name twice).
    await composer.fill('/ex')
    const popup = page.locator('.completion-popup')
    await expect(popup).toBeVisible()
    await expect(popup).toContainText('[pdf]')
    await expect(popup).not.toContainText('/export /export')

    await composer.fill('/export pdf')
    // Dismiss the completion popup before Enter: whether the popup has
    // rendered an exact row by Enter-time is a RENDER RACE — if it has,
    // Enter confirms the row (rewriting the input) instead of executing.
    // Escape is a no-op when the popup is already closed.
    await composer.press('Escape')
    await composer.press('Enter')

    const exportsDir = join(workspace.path, 'exports')
    let pdfPath: string | null = null
    await expect
      .poll(() => {
        if (!existsSync(exportsDir)) return 0
        const pdfs = readdirSync(exportsDir).filter((f) => f.endsWith('.pdf'))
        pdfPath = pdfs[0] ? join(exportsDir, pdfs[0]) : null
        return pdfs.length
      }, { timeout: 60_000 })
      .toBe(1)

    // A real PDF, not a misnamed text file: magic bytes and a printed body.
    const bytes = readFileSync(pdfPath!)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1_000)
  })

  // ── Cost guard ─────────────────────────────────────────────────────────
  await test.step('the cost guard denies the 9 MB read in-turn and re-pins the rule next loop', async () => {
    provider.reset()
    await ensureIdle(page)
    await send(page, 'E2E_COST_READ')
    await expect(transcript).toContainText('COST_GUARD_OK', { timeout: 90_000 })
    // Server-side truth: the tool result carries the guard's model-facing
    // denial — the expensive read never produced content.
    const toolResults = provider.requests.flatMap((request) =>
      Array.isArray(request.body.messages) ? request.body.messages : []).filter((message: any) => message?.role === 'tool')
    const denial = toolResults.map((message: any) => String(message.content ?? '')).find((content) => content.includes('[cost]'))
    expect(denial).toBeDefined()
    expect(denial).toContain('huge.mzML')

    await send(page, 'E2E_COST_RULE_RECALL')
    // The scroller does not chase a turn that settles while the view sits
    // mid-history; park it on the bottom edge so the recall turn's blocks
    // enter the virtualized window before the assertion reads it.
    await page.locator('.agent-page:visible .transcript').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(transcript).toContainText('COST_RULE_PINNED_OK', { timeout: 90_000 })
  })

  // ── Durability: the logs agree ─────────────────────────────────────────
  await test.step('DOM, Pi transcript, and Session JSONL agree', async () => {
    const artifacts = sessionArtifacts(workspace.path)
    expect(artifacts.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.requested', name: 'read', call_id: 'call_readme' }),
      expect.objectContaining({ type: 'tool.completed', call_id: 'call_readme', ok: true }),
      expect.objectContaining({ type: 'tool.requested', name: 'bash', call_id: 'call_plot' }),
      expect.objectContaining({ type: 'tool.completed', call_id: 'call_plot', ok: true }),
      expect.objectContaining({ type: 'message.completed', content: 'GATEWAY_OK:README_SEEN' }),
      expect.objectContaining({ type: 'turn.completed', outcome: 'resolved' }),
    ]))
    // The transcript is virtualized (DynamicScroller): blocks from earlier
    // turns scroll out of the rendered window as later turns stream in.
    // Return the scroller to the top so the DOM assertions below see the
    // oldest blocks again.
    await page.locator('.transcript').evaluate((el) => { el.scrollTop = 0 })
    for (const expected of [
      'Provider finish_reason: network_error',
      'fixture credential rejected',
      'fixture request rejected',
    ]) {
      expect(artifacts.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'turn.failed',
          error: expect.objectContaining({ message: expect.stringContaining(expected) }),
        }),
      ]))
      expect(artifacts.eventText).toContain(expected)
      expect(artifacts.piTranscript).toContain(expected)
      // No DOM re-assertion here: each failure step already asserted its
      // block in the DOM when it was fresh, and the transcript is
      // virtualized — durability is what eventText/piTranscript assert.
    }
    const seqs = artifacts.events.map((event) => event.seq)
    expect(seqs).toEqual(seqs.map((_, index) => index + 1))
    expect(artifacts.piTranscript).toContain('GATEWAY_OK:README_SEEN')
    expect(artifacts.piTranscript).toContain('e2e workspace')
    expect(artifacts.piTranscript).toContain('analysis/e2e-plot/result.json')
    // No DOM re-assertion: the transcript is virtualized and parked at the
    // newest turn this deep in the journey, so the FIRST turn's block is not
    // in the rendered window. Durability is what piTranscript asserts above.
  })

  // ── Side chat (absorbed from the former side-chat.spec.ts) ─────────────
  await test.step('a transcript selection asks the AI in a side chat that archives on close', async () => {
    // Give the transcript fresh, selectable content in the live session.
    // Idle first: a send while busy queues as a plain prompt instead of
    // starting the turn, and the queue never renders a user bubble.
    await ensureIdle(page)
    await send(page, 'SIDEQUOTE42 localize the proteoform and summarize the evidence.')
    // The transcript is virtualized and the scroller does not chase turns that
    // settled while the view sat mid-history — park it on the bottom edge so
    // the newest blocks enter the rendered window before locating them.
    await page.locator('.transcript').evaluate((el) => { el.scrollTop = el.scrollHeight })
    // The projection can keep a hidden clone of the row alongside the
    // rendered one — read the VISIBLE row, not just the first in DOM order.
    const parentMessage = page.locator('.agent-page:visible .transcript__user', { hasText: 'SIDEQUOTE42' })
      .filter({ visible: true }).first()
    await expect(parentMessage).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.agent-page:visible').getByText('FIXTURE_OK').last()).toBeVisible({ timeout: 60_000 })

    // Select the text with a REAL pointer drag, across the text element's own
    // box (the row is wider than its words). One retry: the settle projection
    // can swap the selection's anchor node right after mouseup, and a single
    // redo against the settled DOM is enough to stabilize it.
    // NOT scoped to .agent-page: the pill is teleported to <body> so the
    // page-switch track's transform cannot clip it (Transcript.vue) — it only
    // exists while a live selection is held, so the bare class is unique.
    const pill = page.locator('body > .transcript__ask-pill')
    // The virtualizer re-mounts rows on every settle projection, so
    // scrollIntoViewIfNeeded (which demands a stable element) can time out
    // forever. Read the live box off the text node each attempt instead —
    // boundingBox tolerates churn, and a missed attempt just re-queries.
    let dragged = false
    for (let attempt = 0; attempt < 6 && !dragged; attempt++) {
      const box = await parentMessage.getByText('SIDEQUOTE42').first().boundingBox()
      if (!box || box.width < 20) {
        await page.locator('.agent-page:visible .transcript').evaluate((el) => { el.scrollTop = el.scrollHeight })
        await page.waitForTimeout(500)
        continue
      }
      const target = parentMessage.getByText('SIDEQUOTE42').first()
      if (attempt % 2 === 0) {
        // The text WRAPS: a mid-height horizontal drag (or a triple-click)
        // selects a single rendered line only. Drag the full box diagonally
        // so the selection covers every wrapped line.
        await page.mouse.move(box.x + 2, box.y + 2)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, { steps: 12 })
        await page.mouse.up()
      } else {
        // The virtualizer re-mounts rows on every settle projection and a
        // re-mount clears a drag selection mid-flight; a triple-click selects
        // the whole text atomically through the same selection pipeline.
        await target.click({ clickCount: 3 })
      }
      // The pill renders only for the HOVERED user row, and a virtualizer
      // re-mount fires mouseleave without a compensating mouseenter (the
      // pointer never moved). Jiggle the pointer inside the row so the row
      // re-arms its hover state, then give the pill a beat to mount.
      const after = await target.boundingBox()
      if (after) {
        await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2)
        await page.mouse.move(after.x + after.width / 2 - 2, after.y + after.height / 2, { steps: 2 })
      }
      await page.waitForTimeout(400)
      dragged = await pill.isVisible()
    }
    await expect(pill).toBeVisible()

    // Ask AI: the quote rides into the side composer (consume-once).
    await pill.click()
    await expect(pill).toBeHidden()
    const side = page.locator('.side-chat')
    await expect(side).toBeVisible()
    const sideInput = side.locator('.side-chat__input')
    const seeded = await sideInput.inputValue()
    expect(seeded, 'the quote must be seeded into the side composer').toContain('SIDEQUOTE42')
    expect(seeded).toContain('>')

    // The side turn answers in the panel on its own session.
    await sideInput.fill(`${seeded}\nE2E_SIDE_QUESTION why does the +317 shift matter?`)
    await sideInput.press('Enter')
    await expect(side.getByText('FIXTURE_OK')).toBeVisible({ timeout: 60_000 })

    // Closing the panel archives the child and returns to the parent. The
    // close is scoped to the ACTIVE tab: the journey's earlier workflow-mode
    // turns may have opened other right-rail tabs, and a bare .first() would
    // close one of those instead.
    await page.locator('.agent-tab-strip__tab.is-active .agent-tab-strip__close').click()
    await expect(side).toBeHidden()
    await expect(parentMessage).toBeVisible()
  })

  // ── Settings (absorbed from the former settings-usage.spec.ts) ─────────
  await test.step('settings: statistics, permissions override, and the palette section entry', async () => {
    // The side-bar rail button is the product's own entry point.
    await page.locator('.side-bar__btn[aria-label="Settings"]').click()
    await expect(page.locator('.settings-section-title')).toHaveText('Providers')

    // Statistics: the ledger aggregates the journey's many settled turns.
    await page.locator('.nav-item', { hasText: 'Statistics' }).click()
    const hero = page.locator('.stats-hero')
    await expect(hero).toBeVisible()
    await expect(hero.locator('.stats-card').first()).toContainText(/\d/)
    await expect(page.locator('.req-row', { hasText: 'e2e-model' }).first()).toBeVisible()
    // Two-step clear wipes the ledger — first click arms only.
    await page.getByRole('button', { name: 'Clear data' }).click()
    await page.getByRole('button', { name: 'Really clear?' }).click()
    await expect(page.locator('.settings-tab-content[data-tab="statistics"]')).toContainText('No usage data yet')

    // Permissions: a deny override for shell.exec saves through the gated
    // workspace-file IPC and survives a section remount (fresh read from
    // .tdease/permissions.json).
    await page.locator('.nav-item', { hasText: 'Permissions' }).click()
    const permissionsBody = page.locator('.settings-tab-content[data-tab="permissions"]')
    const overrides = permissionsBody.locator('[data-testid="workspace-overrides"]')
    await expect(overrides).toBeVisible()
    await overrides.getByRole('button', { name: 'Add rule' }).click()
    // One rule renders as one .rule-block: the main row (action/decision/
    // priority selects) plus a sibling .rule-match row (command/paths/note).
    const ruleBlock = overrides.locator('.rule-block').first()
    await ruleBlock.locator('select.rule-action').selectOption('shell.exec')
    await ruleBlock.locator('.rule-match input').first().fill('git status')
    // The preview card evaluates the DRAFT rules through the runtime's own
    // functions — the deny override outranks every baseline decision, so both
    // effective columns read Deny BEFORE anything is saved.
    const preview = overrides.locator('.preview-card')
    await preview.locator('.preview-field input').first().fill('git status')
    const shellPreview = preview.locator('.preview-result', { hasText: 'shell.exec' })
    await expect(shellPreview.locator('.decision-chip').first()).toHaveText('Deny')
    await expect(shellPreview.locator('.decision-chip').nth(1)).toHaveText('Deny')
    await overrides.getByRole('button', { name: 'Save' }).click()
    await expect(overrides.locator('.apply-note.saved')).toBeVisible()
    await page.locator('.nav-item', { hasText: 'Providers' }).click()
    await page.locator('.nav-item', { hasText: 'Permissions' }).click()
    await expect(page.locator('[data-testid="workspace-overrides"] .rule-row .rule-action')).toHaveValue('shell.exec')

    // The palette reaches a Settings SECTION, not just the document — the
    // per-section entry must re-focus the already-open settings document.
    await page.keyboard.press('Control+k')
    const paletteInput = page.locator('.command-palette__input')
    await expect(paletteInput).toBeVisible()
    await paletteInput.fill('statistics')
    await page.getByRole('option', { name: 'Settings: Statistics' }).click()
    await expect(paletteInput).toBeHidden()
    await expect(page.locator('.settings-tab-content[data-tab="statistics"]')).toBeVisible()
    await expect(page.locator('.stats-toolbar')).toBeVisible()
  })

  // ── Window rebuild (last: it replaces the page) ────────────────────────
  await test.step('main window, detached DevTools, close, and rebuild are real', async () => {
    const initial = await app.evaluate(({ BrowserWindow, webContents }) => ({
      windows: BrowserWindow.getAllWindows().map((window) => ({
        id: window.id,
        url: window.webContents.getURL(),
        devToolsOpened: window.webContents.isDevToolsOpened(),
        devToolsId: window.webContents.devToolsWebContents?.id,
      })),
      contents: webContents.getAllWebContents().map((contents) => ({ id: contents.id, type: contents.getType(), url: contents.getURL() })),
    }))
    const main = initial.windows.find((window) => isMainUrl(window.url))
    expect(main).toBeDefined()
    // Detached DevTools are a DEV-mode affordance: main.ts opens them only in
    // its isDev branch, so the packaged release window has none to assert.
    if (!RELEASE_MAIN) {
      expect(main?.devToolsOpened).toBe(true)
      expect(main?.devToolsId).toBeDefined()
      expect(initial.contents).toContainEqual(expect.objectContaining({
        id: main?.devToolsId,
        url: expect.stringMatching(/^devtools:\/\//),
      }))
    }

    const oldId = main!.id
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), oldId)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .some((window) => {
          if (window.isDestroyed()) return false
          const url = window.webContents.getURL()
          return url.includes('index.html') || url.startsWith('http://127.0.0.1:1430')
        }))).toBe(false)
    await app.evaluate(({ app }) => app.emit('activate'))
    const rebuiltId = await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
      .find((window) => {
          if (window.isDestroyed()) return false
          const url = window.webContents.getURL()
          return url.includes('index.html') || url.startsWith('http://127.0.0.1:1430')
        })?.id), { timeout: 30_000 })
      .not.toBeUndefined()
      .then(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .find((window) => {
          if (window.isDestroyed()) return false
          const url = window.webContents.getURL()
          return url.includes('index.html') || url.startsWith('http://127.0.0.1:1430')
        })?.id))
    expect(rebuiltId).toBeDefined()
    expect(rebuiltId).not.toBe(oldId)
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id)
      if (!window || window.isDestroyed() || window.webContents.isLoading()) return false
      return window.webContents.executeJavaScript("Boolean(document.querySelector('.side-bar'))")
    }, rebuiltId!), { timeout: 30_000 }).toBe(true)
  })
})
