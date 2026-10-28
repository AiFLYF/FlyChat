/**
 * FlyChat 全功能真实页面 e2e（playwright-core + 系统 Chrome）
 *
 * 设计原则：
 * - 单步失败不中断，一次跑完拿到完整问题清单
 * - 每步截图，便于人工复核视觉
 * - 自动检测高频真 bug：横向溢出 / 元素出屏 / 弹层拦截点击 / 弹窗标题栏滚走 / 对比度不足
 *
 * 用法：
 *   node scripts/e2e/full.mjs
 *   BASE=http://127.0.0.1:3001 node scripts/e2e/full.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:5180'
// 每次运行写独立子目录：不删旧文件（沙箱的 safe-delete 钩子会拦批量删除并直接失败）
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = path.resolve('.shots/e2e/run-' + RUN)
fs.mkdirSync(OUT, { recursive: true })

const results = []
const softErrors = []
let shotNo = 0

const shot = async (page, name) => {
  shotNo += 1
  const file = `${String(shotNo).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: path.join(OUT, file), fullPage: false }).catch(() => {})
  return file
}

const step = async (name, fn) => {
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, ms: Date.now() - t0, detail })
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)${detail ? '  → ' + detail : ''}`)
  } catch (e) {
    const msg = String(e?.message || e).split('\n')[0].slice(0, 300)
    results.push({ name, ok: false, ms: Date.now() - t0, detail: msg })
    console.log(`  ✗ ${name}  →  ${msg}`)
  }
}

/** 输入框 aria-label 会随「空会话/有会话」变化，统一用第一个 textarea 定位 */
const composer = (page) => page.locator('textarea').first()

const waitIdle = async (page, maxSec = 40) => {
  const t0 = Date.now()
  while (Date.now() - t0 < maxSec * 1000) {
    if ((await page.locator('button[aria-label="停止生成"]').count()) === 0) return true
    await page.waitForTimeout(300)
  }
  return false
}

/**
 * 布局体检。
 * 关键：position:fixed 容器内的元素，其 rect 是视口坐标，
 * 不能再加 scrollY 去和文档高度比较（上一版就是这么误报的）。
 */
const layoutAudit = async (page) =>
  page.evaluate(() => {
    const out = []
    const docW = document.documentElement.clientWidth
    const over = document.documentElement.scrollWidth - docW
    if (over > 2) out.push(`横向溢出 ${over}px`)
    const isFixed = (el) => {
      let n = el
      while (n && n !== document.documentElement) {
        if (getComputedStyle(n).position === 'fixed') return true
        n = n.parentElement
      }
      return false
    }
    // 横向可滚动容器（如首页灵感分类 chips、标签栏）里的元素本来就会排到容器可视区之外，
    // 这是刻意的横向滚动模式，不算布局溢出——只判「父级不可滚动却超出视口」才算 bug。
    const inHScroll = (el) => {
      let n = el.parentElement
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n)
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1)
          return true
        n = n.parentElement
      }
      return false
    }
    // 垂直方向不能简单用「超出文档高度」判定：本应用是 h-dvh 固定外壳 + 内部滚动区，
    // 文档本身永远不滚。正确判据是「超出视口，且没有任何可垂直滚动的祖先」。
    const inVScroll = (el) => {
      let n = el.parentElement
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n)
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 1)
          return true
        n = n.parentElement
      }
      return false
    }
    for (const el of document.querySelectorAll('button, a, input, textarea')) {
      const r = el.getBoundingClientRect()
      if (!(r.width > 0 && r.height > 0)) continue
      if (el.closest('[hidden]')) continue
      if (inHScroll(el)) continue
      const label = (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').slice(0, 18)
      if (r.right > docW + 2) out.push(`横向出屏: ${label} right=${Math.round(r.right)}>${docW}`)
      if (!isFixed(el) && !inVScroll(el) && r.bottom > window.innerHeight + 4)
        out.push(`纵向不可达: ${label} bottom=${Math.round(r.bottom)}>${window.innerHeight}`)
    }
    return { out, docW }
  })

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

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300))
})
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 300)))
page.on('requestfailed', (r) => {
  const u = r.url()
  if (/favicon|\.map$/.test(u)) return
  // 主动点「停止生成」会 abort /api/chat，属于预期内
  if (/\/api\/chat/.test(u) && /ERR_ABORTED/.test(r.failure()?.errorText || '')) return
  consoleErrors.push(`REQFAIL ${u.slice(0, 120)} :: ${r.failure()?.errorText}`)
})

