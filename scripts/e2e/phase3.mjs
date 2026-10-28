/**
 * 第三阶段 e2e：前两轮没覆盖的盲区
 *  1. 深色模式下的对比度（之前只测了浅色）
 *  2. 键盘可达性：Tab 顺序、焦点环是否真的可见、Esc 逐层关闭
 *  3. 产物工作台（代码块「分屏」→ 沙箱预览 → 全屏 → 关闭）
 *  4. MCP 面板：添加表单能打开、空值有校验
 *  5. 断网降级：页面已开时断网，操作应有明确报错而不是静默失败
 *  6. prefers-reduced-motion 降级
 *  7. 超长文本 / 超长 URL 不撑破布局
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:5180'
// 每次运行写独立子目录：不删旧文件（沙箱的 safe-delete 钩子会拦批量删除并直接失败）
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = path.resolve('.shots/e2e3/run-' + RUN)
fs.mkdirSync(OUT, { recursive: true })

const results = []
const soft = []
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

/** 对比度扫描：返回低于阈值的条目（含实际色值，便于定位是哪个令牌） */
const CONTRAST_JS = `(() => {
  const parse = (s) => { const m = String(s).match(/[\\d.]+/g); return m ? m.slice(0,3).map(Number) : null };
  const alphaOf = (s) => { const m = String(s).match(/[\\d.]+/g); return m && m.length > 3 ? Number(m[3]) : 1 };
  const lum = (c) => { const f = c.map(v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2]; };
  const ratio = (a,b) => { const l1=Math.max(lum(a),lum(b)), l2=Math.min(lum(a),lum(b)); return (l1+0.05)/(l2+0.05); };
  const bgOf = (el) => { let n = el; while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor; const p = parse(c);
      if (p && alphaOf(c) > 0.5) return p;
      n = n.parentElement; }
    return parse(getComputedStyle(document.body).backgroundColor); };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('button, a, p, span, li, h1, h2, h3, h4, label, td, th, textarea, code, strong, em')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.top > innerHeight || r.bottom < 0) continue;
    const txt = (el.innerText || el.value || '').trim();
    if (!txt || txt.length > 200) continue;
    if (el.children.length > 0) continue;           // 只测叶子节点，避免父容器重复
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const fgRaw = cs.color; const fg = parse(fgRaw);
    if (!fg || alphaOf(fgRaw) < 0.5) continue;      // 半透明文字单独看，不混进来
    const bg = bgOf(el);
    if (!bg) continue;
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const cr = Math.round(ratio(fg, bg) * 100) / 100;
    const key = cs.color + '|' + bg.join(',') + '|' + size;
    if (cr < need && !seen.has(key)) {
      seen.add(key);
      out.push({ text: txt.slice(0, 16), fg: fgRaw, bg: 'rgb(' + bg.join(',') + ')', size, ratio: cr, need });
    }
  }
  return out;
})()`

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

console.log('\n=== FlyChat 第三阶段 e2e @ ' + BASE + ' ===\n')
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// 切到 mock 模型
await page.locator('button[aria-haspopup="menu"]').first().click()
await page.waitForTimeout(500)
await page.locator('[role="menuitem"]').filter({ hasText: 'mock-flash' }).first().click()
await page.waitForTimeout(600)

// ---------------------------------------------------------------- 1 深色对比度
await step('浅色模式对比度（叶子节点全量）', async () => {
  await shot(page, 'light-home')
  const low = await page.evaluate(CONTRAST_JS)
  if (low.length) {
    soft.push('浅色对比度: ' + low.slice(0, 4).map((x) => `"${x.text}" ${x.ratio}<${x.need} fg=${x.fg} bg=${x.bg}`).join(' | '))
    return `${low.length} 处低于 AA（详见软性告警）`
  }
  return '全部达标'
})

