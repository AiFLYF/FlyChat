/**
 * 第二阶段 e2e：第一轮没覆盖到的功能面
 *  - 多模型对比（同时问两个模型）
 *  - 分享链接生成 + 打开 /s/:id 独立视图
 *  - 单条消息删除
 *  - 会话删除
 *  - 导出对话
 *  - 设置里 MCP / API 网关 / 数据备份 / 提示词面板可交互
 *
 * 经验：这类多弹层流程最怕「上一步留下遮罩」，后面全部超时。
 * 所以每步开头统一 reset（连按两次 Esc + 点空白处），让步骤彼此独立。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:5180'
// 每次运行写独立子目录：不删旧文件（沙箱的 safe-delete 钩子会拦批量删除并直接失败）
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = path.resolve('.shots/e2e2/run-' + RUN)
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
    const msg = String(e?.message || e).split('\n')[0].slice(0, 240)
    results.push({ name, ok: false, ms: Date.now() - t0, detail: msg })
    console.log(`  ✗ ${name}  →  ${msg}`)
  }
}
const composer = (page) => page.locator('textarea').first()
const waitIdle = async (page, maxSec = 40) => {
  const t0 = Date.now()
  while (Date.now() - t0 < maxSec * 1000) {
    if ((await page.locator('button[aria-label="停止生成"]').count()) === 0) return true
    await page.waitForTimeout(300)
  }
  return false
}
/** 清场：关掉所有浮层，确保下一步从干净状态开始 */
const reset = async (page) => {
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }
  await page.mouse.move(1439, 899)
  await page.waitForTimeout(200)
}
/** 窄屏/抽屉状态下把侧边栏打开 */
const ensureSidebar = async (page) => {
  const open = await page.evaluate(() => {
    const a = document.querySelector('aside')
    if (!a) return false
    const r = a.getBoundingClientRect()
    return r.width > 0 && r.left > -1
  })
  if (!open) {
    const expand = page.locator('button[aria-label="展开侧边栏"]')
    if (await expand.count()) {
      await expand.click()
      await page.waitForTimeout(600)
    } else {
      await page.keyboard.press('Control+b')
      await page.waitForTimeout(600)
    }
  }
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
})
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
})
const page = await ctx.newPage()
// Vite 冷启动会做依赖预构建，首屏可能要 10~30s，默认 30s 会偶发超时
page.setDefaultNavigationTimeout(60000)
const errors = []
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200))
})

console.log('\n=== FlyChat 第二阶段 e2e @ ' + BASE + ' ===\n')
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// 先切到 mock 模型（单模型）
await page.locator('button[aria-haspopup="menu"]').first().click()
await page.waitForTimeout(500)
await page.locator('[role="menuitem"]').filter({ hasText: 'mock-flash' }).first().click()
await page.waitForTimeout(600)

// ---------------------------------------------------------------- 多模型对比
await step('开启多模型对比并勾选两个模型', async () => {
  await page.locator('button[aria-haspopup="menu"]').first().click()
  await page.waitForTimeout(600)
  const sw = page.locator('[role="menu"] [role="switch"]').first()
  if (!(await sw.count())) throw new Error('菜单里没有多模型对比开关')
  if ((await sw.getAttribute('aria-checked')) !== 'true') {
    await sw.click()
    await page.waitForTimeout(500)
  }
  const items = page.locator('[role="menuitem"]')
  const n = await items.count()
  if (n < 2) throw new Error('可对比模型不足 2 个，实际 ' + n)
  const names = []
  for (const i of [0, 1]) {
    names.push((await items.nth(i).innerText()).replace(/\s+/g, ' ').trim())
    await items.nth(i).click()
    await page.waitForTimeout(350)
  }
  await shot(page, 'compare-menu')
  await reset(page)
  const trigger = await page.locator('button[aria-haspopup="menu"]').first().innerText()
  if (!/对比/.test(trigger)) throw new Error('触发按钮没进入对比态：' + trigger.replace(/\s+/g, ' '))
  return names.join(' + ') + ' → ' + trigger.replace(/\s+/g, ' ')
})

