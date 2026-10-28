/**
 * 一条命令跑完所有 e2e：起服务 → 等就绪 → 依次跑 4 套 → 收尾。
 *
 * 为什么要这个脚本：本机后台进程不随回合结束存活，
 * 手动起三个服务再跑测试时经常跑到一半发现端口已经没了（ERR_CONNECTION_REFUSED）。
 * 把生命周期收敛到一个进程里，服务活着的时间就等于测试跑的时间。
 *
 * 用法：
 *   node scripts/e2e/run-all.mjs                 # 跑全部
 *   node scripts/e2e/run-all.mjs full features2  # 只跑指定套件
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const NODE = process.execPath
const SHOTS = path.join(ROOT, '.shots')
fs.mkdirSync(SHOTS, { recursive: true })

// WEB_PORT 可覆盖：跑隔离环境（如多用户模式另起一套端口 + 独立数据目录）时用
const WEB_PORT = process.env.WEB_PORT || '5180'
const BASE = process.env.BASE || `http://127.0.0.1:${WEB_PORT}`
// 后端端口跟 server/config.js 的 PORT 一致；3001 被占或落进 Windows 保留端口段时，
// 用 `PORT=3011 node scripts/e2e/run-all.mjs` 整体切换（vite 代理也会跟着走）
const API = `http://127.0.0.1:${process.env.PORT || 3001}`
const MOCK = 'http://127.0.0.1:8790'

const SUITES = {
  full: 'scripts/e2e/full.mjs',
  features2: 'scripts/e2e/features2.mjs',
  phase3: 'scripts/e2e/phase3.mjs',
  phase4: 'scripts/e2e/phase4.mjs',
  phase5: 'scripts/e2e/phase5.mjs',
  phase6: 'scripts/e2e/phase6.mjs',
}

const procs = []
const logs = []

function start(name, args, logFile) {
  const out = fs.openSync(path.join(SHOTS, logFile), 'w')
  const child = spawn(NODE, args, { cwd: ROOT, stdio: ['ignore', out, out], env: process.env })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) logs.push(`[${name}] 提前退出 code=${code}`)
  })
  procs.push({ name, child })
  console.log(`  启动 ${name} (pid ${child.pid})`)
  return child
}

async function waitFor(url, label, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok || res.status < 500) return true
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内没有就绪：${url}`)
}

/**
 * 预热首屏。
 *
 * Vite 的依赖预构建是在「浏览器第一次请求模块图」时才触发的，只 curl 一个 200 不会触发。
 * 冷启动时这一次能到 60s+（本机实测），会正好吃掉第一个套件的 page.goto 超时，
 * 表现成「服务明明起来了却 net::ERR_CONNECTION_REFUSED / Timeout」。
 * 在这里先用无头浏览器把这一趟走完，套件就都跑在热缓存上。
 */
async function warmUp() {
  if (process.env.SKIP_WARMUP === '1') return
  const req = createRequire('C:/Users/FLYF/.workbuddy-ai/binaries/node/workspace/')
  const { chromium } = req('playwright-core')
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--no-proxy-server'],
  })
  const t0 = Date.now()
  try {
    const page = await browser.newPage()
    page.setDefaultNavigationTimeout(120000)
    // 用 domcontentloaded + 等输入框出现，而不是 waitUntil:'load'：
    // 'load' 要等所有子资源（字体/图标），任何一个卡住就会一直挂着。
    // 输入框出现就说明模块图已经全部加载完，依赖预构建也就跑完了。
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await page.waitForSelector('textarea', { timeout: 120000 })
    await page.waitForTimeout(800)
    console.log(`  首屏预热完成（${Math.round((Date.now() - t0) / 1000)}s）\n`)
  } catch (e) {
    console.log(`  首屏预热失败（${Math.round((Date.now() - t0) / 1000)}s）：${e.message.split('\n')[0]}`)
  } finally {
    await browser.close()
  }
}

function stopAll() {
  for (const { name, child } of procs) {
    if (!child.killed) {
      try {
        // Windows 下直接 kill 子进程即可（不是 shell 包装，pid 就是 node）
        child.kill('SIGTERM')
      } catch {
        /* 已退出 */
      }
    }
  }
}