await step('切到深色模式', async () => {
  await page.locator('button:has-text("设置")').first().click()
  await page.waitForTimeout(800)
  const dark = page.locator('button:has-text("深色")').first()
  await dark.scrollIntoViewIfNeeded()
  await dark.click()
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  if (!(await page.evaluate(() => document.documentElement.classList.contains('dark'))))
    throw new Error('未进入深色模式')
  return '深色生效'
})

await step('深色模式对比度（叶子节点全量）', async () => {
  await shot(page, 'dark-home')
  const low = await page.evaluate(CONTRAST_JS)
  if (low.length) {
    soft.push('深色对比度: ' + low.slice(0, 4).map((x) => `"${x.text}" ${x.ratio}<${x.need} fg=${x.fg} bg=${x.bg}`).join(' | '))
    return `${low.length} 处低于 AA（详见软性告警）`
  }
  return '全部达标'
})

await step('深色下打开设置弹窗并查对比度', async () => {
  await page.locator('button:has-text("设置")').first().click()
  await page.waitForTimeout(900)
  await shot(page, 'dark-settings')
  const low = await page.evaluate(CONTRAST_JS)
  await reset(page)
  if (low.length) {
    soft.push('深色弹窗对比度: ' + low.slice(0, 4).map((x) => `"${x.text}" ${x.ratio}<${x.need}`).join(' | '))
    return `${low.length} 处低于 AA`
  }
  return '全部达标'
})

await step('恢复浅色', async () => {
  await page.locator('button:has-text("设置")').first().click()
  await page.waitForTimeout(800)
  const light = page.locator('button:has-text("浅色")').first()
  await light.scrollIntoViewIfNeeded()
  await light.click()
  await page.waitForTimeout(700)
  await reset(page)
  if (await page.evaluate(() => document.documentElement.classList.contains('dark')))
    throw new Error('没恢复浅色')
  return '已恢复'
})

// ---------------------------------------------------------------- 2 键盘可达性
await step('Tab 遍历：焦点不丢、顺序前进', async () => {
  await reset(page)
  const seen = []
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab')
    const info = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return null
      return {
        tag: el.tagName,
        label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').slice(0, 20),
        inViewport: (() => { const r = el.getBoundingClientRect(); return r.top >= -2 && r.bottom <= innerHeight + 2 && r.width > 0 })(),
      }
    })
    if (!info) throw new Error(`第 ${i + 1} 次 Tab 后焦点掉到 body`)
    seen.push(info.label || info.tag)
  }
  await shot(page, 'tab-focus')
  return `${seen.length} 次 Tab 全部落在可聚焦元素上`
})

await step('每个 Tab 停靠点都有可见焦点指示', async () => {
  // 必须重载：blur() 不会把 Tab 起点归零，Chrome 会从上次焦点继续，
  // 上一次 25 连 Tab 之后焦点已经在页面末尾，继续 Tab 会直接跳到浏览器地址栏
  // （activeElement 变 body），那是正常结束而不是缺陷。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2400)
  const bad = []
  let count = 0
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(90)
    const info = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return { lost: true }
      // 向上找 5 层：有些组件把焦点环画在父级（如输入卡）
      let x = el
      let ring = false
      for (let d = 0; d < 5 && x; d++) {
        const cs = getComputedStyle(x)
        if (cs.boxShadow && cs.boxShadow !== 'none') { ring = true; break }
        if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) { ring = true; break }
        x = x.parentElement
      }
      return {
        tag: el.tagName,
        label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').slice(0, 18),
        ring,
      }
    })
    if (info.lost) break // 焦点走到浏览器 UI，文档内已遍历完
    count += 1
    if (!info.ring) bad.push(`<${info.tag}> ${info.label}`)
  }
  await shot(page, 'focus-ring')
  if (count < 8) throw new Error(`只测到 ${count} 个停靠点，样本太少`)
  if (bad.length) throw new Error('无焦点指示：' + bad.slice(0, 3).join(' | '))
  return `${count} 个停靠点全部有可见焦点环`
})

