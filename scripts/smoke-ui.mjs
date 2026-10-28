/**
 * Playwright 冒烟脚本（开发期自测，不参与构建）。
 * 覆盖：多断点渲染 / 元素越界 / 顶栏高度 / 进出场动画 / 键盘可达性 /
 *       浮层 Esc 关闭 / 主题过渡 / reduced-motion 降级 / 长会话分段渲染。
 *
 * 用法：node scripts/smoke-ui.mjs [baseURL]
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

// Playwright 解析（可移植）：
// 1) 优先尝试项目本地依赖（执行 `npm i -D playwright` 后可直接运行）；
// 2) 否则回退到托管 workspace（本机开发环境），可用 PLAYWRIGHT_REQUIRE 指向任意路径。
// 3) 只装了 playwright-core 也能跑——它不带浏览器二进制，改用系统 Chrome（channel: chrome）。
// 回退路径用 homedir 推导，别写死用户名（写死过 C:/Users/f/...，换机就 Module Not Found）。
const requireLocal = createRequire(import.meta.url)
const fallbackRoot =
  process.env.PLAYWRIGHT_REQUIRE || `${os.homedir().replace(/\\/g, '/')}/.workbuddy-ai/binaries/node/workspace/`
let chromium
let useSystemChrome = false
try {
  ;({ chromium } = requireLocal('playwright'))
} catch {
  const requireFallback = createRequire(fallbackRoot.endsWith('/') ? fallbackRoot : fallbackRoot + '/')
  try {
    ;({ chromium } = requireFallback('playwright'))
  } catch {
    ;({ chromium } = requireFallback('playwright-core'))
    useSystemChrome = true
  }
}

// 目标地址：env BASE_URL > 命令行参数 > Vite 默认 5173（与 vite.config.ts 对齐）
const base = process.env.BASE_URL || process.argv[2] || 'http://127.0.0.1:5173'
const out = fileURLToPath(new URL('../.shots/', import.meta.url))
mkdirSync(out, { recursive: true })

const errors = []
// 本机有 http_proxy 环境变量，Chromium 会走代理导致 localhost 不可达
const browser = await chromium.launch({
  ...(useSystemChrome ? { channel: 'chrome' } : {}),
  args: ['--no-proxy-server', '--proxy-bypass-list=<-loopback>'],
})

/** 越界检测：根容器是 overflow-hidden，滚动条检测无效，必须逐元素比对 */
async function outOfBounds(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const bad = []
    const roots = [document.querySelector('header'), ...document.querySelectorAll('.r-2xl')]
    for (const root of roots) {
      if (!root) continue
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
          // SVG 元素的 className 是 SVGAnimatedString
          const cls = el.getAttribute('class') || ''
          bad.push(`${el.tagName}<${cls.slice(0, 34)}> [${Math.round(r.left)},${Math.round(r.right)}]`)
        }
      }
    }
    return [...new Set(bad)].slice(0, 6)
  })
}

/* ───────────────── 第一组：空态 + 设置弹窗 ───────────────── */

