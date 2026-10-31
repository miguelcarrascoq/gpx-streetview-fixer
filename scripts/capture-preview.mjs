import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const gpxPath = path.join(
  root,
  'uploads',
  'VID_20251117_054832_00_003_original.gpx',
)
const outPath = path.join(root, 'docs', 'preview.jpg')

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1200, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
const page = await context.newPage()

await page.goto('http://127.0.0.1:43123/gpx-streetview-fixer/', {
  waitUntil: 'networkidle',
})

await page.addStyleTag({
  content: `
    html {
      background-color: #0f1c18 !important;
    }
    body {
      background-color: #0f1c18 !important;
      background-image:
        radial-gradient(1100px 640px at 12% -8%, #2f6754 0%, transparent 58%),
        radial-gradient(820px 480px at 100% 0%, #4a3418 0%, transparent 52%),
        linear-gradient(165deg, #0f1c18, #1a332c 55%, #0c1613) !important;
      background-attachment: scroll !important;
      background-repeat: no-repeat !important;
      background-size: 100% 100% !important;
    }
    .panel, .card {
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      background: rgba(16, 34, 28, 0.96) !important;
      border-color: rgba(255, 255, 255, 0.16) !important;
    }
    .brand { color: #e0b01f !important; }
    .cta {
      background: #e0b01f !important;
      color: #1a1400 !important;
    }
    .howto { display: none !important; }
    .leaflet-container { background: #17231f !important; }
  `,
})

await page.setInputFiles('#gpx-file', gpxPath)
await page.waitForSelector('.card.map-card', { timeout: 60_000 })
await page.waitForFunction(
  () => !document.body.innerText.includes('Processing…'),
  { timeout: 60_000 },
)

const fixedBtn = page.locator('.map-toggle button', { hasText: 'Fixed' })
if (await fixedBtn.count()) await fixedBtn.click()
await page.waitForTimeout(3500)

const contentHeight = await page.evaluate(() => {
  const grid = document.querySelector('.grid')
  if (!grid) return document.documentElement.scrollHeight
  return Math.ceil(grid.getBoundingClientRect().bottom + window.scrollY + 48)
})

await page.setViewportSize({
  width: 1200,
  height: Math.max(900, Math.min(contentHeight, 3200)),
})
await page.evaluate(() => window.scrollTo(0, 0))
await page.waitForTimeout(1200)

await page.screenshot({
  path: outPath,
  animations: 'disabled',
  type: 'jpeg',
  quality: 92,
  fullPage: false,
  omitBackground: false,
})

const probe = await page.evaluate(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  // sample via getComputedStyle only
  const body = getComputedStyle(document.body)
  const panel = getComputedStyle(document.querySelector('.panel') || document.body)
  return {
    bodyBg: body.backgroundColor,
    bodyImage: body.backgroundImage.slice(0, 80),
    panelBg: panel.backgroundColor,
    h: document.documentElement.clientHeight,
  }
})

console.log('Wrote', outPath, { contentHeight, ...probe })
await browser.close()