await step('Esc 逐层关闭（弹窗 → 浮层）', async () => {
  await reset(page)
  await page.locator('button[aria-haspopup="menu"]').first().click()
  await page.waitForTimeout(500)
  if (!(await page.locator('[role="menu"]').count())) throw new Error('模型菜单没打开')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  if (await page.locator('[role="menu"]').count()) throw new Error('Esc 没关掉模型菜单')

  await page.locator('button:has-text("设置")').first().click()
  await page.waitForTimeout(700)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  if (await page.locator('[role="dialog"]').count()) throw new Error('Esc 没关掉设置弹窗')
  return '浮层与弹窗都能 Esc 关闭'
})

// ---------------------------------------------------------------- 3 产物工作台
await step('发送含 HTML 代码块的消息', async () => {
  await reset(page)
  // 闪测模型对提到「html/构件」的提示词会回一段 HTML 代码块；
  // 「分屏」按钮只在 html/svg 代码块上出现，用 js 代码块测不到这条链路。
  await composer(page).fill('给我一个 html 页面的构件示例')
  await composer(page).press('Enter')
  await waitIdle(page, 45)
  await page.waitForTimeout(1000)
  if (!(await page.locator('.markdown-body pre').count())) throw new Error('没有渲染出代码块')
  const lang = await page.evaluate(() => document.querySelector('.markdown-body pre code')?.className || '')
  return '代码块就绪（' + lang.slice(0, 30) + '）'
})

await step('代码块「分屏」打开产物工作台', async () => {
  const split = page.locator('button[title*="分屏"]').first()
  if (!(await split.count())) throw new Error('代码块工具栏没有「分屏」按钮')
  await split.click()
  await page.waitForTimeout(1500)
  await shot(page, 'artifact-open')
  const ws = page.locator('[role="region"], [role="dialog"]').filter({ has: page.locator('iframe') })
  const iframes = await page.locator('iframe').count()
  if (!iframes) throw new Error('工作台没有渲染 iframe 沙箱')
  return `沙箱 iframe ${iframes} 个`
})

await step('工作台切换设备尺寸 / 全屏 / 关闭', async () => {
  const mobile = page.locator('button[title="移动端 (375px)"]').first()
  if (await mobile.count()) {
    await mobile.click()
    await page.waitForTimeout(600)
    await shot(page, 'artifact-mobile')
  }
  const full = page.locator('button[title*="全屏"]').first()
  if (await full.count()) {
    await full.click()
    await page.waitForTimeout(800)
    await shot(page, 'artifact-fullscreen')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }
  const close = page.locator('button[title="关闭工作台"]').first()
  if (!(await close.count())) throw new Error('没有关闭工作台按钮')
  await close.click()
  await page.waitForTimeout(700)
  if (await page.locator('iframe').count()) throw new Error('关闭后 iframe 仍在')
  return '尺寸切换 / 全屏 / 关闭均正常'
})