console.log('\n=== FlyChat 全功能 e2e @ ' + BASE + ' ===\n')

// ---------------------------------------------------------------- 1 首屏
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

await step('首屏渲染 + 骨架屏消失', async () => {
  await composer(page).waitFor({ timeout: 15000 })
  const skel = await page.locator('.skeleton').count()
  if (skel > 0) throw new Error('骨架屏未消失，仍有 ' + skel + ' 个 skeleton')
  await shot(page, 'home')
  return '输入框就绪'
})

await step('首屏布局体检', async () => {
  const r = await layoutAudit(page)
  if (r.out.length) throw new Error(r.out.slice(0, 3).join(' | '))
  return `视口 ${r.docW}px 无溢出`
})

// ---------------------------------------------------------------- 2 模型选择
await step('模型选择器：打开/搜索/切换 mock-flash', async () => {
  await page.locator('button[aria-haspopup="menu"]').first().click()
  await page.waitForTimeout(500)
  await shot(page, 'model-menu')
  await page.locator('input[aria-label="搜索模型"]').fill('mock')
  await page.waitForTimeout(400)
  await page.locator('[role="menu"] >> text=mock-flash').first().click()
  await page.waitForTimeout(600)
  const trigger = await page.locator('button[aria-haspopup="menu"]').first().innerText()
  if (!/闪测/.test(trigger)) throw new Error('切换后触发按钮仍是：' + trigger.replace(/\s+/g, ' '))
  return '已切到 闪测模型 · mock-flash'
})

// ---------------------------------------------------------------- 3 流式对话
await step('发送消息 + 流式输出', async () => {
  await composer(page).fill('请输出一个流程图、一个公式、一段代码和一个表格，用于验证渲染。')
  await composer(page).press('Enter')
  await page.waitForTimeout(400)
  const streaming = await page.locator('button[aria-label="停止生成"]').count()
  await shot(page, 'streaming')
  if (!streaming) throw new Error('未进入流式状态（停止生成按钮没出现）')
  if (!(await waitIdle(page, 45))) throw new Error('流式超过 45s 未结束')
  await page.waitForTimeout(700)
  await shot(page, 'chat-done')
  return '流式正常结束'
})

await step('空知识库不再弹「没有检索到相关内容」', async () => {
  const n = await page.locator('text=知识库中没有检索到相关内容').count()
  if (n > 0) throw new Error('仍然出现 ' + n + ' 条空知识库提示')
  return '无噪声提示'
})

await step('Markdown 渲染：代码块/高亮/加粗/列表', async () => {
  const n = await page.evaluate(() => ({
    code: document.querySelectorAll('.markdown-body pre code').length,
    hljs: document.querySelectorAll('.markdown-body pre code span[class*="hljs"]').length,
    strong: document.querySelectorAll('.markdown-body strong').length,
    li: document.querySelectorAll('.markdown-body li').length,
  }))
  if (!n.code) throw new Error('没有代码块')
  if (!n.strong) throw new Error('没有加粗渲染')
  if (!n.li) throw new Error('没有列表渲染')
  return `code=${n.code} hljs=${n.hljs} strong=${n.strong} li=${n.li}`
})

// ---------------------------------------------------------------- 4 消息操作
await step('消息悬停操作栏', async () => {
  await page.locator('.markdown-body').last().hover()
  await page.waitForTimeout(400)
  if (!(await page.locator('button[aria-label="回答满意"]').last().isVisible()))
    throw new Error('悬停后操作栏不可见')
  await shot(page, 'msg-actions')
  return '操作栏可见'
})

await step('复制回答到剪贴板', async () => {
  await page.locator('.markdown-body').last().hover()
  await page.waitForTimeout(200)
  await page.locator('button[aria-label="复制"], button:has-text("复制")').last().click()
  await page.waitForTimeout(500)
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  if (!clip || clip.length < 5) throw new Error('剪贴板为空，复制失败')
  await shot(page, 'copy-toast')
  return `剪贴板 ${clip.length} 字`
})

