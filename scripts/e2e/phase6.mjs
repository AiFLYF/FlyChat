/**
 * 第六阶段 e2e：多用户模式（MULTI_USER=true）
 *
 * 这是之前唯一完全没测过的功能面：初始化管理员、登录/退出、会话保持、
 * 密码错误提示、数据隔离、越权访问。
 *
 * ⚠️ 必须在**隔离环境**里跑，别打到日常那个库：
 *   WEB_PORT=5181 PORT=4101 MULTI_USER=true FLYCHAT_DATA_DIR=.shots/mu-data \
 *     node scripts/e2e/run-all.mjs phase6
 * （run-all 会把 env 透传给前后端，vite 代理也跟着 PORT 走）
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.WEB_PORT || '5180'}`
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = path.resolve('.shots/e2e6/run-' + RUN)
fs.mkdirSync(OUT, { recursive: true })

const results = []
let shotNo = 0
const shot = async (page, name) => {
  shotNo += 1
  await page.screenshot({ path: path.join(OUT, `${String(shotNo).padStart(2, '0')}-${name}.png`) }).catch(() => {})
}
const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    const d = await fn()
    results.push({ name, ok: true, ms: Date.now() - t0, detail: d })
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)${d ? '  → ' + d : ''}`)
  } catch (e) {
    const msg = String(e?.message || e).split('\n')[0].slice(0, 260)
    results.push({ name, ok: false, ms: Date.now() - t0, detail: msg })
    console.log(`  ✗ ${name}  →  ${msg}`)
  }
}

const ADMIN = { username: 'admin', displayName: '管理员', password: 'Adm1n-Passw0rd' }
const BOB = { username: 'bob', displayName: 'Bob', password: 'B0b-Passw0rd' }

// 登录框的 aria-label 随模式变化（初始化时是「初始化系统管理员」），
// 读屏用户听到的才是当前这一步该做的事，所以这里两种都要认。
const AUTH_DIALOG = '[aria-label="账户登录"], [aria-label="初始化系统管理员"]'

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.setDefaultNavigationTimeout(60000)
const errors = []
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)))

console.log('\n=== FlyChat 第六阶段 e2e（多用户）@ ' + BASE + ' ===\n')

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)

// ---------------------------------------------------------------- 初始化
await step('首屏强制显示初始化界面', async () => {
  const dlg = page.locator(AUTH_DIALOG)
  await dlg.waitFor({ state: 'visible', timeout: 15000 })
  const txt = (await dlg.innerText()).replace(/\s+/g, ' ')
  await shot(page, 'setup')
  if (!/初始化系统管理员/.test(txt)) throw new Error('没有进入初始化模式：' + txt.slice(0, 80))
  return '显示「初始化系统管理员」'
})

await step('未登录时不能用 Esc 关掉登录框', async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  const still = await page.locator(AUTH_DIALOG).count()
  if (!still) throw new Error('Esc 把强制登录框关掉了（应该关不掉）')
  return 'Esc 无效，符合预期'
})

await step('创建管理员并进入主界面', async () => {
  const dlg = page.locator(AUTH_DIALOG)
  await dlg.locator('input').first().fill(ADMIN.username)
  // 初始化模式比登录多「显示名」和「确认密码」两个框，按 aria-label / placeholder 定位更稳
  const display = dlg.locator('input').nth(1)
  await display.fill(ADMIN.displayName)
  const pwd = dlg.locator('input[type="password"]').first()
  await pwd.fill(ADMIN.password)
  const confirm = dlg.locator('input[type="password"]').nth(1)
  if (await confirm.count()) await confirm.fill(ADMIN.password)
  await shot(page, 'setup-filled')
  await dlg.locator('button:has-text("创建并开启服务")').click()
  await page.waitForTimeout(2500)
  await shot(page, 'after-setup')
  if (await page.locator(AUTH_DIALOG).count()) {
    const t = await page.locator(AUTH_DIALOG).innerText()
    throw new Error('仍在登录框：' + t.replace(/\s+/g, ' ').slice(0, 120))
  }
  if (!(await page.locator('aside').count())) throw new Error('没有进入主界面（侧边栏不存在）')
  return '已创建并进入主界面'
})

await step('刷新后保持登录（会话 cookie）', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  if (await page.locator(AUTH_DIALOG).count()) throw new Error('刷新后要求重新登录')
  const me = await ctx.request.get(BASE + '/api/auth/me')
  const data = await me.json()
  if (!data?.user?.username) throw new Error('/api/auth/me 没返回用户：' + JSON.stringify(data).slice(0, 120))
  return `cookie 有效，当前用户 ${data.user.username}（${data.user.role}）`
})

// ---------------------------------------------------------------- 退出 / 错误密码
await step('退出登录后回到登录界面', async () => {
  // 退出登录在侧边栏底部的「用户菜单」里：先点用户按钮展开，再点退出
  const userBtn = page.locator('aside button').filter({ hasText: ADMIN.displayName }).first()
  if (!(await userBtn.count())) throw new Error('找不到侧边栏的用户菜单按钮')
  await userBtn.click()
  await page.waitForTimeout(700)
  const logout = page.locator('button').filter({ hasText: '退出登录' }).first()
  if (!(await logout.count())) throw new Error('展开用户菜单后没有「退出登录」')
  await shot(page, 'user-menu')
  await logout.click()
  await page.waitForTimeout(2000)
  const dlg = page.locator(AUTH_DIALOG)
  if (!(await dlg.count())) throw new Error('退出后没有回到登录界面')
  const txt = (await dlg.innerText()).replace(/\s+/g, ' ')
  await shot(page, 'login')
  if (!/登录 FlyChat/.test(txt)) throw new Error('登录界面文案异常：' + txt.slice(0, 80))
  return '已退出，显示登录界面'
})

await step('密码错误给出统一提示（不泄露账号是否存在）', async () => {
  const dlg = page.locator(AUTH_DIALOG)
  await dlg.locator('input').first().fill(ADMIN.username)
  await dlg.locator('input[type="password"]').first().fill('wrong-password-123')
  await dlg.locator('button:has-text("立即登录")').click()
  // 等「结果出现」而不是等固定毫秒：本机负载高时一次登录往返实测可到 1~2s，
  // 写死 2s 会偶发读到还在 loading 的按钮（detail 里会出现「请稍候...」）。
  await dlg
    .locator('text=用户名或密码不正确')
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => {})
  const txt = (await dlg.innerText()).replace(/\s+/g, ' ')
  await shot(page, 'login-error')
  if (!/用户名或密码不正确/.test(txt)) throw new Error('没有给出统一错误提示：' + txt.slice(0, 120))
  return '提示「用户名或密码不正确」'
})

await step('正确密码登录成功', async () => {
  const dlg = page.locator(AUTH_DIALOG)
  await dlg.locator('input[type="password"]').first().fill(ADMIN.password)
  await dlg.locator('button:has-text("立即登录")').click()
  // 同上：等弹窗真的消失，而不是赌一个固定时长
  await page
    .locator(AUTH_DIALOG)
    .first()
    .waitFor({ state: 'detached', timeout: 20000 })
    .catch(() => {})
  if (await page.locator(AUTH_DIALOG).count()) throw new Error('仍然停留在登录框')
  return '登录成功'
})

// ---------------------------------------------------------------- 数据隔离
let adminConvId = ''
await step('管理员发一条消息（作为隔离测试的靶子）', async () => {
  await page.locator('textarea').first().fill('管理员私有会话：暗号是青鸟')
  await page.locator('textarea').first().press('Enter')
  // 轮询而不是等固定 6s：慢机器上「流式回答结束 + 会话落库」可能超过 6s，
  // 之前就是因为固定等待不够，后面所有步骤连带失败（靶子 id 是空的）
  let items = []
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000)
    const list = await (await ctx.request.get(BASE + '/api/conversations')).json()
    items = list.items || []
    if (items.length) break
  }
  if (!items.length) throw new Error('管理员名下没有会话')
  adminConvId = items[0].id
  return `会话 ${items.length} 条，靶子 id=${adminConvId}`
})

await step('管理员创建第二个用户（普通角色）', async () => {
  const res = await ctx.request.post(BASE + '/api/users', {
    data: { username: BOB.username, password: BOB.password, displayName: BOB.displayName, role: 'user' },
  })
  if (res.status() !== 201) throw new Error(`创建用户失败 HTTP ${res.status()}：${(await res.text()).slice(0, 120)}`)
  const u = await res.json()
  if (u.role !== 'user') throw new Error('角色不对：' + u.role)
  return `已创建 ${u.username}（${u.role}）`
})

await step('普通用户登录后看不到管理员的会话', async () => {
  // 换一个干净的浏览器上下文，模拟另一台设备
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const p2 = await ctx2.newPage()
  p2.setDefaultNavigationTimeout(60000)
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p2.waitForTimeout(3000)
  const dlg = p2.locator(AUTH_DIALOG)
  await dlg.waitFor({ state: 'visible', timeout: 15000 })
  await dlg.locator('input').first().fill(BOB.username)
  await dlg.locator('input[type="password"]').first().fill(BOB.password)
  await dlg.locator('button:has-text("立即登录")').click()
  await p2
    .locator(AUTH_DIALOG)
    .first()
    .waitFor({ state: 'detached', timeout: 20000 })
    .catch(() => {})
  shotNo += 1
  await p2.screenshot({ path: path.join(OUT, `${String(shotNo).padStart(2, '0')}-bob-home.png`) })

  // 没有靶子 id 时「越权读取」会打到 /api/conversations/ 上拿到 200，误报成隔离失效，
  // 所以这里先明确前置条件
  if (!adminConvId) throw new Error('前置步骤没有拿到管理员的会话 id，无法验证越权读取')

  const list = await (await ctx2.request.get(BASE + '/api/conversations')).json()
  const items = list.items || []
  const leaked = items.find((c) => c.id === adminConvId)
  if (leaked) throw new Error('普通用户能看到管理员的会话（数据隔离失效）')

  // 越权直连：拿管理员的会话 id 去读，应 404 而不是 403（不暴露存在性）
  const direct = await ctx2.request.get(BASE + '/api/conversations/' + adminConvId)
  const code = direct.status()
  await ctx2.close()
  if (code !== 404) throw new Error(`越权读取返回 ${code}，期望 404`)
  return `bob 名下 ${items.length} 条会话；越权读取 → 404`
})

await step('普通用户不能访问用户管理接口', async () => {
  const ctx3 = await browser.newContext()
  const p3 = await ctx3.newPage()
  p3.setDefaultNavigationTimeout(60000)
  await p3.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p3.waitForTimeout(2500)
  const dlg = p3.locator(AUTH_DIALOG)
  await dlg.locator('input').first().fill(BOB.username)
  await dlg.locator('input[type="password"]').first().fill(BOB.password)
  await dlg.locator('button:has-text("立即登录")').click()
  await p3.waitForTimeout(2000)
  const res = await ctx3.request.get(BASE + '/api/users')
  const code = res.status()
  await ctx3.close()
  if (code === 200) throw new Error('普通用户能读到用户列表（越权）')
  return `/api/users 对普通用户返回 ${code}`
})

console.log('\n=== 结果汇总 ===')
const pass = results.filter((r) => r.ok).length
const fail = results.filter((r) => !r.ok)
console.log(`通过 ${pass}/${results.length}`)
for (const f of fail) console.log(`  ✗ ${f.name}  →  ${f.detail}`)
if (errors.length) {
  console.log('\n页面错误：')
  for (const e of [...new Set(errors)].slice(0, 8)) console.log('  ! ' + e)
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, errors: [...new Set(errors)] }, null, 2), 'utf8')
console.log('\n截图目录：' + OUT)
await browser.close()
process.exitCode = fail.length ? 1 : 0