await step('对比模式发送并得到多列结果', async () => {
  await composer(page).fill('用一句话解释什么是 SSE 流式输出')
  await composer(page).press('Enter')
  await page.waitForTimeout(1200)
  await shot(page, 'compare-streaming')
  await waitIdle(page, 60)
  await page.waitForTimeout(1500)
  await shot(page, 'compare-result')
  // 上游挂掉的那一列渲染成错误块而不是 .markdown-body，所以不能只数 markdown 数量；
  // 用「对比头 + 每个模型名都出现」判断两列都渲染了
  const info = await page.evaluate(() => ({
    text: (document.body.innerText || '').replace(/\s+/g, ' '),
    markdown: document.querySelectorAll('.markdown-body').length,
    retryBtns: [...document.querySelectorAll('button')].filter((b) => /重试/.test(b.innerText || '')).length,
  }))
  const hasHeader = /多模型对比|个回答/.test(info.text)
  const hasBoth = /space-bunny-free/.test(info.text) && /mock-flash/.test(info.text)
  if (!hasHeader || !hasBoth) throw new Error(`对比结果不完整：header=${hasHeader} both=${hasBoth}`)
  return `两列都已渲染（markdown ${info.markdown} 个，重试按钮 ${info.retryBtns} 个）`
})

await step('关闭多模型对比', async () => {
  await page.locator('button[aria-haspopup="menu"]').first().click()
  await page.waitForTimeout(600)
  const sw = page.locator('[role="menu"] [role="switch"]').first()
  if (await sw.count()) {
    if ((await sw.getAttribute('aria-checked')) === 'true') await sw.click()
  }
  await page.waitForTimeout(500)
  await reset(page)
  const trigger = await page.locator('button[aria-haspopup="menu"]').first().innerText()
  if (/对比/.test(trigger)) throw new Error('仍处于对比态')
  return '已回到单模型：' + trigger.replace(/\s+/g, ' ')
})