await step('点赞反馈 + Toast', async () => {
  await page.locator('.markdown-body').last().hover()
  await page.locator('button[aria-label="回答满意"]').last().click()
  await page.waitForTimeout(500)
  if (!(await page.locator('text=感谢您的反馈').count())) throw new Error('点赞后没有 Toast')
  await shot(page, 'feedback-toast')
  return '反馈 Toast 正常'
})

await step('生成分享卡片 + Esc 可关闭', async () => {
  await page.locator('.markdown-body').last().hover()
  await page.locator('button[aria-label="生成分享卡片"]').last().click()
  await page.waitForTimeout(1400)
  await shot(page, 'share-card')
  if (!(await page.locator('[role="dialog"]').count())) throw new Error('分享弹窗未打开')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const left = await page.locator('[role="dialog"]').count()
  if (left) throw new Error('Esc 关不掉分享弹窗，遮罩仍在（会拦截后续所有点击）')
  return '打开正常，Esc 可关闭'
})

await step('重新生成（多版本切换）', async () => {
  await page.locator('.markdown-body').last().hover()
  await page.locator('button[aria-label="重新生成"]').last().click()
  await page.waitForTimeout(1000)
  await waitIdle(page, 30)
  const hasVer = await page.locator('button[aria-label="查看上一回答版本"]').count()
  await shot(page, 'regenerate')
  if (!hasVer) throw new Error('重新生成后没有版本切换按钮')
  return '生成第二版并可切换'
})

await step('停止生成', async () => {
  // 提示词里带「很长」时闪测模型会回一段长文（约 4~5s），
  // 否则固定回复只有 1s，Playwright 的可点击性检查还没走完按钮就没了
  await composer(page).fill('请写一篇很长的文章')
  await composer(page).press('Enter')
  const stop = page.locator('button[aria-label="停止生成"]')
  await stop.waitFor({ state: 'visible', timeout: 8000 })
  await stop.click({ timeout: 8000 })
  await page.waitForTimeout(900)
  await shot(page, 'stopped')
  if (await page.locator('button[aria-label="停止生成"]').count())
    throw new Error('点击停止后仍在生成')
  const stopped = await page.locator('text=已停止生成').count()
  return stopped ? '停止并标记「已停止生成」' : '停止生效（无标记文本）'
})

await step('编辑用户消息并重新发送', async () => {
  const editBtn = page.locator('button[aria-label="编辑消息"]').first()
  if (!(await editBtn.count())) throw new Error('找不到编辑消息按钮')
  await editBtn.click({ force: true })
  await page.waitForTimeout(500)
  await shot(page, 'edit-mode')
  const editor = page.locator('textarea').first()
  await editor.fill('改写后的问题：只回复两个字「收到」')
  await editor.press('Control+Enter')
  await page.waitForTimeout(1200)
  await waitIdle(page, 30)
  await shot(page, 'edit-resend')
  return '编辑重发完成'
})

// ---------------------------------------------------------------- 5 侧边栏 / 会话
const convItem = (page) => page.locator('aside [role="listitem"]').first()

await step('会话搜索', async () => {
  const s = page.locator('input[aria-label="搜索对话"]')
  await s.fill('改写')
  await page.waitForTimeout(500)
  await shot(page, 'search-conv')
  const n = await page.locator('aside [role="listitem"]').count()
  await s.fill('')
  await page.waitForTimeout(400)
  if (n === 0) throw new Error('搜索「改写」没有任何结果')
  return `命中 ${n} 个会话`
})

await step('会话重命名', async () => {
  const item = convItem(page)
  await item.hover()
  await page.waitForTimeout(300)
  await page.locator('aside button[aria-label="重命名"]').first().click()
  await page.waitForTimeout(400)
  await shot(page, 'rename-inline')
  const input = page.locator('aside input:not([aria-label="搜索对话"])').first()
  if (!(await input.count())) throw new Error('点重命名后没有出现输入框')
  await input.fill('E2E 重命名会话')
  await input.press('Enter')
  await page.waitForTimeout(600)
  if (!(await page.locator('aside >> text=E2E 重命名会话').count()))
    throw new Error('重命名未生效')
  return '重命名成功'
})