await step('SVG 代码块：预览走 iframe 且能渲染', async () => {
  await reset(page)
  await composer(page).fill('画一个 svg 图标')
  await composer(page).press('Enter')
  await waitIdle(page, 45)
  await page.waitForTimeout(1200)
  await shot(page, 'svg-code')

  // 同一会话里前面还有一个 HTML 代码块，必须取最后一个，否则测的是上一条消息
  const block = page.locator('[class*="group/code"]').last()
  if (!(await block.count())) throw new Error('没有渲染出代码块')
  const lang = await block.locator('pre code').first().getAttribute('class')
  if (!/svg/i.test(lang || '')) throw new Error('最后一块不是 svg：' + String(lang).slice(0, 40))

  const previewBtn = block.locator('button').filter({ hasText: /^预览$/ }).first()
  if (!(await previewBtn.count())) throw new Error('svg 代码块没有「预览」按钮')
  await previewBtn.click()
  await page.waitForTimeout(900)
  if (!(await block.locator('iframe').count())) throw new Error('点了「预览」但没出现 iframe')

  // 回归守卫：回答结束后「猜你想问」是异步插入的，会触发一次 store 更新。
  // 元素渲染表写在组件内部时，这次更新会让代码块整棵重建、viewMode 被重置回「代码」，
  // 表现为「点了预览，过一秒自己跳回去」。这里等它真的插进来再确认预览还开着。
  const suggestion = page.locator('text=猜你想问').last()
  await suggestion.waitFor({ timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(500)
  if (!(await block.locator('iframe').count())) {
    throw new Error('预览被后续渲染重置回代码（组件被重建，渲染表身份不稳定）')
  }
  await shot(page, 'svg-preview')

  // 沙箱 iframe 只给 allow-scripts、不给 allow-same-origin，所以父页面读 contentDocument 是 null
  // （这正是安全设计）。用 Playwright 的 contentFrame() 走 CDP 跨进程访问。
  const handle = await block.locator('iframe').first().elementHandle()
  if (!handle) throw new Error('没有 iframe')
  const frame = await handle.contentFrame()
  if (!frame) throw new Error('拿不到 iframe 的 frame')
  const svg = frame.locator('svg').first()
  const n = await svg.count()
  const box = n ? await svg.boundingBox() : null
  const info = {
    ok: n > 0 && !!box,
    sandbox: await block.locator('iframe').first().getAttribute('sandbox'),
    w: box ? Math.round(box.width) : 0,
    h: box ? Math.round(box.height) : 0,
  }
  if (!info.ok) throw new Error('预览 iframe 里没有渲染出 svg')
  if (!info.w || !info.h) throw new Error('svg 尺寸为 0：' + JSON.stringify(info))
  return `iframe 内 svg ${info.w}×${info.h}，sandbox=${info.sandbox}`
})

await step('SVG 代码块：分屏打开产物工作台', async () => {
  const split = page.locator('[class*="group/code"]').last().locator('button[title*="分屏"]').first()
  if (!(await split.count())) throw new Error('svg 代码块没有「分屏」按钮')
  await split.click()
  await page.waitForTimeout(1500)
  await shot(page, 'svg-artifact')
  const iframes = await page.locator('iframe').count()
  if (!iframes) throw new Error('工作台没有渲染 iframe')
  const close = page.locator('button[title="关闭工作台"]').first()
  if (await close.count()) {
    await close.click()
    await page.waitForTimeout(700)
  }
  return `工作台 iframe ${iframes} 个`
})

// ---------------------------------------------------------------- 4 MCP 面板
await step('MCP：添加服务表单 + 空值校验', async () => {
  await reset(page)
  await page.locator('button:has-text("设置")').first().click()
  await page.waitForTimeout(800)
  await page.locator('[role="tab"]').filter({ hasText: 'MCP' }).first().click()
  await page.waitForTimeout(700)
  const add = page.locator('button:has-text("添加服务")').first()
  if (!(await add.count())) throw new Error('没有「添加服务」按钮')
  await add.click()
  await page.waitForTimeout(600)
  await shot(page, 'mcp-form')
  const nameInput = page.locator('input[placeholder*="filesystem"]').first()
  if (!(await nameInput.count())) throw new Error('表单没有名称输入框')
  // 空名称直接保存，应有校验而不是静默通过
  const save = page.locator('[role="dialog"] button').filter({ hasText: /保存|添加|确认/ }).first()
  if (await save.count()) {
    await save.click()
    await page.waitForTimeout(600)
  }
  const stillOpen = await page.locator('input[placeholder*="filesystem"]').count()
  await shot(page, 'mcp-validation')
  await reset(page)
  if (!stillOpen) throw new Error('空表单被直接保存了，没有校验')
  return '表单打开正常，空值被拦下'
})

// ---------------------------------------------------------------- 5 断网降级
await step('页面已开时断网：发送应给出明确错误', async () => {
  await reset(page)
  await ctx.setOffline(true)
  await composer(page).fill('断网测试')
  await composer(page).press('Enter')
  await page.waitForTimeout(4000)
  await shot(page, 'offline-send')
  const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))
  const hasError = /失败|错误|无法|断开|网络/.test(txt)
  await ctx.setOffline(false)
  await page.waitForTimeout(500)
  if (!hasError) throw new Error('断网后没有任何错误提示，用户会以为消息发出去了')
  return '有明确错误提示'
})

