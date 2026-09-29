// Retake the palette shot over a clean background (fasta tab, no settings
// page => no version badge), then inspect the 运行 dock tab content.
import { chromium } from '@playwright/test'

const OUT = 'C:/Users/ray/Desktop/软件著作权申请资料/截图-v2'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages()[0]
await page.bringToFront()

// activate the fasta document tab so no settings content is on screen
const switched = await page.evaluate(() => {
  const el = [...document.querySelectorAll('button, [role="tab"], *[class*="tab"] *')].find(
    (n) => n.textContent?.trim() === 'histone48.fasta',
  )
  if (!el) return false
  el.click()
  return true
})
console.log('switched to fasta tab:', switched)
await page.waitForTimeout(700)

await page.keyboard.press('Control+KeyK')
await page.waitForTimeout(900)
if (!(await page.evaluate(() => !!document.querySelector('dialog[open]'))))
  throw new Error('palette did not open')
await page.screenshot({ path: `${OUT}/07-2-命令面板.png` })
console.log('retaken 07-2-命令面板.png')
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

// inspect the 运行 dock tab: close 日志 first if open, then open 运行
const clickButton = (label) =>
  page.evaluate((want) => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === want)
    if (!el) return false
    el.click()
    return true
  }, label)
await clickButton('日志')
await page.waitForTimeout(400)
if (!(await clickButton('运行'))) throw new Error('运行 toggle not found')
await page.waitForTimeout(1000)
const text = await page.evaluate(() => {
  const docks = [...document.querySelectorAll('section, aside, div')].filter(
    (d) => d.className && String(d.className).includes('dock'),
  )
  return (docks.at(-1)?.innerText ?? document.body.innerText)
    .replace(/\n{2,}/g, '\n')
    .slice(0, 1200)
})
console.log('=== 运行 dock text ===')
console.log(text)
await browser.close()
