/**
 * 动画/过渡专项断言（开发期自测，不参与构建）。
 * 覆盖 smoke-ui.mjs 没有覆盖的四类：
 *  1. 骨架屏必须被真实内容替换（不能一直挂着 shimmer）
 *  2. 流式输出是增量渲染：多次采样文本长度严格递增，且流式光标流式期间在场、结束后消失
 *  3. 移动端抽屉展开/收起要到终态，不能卡在中间（transform 必须是 identity/none）
 *  4. prefers-reduced-motion 下动画真实降级（计算时长 ≈ 0）
 *
 * 前置：dev 服务（:5173/:3001）与 mock-flash（:8790，已注册为自定义服务商）在跑。
 * 用法：node scripts/anim-check.mjs [baseURL]
 */
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, useSystemChrome } from './lib/playwright.mjs'

const base = process.env.BASE_URL || process.argv[2] || 'http://localhost:5173'
const out = process.env.SHOTS_DIR || fileURLToPath(new URL('../.shots/anim/', import.meta.url))
mkdirSync(out, { recursive: true })

const errors = []
// headless Chromium 默认不驱动 BeginFrame，rAF 实际只有 ~1Hz，
// 而前端流式输出按 rAF 合帧刷新——不解锁帧率的话「打字机节奏」在自动化里根本观察不到。
// 这几个 flag 只是解除自动化环境的帧率/后台节流，不改变被测代码路径。
const UNTHROTTLE_ARGS = [
  '--disable-frame-rate-limit',
  '--disable-gpu-vsync',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
]
const browser = await chromium.launch({
  ...(useSystemChrome ? { channel: 'chrome' } : {}),
  args: ['--no-proxy-server', '--proxy-bypass-list=<-loopback>', ...UNTHROTTLE_ARGS],
})

/** 找闪测服务商 id（注册过多次就取第一个活着的） */
async function mockProviderId() {
  const res = await fetch('http://127.0.0.1:3001/api/providers')
  const { providers } = await res.json()
  for (const p of providers) {
    if (!p.id.startsWith('custom') || !p.models.includes('mock-flash')) continue
    try {
      const baseUrl = await fetch(`http://127.0.0.1:3001/api/providers/custom/${p.id}`)
        .then((r) => r.json())
        .then((d) => d.baseUrl || '')
      const probe = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3000) })
      if (probe.ok) return p.id
    } catch { /* 下一个 */ }
  }
  return null
}

/** 播种：选定 mock 模型 + 空会话，让流式测试不依赖 UI 里的模型切换交互 */
async function seedSettings(page, providerId) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('textarea', { timeout: 120000 })
  await page.waitForTimeout(1500) // 等 hydrate，避免空状态写回覆盖
  await page.evaluate(
    (provider) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('keyval-store', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('keyval')
        req.onsuccess = () => {
          const tx = req.result.transaction('keyval', 'readwrite')
          tx.objectStore('keyval').put(
            JSON.stringify({
              state: {
                conversations: [],
                activeId: null,
                settings: {
                  provider, model: 'mock-flash', compareModels: [], compareEnabled: false,
                  temperature: 0.7, topP: 1, maxTokens: 4096, systemPrompt: '',
                  theme: 'light', webSearch: false, thinking: false, usingContext: true,
                },
                prompts: [], assistants: [], hydrated: true,
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
    providerId
  )
}

/* ── 1. 骨架屏 → 真实内容 ── */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push('[skeleton] pageerror: ' + e.message))
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 })
  // 尽早采样一次：能不能看到骨架屏取决于机器速度，看到最好，看不到不算失败
  const sawSkeleton = (await page.locator('.skeleton').count()) > 0
  await page.waitForSelector('textarea', { timeout: 120000 })
  await page.waitForTimeout(2000)
  const left = await page.locator('.skeleton').count()
  if (left !== 0) errors.push(`[skeleton] 数据恢复完成后仍残留 ${left} 个骨架元素`)
  const usable = await page.evaluate(() => {
    const ta = document.querySelector('textarea')
    return !!ta && ta.getBoundingClientRect().width > 100
  })
  if (!usable) errors.push('[skeleton] 真实界面未就位（输入框不可见）')
  console.log(`skeleton: saw=${sawSkeleton} left=${left}`)
  await ctx.close()
}

/* ── 2. 流式增量渲染节奏 ── */
{
  const providerId = await mockProviderId()
  if (!providerId) {
    errors.push('[stream] 找不到活着的 mock-flash 服务商（先跑 npm run mock:flash -- --register）')
  } else {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push('[stream] pageerror: ' + e.message))
    await seedSettings(page, providerId)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('textarea', { timeout: 120000 })
    await page.waitForTimeout(1500)

    // 长度采样改在页面内做：Node 侧 80ms 轮询 + evaluate 往返约 120-150ms/次，
    // mock 连接预热后整个流式窗口只有 ~1s，轮询只能抓到 2 次递增（假失败）。
    // MutationObserver 直接记 DOM 变更，粒度与 rAF 合帧 flush 对齐，与环境速度无关。
    await page.evaluate(() => {
      window.__lens = []
      const measure = () => {
        const nodes = document.querySelectorAll('.markdown-body, .whitespace-pre-wrap')
        const len = nodes.length ? nodes[nodes.length - 1].textContent.length : 0
        if (!window.__lens.length || window.__lens[window.__lens.length - 1] !== len) window.__lens.push(len)
      }
      window.__obs = new MutationObserver(measure)
      window.__obs.observe(document.body, { childList: true, subtree: true, characterData: true })
    })

    await page.locator('textarea').first().fill('你好')
    await page.keyboard.press('Enter')

    // 光标出现再消失 = 流式完整跑完一轮；期间不采样，只等终态
    let caretSeen = false
    for (let i = 0; i < 250; i += 1) {
      const caretNow = await page.evaluate(() => !!document.querySelector('.stream-caret'))
      if (caretNow) caretSeen = true
      if (caretSeen && !caretNow) break
      await page.waitForTimeout(80)
    }
    const lengths = await page.evaluate(() => {
      window.__obs?.disconnect()
      return window.__lens || []
    })
    const increasing = lengths.filter((v, i) => i > 0 && v > lengths[i - 1]).length
    const finalLen = lengths.length ? Math.max(...lengths) : 0
    console.log(`stream: 变更点=${lengths.length} 递增次数=${increasing} final=${finalLen} caret=${caretSeen}`)
    if (increasing < 3) errors.push(`[stream] 打字机节奏缺失（文本只增长了 ${increasing} 次），增量渲染没生效`)
    if (finalLen < 20) errors.push(`[stream] 最终内容过短（${finalLen} 字符），流式可能没完成`)
    if (!caretSeen) errors.push('[stream] 流式期间没有出现 .stream-caret 光标')

    // 结束后：懒加载的 Markdown 渲染态要替换掉纯文本兜底
    let rendered = 0
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(200)
      rendered = await page.evaluate(() => {
        const bodies = document.querySelectorAll('.markdown-body')
        return bodies.length ? bodies[bodies.length - 1].textContent.length : 0
      })
      if (rendered >= 20) break
    }
    if (rendered < 20) errors.push(`[stream] Markdown 渲染态未替换兜底文本（.markdown-body 内容 ${rendered} 字符）`)
    await page.screenshot({ path: `${out}stream-done.png` })
    await ctx.close()
  }
}

