// Resume the settings walk for the remaining nav items.
import { chromium } from '@playwright/test'
import { appendFileSync } from 'node:fs'

const OUT = 'C:/Users/ray/Desktop/软件著作权申请资料/截图-v2'
const LOG = 'C:/Users/ray/Desktop/TDEase-zero/.scratch/settings-walk2.log'
const ITEMS = [
  ['MCP', '15-6-设置-MCP.png'],
  ['分享', '15-7-设置-分享.png'],
  ['Statistics', '15-9-设置-统计.png'],
  ['许可与协议', '15-10-设置-关于.png'],
]

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
await page.bringToFront()

for (const [label, file] of ITEMS) {
  const found = await page.evaluate((want) => {
    const el = [...document.querySelectorAll('button, a, [role="tab"]')].find(
      (n) => n.textContent.trim() === want,
    )
    if (!el) return false
    el.click()
    return true
  }, label)
  if (!found) throw new Error(`nav item not found: ${label}`)
  await page.waitForTimeout(900)
  const text = await page.evaluate(() => {
    const root = document.querySelector('.settings-document, .settings, [data-settings]')
    return (root ? root.innerText : document.body.innerText).replace(/\n{2,}/g, '\n').slice(0, 1600)
  })
  await page.screenshot({ path: `${OUT}/${file}` })
  appendFileSync(LOG, `=== ${label} -> ${file}\n${text}\n\n`)
}
await browser.close()
appendFileSync(LOG, 'DONE\n')
console.log('DONE')
