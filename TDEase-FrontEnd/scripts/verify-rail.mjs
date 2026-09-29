import pw from 'file:///C:/Users/ray/Desktop/TDEase-nexus/TDEase-FrontEnd/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.js'
const { chromium } = pw
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://localhost:1420/', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForSelector('.side-bar', { timeout: 15000 })
await page.waitForTimeout(1000)

const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)} }

const audit = await page.evaluate(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)} }
  const sb = document.querySelector('.side-bar')
  const btns = Array.from(sb.querySelectorAll('.side-bar__btn')).map((el) => r(el))
  const inline = Array.from(sb.querySelectorAll('.side-bar__inline')).map((el) => r(el))
  // search must be gone
  const searchGone = sb.querySelectorAll('.side-bar__palette, [class*="palette"]').length
  return { sideBar: r(sb), btns, inline, searchGone }
})
console.log('=== NARROW RAIL AUDIT ===')
console.log('SideBar rect (width should be ~56):', JSON.stringify(audit.sideBar))
console.log('Search elements (must be 0):', audit.searchGone)
console.log('\nIcon buttons (should all be 40px wide, stacked vertically):')
for (const b of audit.btns) console.log('  ', JSON.stringify(b))
console.log('\nInline switcher cells (Lang/Theme dropdowns):')
for (const b of audit.inline) console.log('  ', JSON.stringify(b))

// Verify vertical stacking: all x centers ≈ same (rail center), y increasing
const all = [...audit.btns, ...audit.inline].filter(Boolean)
const xs = all.map((b) => b.x + b.w/2)
const xSpread = Math.max(...xs) - Math.min(...xs)
const ys = all.map((b) => b.y)
const ySorted = ys.every((y,i) => i===0 || ys[i-1] <= y)
console.log('\nx-center spread (small = vertical column):', Math.round(xSpread), 'px')
console.log('y strictly increasing (top-to-bottom stack)?', ySorted)
console.log('=> narrow vertical rail?', audit.sideBar.w <= 60 && xSpread <= 12 && all.length >= 4)

await browser.close()
