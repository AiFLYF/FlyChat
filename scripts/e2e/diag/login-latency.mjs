/**
 * 诊断：多用户模式下「登录」按钮一直停在「请稍候…」。
 *
 * 已知：后端 /api/auth/login 用 curl 打 0.48s 就返回 400 invalid_credentials，
 * 但浏览器里点「立即登录」后按钮一直是 loading。这个脚本把请求/响应/失败事件
 * 和按钮文案的时间线打出来，用来区分「请求没发出去」「代理挂着不回」「回了但 UI 没更新」。
 */
import { createRequire } from 'node:module'
const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:5181'
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.setDefaultNavigationTimeout(90000)

const t0 = Date.now()
const ts = () => String(Date.now() - t0).padStart(6) + 'ms'
page.on('request', (r) => {
  if (r.url().includes('/api/auth')) console.log(ts(), '→ REQ', r.method(), r.url())
})
page.on('response', async (r) => {
  if (r.url().includes('/api/auth')) console.log(ts(), '← RES', r.status(), r.url())
})
page.on('requestfailed', (r) => {
  if (r.url().includes('/api/auth')) console.log(ts(), '✗ FAIL', r.failure()?.errorText, r.url())
})

// 1) 确保管理员存在（幂等：已存在就跳过）
const me0 = await (await ctx.request.get(BASE + '/api/auth/me')).json()
console.log('初始 /api/auth/me:', JSON.stringify(me0))
if (me0.needsSetup) {
  const r = await ctx.request.post(BASE + '/api/auth/setup', {
    data: { username: 'admin', password: 'Adm1n-Passw0rd', displayName: '管理员' },
  })
  console.log('setup →', r.status())
}

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
await page.screenshot({ path: '.shots/diag/login-0-initial.png' })

// 2) 通过接口退出登录，刷新回到登录框
await ctx.request.post(BASE + '/api/auth/logout', { data: {} })
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)
const dlg = page.locator('[aria-label="账户登录"], [aria-label="初始化系统管理员"]').first()
console.log('登录框可见:', await dlg.isVisible().catch(() => false))

// 3) 故意输错密码，观察 10 秒内按钮文案的变化
await dlg.locator('input').first().fill('admin')
await dlg.locator('input[type="password"]').first().fill('wrong-password-123')
const btn = dlg.locator('button:has-text("立即登录"), button:has-text("请稍候")').first()
await btn.click()
for (let i = 1; i <= 10; i++) {
  await page.waitForTimeout(1000)
  const text = (await btn.innerText().catch(() => '?')).trim()
  const errText = (await dlg.innerText()).replace(/\s+/g, ' ').slice(-60)
  console.log(ts(), `第 ${i}s 按钮=「${text}」 尾部文案=「${errText}」`)
  if (!text.includes('请稍候')) break
}
await page.screenshot({ path: '.shots/diag/login-1-after-click.png' })

await browser.close()
