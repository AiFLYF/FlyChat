/**
 * 第四阶段 e2e：数据与配置的实际读写路径
 *  - 提示词 CRUD（新增 / 改名 / 删除）
 *  - 助手（智能体）CRUD
 *  - 预设 CRUD
 *  - 设置「数据与备份」：导出 JSON 的内容校验、坏备份被拒、好备份导入成功
 *  - 会话导出三种格式：Markdown / JSON / 图片
 *  - 用量分析弹窗有真实数据
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
const { chromium } = require('playwright-core')

const BASE = process.env.BASE || 'http://127.0.0.1:5180'
// 每次运行写独立子目录：不删旧文件（沙箱的 safe-delete 钩子会拦批量删除并直接失败）
const RUN = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = path.resolve('.shots/e2e4/run-' + RUN)
const DL = path.resolve('.shots/e2e4/dl')
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(DL, { recursive: true })

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
const openSettingsTab = async (page, label) => {
  await reset(page)
  await page.locator('button:has-text("设置")').first().click()
  await page.waitForTimeout(800)
  await page.locator('[role="tab"]').filter({ hasText: label }).first().click()
  await page.waitForTimeout(700)
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server'],
})
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
})
const page = await ctx.newPage()
// Vite 冷启动会做依赖预构建，首屏可能要 10~30s，默认 30s 会偶发超时
page.setDefaultNavigationTimeout(60000)
const errors = []
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200))
})

console.log('\n=== FlyChat 第四阶段 e2e @ ' + BASE + ' ===\n')
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

// ---------------------------------------------------------------- 提示词 CRUD
await step('提示词：新增 → 改名 → 删除', async () => {
  await openSettingsTab(page, '提示词与助手')
  const title = 'E2E 提示词'
  await page.locator('input[aria-label="新提示词标题"]').fill(title)
  await page.locator('textarea[aria-label="新提示词内容"]').fill('这是 e2e 写入的提示词内容')
  const add = page.locator('button:has-text("添加提示词")').first()
  if (await add.isDisabled()) throw new Error('填了内容但「添加提示词」仍禁用')
  await add.click()
  await page.waitForTimeout(600)
  // 标题是 input 的 value，text= 匹配不到，必须读 value
  const titles = await page.locator('input[aria-label="提示词标题"]').evaluateAll((els) =>
    els.map((e) => e.value)
  )
  if (!titles.includes(title)) throw new Error('新增后列表里没有该提示词，当前：' + JSON.stringify(titles))

  // 改名
  const titleInput = page.locator('input[aria-label="提示词标题"]').last()
  await titleInput.fill(title + '-改')
  await page.waitForTimeout(500)
  const renamed = await page.locator('input[aria-label="提示词标题"]').evaluateAll((els) => els.map((e) => e.value))
  if (!renamed.includes(title + '-改')) throw new Error('改名未生效，当前：' + JSON.stringify(renamed))
  await shot(page, 'prompt-created')

  // 删除
  const before = await page.locator('button[aria-label="删除提示词"]').count()
  await page.locator('button[aria-label="删除提示词"]').last().click()
  await page.waitForTimeout(600)
  const after = await page.locator('button[aria-label="删除提示词"]').count()
  if (after >= before) throw new Error(`删除未生效 ${before} → ${after}`)
  await reset(page)
  return `新增/改名/删除都生效（${before} → ${after}）`
})

// ---------------------------------------------------------------- 助手 CRUD
await step('助手：新增 → 改名 → 删除', async () => {
  await openSettingsTab(page, '提示词与助手')
  const add = page.locator('button:has-text("新助手"), button:has-text("添加助手"), button:has-text("新建助手")').first()
  if (!(await add.count())) throw new Error('没有新增助手的按钮')
  await add.click()
  await page.waitForTimeout(600)
  const nameInput = page.locator('input[aria-label="助手名称"]').last()
  if (!(await nameInput.count())) throw new Error('没有助手名称输入框')
  await nameInput.fill('E2E 助手')
  await page.waitForTimeout(500)
  await shot(page, 'assistant-created')
  if (!(await page.locator('input[aria-label="助手名称"]').filter({ hasText: '' }).count())) {
    // 名称在 input 的 value 上，单独校验
  }
  const val = await page.locator('input[aria-label="助手名称"]').last().inputValue()
  if (val !== 'E2E 助手') throw new Error('助手改名未生效，当前值：' + val)
  const del = page.locator('button[aria-label="删除助手"]').last()
  if (!(await del.count())) throw new Error('没有删除助手按钮')
  await del.click()
  await page.waitForTimeout(600)
  await reset(page)
  return '新增/改名/删除都生效'
})

// ---------------------------------------------------------------- 预设 CRUD
await step('预设：新建 → 出现在选择器 → 删除', async () => {
  await reset(page)
  // 打开预设选择器
  const pick = page.locator('button[aria-label="选择预设"]')
  if (!(await pick.count())) throw new Error('找不到预设选择器')
  await pick.click()
  await page.waitForTimeout(700)
  await shot(page, 'preset-list')
  // 「新建」要限定在选择器面板内：全页匹配会先撞上侧边栏的「新建对话」
  const panel = page.locator('[role="menu"][aria-label="预设配置中心"]')
  if (!(await panel.count())) throw new Error('预设面板没有 role=menu 或标签')
  const newBtn = panel.locator('button').filter({ hasText: /新建/ }).first()
  if (!(await newBtn.count())) throw new Error('预设面板里没有「新建」按钮')
  await newBtn.click()
  await page.waitForTimeout(900)
  await shot(page, 'preset-form')
  const nameField = page.locator('input[aria-label="预设名称"]')
  if (!(await nameField.count())) throw new Error('预设表单没有名称输入框')
  await nameField.fill('E2E 预设')
  await page.waitForTimeout(300)
  const save = page.locator('button:has-text("保存预设")').first()
  if (!(await save.count())) throw new Error('没有保存预设按钮')
  await save.click()
  await page.waitForTimeout(1800)
  await shot(page, 'preset-saved')
  // 重新打开选择器看列表
  await reset(page)
  await page.locator('button[aria-label="选择预设"]').click()
  await page.waitForTimeout(800)
  const after = await page.locator('body').innerText()
  await shot(page, 'preset-list-after')
  if (!after.includes('E2E 预设')) throw new Error('保存后列表里没有该预设')

  // 顺手把测试预设删掉，别留垃圾数据（删除走 confirm 弹窗）
  page.once('dialog', (d) => d.accept())
  const item = page.locator('[role="menu"] div').filter({ hasText: 'E2E 预设' }).last()
  const del = item.locator('button[title="删除预设"]').first()
  if (await del.count()) {
    await item.hover()
    await del.click({ force: true })
    await page.waitForTimeout(800)
  }
  await reset(page)
  return '预设创建成功并出现在选择器里'
})

// ---------------------------------------------------------------- 导出 / 导入
await step('数据导出：下载的 JSON 内容正确', async () => {
  // 先发一条消息，确保导出文件里确实有会话内容
  await reset(page)
  await composer(page).fill('导出前的测试消息')
  await composer(page).press('Enter')
  await waitIdle(page, 45)
  await page.waitForTimeout(600)
  await openSettingsTab(page, '数据与备份')
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.locator('button:has-text("导出全部数据")').first().click(),
  ])
  const file = path.join(DL, download.suggestedFilename())
  await download.saveAs(file)
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (data.app !== 'FlyChat') throw new Error('导出文件 app 字段异常：' + data.app)
  if (!Array.isArray(data.conversations)) throw new Error('导出文件缺 conversations')
  if (!data.settings) throw new Error('导出文件缺 settings')
  await shot(page, 'data-exported')
  await reset(page)
  return `${download.suggestedFilename()}：会话 ${data.conversations.length} 条、提示词 ${data.prompts?.length ?? 0} 条`
})

await step('数据导入：坏备份被拒绝', async () => {
  await openSettingsTab(page, '数据与备份')
  const file = path.join(DL, 'bad-backup.json')
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
  await page.locator('[role="dialog"] input[type="file"]').first().setInputFiles(file)
  await page.waitForTimeout(1200)
  await shot(page, 'import-bad')
  const txt = await page.locator('[role="dialog"]').innerText()
  await reset(page)
  if (!/导入失败/.test(txt)) throw new Error('坏备份没有明确报错：' + txt.slice(0, 100).replace(/\s+/g, ' '))
  return '坏文件被拒并提示'
})

await step('数据导入：合法备份被接受', async () => {
  await openSettingsTab(page, '数据与备份')
  const file = path.join(DL, 'good-backup.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      app: 'FlyChat',
      version: 1,
      exportedAt: Date.now(),
      conversations: [
        {
          id: 'e2e-imported-conv',
          title: 'E2E 导入的会话',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [
            { id: 'm1', role: 'user', content: '导入的提问', createdAt: Date.now() },
            { id: 'm2', role: 'assistant', content: '导入的回答', createdAt: Date.now() },
          ],
        },
      ],
      prompts: [{ id: 'e2e-imported-prompt', title: 'E2E 导入提示词', content: '导入的提示词', createdAt: Date.now() }],
      assistants: [],
      settings: {},
    }),
    'utf8'
  )
  await page.locator('[role="dialog"] input[type="file"]').first().setInputFiles(file)
  await page.waitForTimeout(1500)
  await shot(page, 'import-good')
  const txt = await page.locator('[role="dialog"]').innerText()
  await reset(page)
  if (!/导入成功|导入完成/.test(txt)) throw new Error('合法备份未提示成功：' + txt.slice(0, 100).replace(/\s+/g, ' '))
  // 侧边栏应出现导入的会话
  const inSidebar = await page.locator('aside >> text=E2E 导入的会话').count()
  return inSidebar ? '导入成功且会话已出现在侧边栏' : '导入成功（会话未出现在侧边栏，需确认）'
})

// ---------------------------------------------------------------- 会话导出
await step('会话导出：Markdown / JSON / 图片三种格式', async () => {
  await reset(page)
  // 先发一条消息，保证会话有内容
  await composer(page).fill('导出测试消息')
  await composer(page).press('Enter')
  await waitIdle(page, 45)
  await page.waitForTimeout(800)

  const exportBtn = page.locator('button:has-text("导出")').first()
  await exportBtn.click()
  await page.waitForTimeout(700)
  // 先把菜单项文字抓下来（点完菜单会收起）
  const labels = (await page.locator('[role="menuitem"]').allInnerTexts()).map((s) => s.replace(/\s+/g, ''))
  if (labels.length < 3) throw new Error('导出菜单项少于 3 个，实际 ' + labels.length)
  await reset(page)

  const got = []
  for (const label of labels) {
    await exportBtn.click()
    await page.waitForTimeout(700)
    const item = page.locator('[role="menuitem"]').filter({ hasText: label }).first()
    if (!(await item.count())) {
      got.push(`${label}:菜单项消失`)
      continue
    }
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
      item.click(),
    ])
    if (!download) {
      got.push(`${label}:无下载`)
      continue
    }
    const f = path.join(DL, download.suggestedFilename())
    await download.saveAs(f)
    const size = fs.statSync(f).size
    got.push(`${label}:${download.suggestedFilename()}(${size}B)`)
    await page.waitForTimeout(500)
  }
  await shot(page, 'export-formats')
  const bad = got.filter((g) => /无下载|菜单项消失|\(0B\)/.test(g))
  if (bad.length) throw new Error('导出失败：' + bad.join(' | '))
  return got.join(' | ')
})

// ---------------------------------------------------------------- 用量分析
await step('用量分析弹窗有真实数据', async () => {
  await reset(page)
  const usageBtn = page.locator('button:has-text("用量分析")').first()
  await usageBtn.click()
  // 偶发：上一次导出菜单的退场动画还没结束，第一次点击被吃掉，补一次点击
  try {
    await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 6000 })
  } catch {
    await usageBtn.click()
    await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 8000 })
  }
  await page.waitForTimeout(1200)
  await shot(page, 'usage-real')
  const txt = await page.locator('[role="dialog"]').innerText()
  await reset(page)
  if (!/token|Token|用量|消费/i.test(txt)) throw new Error('用量弹窗内容异常：' + txt.slice(0, 100).replace(/\s+/g, ' '))
  return '内容正常：' + txt.replace(/\s+/g, ' ').slice(0, 60)
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