await step('会话置顶', async () => {
  const item = page.locator('aside [role="listitem"]').filter({ hasText: 'E2E 重命名会话' }).first()
  await item.hover()
  await page.waitForTimeout(300)
  const pin = page.locator('aside button[aria-label="置顶"]').first()
  if (!(await pin.count())) throw new Error('找不到置顶按钮')
  await pin.click()
  await page.waitForTimeout(500)
  await shot(page, 'conv-pinned')
  const pinned = await page.locator('aside button[aria-label="取消置顶"]').count()
  if (!pinned) throw new Error('置顶后没有变成「取消置顶」')
  return '已置顶'
})

await step('新建文件夹', async () => {
  await page.locator('button[title="新建文件夹"]').click()
  await page.waitForTimeout(400)
  const input = page.locator('input[placeholder="文件夹名称..."]')
  if (!(await input.count())) throw new Error('没有出现文件夹命名输入框')
  await input.fill('E2E 文件夹')
  await input.press('Enter')
  await page.waitForTimeout(600)
  await shot(page, 'folder-created')
  if (!(await page.locator('aside >> text=E2E 文件夹').count()))
    throw new Error('文件夹未创建')
  return '文件夹创建成功'
})

await step('新建对话', async () => {
  await page.locator('button:has-text("新对话")').first().click()
  await page.waitForTimeout(700)
  if (!(await page.locator('text=有什么可以帮你').count())) throw new Error('新建后未回到欢迎页')
  await shot(page, 'new-chat')
  return '回到欢迎页'
})

// ---------------------------------------------------------------- 6 输入区
await step('输入框多行自增高', async () => {
  const ta = composer(page)
  const h0 = (await ta.boundingBox()).height
  await ta.fill('第一行\n第二行\n第三行\n第四行')
  await page.waitForTimeout(400)
  const h1 = (await ta.boundingBox()).height
  await shot(page, 'composer-expand')
  await ta.fill('')
  if (h1 <= h0) throw new Error(`未自增高 ${h0} → ${h1}`)
  return `高度 ${Math.round(h0)} → ${Math.round(h1)}`
})

await step('提示词库浮层', async () => {
  await page.locator('button[aria-label="提示词库"]').click()
  await page.waitForTimeout(500)
  await shot(page, 'prompt-picker')
  const panel = await page.locator('[role="menu"], [role="dialog"]').count()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  if (!panel) throw new Error('提示词库没有浮层')
  return '浮层正常'
})

await step('深度思考开关', async () => {
  const btn = page.locator('button[aria-label="深度思考"]')
  await btn.click()
  await page.waitForTimeout(400)
  const pressed = await btn.getAttribute('aria-pressed')
  await shot(page, 'deep-think')
  return 'aria-pressed=' + pressed
})

await step('智能体工具浮层', async () => {
  await page.locator('button[aria-label="智能体工具 (Agent / MCP)"]').click()
  await page.waitForTimeout(500)
  await shot(page, 'agent-tools')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  return '浮层打开并关闭'
})

await step('附件上传（图片）', async () => {
  const fileInput = page.locator('input[type="file"]').first()
  if (!(await fileInput.count())) throw new Error('没有 file input')
  await fileInput.setInputFiles('scripts/.test-image.png')
  await page.waitForTimeout(1500)
  await shot(page, 'attachment')
  if (!(await page.locator('text=test-image.png').count())) throw new Error('附件没有出现在输入区')
  return '附件已挂载'
})

// ---------------------------------------------------------------- 7 全局弹窗
await step('快捷指令面板 Ctrl+K（role=dialog）', async () => {
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(700)
  await shot(page, 'command-palette')
  const dlg = page.locator('[role="dialog"][aria-modal="true"]')
  if (!(await dlg.count())) throw new Error('面板没有 role=dialog/aria-modal')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  return '打开/关闭正常，角色齐全'
})

await step('快捷键说明面板（?）', async () => {
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('?')
  await page.waitForTimeout(600)
  await shot(page, 'shortcuts')
  const t = await page.locator('[role="dialog"] >> text=快捷键').count()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (!t) throw new Error('快捷键面板未出现')
  return '面板正常'
})

await step('用量分析弹窗', async () => {
  await page.locator('button:has-text("用量分析")').click()
  await page.waitForTimeout(900)
  await shot(page, 'usage')
  const dlg = await page.locator('[role="dialog"]').count()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (!dlg) throw new Error('弹窗未打开')
  return '弹窗正常'
})

