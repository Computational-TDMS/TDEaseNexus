// Capture the two uncovered modules: command palette (Ctrl+K) and the
// bottom logs panel from the status-bar toggle. Both full-window.
import { chromium } from '@playwright/test'

const OUT = 'C:/Users/ray/Desktop/软件著作权申请资料/截图-v2'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
await page.bringToFront()

const clickButton = (label) =>
  page.evaluate((want) => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === want)
    if (!el) return false
    el.click()
    return true
  }, label)

// --- command palette (Ctrl+K) ---
await page.keyboard.press('Control+KeyK')
await page.waitForTimeout(900)
const paletteOpen = await page.evaluate(() => !!document.querySelector('dialog[open]'))
if (!paletteOpen) throw new Error('command palette did not open')
await page.screenshot({ path: `${OUT}/07-2-命令面板.png` })
console.log('saved 07-2-命令面板.png')
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

// --- logs panel via status-bar 日志 toggle ---
// make sure the navigator is expanded again (settings shots had it collapsed)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    (b.getAttribute('aria-label') || b.title || '').includes('展开导航栏'),
  )
  if (btn) btn.click()
})
await page.waitForTimeout(400)
if (!(await clickButton('日志'))) throw new Error('logs toggle not found')
await page.waitForTimeout(1200)
const logText = await page.evaluate(() => document.body.innerText)
console.log('logs panel visible:', /日志/.test(logText))
await page.screenshot({ path: `${OUT}/10-3-运行日志面板.png` })
console.log('saved 10-3-运行日志面板.png')

// leave the app as we found it: close the panel
if (!(await clickButton('日志'))) console.log('warn: could not toggle logs closed')
await browser.close()
console.log('DONE')
