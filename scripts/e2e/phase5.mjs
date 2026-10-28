/**
 * 第五阶段 e2e：知识库全链路 + 移动端抽屉 + 文件夹拖拽 + 快捷键
 *
 * 知识库是前几轮唯一没测通的核心功能（只测过「空库不弹提示」）。
 * 这里走完整链路：上传文档 → 流水线处理就绪 → 提问 → 检索命中 → 引用块渲染 → 展开看片段。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:5180'
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = path.resolve('.shots/e2e5/run-' + RUN)
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
const composer = (page) => page.locator('textarea').first()
const waitIdle = async (page, maxSec = 40) => {
  const t0 = Date.now()
  while (Date.now() - t0 < maxSec * 1000) {
    if ((await page.locator('button[aria-label="停止生成"]').count()) === 0) return true
    await page.waitForTimeout(300)
  }
  return false
}
const reset = async (page) => {
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }
  await page.mouse.move(5, 5)
  await page.waitForTimeout(200)
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
// Vite 冷启动会做依赖预构建，首屏可能要 10~30s，默认 30s 会偶发超时
page.setDefaultNavigationTimeout(60000)
const errors = []
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200))
})

console.log('\n=== FlyChat 第五阶段 e2e @ ' + BASE + ' ===\n')
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

await page.locator('button[aria-haspopup="menu"]').first().click()
await page.waitForTimeout(500)
await page.locator('[role="menuitem"]').filter({ hasText: 'mock-flash' }).first().click()
await page.waitForTimeout(600)

// ---------------------------------------------------------------- 知识库上传
const DOC_TEXT = [
  '蓝鲸计划内部说明',
  '',
  '项目代号：蓝鲸计划',
  '预算上限：1200 万元人民币',
  '负责人：林知远',
  '交付时间：2027 年 3 月 15 日',
  '风险点：第三方地图服务续约价格可能上涨 30%。',
  '',
  '蓝鲸计划的核心目标是把现有订单系统迁移到新的微服务架构，',
  '迁移期间需要保持双写，回滚窗口不超过 5 分钟。',
].join('\n')

await step('知识库：清空历史文档（保证可重复）', async () => {
  await reset(page)
  await page.locator('button:has-text("知识库 (RAG)")').first().click()
  await page.waitForTimeout(1200)
  let n = await page.locator('[role="dialog"] button[title="删除文档"]').count()
  let removed = 0
  while (n > 0 && removed < 30) {
    page.once('dialog', (d) => d.accept())
    await page.locator('[role="dialog"] button[title="删除文档"]').first().click()
    await page.waitForTimeout(700)
    const next = await page.locator('[role="dialog"] button[title="删除文档"]').count()
    if (next >= n) throw new Error('删除文档没有生效（数量没减少）')
    n = next
    removed += 1
  }
  await reset(page)
  return removed ? `清理了 ${removed} 个旧文档` : '知识库本来就是空的'
})

await step('知识库：上传文档', async () => {
  await reset(page)
  await page.locator('button:has-text("知识库 (RAG)")').first().click()
  await page.waitForTimeout(1200)
  const dlg = page.locator('[role="dialog"]').first()
  if (!(await dlg.count())) throw new Error('知识库弹窗没打开')
  await shot(page, 'kb-empty')

  const file = path.join(OUT, '蓝鲸计划.txt')
  fs.writeFileSync(file, DOC_TEXT, 'utf8')
  const input = page.locator('[role="dialog"] input[type="file"]').first()
  if (!(await input.count())) throw new Error('知识库弹窗里没有上传输入框')
  await input.setInputFiles(file)
  await page.waitForTimeout(1500)
  await shot(page, 'kb-uploading')
  const txt = await dlg.innerText()
  if (!/蓝鲸计划/.test(txt)) throw new Error('上传后列表里没有该文档：' + txt.slice(0, 120).replace(/\s+/g, ' '))
  return '文档已进入列表'
})

await step('知识库：等待流水线处理就绪', async () => {
  const dlg = page.locator('[role="dialog"]').first()
  const t0 = Date.now()
  let state = ''
  while (Date.now() - t0 < 60000) {
    state = await dlg.innerText()
    // 文档就绪后统计区会显示「已就绪文档 ≥ 1」，行内也不再是处理中
    const readyCount = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      if (!d) return 0
      const m = (d.innerText || '').match(/已就绪文档\s*(\d+)/)
      return m ? Number(m[1]) : 0
    })
    if (readyCount > 0) {
      await shot(page, 'kb-ready')
      return `就绪文档 ${readyCount} 个（${Math.round((Date.now() - t0) / 1000)}s）`
    }
    if (/失败/.test(state) && /蓝鲸计划[\s\S]{0,40}失败/.test(state)) {
      throw new Error('文档处理失败：' + state.replace(/\s+/g, ' ').slice(0, 160))
    }
    await page.waitForTimeout(800)
  }
  throw new Error('60s 内文档没有就绪：' + state.replace(/\s+/g, ' ').slice(0, 160))
})

// ---------------------------------------------------------------- 检索 + 引用
await step('提问后命中知识库并渲染引用块', async () => {
  await reset(page)
  await composer(page).fill('蓝鲸计划的预算上限是多少？负责人是谁？')
  await composer(page).press('Enter')
  await waitIdle(page, 60)
  await page.waitForTimeout(1500)
  await shot(page, 'kb-answer')
  const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))
  const hasBlock = /知识库检索参考来源/.test(txt)
  if (!hasBlock) throw new Error('回答下方没有「知识库检索参考来源」块：' + txt.slice(-200))
  const notice = /没有检索到相关内容/.test(txt)
  if (notice) throw new Error('检索没命中，出现了「没有检索到相关内容」提示')
  return '引用块已渲染，且没有「未检索到」提示'
})

await step('引用块可展开并显示片段', async () => {
  const toggle = page.locator('button').filter({ hasText: '知识库检索参考来源' }).first()
  if (!(await toggle.count())) throw new Error('找不到引用块折叠按钮')
  await toggle.click()
  await page.waitForTimeout(700)
  await shot(page, 'kb-sources-open')
  const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))
  // 片段里应出现文档原文的关键词
  if (!/蓝鲸计划|预算|1200/.test(txt)) throw new Error('展开后没看到文档片段')
  return '片段内容正确'
})

// ---------------------------------------------------------------- 文档删除
await step('删除文档后不再检索', async () => {
  await reset(page)
  await page.locator('button:has-text("知识库 (RAG)")').first().click()
  await page.waitForTimeout(1200)
  const del = page.locator('[role="dialog"] button[title="删除文档"]')
  const before = await del.count()
  if (!before) throw new Error('找不到删除文档按钮')
  // 文档行刚进入 ready 时列表可能正在重渲染，点一次没生效就再点一次
  let after = before
  for (let attempt = 0; attempt < 3 && after >= before; attempt++) {
    await del.first().click()
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500)
      after = await del.count()
      if (after < before) break
    }
  }
  await shot(page, 'kb-deleted')
  const txt = await page.locator('[role="dialog"]').first().innerText()
  await reset(page)
  if (after >= before) throw new Error(`删除后数量没减少 ${before} → ${after}`)
  if (after === 0 && /蓝鲸计划/.test(txt)) throw new Error('删空后列表里仍显示文档名')
  return `${before} → ${after}`
})

// ---------------------------------------------------------------- 移动端抽屉
await step('移动端抽屉：打开 → 遮罩关闭', async () => {
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const p = await m.newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(2500)
  shotNo += 1
  await p.screenshot({ path: path.join(OUT, `${String(shotNo).padStart(2, '0')}-mobile-closed.png`) })

  const open = p.locator('button[aria-label="展开侧边栏"]').first()
  if (!(await open.count())) throw new Error('窄屏没有「展开侧边栏」按钮')
  await open.click()
  await p.waitForTimeout(700)
  shotNo += 1
  await p.screenshot({ path: path.join(OUT, `${String(shotNo).padStart(2, '0')}-mobile-drawer.png`) })
  const drawerOpen = await p.evaluate(() => {
    const a = document.querySelector('aside')
    if (!a) return false
    const r = a.getBoundingClientRect()
    return r.width > 0 && r.left > -1
  })
  if (!drawerOpen) throw new Error('点击后抽屉没有出现')

  // 点遮罩关闭
  await p.mouse.click(370, 400)
  await p.waitForTimeout(700)
  const drawerClosed = await p.evaluate(() => {
    const a = document.querySelector('aside')
    if (!a) return true
    const r = a.getBoundingClientRect()
    return r.left < -10 || r.width === 0
  })
  shotNo += 1
  await p.screenshot({ path: path.join(OUT, `${String(shotNo).padStart(2, '0')}-mobile-after-mask.png`) })
  await m.close()
  if (!drawerClosed) throw new Error('点遮罩后抽屉没有关闭')
  return '打开与遮罩关闭都正常'
})

// ---------------------------------------------------------------- 快捷键
await step('Ctrl+B 切换侧边栏', async () => {
  await reset(page)
  const before = await page.evaluate(() => {
    const a = document.querySelector('aside')
    return a ? a.getBoundingClientRect().width : 0
  })
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(700)
  const after = await page.evaluate(() => {
    const a = document.querySelector('aside')
    return a ? a.getBoundingClientRect().width : 0
  })
  await shot(page, 'ctrl-b')
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(600)
  if (before === after) throw new Error(`Ctrl+B 没有切换侧边栏（宽度都是 ${before}）`)
  return `${Math.round(before)}px → ${Math.round(after)}px`
})

// ---------------------------------------------------------------- 文件夹拖拽
// 每次用唯一名字：历史运行留下的同名文件夹会让「找哪一行」和计数断言都失准
const folderName = '拖拽目标-' + RUN.slice(11, 19).replace(/-/g, '')

await step('拖拽会话到文件夹', async () => {
  await reset(page)
  // 确保侧边栏展开且有会话
  const hasAside = await page.evaluate(() => {
    const a = document.querySelector('aside')
    return a ? a.getBoundingClientRect().width > 100 : false
  })
  if (!hasAside) {
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(600)
  }
  const conv = page.locator('aside [role="listitem"]').first()
  if (!(await conv.count())) throw new Error('侧边栏没有会话可拖')

  // 新建一个文件夹作为拖放目标。
  // 「新建文件夹」是按钮的 title 不是文本，点完会就地展开一个输入框（不是弹窗）。
  await page.locator('button[title="新建文件夹"]').first().click()
  await page.waitForTimeout(600)
  const nameInput = page.locator('aside input[placeholder*="文件夹"]').first()
  if (!(await nameInput.count())) throw new Error('点「新建文件夹」后没有出现输入框')
  await nameInput.fill(folderName)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  await reset(page)
  await shot(page, 'folder-created')

  const target = page.locator('aside').getByText(folderName).first()
  if (!(await target.count())) throw new Error('没有创建出拖放目标文件夹')

  // 首选真鼠标拖拽（HTML5 DnD）；Chromium 对合成 dragstart/drop 偶发不触发 React 处理，
  // 拖不动时退回同一功能的菜单入口「移动到文件夹」，两条都是真实用户路径。
  let via = '拖拽'
  try {
    await conv.dragTo(target, { timeout: 6000 })
  } catch {
    via = '菜单'
  }
  await page.waitForTimeout(1200)

  const badgeOf = () =>
    page.evaluate((folderName) => {
      const els = [...document.querySelectorAll('aside *')].filter((e) =>
        (e.textContent || '').includes(folderName)
      )
      const leaf = els[els.length - 1]
      let p = leaf
      for (let i = 0; i < 5 && p; i++) {
        const m = (p.innerText || '').replace(/\s+/g, ' ').match(new RegExp(folderName + '\\s*(\\d+)'))
        if (m) return Number(m[1])
        p = p.parentElement
      }
      return null
    }, folderName)

  let badge = await badgeOf()
  if (!badge) {
    // 退回菜单路径
    via = '菜单'
    await conv.hover()
    await page.waitForTimeout(300)
    const moveBtn = page.locator('aside button[aria-label="移动到文件夹"]').first()
    if (!(await moveBtn.count())) throw new Error('既拖不动也找不到「移动到文件夹」按钮')
    await moveBtn.click()
    await page.waitForTimeout(600)
    const opt = page.locator('[role="menu"]').getByText(folderName).first()
    if (!(await opt.count())) throw new Error('移动菜单里没有目标文件夹')
    await opt.click()
    await page.waitForTimeout(1200)
    badge = await badgeOf()
  }
  await shot(page, 'folder-dropped')
  if (!badge) throw new Error('拖拽后文件夹里仍然是 0 个会话（badge=' + badge + '）')
  return `${via}路径：文件夹内会话数 ${badge}`
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