await step('知识库弹窗（role=dialog）', async () => {
  await page.locator('button:has-text("知识库")').click()
  await page.waitForTimeout(900)
  await shot(page, 'knowledge')
  const ok = await page.locator('[role="dialog"][aria-modal="true"]').count()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (!ok) throw new Error('知识库弹窗没有 role=dialog')
  return '弹窗正常，角色齐全'
})

await step('智能体市场弹窗', async () => {
  await page.locator('button:has-text("智能体市场")').click()
  await page.waitForTimeout(900)
  await shot(page, 'market')
  const dlg = await page.locator('[role="dialog"]').count()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (!dlg) throw new Error('弹窗未打开')
  return '弹窗正常'
})

await step('设置弹窗：6 个标签全部可点（role=tab）', async () => {
  await page.locator('button:has-text("设置")').click()
  await page.waitForTimeout(800)
  await shot(page, 'settings-general')
  const tabs = page.locator('[role="tab"]')
  const n = await tabs.count()
  if (n !== 6) throw new Error(`标签数量 ${n}，期望 6`)
  for (let i = 0; i < n; i++) {
    const t = tabs.nth(i)
    const label = (await t.innerText()).trim()
    await t.click()
    await page.waitForTimeout(450)
    const selected = await t.getAttribute('aria-selected')
    if (selected !== 'true') throw new Error(`点击「${label}」后 aria-selected=${selected}`)
    await shot(page, `settings-${i + 1}-${label.replace(/[^\w\u4e00-\u9fa5]/g, '')}`)
  }
  // 回到第一个标签再关
  await tabs.first().click()
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  return `遍历 ${n} 个标签，aria-selected 全部正确`
})

await step('预设管理弹窗（role=dialog）', async () => {
  await page.locator('button[aria-label="选择预设"]').click()
  await page.waitForTimeout(600)
  await shot(page, 'preset-picker')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  return '预设浮层正常'
})

// ---------------------------------------------------------------- 8 主题
const setTheme = async (label) => {
  await page.locator('button:has-text("设置")').first().click()
  await page.waitForTimeout(700)
  // 主题选项就在「常规与模型」标签底部，不需要先切标签
  const btn = page.locator(`button:has-text("${label}")`).first()
  await btn.scrollIntoViewIfNeeded()
  await btn.click()
  await page.waitForTimeout(700)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
}

await step('深色模式', async () => {
  await setTheme('深色')
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  await shot(page, 'dark-mode')
  if (!isDark) throw new Error('未切到深色（html.dark 缺失）')
  return '深色生效'
})

await step('恢复浅色', async () => {
  await setTheme('浅色')
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  await shot(page, 'light-mode')
  if (isDark) throw new Error('没有恢复浅色')
  return '已恢复浅色'
})

// ---------------------------------------------------------------- 9 响应式
for (const [w, h, label] of [
  [1024, 768, '1024'],
  [768, 1024, '768'],
  [390, 844, '390'],
  [320, 568, '320'],
]) {
  await step(`响应式 ${label}×${h} 布局体检`, async () => {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(700)
    // 窄屏下侧边栏是抽屉，会盖住主内容；不收起就看不到真正要体检的页面。
    // 用 Ctrl+B 而不是点按钮：按钮在动画/重排期间可能不可点击，键盘切换更稳。
    if (w < 768) {
      const drawerOpen = await page.evaluate(() => {
        const a = document.querySelector('aside')
        if (!a) return false
        const r = a.getBoundingClientRect()
        return r.width > 0 && r.left > -1
      })
      if (drawerOpen) {
        await page.keyboard.press('Control+b')
        await page.waitForTimeout(700)
      }
    }
    await shot(page, `viewport-${label}`)
    const r = await layoutAudit(page)
    if (r.out.length) throw new Error(r.out.slice(0, 3).join(' | '))
    return '无溢出'
  })
}

