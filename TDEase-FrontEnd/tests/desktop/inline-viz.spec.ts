/**
 * Inline-visualization fragment — the desktop smoke for the unified viz frame.
 *
 * Verifies the whole chain with nothing faked above the provider: a turn's
 * assistant reply embed-cites `![[viz/protein-ptm.html]]`, the transcript
 * hydrates it as the unified viz frame (slim bar + auto-fitting body), and
 * the served bytes are wrapped with the live theme (fragment content has no
 * doctype). HTML frames AUTO-FIT: the fit runtime inside the sandboxed frame
 * reports the settled height, the parent sizes the iframe to it (and caches
 * it per path — the remount flicker fix). The screenshot is the
 * deliverable — it shows the real rendering, footer included, the way a
 * case round will see it.
 */
import { expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openAgentPage, test } from './desktop-app'

/** The fragment the scripted reply embeds: a neutral protein with mapped PTM
 *  sites, hand-written inline SVG on host theme tokens — the exact shape the
 *  inline_visualization prompt fragment asks the agent for. No case data. */
const PROTEIN_PTM_FRAGMENT = `<div class="ptm">
  <header class="ptm__head">
    <span class="ptm__title">Protein X <span class="ptm__sub">· 431 aa · 6 mapped sites</span></span>
    <span class="ptm__legend">
      <i class="ptm__chip ptm__chip--lipid"></i>lipid anchor
      <i class="ptm__chip ptm__chip--p"></i>phospho
      <i class="ptm__chip ptm__chip--ac"></i>acetyl
    </span>
  </header>
  <svg viewBox="0 0 760 230" role="img" aria-label="Protein X backbone with six mapped modification sites between residues 2 and 310">
    <g class="ptm__axis">
      <text x="40" y="212">0</text><text x="200" y="212">100</text>
      <text x="368" y="212">200</text><text x="536" y="212">300</text>
      <text x="704" y="212">400 aa</text>
      <line x1="40" y1="196" x2="712" y2="196" />
    </g>
    <g class="ptm__domains">
      <rect x="40" y="118" width="228" height="16" rx="8" class="ptm__dom ptm__dom--nlobe" />
      <rect x="272" y="118" width="277" height="16" class="ptm__dom ptm__dom--cat" />
      <rect x="553" y="118" width="159" height="16" rx="8" class="ptm__dom ptm__dom--ctail" />
      <text x="46" y="110">regulatory lobe</text>
      <text x="278" y="110">catalytic core</text>
      <text x="559" y="110">C-tail</text>
    </g>
    <g class="ptm__sites">
      <g class="ptm__site" transform="translate(43,0)">
        <line x1="0" y1="118" x2="0" y2="72" />
        <path d="M 0 62 L 8 70 L 0 78 L -8 70 Z" class="ptm__mark ptm__mark--lipid" />
        <text x="12" y="34">Gly2 · myristoyl</text>
      </g>
      <g class="ptm__site" transform="translate(127,0)">
        <line x1="0" y1="118" x2="0" y2="74" />
        <circle cx="0" cy="66" r="7" class="ptm__mark ptm__mark--p" />
        <text x="12" y="58">Ser56 · phospho</text>
      </g>
      <g class="ptm__site" transform="translate(176,0)">
        <line x1="0" y1="118" x2="0" y2="106" />
        <circle cx="0" cy="98" r="7" class="ptm__mark ptm__mark--p" />
        <text x="12" y="90">Thr87 · phospho</text>
      </g>
      <g class="ptm__site" transform="translate(214,0)">
        <line x1="0" y1="118" x2="0" y2="58" />
        <circle cx="0" cy="50" r="7" class="ptm__mark ptm__mark--p" />
        <text x="12" y="34">Tyr112 · phospho</text>
      </g>
      <g class="ptm__site" transform="translate(93,0)">
        <line x1="0" y1="134" x2="0" y2="148" />
        <path d="M 0 148 L 8 156 L 0 164 L -8 156 Z" class="ptm__mark ptm__mark--lipid" />
        <text x="12" y="182">Cys34 · palmitoyl</text>
      </g>
      <g class="ptm__site" transform="translate(523,0)">
        <line x1="0" y1="134" x2="0" y2="146" />
        <rect x="-6" y="146" width="12" height="12" rx="2" class="ptm__mark ptm__mark--ac" />
        <text x="12" y="182">Lys310 · acetyl</text>
      </g>
    </g>  </svg>
  <footer class="ptm__foot">
    Lipid anchors flank the regulatory lobe; the pSer/pThr/pTyr cluster
    (56/87/112) sits inside it, and Lys310 acetylation marks the catalytic
    boundary. Positions are residue numbers, not pixels.
  </footer>
</div>
<style>
  .ptm { padding: 2px 4px 6px; color: var(--color-text); }
  .ptm__head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; }
  .ptm__title { font-weight: 600; font-size: 14px; }
  .ptm__sub { font-weight: 400; color: var(--color-text-muted); font-size: 12px; }
  .ptm__legend { margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--color-text-secondary); }
  .ptm__chip { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .ptm__chip--lipid { background: var(--chart-series-3); }
  .ptm__chip--p { background: var(--chart-series-1); }
  .ptm__chip--ac { background: var(--chart-series-4); }
  .ptm svg { width: 100%; height: auto; }
  .ptm text { font-size: 11.5px; fill: var(--color-text-secondary); }
  .ptm__axis text { fill: var(--color-text-muted); }
  .ptm__axis line { stroke: var(--color-border); }
  .ptm__domains text { font-size: 11px; fill: var(--color-text-muted); }
  .ptm__dom--nlobe { fill: color-mix(in srgb, var(--chart-series-1) 16%, transparent); }
  .ptm__dom--cat { fill: color-mix(in srgb, var(--chart-series-2) 16%, transparent); }
  .ptm__dom--ctail { fill: color-mix(in srgb, var(--chart-series-5) 14%, transparent); }
  .ptm__site line { stroke: var(--color-border); stroke-width: 1; }
  .ptm__site > text { fill: var(--color-text); }
  .ptm__tag { font-size: 11px; fill: var(--color-text-muted) !important; }
  .ptm__mark--lipid { fill: var(--chart-series-3); }
  .ptm__mark--p { fill: var(--chart-series-1); }
  .ptm__mark--ac { fill: var(--chart-series-4); }
  .ptm__foot { margin-top: 6px; font-size: 12px; color: var(--color-text-muted);
    max-width: 62ch; }
  @media (prefers-reduced-motion: reduce) { .ptm__site { transition: none; } }
  .ptm__site { cursor: default; }
  .ptm__site:hover > text { fill: var(--color-primary); }
</style>
`

