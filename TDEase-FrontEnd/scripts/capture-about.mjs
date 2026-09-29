// Retake the About (许可与协议) settings page after the version bump HMR.
import { chromium } from '@playwright/test'

const OUT = 'C:/Users/ray/Desktop/软件著作权申请资料/截图-v2'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
await page.bringToFront()

const has = (t) => page.getByText(t, { exact: true }).first().isVisible().catch(() => false)
if (!(await has('许可与协议'))) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') || '').includes('设置') || b.title.includes('设置'),
    )
    if (!btn) throw new Error('settings rail button not found')
    btn.click()
  })
  await page.waitForTimeout(900)
}
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') || b.title || '').includes('收起导航栏'),
  )
  if (btn) btn.click()
})
await page.waitForTimeout(400)
await page.evaluate(() => {
  const el = [...document.querySelectorAll('button, a, [role="tab"]')].find(
    (n) => n.textContent.trim() === '许可与协议',
  )
  if (!el) throw new Error('nav item not found')
  el.click()
})
await page.waitForTimeout(1000)
const body = await page.evaluate(() => document.body.innerText)
const m = body.match(/TDEaseNexus v([\w.\-]+)/)
console.log('version shown:', m ? m[1] : 'NOT_FOUND')
if (!m || m[1] !== '1.0.0') throw new Error('version not updated (HMR did not apply)')
await page.screenshot({ path: `${OUT}/15-10-设置-关于.png` })
console.log('SAVED 15-10-设置-关于.png')
await browser.close()