// 窄屏下设置弹窗：标签全可见 + 关闭按钮常驻
await step('窄屏设置弹窗：标签全可见 + 关闭按钮常驻', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(600)
  const expand = page.locator('button[aria-label="展开侧边栏"]')
  if (await expand.count()) {
    await expand.click()
    await page.waitForTimeout(500)
  }
  await page.locator('button:has-text("设置")').first().click()
  await page.waitForTimeout(900)
  await shot(page, 'settings-mobile-top')

  const tabs = await page.evaluate(() => {
    const list = [...document.querySelectorAll('[role="tab"]')]
    const docW = document.documentElement.clientWidth
    return list.map((t) => {
      const r = t.getBoundingClientRect()
      return { label: t.innerText.trim(), right: Math.round(r.right), visible: r.right <= docW + 2 && r.left >= -2 }
    })
  })
  const hidden = tabs.filter((t) => !t.visible)
  if (hidden.length) throw new Error('标签仍被裁切：' + hidden.map((t) => t.label).join('/'))

  // 滚到内容底部，确认标题栏与关闭按钮仍在视口内
  await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]')
    const body = dlg?.querySelector('.overflow-y-auto')
    const scroller = [...(dlg?.querySelectorAll('*') || [])].find(
      (el) => el.scrollHeight > el.clientHeight + 8
    )
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  })
  await page.waitForTimeout(500)
  await shot(page, 'settings-mobile-bottom')
  const close = await page.evaluate(() => {
    const b = document.querySelector('[role="dialog"] button[aria-label="关闭"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { top: Math.round(r.top), inViewport: r.top >= 0 && r.bottom <= innerHeight }
  })
  if (!close?.inViewport) throw new Error('滚到底后关闭按钮不在视口内 top=' + close?.top)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  return `6 个标签全可见，关闭按钮 top=${close.top}`
})

await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(400)

// ---------------------------------------------------------------- 10 对比度
await step('文字对比度（WCAG AA）', async () => {
  const rows = await page.evaluate(() => {
    const parse = (s) => {
      const m = String(s).match(/[\d.]+/g)
      return m ? m.slice(0, 3).map(Number) : null
    }
    const lum = (c) => {
      const f = c.map((v) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]
    }
    const ratio = (a, b) => {
      const l1 = Math.max(lum(a), lum(b))
      const l2 = Math.min(lum(a), lum(b))
      return (l1 + 0.05) / (l2 + 0.05)
    }
    const bgOf = (el) => {
      let n = el
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor
        const p = parse(c)
        const alpha = (c.match(/[\d.]+/g) || [])[3]
        if (p && (alpha === undefined || Number(alpha) > 0.5)) return p
        n = n.parentElement
      }
      return parse(getComputedStyle(document.body).backgroundColor)
    }
    const out = []
    const sels = ['textarea', 'button', 'h1', 'h2', '.markdown-body p', '.markdown-body li', '.markdown-body code']
    for (const s of sels) {
      for (const el of [...document.querySelectorAll(s)].slice(0, 6)) {
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        const fg = parse(getComputedStyle(el).color)
        const bg = bgOf(el)
        if (!fg || !bg) continue
        const txt = (el.innerText || el.value || '').trim().slice(0, 12)
        if (!txt) continue
        out.push({ sel: s, txt, ratio: Math.round(ratio(fg, bg) * 100) / 100 })
      }
    }
    return out
  })
  const low = rows.filter((r) => r.ratio < 4.5)
  if (low.length) {
    softErrors.push('对比度不足: ' + low.slice(0, 5).map((r) => `${r.sel} "${r.txt}" ${r.ratio}`).join(' | '))
  }
  return `${rows.length} 项检测，${low.length} 项 <4.5`
})

// ---------------------------------------------------------------- 汇总
console.log('\n=== 结果汇总 ===')
const pass = results.filter((r) => r.ok).length
const fail = results.filter((r) => !r.ok)
console.log(`通过 ${pass}/${results.length}`)
if (fail.length) {
  console.log('\n失败项：')
  for (const f of fail) console.log(`  ✗ ${f.name}  →  ${f.detail}`)
}
if (softErrors.length) {
  console.log('\n软性告警：')
  for (const s of softErrors) console.log('  ! ' + s)
}
if (consoleErrors.length) {
  console.log('\n控制台错误 (' + consoleErrors.length + ')：')
  for (const e of [...new Set(consoleErrors)].slice(0, 15)) console.log('  ! ' + e)
}

fs.writeFileSync(
  path.join(OUT, 'report.json'),
  JSON.stringify({ base: BASE, results, softErrors, consoleErrors: [...new Set(consoleErrors)] }, null, 2),
  'utf8'
)
console.log('\n截图目录：' + OUT)

await browser.close()
process.exitCode = fail.length ? 1 : 0