const argv = process.argv.slice(2)
// --exec <file>：起好服务后跑任意一次性诊断脚本（探针），跑完照样收尾。
// 本机后台进程不跨命令存活，所以临时排查也得走这个入口，否则服务会在两条命令之间被回收。
const execIdx = argv.indexOf('--exec')
const execScript = execIdx > -1 ? argv[execIdx + 1] : null
// 只有真的带了 --exec 才需要把它的值从套件名里剔除（execIdx 为 -1 时不能误删第一个参数）
const wanted = execIdx > -1 ? argv.filter((_, i) => i !== execIdx && i !== execIdx + 1) : argv
// phase6（多用户）必须跑在独立环境里（MULTI_USER=true + 独立数据目录），
// 默认全量不带上它，否则会拿单用户的后端去测多用户，全部失败。
const DEFAULT_SUITES = Object.keys(SUITES).filter((k) => k !== 'phase6')
const suites = execScript ? [] : wanted.length ? wanted : DEFAULT_SUITES
for (const s of suites) {
  if (!SUITES[s]) {
    console.error(`未知套件：${s}（可选：${Object.keys(SUITES).join(' / ')}）`)
    process.exit(2)
  }
}

const cleanup = () => stopAll()
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

console.log('\n=== 准备环境 ===')
try {
  // 先探一下，已经在跑的就不重复起（避免 EADDRINUSE）
  const alive = await Promise.all(
    [API + '/api/health', BASE + '/', MOCK + '/v1/models'].map((u) =>
      fetch(u, { signal: AbortSignal.timeout(1500) })
        .then(() => true)
        .catch(() => false)
    )
  )
  if (!alive[0]) start('backend', ['server/index.js'], 'run-backend.log')
  else console.log('  后端已在运行，复用')
  if (!alive[1]) start('vite', ['node_modules/vite/bin/vite.js', '--port', WEB_PORT, '--strictPort', '--host', '127.0.0.1'], 'run-vite.log')
  else console.log('  前端已在运行，复用')
  if (!alive[2]) start('mock', ['scripts/mock-flash.mjs'], 'run-mock.log')
  else console.log('  闪测模型已在运行，复用')

  await waitFor(API + '/api/health', '后端')
  // Vite 冷启动要做依赖预构建，实测能到 25s+，给足 120s 别卡在临界点上
  await waitFor(BASE + '/', '前端', 120000)
  await waitFor(MOCK + '/v1/models', '闪测模型')
  console.log('  三个服务就绪')
  if (!execScript && !wanted.length) {
    console.log('  提示：phase6（多用户）需独立环境，默认不跑——')
    console.log('        WEB_PORT=5181 PORT=4101 MULTI_USER=true FLYCHAT_DATA_DIR=.shots/mu-data \\')
    console.log('          node scripts/e2e/run-all.mjs phase6')
  }
  await warmUp()
} catch (e) {
  console.error('环境启动失败：' + e.message)
  for (const l of logs) console.error('  ' + l)
  cleanup()
  process.exit(1)
}

const summary = []
if (execScript) {
  console.log(`=== exec: ${execScript} ===`)
  const code = await new Promise((resolve) => {
    const child = spawn(NODE, [execScript], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, BASE } })
    child.on('exit', (c) => resolve(c ?? 1))
  })
  summary.push({ name: execScript, ok: code === 0 })
}

for (const name of suites) {
  console.log(`=== ${name} ===`)
  const code = await new Promise((resolve) => {
    const child = spawn(NODE, [SUITES[name]], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, BASE },
    })
    child.on('exit', (c) => resolve(c ?? 1))
  })
  summary.push({ name, ok: code === 0 })
  console.log('')
}

console.log('=== 总览 ===')
for (const s of summary) console.log(`  ${s.ok ? '✓' : '✗'} ${s.name}`)
if (logs.length) {
  console.log('\n服务异常：')
  for (const l of logs) console.log('  ' + l)
}

cleanup()
process.exitCode = summary.every((s) => s.ok) ? 0 : 1