// ---------------------------------------------------------------- 分享链接
let shareUrl = null
await step('生成公开分享链接', async () => {
  await reset(page)
  await page.locator('.markdown-body').last().hover()
  await page.locator('button[aria-label="生成分享卡片"]').last().click()
  await page.waitForTimeout(1400)
  const linkTab = page.locator('[role="dialog"] button').filter({ hasText: /链接|Link/ }).first()
  if (await linkTab.count()) {
    await linkTab.click()
    await page.waitForTimeout(600)
  }
  await shot(page, 'share-link-tab')
  const gen = page.locator('[role="dialog"] button').filter({ hasText: /生成|创建/ }).first()
  if (!(await gen.count())) throw new Error('找不到生成链接按钮')
  await gen.click()
  await page.waitForTimeout(3000)
  await shot(page, 'share-link-created')
  const txt = await page.locator('[role="dialog"]').innerText()
  const m = txt.match(/https?:\/\/[^\s"'）)]+\/(?:s|share)\/[^\s"'）)]+/)
  if (m) shareUrl = m[0]
  if (!shareUrl) {
    // 链接放在 readonly input 的 value 里，innerText 读不到，必须走 inputValue
    const input = page.locator('[role="dialog"] input[readonly]').first()
    if (await input.count()) {
      const v = await input.inputValue().catch(() => '')
      if (/^https?:/.test(v)) shareUrl = v
    }
  }
  await reset(page)
  if (!shareUrl) throw new Error('没有拿到分享链接；弹窗文本片段：' + txt.slice(0, 120).replace(/\s+/g, ' '))
  return shareUrl
})

await step('打开分享链接渲染独立视图', async () => {
  if (!shareUrl) throw new Error('上一步没有拿到链接')
  const p2 = await ctx.newPage()
  const errs = []
  p2.on('pageerror', (e) => errs.push(e.message))
  await p2.goto(shareUrl, { waitUntil: 'domcontentloaded' })
  await p2.waitForTimeout(3000)
  shotNo += 1
  await p2.screenshot({ path: path.join(OUT, `${String(shotNo).padStart(2, '0')}-shared-view.png`) })
  const info = await p2.evaluate(() => ({
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
    hasAside: !!document.querySelector('aside'),
    hasComposer: !!document.querySelector('textarea'),
  }))
  await p2.close()
  if (!/SSE|流式|闪测|mock/.test(info.text)) throw new Error('分享页没渲染出消息内容：' + info.text.slice(0, 100))
  if (errs.length) throw new Error('分享页报错：' + errs[0].slice(0, 120))
  return `内容正常，${info.hasAside ? '仍带侧边栏' : '无侧边栏'}，${info.hasComposer ? '仍可输入' : '只读'}`
})

// ---------------------------------------------------------------- 消息删除
await step('删除单条消息', async () => {
  await reset(page)
  const before = await page.locator('.markdown-body').count()
  await page.locator('.markdown-body').last().hover()
  await page.waitForTimeout(300)
  const del = page.locator('button[aria-label="删除消息"]').last()
  if (!(await del.count())) throw new Error('找不到删除消息按钮')
  await del.click()
  await page.waitForTimeout(900)
  await shot(page, 'msg-deleted')
  const after = await page.locator('.markdown-body').count()
  if (after >= before) throw new Error(`删除后数量没减少 ${before} → ${after}`)
  return `${before} → ${after}`
})

// ---------------------------------------------------------------- 导出
await step('导出对话下拉菜单', async () => {
  await reset(page)
  const exportBtn = page.locator('button[aria-label="导出"]').first()
  if (!(await exportBtn.count())) throw new Error('找不到导出按钮')
  await exportBtn.click()
  await page.waitForTimeout(700)
  await shot(page, 'export-menu')
  const items = await page.locator('[role="menuitem"]').allInnerTexts()
  await reset(page)
  if (!items.length) throw new Error('导出菜单没有选项')
  return '选项：' + items.map((s) => s.replace(/\s+/g, '')).join(' / ')
})

// ---------------------------------------------------------------- 设置面板
const openSettingsTab = async (label) => {
  await reset(page)
  await page.locator('button:has-text("设置")').first().click()
  await page.waitForTimeout(800)
  await page.locator(`[role="tab"]`).filter({ hasText: label }).first().click()
  await page.waitForTimeout(800)
}

for (const [label, expect, name] of [
  ['MCP', /MCP/, 'mcp'],
  ['API 网关', /网关|Token|令牌/, 'api'],
  ['数据与备份', /导出|备份|导入/, 'data'],
  ['提示词与助手', /提示词|助手/, 'prompts'],
]) {
  await step(`设置 · ${label} 面板可交互`, async () => {
    await openSettingsTab(label)
    await shot(page, `settings-${name}`)
    const txt = await page.locator('[role="dialog"]').innerText()
    if (!expect.test(txt)) throw new Error('面板内容异常：' + txt.slice(0, 100).replace(/\s+/g, ' '))
    await reset(page)
    return '渲染正常'
  })
}

await step('键盘导航：标签栏左右方向键', async () => {
  await openSettingsTab('常规与模型')
  // 弹窗可能还在退场/进场动画中，先等它稳定再操作
  await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(400)
  const tab = page.locator('[role="tab"]').first()
  if (!(await tab.count())) throw new Error('设置弹窗里没有 role=tab')
  await tab.focus({ timeout: 10000 })
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(500)
  const sel = await page.evaluate(() => {
    const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.getAttribute('aria-selected') === 'true')
    return (t?.innerText.trim() || '') + '|' + (document.activeElement === t)
  })
  await reset(page)
  if (!sel.endsWith('true')) throw new Error('方向键后焦点没跟着走：' + sel)
  return '焦点与选中同步：' + sel.split('|')[0]
})

// ---------------------------------------------------------------- 会话删除
await step('删除会话', async () => {
  await reset(page)
  await ensureSidebar(page)
  const before = await page.locator('aside [role="listitem"]').count()
  if (!before) throw new Error('侧边栏没有会话可删')
  const item = page.locator('aside [role="listitem"]').first()
  await item.hover()
  await page.waitForTimeout(400)
  const del = page.locator('aside button[aria-label="删除"]').first()
  if (!(await del.count())) throw new Error('找不到删除会话按钮')
  await del.click()
  await page.waitForTimeout(1000)
  await shot(page, 'conv-deleted')
  const after = await page.locator('aside [role="listitem"]').count()
  if (after >= before) throw new Error(`会话数没减少 ${before} → ${after}`)
  return `${before} → ${after}`
})

console.log('\n=== 结果汇总 ===')
const pass = results.filter((r) => r.ok).length
const fail = results.filter((r) => !r.ok)
console.log(`通过 ${pass}/${results.length}`)
for (const f of fail) console.log(`  ✗ ${f.name}  →  ${f.detail}`)
if (errors.length) {
  console.log('\n页面错误：')
  for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ! ' + e)
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, errors: [...new Set(errors)] }, null, 2), 'utf8')
console.log('\n截图目录：' + OUT)
await browser.close()
process.exitCode = fail.length ? 1 : 0