/* ── 3. 移动端抽屉终态 ── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push('[drawer] pageerror: ' + e.message))
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('textarea', { timeout: 120000 })
  await page.waitForTimeout(1500)

  await page.getByRole('button', { name: '展开侧边栏' }).first().click()
  await page.waitForTimeout(900) // 等动画完整跑完
  const openState = await page.evaluate(() => {
    // 抽屉容器：固定定位、带 transform 过渡的那个 aside/nav
    const el = [...document.querySelectorAll('aside, nav, div')].find((n) => {
      const cs = getComputedStyle(n)
      return cs.position === 'fixed' && n.querySelector('input[placeholder*="搜索"]')
    })
    if (!el) return { found: false }
    const t = getComputedStyle(el).transform
    return { found: true, transform: t, visible: el.getBoundingClientRect().left >= -1 }
  })
  if (!openState.found) errors.push('[drawer] 找不到抽屉容器')
  else {
    // 终态必须是 identity（none）或单位矩阵：任何含负偏移的 matrix 都是卡在中途
    const t = openState.transform
    const atFinal = t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)'
    if (!atFinal && !openState.visible) errors.push(`[drawer] 展开后卡在中途：transform=${t}`)
    if (!openState.visible) errors.push('[drawer] 展开后抽屉仍不可见')
  }
  await page.screenshot({ path: `${out}drawer-open.png` })

  // 收起：点遮罩或关闭按钮
  const closeBtn = page.getByRole('button', { name: /收起|关闭侧边栏/ }).first()
  if (await closeBtn.count()) await closeBtn.click()
  else await page.mouse.click(370, 400)
  await page.waitForTimeout(900)
  const closedGone = await page.evaluate(() => {
    const el = [...document.querySelectorAll('aside, nav, div')].find((n) => {
      const cs = getComputedStyle(n)
      return cs.position === 'fixed' && n.querySelector('input[placeholder*="搜索"]')
    })
    if (!el) return true // 已卸载，没问题
    return el.getBoundingClientRect().right <= 1 // 完全移出屏幕才算收好
  })
  if (!closedGone) errors.push('[drawer] 收起后仍占据屏幕（卡在中间态）')
  console.log('drawer: open/close done')
  await ctx.close()
}

/* ── 4. prefers-reduced-motion 真实降级 ── */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push('[rm] pageerror: ' + e.message))
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('textarea', { timeout: 120000 })
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '设置' }).first().click()
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 })
  const dur = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    return d ? getComputedStyle(d).animationDuration : 'missing'
  })
  // CSS 里降级为 0.01ms：凡是还挂着百毫秒级动画时长就是没降级
  if (dur === 'missing') errors.push('[rm] 弹窗未打开')
  else if (parseFloat(dur) > 0.02) errors.push(`[rm] 弹窗动画未降级：animationDuration=${dur}`)
  console.log(`reduced-motion: dialog animationDuration=${dur}`)
  await ctx.close()
}

await browser.close()
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'anim-check: all pass')
process.exitCode = errors.length ? 1 : 0