await step('断网时页面仍可交互（不白屏）', async () => {
  await ctx.setOffline(true)
  await page.waitForTimeout(300)
  const ok = await page.evaluate(() => {
    const t = document.querySelector('textarea')
    if (!t) return false
    t.focus()
    return document.activeElement === t
  })
  await ctx.setOffline(false)
  await page.waitForTimeout(400)
  if (!ok) throw new Error('断网后输入框不可聚焦')
  return '输入框仍可用'
})

// ---------------------------------------------------------------- 6 reduced-motion
await step('prefers-reduced-motion 降级', async () => {
  const ctx2 = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: 'reduce',
  })
  const p2 = await ctx2.newPage()
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p2.waitForTimeout(2000)
  shotNo += 1
  await p2.screenshot({ path: path.join(OUT, `${String(shotNo).padStart(2, '0')}-reduced-motion.png`) })
  const anim = await p2.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      const d = parseFloat(cs.animationDuration) || 0
      const t = parseFloat(cs.transitionDuration) || 0
      if (d > 0.2 && cs.animationName !== 'none') bad.push('anim:' + (el.className || '').toString().slice(0, 30))
      else if (t > 0.3) bad.push('trans:' + (el.className || '').toString().slice(0, 30))
    }
    return bad.slice(0, 5)
  })
  await ctx2.close()
  if (anim.length) throw new Error('reduce 下仍有长动画/过渡：' + anim.join(' | '))
  return '无长动画残留'
})

// ---------------------------------------------------------------- 7 超长内容
await step('超长 URL / 无空格长串不撑破布局', async () => {
  await reset(page)
  const longUrl = 'https://example.com/' + 'a'.repeat(180)
  const longWord = 'x'.repeat(200)
  await composer(page).fill(`看这个链接 ${longUrl} 和这个长串 ${longWord} 会不会撑破布局`)
  await composer(page).press('Enter')
  await waitIdle(page, 45)
  await page.waitForTimeout(1000)
  await shot(page, 'long-text')
  const over = await page.evaluate(() => {
    const docW = document.documentElement.clientWidth
    return {
      pageOverflow: document.documentElement.scrollWidth - docW,
      bubbles: [...document.querySelectorAll('.markdown-body, [class*="bubble"]')].map((el) => {
        const r = el.getBoundingClientRect()
        return { right: Math.round(r.right), docW }
      }).filter((x) => x.right > x.docW + 2),
    }
  })
  if (over.pageOverflow > 2 || over.bubbles.length)
    throw new Error(`超长文本导致溢出 ${over.pageOverflow}px / ${over.bubbles.length} 个气泡越界`)
  return '无溢出'
})

console.log('\n=== 结果汇总 ===')
const pass = results.filter((r) => r.ok).length
const fail = results.filter((r) => !r.ok)
console.log(`通过 ${pass}/${results.length}`)
for (const f of fail) console.log(`  ✗ ${f.name}  →  ${f.detail}`)
if (soft.length) {
  console.log('\n软性告警：')
  for (const s of soft) console.log('  ! ' + s)
}
if (errors.length) {
  console.log('\n页面错误：')
  for (const e of [...new Set(errors)].slice(0, 10)) console.log('  ! ' + e)
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ results, soft, errors: [...new Set(errors)] }, null, 2), 'utf8')
console.log('\n截图目录：' + OUT)
await browser.close()
process.exitCode = fail.length ? 1 : 0