const LAYOUTS = [
  { name: 'desktop-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  { name: 'desktop-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  { name: 'tablet-light', viewport: { width: 834, height: 1112 }, colorScheme: 'light' },
  { name: 'mobile-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { name: 'mobile-narrow', viewport: { width: 320, height: 720 }, colorScheme: 'light' },
]

for (const s of LAYOUTS) {
  const ctx = await browser.newContext({ viewport: s.viewport, colorScheme: s.colorScheme })
  const page = await ctx.newPage()
  const tag = s.name
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`))

  await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${out}smoke-${tag}.png` })
  console.log('shot ok:', tag)

  // 焦点态：输入框只应有「一层」描边，不能出现内外双层框
  const ta = page.locator('textarea').first()
  if (await ta.count()) {
    await ta.click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}smoke-${tag}-focus.png` })
    const taShadow = await ta.evaluate((el) => getComputedStyle(el).boxShadow)
    if (taShadow !== 'none') errors.push(`[${tag}] textarea 自带焦点环: ${taShadow}`)
  }

  // 打开设置弹窗（窄屏侧栏是抽屉，先展开）
  if (s.viewport.width < 768) {
    await page.getByRole('button', { name: '展开侧边栏' }).first().click()
    await page.waitForTimeout(500)
  }
  await page.getByRole('button', { name: '设置' }).first().click()

  // 进场动画断言
  await page.waitForTimeout(110)
  await page.screenshot({ path: `${out}smoke-${tag}-settings-enter.png` })
  const entering = await page.evaluate(() => {
    const p = document.querySelector('[role="dialog"]')
    return p ? getComputedStyle(p).animationName : 'unmounted'
  })
  if (!entering.includes('modal-rise')) errors.push(`[${tag}] 弹窗进场动画缺失: ${entering}`)

  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}smoke-${tag}-settings.png` })

  // 系统提示词：填入后关闭/重载/重开，确认 IndexedDB 自动持久化
  if (tag === 'desktop-light') {
    // 「全局系统提示词」现在归在「提示词与助手」标签下（默认打开的是「常规与模型」），
    // 不先切标签会误报「设置里缺少全局系统提示词输入框」。
    await page.getByRole('tab', { name: '提示词与助手' }).first().click()
    await page.waitForTimeout(500)
    const systemPrompt = page.getByLabel('全局系统提示词')
    const probe = 'smoke 系统提示词持久化检查'
    if ((await systemPrompt.count()) === 0) {
      errors.push(`[${tag}] 设置里缺少全局系统提示词输入框`)
    } else {
      await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]')
        const p = document.querySelector('#global-system-prompt')
        if (d && p) d.scrollTop = p.getBoundingClientRect().top - d.getBoundingClientRect().top - 80
      })
      await page.mouse.move(4, 4)
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${out}smoke-${tag}-system-prompt.png` })
      await systemPrompt.fill(probe)
      await page.waitForTimeout(250)
      if ((await page.getByText('已启用', { exact: true }).count()) === 0) {
        errors.push(`[${tag}] 系统提示词状态没有显示已启用`)
      }
      await page.getByRole('button', { name: '关闭' }).first().click()
      await page.waitForTimeout(300)
      await page.reload({ waitUntil: 'networkidle', timeout: 30000 })
      await page.waitForTimeout(800)
      await page.getByRole('button', { name: '设置' }).first().click()
      await page.waitForTimeout(700)
      // 重载后标签回到默认项，同样要先切回「提示词与助手」
      await page.getByRole('tab', { name: '提示词与助手' }).first().click()
      await page.waitForTimeout(500)
      const restored = await page.getByLabel('全局系统提示词').inputValue().catch(() => '')
      if (restored !== probe) errors.push(`[${tag}] 系统提示词未持久化：${JSON.stringify(restored)}`)
      await page.getByLabel('全局系统提示词').fill('')
    }
  }

  // 独立输入框焦点态（全局实色环）
  const custom = page.getByLabel('自定义模型名称')
  if (await custom.count()) {
    await custom.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}smoke-${tag}-settings-focus.png` })
  }

  // 「模型服务」面板
  const addProvider = page.getByRole('button', { name: '添加自定义服务商' })
  if (await addProvider.count()) {
    await addProvider.scrollIntoViewIfNeeded()
    await page.mouse.move(4, 4)
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${out}smoke-${tag}-providers.png` })

    await addProvider.click()
    await page.waitForTimeout(250)
    await page.getByPlaceholder('例如：我的中转站').fill('测试中转站')
    await page.getByPlaceholder('https://api.example.com/v1').fill('http://127.0.0.1:8084/v1')
    await page.getByPlaceholder(/gpt-4o-mini/).fill('space-bunny-free')
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${out}smoke-${tag}-provider-form.png` })
    await page.getByRole('button', { name: '取消' }).last().click()
    await page.waitForTimeout(250)
  }

  // 滚到底：主题分段控件 + 快捷开关 + 数据区
  await page.mouse.move(4, 4)
  await page.evaluate(() => {
    const p = document.querySelector('[role="dialog"]')
    if (p) p.scrollTop = p.scrollHeight
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}smoke-${tag}-settings-bottom.png` })

  // 主题切换：应短暂挂上 .theme-anim 让整站渐变
  const opposite = s.colorScheme === 'dark' ? '浅色' : '深色'
  const themeBtn = page.getByRole('button', { name: opposite })
  if (await themeBtn.count()) {
    await themeBtn.click()
    const animOn = await page.evaluate(() =>
      document.documentElement.classList.contains('theme-anim')
    )
    await page.waitForTimeout(90)
    await page.screenshot({ path: `${out}smoke-${tag}-theme-switch.png` })
    await page.waitForTimeout(420)
    const animOff = await page.evaluate(() =>
      document.documentElement.classList.contains('theme-anim')
    )
    if (!animOn) errors.push(`[${tag}] 主题切换未启用全局过渡`)
    if (animOff) errors.push(`[${tag}] 主题过渡类未按时清理`)
    await page.getByRole('button', { name: '跟随系统' }).click()
    await page.waitForTimeout(300)
  }

  // 退场动画断言
  await page.getByRole('button', { name: '关闭' }).first().click()
  await page.waitForTimeout(70)
  const exiting = await page.evaluate(() => {
    const p = document.querySelector('[role="dialog"]')
    return p ? getComputedStyle(p).animationName : 'unmounted'
  })
  if (exiting !== 'modal-sink') errors.push(`[${tag}] 弹窗退场动画缺失: ${exiting}`)
  await page.screenshot({ path: `${out}smoke-${tag}-settings-exit.png` })
  await page.waitForTimeout(500)
  if (await page.evaluate(() => !!document.querySelector('[role="dialog"]'))) {
    errors.push(`[${tag}] 弹窗退场后未卸载`)
  }

  // 越界 + 溢出
  const bad = await outOfBounds(page)
  if (bad.length) errors.push(`[${tag}] 越界:\n    ` + bad.join('\n    '))
  await ctx.close()
}

/* ───────────────── 第二组：对话态（含长会话分段渲染） ───────────────── */

/** 向 IndexedDB 播种一个会话。zustand persist 用 idb-keyval，键名 flychat-store */
async function seedConversation(page, messages, title) {
  await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 })
  // 必须等应用 hydrate 完成，否则它会把空状态写回 IDB 覆盖播种
  await page.waitForTimeout(1500)
  return page.evaluate(
    ({ messages, title }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('keyval-store', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('keyval')
        req.onsuccess = () => {
          const tx = req.result.transaction('keyval', 'readwrite')
          tx.objectStore('keyval').put(
            JSON.stringify({
              state: {
                conversations: [
                  {
                    id: 'c1',
                    title,
                    createdAt: Date.now() - messages.length * 60000,
                    updatedAt: Date.now(),
                    messages,
                  },
                ],
                activeId: 'c1',
                settings: {
                  provider: 'anthropic',
                  model: 'space-bunny-free',
                  compareModels: [],
                  compareEnabled: false,
                  temperature: 0.7,
                  topP: 1,
                  maxTokens: 4096,
                  systemPrompt: '',
                  theme: 'light',
                  webSearch: false,
                  thinking: false,
                  usingContext: true,
                },
                prompts: [],
                assistants: [],
                hydrated: true,
              },
              version: 0,
            }),
            'flychat-store'
          )
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      }),
    { messages, title }
  )
}

function seedMessages(count) {
  const now = Date.now()
  const list = []
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      list.push({
        id: `u${i}`,
        role: 'user',
        content: `第 ${i + 1} 条提问：这句话用于验证长会话的分段渲染。`,
        createdAt: now - (count - i) * 60000,
      })
    } else {
      list.push({
        id: `a${i}`,
        role: 'assistant',
        model: 'space-bunny-free',
        status: 'done',
        createdAt: now - (count - i) * 60000 + 30000,
        content: `第 ${i + 1} 条回答，含行内代码 \`foo()\` 与列表。`,
      })
    }
  }
  return list
}