test('inline viz fragment renders auto-fitting in the unified frame', async ({
  page, workspace, openWorkspace, configureProvider, consoleErrors,
}) => {
  test.setTimeout(180_000)
  await page.evaluate(() => localStorage.setItem('locale', 'en-US'))
  await page.reload()
  await page.waitForSelector('.side-bar', { timeout: 30_000 })
  await configureProvider()

  mkdirSync(join(workspace.path, 'viz'), { recursive: true })
  writeFileSync(join(workspace.path, 'viz', 'protein-ptm.html'), PROTEIN_PTM_FRAGMENT, 'utf8')

  await openWorkspace()
  await openAgentPage(page)

  // Tap the height channel: the last reported tdz:frame-height IS the
  // content's settled scrollHeight — matching it against the rendered
  // iframe height below proves nothing is hidden behind an internal scroll.
  await page.evaluate(() => {
    window.addEventListener('message', (event) => {
      const data = event.data as { type?: string; h?: number } | null
      if (data && data.type === 'tdz:frame-height') {
        (window as unknown as { __lastFrameHeight?: number }).__lastFrameHeight = data.h
      }
    })
  })

  const composer = page.locator('.agent-page:visible textarea:visible')
  await expect(composer).toBeVisible()
  await composer.fill('E2E_VIZ_FRAGMENT')
  await composer.press('Enter')

  // Settle: the send control returns and nothing stays queued.
  await expect(page.locator('.composer__send').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.composer__queued')).toBeHidden()

  // The embed produced the unified viz frame: bar (name + open-external)
  // visible over an AUTO-FITTING body — the sandboxed runtime reported its
  // settled height and the parent sized the iframe to it.
  const frame = page.locator('.md-media-frame[data-file-kind="html"]').first()
  await expect(frame).toBeVisible()
  const bar = frame.locator('.md-media-frame__bar')
  await expect(bar).toBeVisible()
  await expect(frame.locator('.md-media-frame__name')).toHaveText('protein-ptm.html')
  await expect(frame.locator('.md-media-frame__external')).toBeVisible()

  const iframe = frame.locator('iframe.md-media-frame__doc')
  await expect(iframe).toBeVisible()
  await expect(frame).toHaveAttribute('data-frame-live', 'true', { timeout: 10_000 })
  // The runtime reports on load AND again on settle (fonts/body growth) —
  // poll until the height is stable so the screenshot never races the last
  // report.
  let settledHeight = 0
  let stableCount = 0
  for (let i = 0; i < 50 && stableCount < 3; i += 1) {
    const h = await iframe.evaluate((el) => Math.round(el.getBoundingClientRect().height))
    if (h === settledHeight && h >= 140) stableCount += 1
    else { settledHeight = h; stableCount = 1 }
    await page.waitForTimeout(100)
  }
  expect(settledHeight).toBeGreaterThanOrEqual(140)
  expect(settledHeight).toBeLessThanOrEqual(10_000)
  // No-clip proof: the rendered iframe height equals the content's own
  // settled scrollHeight (the last height report), so the frame shows all
  // of it — no internal scroll, nothing hidden.
  const reported = await page.evaluate(() => (window as unknown as { __lastFrameHeight?: number }).__lastFrameHeight)
  expect(reported).toBe(settledHeight)

  // The deliverable: the real rendered pixels of the fragment in the app.
  await frame.screenshot({ path: 'test-results/inline-viz-fragment.png' })

  // ── The composer toggle: hollow star lights up and dresses the card ──────
  const toggle = page.locator('.composer__viz')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.composer--viz-on')).toBeVisible()
  await page.waitForTimeout(1_600) // let the aurora sweep + a sparkle crest
  await page.locator('.composer--viz-on').screenshot({ path: 'test-results/inline-viz-composer-on.png' })
  // Lit mode must not break the input: a second turn still dispatches.
  await composer.fill('E2E_VIZ_FRAGMENT (again)')
  await composer.press('Enter')
  await expect(page.locator('.composer__send').first()).toBeVisible({ timeout: 60_000 })

  // ── The conversation bookmark rail: one tick per user turn, click jumps ──
  // Two turns sent above ⇒ two ticks; the active one tracks the viewport and
  // clicking the first tick scrolls back to the conversation start.
  const rail = page.locator('.transcript__tickrail')
  await expect(rail).toBeVisible()
  const ticks = rail.locator('.transcript__tick')
  await expect(ticks).toHaveCount(2)
  await ticks.first().click()
  await expect(ticks.first()).toHaveClass(/transcript__tick--active/, { timeout: 5_000 })
  const scrollTop = await page.evaluate(() => {
    const el = document.querySelector('.transcript')
    return el ? Math.round(el.scrollTop) : -1
  })
  expect(scrollTop).toBeLessThan(80)

  expect(consoleErrors.filter((line) => !line.includes('Content Security Policy'))).toEqual([])
})
