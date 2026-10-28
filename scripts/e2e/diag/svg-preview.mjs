import { createRequire } from 'node:module'
const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--no-proxy-server'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
page.setDefaultNavigationTimeout(90000)
await page.goto('http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
await page.locator('button[aria-haspopup="menu"]').first().click()
await page.waitForTimeout(600)
await page.locator('[role="menuitem"]').filter({ hasText: 'mock-flash' }).first().click()
await page.waitForTimeout(600)
await page.locator('textarea').first().fill('画一个 svg 图标')
await page.locator('textarea').first().press('Enter')
await page.waitForTimeout(6000)

const blocks = await page.locator('[class*="group/code"]').count()
console.log('代码块数:', blocks)
const btns = await page.locator('[class*="group/code"]').last().locator('button').evaluateAll((els) =>
  els.map((e) => ({ text: JSON.stringify((e.innerText || '').trim()), title: e.getAttribute('title') }))
)
console.log('最后一块的按钮:', JSON.stringify(btns, null, 1))

const pb = page.locator('[class*="group/code"]').last().locator('button').filter({ hasText: /^预览$/ })
console.log('匹配「预览」数量:', await pb.count())
if (await pb.count()) {
  await pb.first().click()
  await page.waitForTimeout(1500)
  const n = await page.locator('[class*="group/code"]').last().locator('iframe').count()
  console.log('点击后 iframe 数:', n)
  const cls = await page.locator('[class*="group/code"]').last().locator('button').evaluateAll((els) =>
    els.map((e) => ({ t: (e.innerText || '').trim(), cls: (e.className || '').includes('bg-accent') }))
  )
  console.log('按钮态:', JSON.stringify(cls))
  await page.screenshot({ path: '.shots/diag/svg-preview-probe.png' })
}
await browser.close()