const CHAT_CASES = [
  { name: 'chat-desktop-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light', messages: 2 },
  { name: 'chat-desktop-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark', messages: 2 },
  { name: 'chat-mobile-narrow', viewport: { width: 320, height: 720 }, colorScheme: 'light', messages: 2 },
  { name: 'chat-long', viewport: { width: 1440, height: 900 }, colorScheme: 'light', messages: 90 },
]

for (const c of CHAT_CASES) {
  const ctx = await browser.newContext({ viewport: c.viewport, colorScheme: c.colorScheme })
  const page = await ctx.newPage()
  const tag = c.name
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`))

  await seedConversation(page, seedMessages(c.messages), '分段渲染测试会话')
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 })
  // 等 provider 列表拉取完成：模型名后缀出现后才是顶栏最宽的稳定态
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${out}smoke-${tag}.png` })

  // ── 分段渲染断言 ──
  const shown = await page.locator('.markdown-body').count()
  console.log(`${tag}: 渲染 ${shown} / ${c.messages} 条`)
  if (c.messages > 40) {
    if (shown > 60) errors.push(`[${tag}] 默认渲染过多（${shown}），分段未生效`)
    const loadMore = page.getByRole('button', { name: /加载更早的/ })
    if ((await loadMore.count()) === 0) errors.push(`[${tag}] 超过 40 条却未出现「加载更早」`)
    else {
      // 每页 40 条，90 条要连点两次才能展开完，所以循环直到按钮消失
      let clicks = 0
      while ((await loadMore.count()) > 0 && clicks < 6) {
        await loadMore.click()
        await page.waitForTimeout(500)
        clicks++
      }
      const expanded = await page.locator('.markdown-body').count()
      const expected = Math.floor(c.messages / 2)
      if (expanded !== expected) {
        errors.push(`[${tag}] 展开后消息数不符：期望 ${expected}，实际 ${expanded}`)
      }
      if ((await loadMore.count()) > 0) errors.push(`[${tag}] 连点 ${clicks} 次仍有剩余按钮`)
      console.log(`${tag}: 分段加载 ${shown} → ${expanded}（${clicks} 次）`)
      await page.screenshot({ path: `${out}smoke-${tag}-expanded.png` })
    }
  }

  // 悬停助手消息，验证操作栏
  const bubble = page.locator('.markdown-body').first()
  if (await bubble.count()) {
    await bubble.hover()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}smoke-${tag}-hover.png` })
  }

  // 窄屏侧栏是抽屉，需先展开才能聚焦会话项（与真实 UX 一致）
  if (c.viewport.width < 768) {
    await page.getByRole('button', { name: '展开侧边栏' }).first().click()
    await page.waitForTimeout(400)
  }

  // 键盘可达性：会话项应可聚焦
  await page.locator('[role="listitem"]').first().focus()
  if ((await page.evaluate(() => document.activeElement?.getAttribute('role')) !== 'listitem')) {
    errors.push(`[${tag}] 会话项不可键盘聚焦`)
  }

  // 导出菜单：打开 → Esc 关闭 → 有退场动画
  if (c.viewport.width >= 768) {
    await page.getByRole('button', { name: '导出' }).first().click()
    await page.waitForTimeout(300)
    if ((await page.getByRole('menu').count()) === 0) errors.push(`[${tag}] 导出菜单未打开`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(50)
    const exitAnim = await page.evaluate(() => {
      const m = document.querySelector('[role="menu"]')
      return m ? getComputedStyle(m).animationName : 'unmounted'
    })
    await page.waitForTimeout(350)
    if (exitAnim !== 'menu-out') errors.push(`[${tag}] 下拉退场动画缺失: ${exitAnim}`)
    if ((await page.getByRole('menu').count()) !== 0) errors.push(`[${tag}] 菜单退场后未卸载`)
  }

  // 快捷键面板：? 打开 / Esc 关闭
  await page.keyboard.press('?')
  await page.waitForTimeout(450)
  if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) {
    errors.push(`[${tag}] 按 ? 未打开快捷键面板`)
  }
  await page.screenshot({ path: `${out}smoke-${tag}-shortcuts.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  if (await page.evaluate(() => !!document.querySelector('[role="dialog"]'))) {
    errors.push(`[${tag}] Esc 未关闭快捷键面板`)
  }

  // 顶栏高度 + 越界
  const headerH = await page.evaluate(() => document.querySelector('header')?.clientHeight ?? 0)
  if (headerH > 58) errors.push(`[${tag}] 顶栏被撑高到 ${headerH}px（标题换行 / truncate 失效）`)
  const bad = await outOfBounds(page)
  if (bad.length) errors.push(`[${tag}] 越界:\n    ` + bad.join('\n    '))

  console.log('shot ok:', tag)
  await ctx.close()
}

/* ───────────────── 第三组：减少动效降级 ───────────────── */

{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push('[reduced-motion] pageerror: ' + e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('[reduced-motion] console: ' + m.text())
  })
  await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.waitForTimeout(80)
  if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) {
    errors.push('[reduced-motion] 弹窗未立即出现')
  }
  await page.getByRole('button', { name: '关闭' }).first().click()
  await page.waitForTimeout(80)
  if (await page.evaluate(() => !!document.querySelector('[role="dialog"]'))) {
    errors.push('[reduced-motion] 弹窗未立即卸载（退场动画未降级）')
  }
  console.log('shot ok: reduced-motion')
  await ctx.close()
}

await browser.close()
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console/page errors, no overflow')
