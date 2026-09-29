// Walk the Settings nav one item at a time, in display order, capturing a
// full-window screenshot per item plus the item's innerText (caption source).
import { chromium } from '@playwright/test'

const OUT = 'C:/Users/ray/Desktop/软件著作权申请资料/截图-v2'
const ITEMS = [
  ['通用', '15-1-设置-通用.png'],
  ['外观', '15-2-设置-外观.png'],
  ['Providers', '15-3-设置-服务商.png'],
  ['权限', '15-4-设置-权限.png'],
  ['Agent Tools', '15-5-设置-AgentTools.png'],
  ['MCP', '15-6-设置-MCP.png'],
  ['分享', '15-7-设置-分享.png'],
  ['Statistics', '15-9-设置-统计.png'],
  ['许可与协议', '15-9a-设置-关于.png'],
]

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
await page.bringToFront()

const has = (t) => page.getByText(t, { exact: true }).first().isVisible().catch(() => false)

// 1. open Settings from the icon rail if its nav is not on screen
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
if (!(await has('许可与协议'))) throw new Error('settings nav did not open')

// 2. collapse the file navigator if it is expanded (settings shots stay
// navigator-free per review requirement)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') || b.title || '').includes('收起导航栏'),
  )
  if (btn) btn.click()
})
await page.waitForTimeout(400)

// 3. walk nav items in display order
for (const [label, file] of ITEMS) {
  const info = await page.evaluate((want) => {
    const nodes = [...document.querySelectorAll('button, a, [role="tab"]')]
    const el = nodes.find((n) => n.textContent.trim() === want)
    if (!el) return null
    el.click()
    const active = el.getAttribute('aria-current') || el.className
    return { active: String(active).slice(0, 120) }
  }, label)
  if (!info) throw new Error(`nav item not found: ${label}`)
  await page.waitForTimeout(800)
  const text = await page.evaluate(() => {
    const root = document.querySelector('.settings-document, .settings, [data-settings]')
    return (root ? root.innerText : document.body.innerText).replace(/\n{2,}/g, '\n').slice(0, 1400)
  })
  await page.screenshot({ path: `${OUT}/${file}` })
  console.log(`=== ${label} -> ${file} | active=${info.active}`)
  console.log(text)
  console.log('')
}
await browser.close()
console.log('DONE')
