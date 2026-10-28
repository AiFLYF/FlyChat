/**
 * 验证首屏三态：加载中 / 请求失败 / 正常。
 * 用 CDP 的请求拦截（route）人为延迟和失败，确认不再把「还在加载」渲染成「没配 Key」。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:5180'
const OUT = path.resolve('.shots/diag')
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox', '--no-proxy-server'] })

const readHero = (page) =>
  page.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ')
    const m = t.match(/晚上好[^。]*。(.{0,90})/)
    return {
      subtitle: m ? m[1].slice(0, 90) : '(未匹配)',
      hasKeyWarn: /还没有配置 API Key/.test(t),
      cta: /去设置|重试/.test(t) ? (t.includes('重试') ? '重试' : '去设置') : '无',
      placeholder: document.querySelector('textarea')?.getAttribute('placeholder') || '',
    }
  })

// 1) 延迟 3s 才返回 providers
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
page.setDefaultNavigationTimeout(60000)
  await page.route('**/api/providers', async (route) => {
    await new Promise((r) => setTimeout(r, 3000))
    await route.continue()
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await page.screenshot({ path: path.join(OUT, 'state-loading.png') })
  console.log('[延迟 3s / 加载中]', JSON.stringify(await readHero(page), null, 0))
  await page.waitForTimeout(3500)
  await page.screenshot({ path: path.join(OUT, 'state-loaded.png') })
  console.log('[延迟 3s / 已就绪]', JSON.stringify(await readHero(page), null, 0))
  await ctx.close()
}

// 2) providers 请求一直失败：重试两次后应停在错误态（约 0.8+1.6s 后）
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  let hits = 0
  await page.route('**/api/providers', (route) => {
    hits += 1
    return route.abort('connectionrefused')
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  await page.screenshot({ path: path.join(OUT, 'state-error.png') })
  console.log('[一直失败] 请求次数=' + hits, JSON.stringify(await readHero(page), null, 0))
  await ctx.close()
}

// 3) 前两次失败、第三次成功：应自动恢复成就绪，不闪错误态
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  let hits = 0
  await page.route('**/api/providers', async (route) => {
    hits += 1
    if (hits <= 2) return route.abort('connectionrefused')
    return route.continue()
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const mid = await readHero(page)
  await page.waitForTimeout(4500)
  await page.screenshot({ path: path.join(OUT, 'state-recovered.png') })
  const after = await readHero(page)
  console.log('[两次失败后恢复] 请求次数=' + hits, JSON.stringify(after, null, 0))
  if (after.hasKeyWarn || after.placeholder.includes('无法连接')) {
    console.log('  ✗ 自动重试没有生效')
    process.exitCode = 1
  } else {
    console.log('  ✓ 自动重试后恢复正常（期间 1.2s 时状态：' + mid.placeholder + '）')
  }
  await ctx.close()
}

await browser.close()
