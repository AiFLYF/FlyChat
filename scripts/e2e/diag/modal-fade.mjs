import { createRequire } from 'node:module'
const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:5180'
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--no-proxy-server'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.setDefaultNavigationTimeout(60000)
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

await page.locator('button:has-text("设置")').first().click()
await page.waitForTimeout(900)

const read = async (tag) => {
  const info = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]')
    const fade = dlg?.querySelector('.fade-out-bottom')
    const scroller = [...(dlg?.querySelectorAll('div') || [])].find((el) => el.scrollHeight > el.clientHeight + 8)
    return {
      fadeVisible: !!fade,
      fadeBox: fade ? (() => { const r = fade.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height) } })() : null,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      canScroll: scroller ? scroller.scrollHeight - scroller.clientHeight : 0,
    }
  })
  console.log(tag, JSON.stringify(info))
  return info
}

await page.screenshot({ path: '.shots/diag/modal-fade-top.png' })
const top = await read('顶部时:')

// 滚到底
await page.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"]')
  const scroller = [...(dlg?.querySelectorAll('div') || [])].find((el) => el.scrollHeight > el.clientHeight + 8)
  if (scroller) scroller.scrollTop = scroller.scrollHeight
})
await page.waitForTimeout(600)
await page.screenshot({ path: '.shots/diag/modal-fade-bottom.png' })
const bottom = await read('滚到底:')

// 切到「数据与备份」标签（内容短），渐隐应消失
await page.locator('[role="tab"]').filter({ hasText: '数据与备份' }).first().click()
await page.waitForTimeout(700)
await page.screenshot({ path: '.shots/diag/modal-fade-tab.png' })
const tab = await read('切标签后:')

await browser.close()
console.log('\n判定：',
  top.fadeVisible && !bottom.fadeVisible ? '✓ 顶部有渐隐、滚到底消失' : '✗ 渐隐状态不对',
  '|', tab.fadeVisible ? '切标签后仍有渐隐（内容仍可滚动）' : '切标签后无渐隐')
