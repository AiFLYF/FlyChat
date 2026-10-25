#!/usr/bin/env node
/**
 * 后端冒烟脚本：对着一个**正在运行**的服务，把关键接口走一遍。
 *
 * 用途：
 *   - 部署后确认服务真的活着（不只是 /api/health 返回 200）
 *   - 改完后端跑一次，比手工点界面快
 *
 * 用法：
 *   node scripts/smoke-api.mjs                       # 默认 http://127.0.0.1:3001
 *   node scripts/smoke-api.mjs http://127.0.0.1:3011
 *   FLYCHAT_ACCESS_TOKEN=xxx node scripts/smoke-api.mjs   # 服务端开了鉴权时
 *
 * 不需要真实 API Key：只验证「接口通、结构对、错误处理合理」，不发真实模型请求。
 */

const BASE = (process.argv[2] || process.env.FLYCHAT_URL || 'http://127.0.0.1:3001').replace(/\/$/, '')
const TOKEN = process.env.FLYCHAT_ACCESS_TOKEN || ''

let pass = 0
let fail = 0
const failures = []

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    ...extra,
  }
}

async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    failures.push({ name, message: err?.message || String(err) })
    console.log(`  ✗ ${name}\n      ${err?.message || err}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

async function get(path) {
  return fetch(`${BASE}${path}`, { headers: headers() })
}

async function post(path, body) {
  return fetch(`${BASE}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
}

console.log(`\nFlyChat 后端冒烟：${BASE}\n`)

await check('GET /api/health 返回 200 且 ok=true', async () => {
  const res = await get('/api/health')
  assert(res.status === 200, `状态码 ${res.status}`)
  const body = await res.json()
  assert(body.ok === true, 'ok 不为 true')
})

await check('GET /api/config 返回能力开关', async () => {
  const body = await (await get('/api/config')).json()
  assert(body.features && typeof body.features.webSearch === 'boolean', '缺少 features.webSearch')
  assert(body.limits && body.limits.bodyBytes > 0, '缺少 limits.bodyBytes')
})

await check('GET /api/providers 不泄露 API Key', async () => {
  const text = await (await get('/api/providers')).text()
  assert(!/apiKey/i.test(text), '响应体里出现了 apiKey 字段')
})

await check('GET /api/providers/all 返回全部服务商模板', async () => {
  const body = await (await get('/api/providers/all')).json()
  assert(Array.isArray(body.providers) && body.providers.length > 0, '没有返回服务商')
})

await check('GET /api/models 返回模型目录', async () => {
  const body = await (await get('/api/models')).json()
  assert(Array.isArray(body.models), 'models 不是数组')
  for (const m of body.models) {
    assert(typeof m.contextWindow === 'number' && m.contextWindow > 0, `${m.model} 缺少 contextWindow`)
    assert(m.capabilities && typeof m.capabilities.vision === 'boolean', `${m.model} 缺少 capabilities`)
  }
})

await check('GET /api/conversations 返回列表结构', async () => {
  const res = await get('/api/conversations')
  if (res.status === 503) {
    console.log('      （服务端持久化不可用，跳过）')
    return
  }
  const body = await res.json()
  assert(Array.isArray(body.items), 'items 不是数组')
})

await check('会话创建 → 读取 → 删除 闭环', async () => {
  const id = `smoke-${Date.now().toString(36)}`
  const created = await post('/api/conversations', {
    id,
    title: '冒烟测试',
    messages: [{ id: `${id}-m1`, role: 'user', content: '你好' }],
  })
  if (created.status === 503) return
  assert(created.status === 201, `创建返回 ${created.status}`)

  const got = await (await get(`/api/conversations/${id}`)).json()
  assert(got.messages?.length === 1, '读取到的消息数不对')

  const del = await fetch(`${BASE}/api/conversations/${id}`, { method: 'DELETE', headers: headers() })
  assert(del.status === 200, `删除返回 ${del.status}`)
})

await check('分享创建 → 公开读取 → 删除', async () => {
  const share = await post('/api/share', {
    snapshot: { id: 'smoke-share', title: '冒烟分享', messages: [{ id: 'x', role: 'user', content: 'hi' }] },
  })
  if (share.status === 503) return
  assert(share.status === 201, `创建分享返回 ${share.status}`)
  const { id } = await share.json()

  // 读取分享**故意不带令牌**：它是公开接口
  const read = await fetch(`${BASE}/api/share/${id}`)
  assert(read.status === 200, `读取分享返回 ${read.status}`)
  const data = await read.json()
  assert(data.title === '冒烟分享', '分享标题不对')

  const del = await fetch(`${BASE}/api/share/${id}`, { method: 'DELETE', headers: headers() })
  assert(del.status === 200, `删除分享返回 ${del.status}`)
})

await check('GET /api/presets 可用（存储不可用时要给 JSON 而不是 HTML）', async () => {
  const res = await get('/api/presets')
  // 存储可用 → 200 + items；不可用 → 503 + JSON 错误。两种都不是前端 HTML
  assert(res.status === 200 || res.status === 503, `状态码 ${res.status}`)
  const body = await res.json()
  if (res.status === 200) assert(Array.isArray(body.items), 'items 应为数组')
  else assert(typeof body.code === 'string', '503 时要带 code')
})

await check('GET /api/mcp/servers 与 /api/mcp/tools 可用', async () => {
  const servers = await get('/api/mcp/servers')
  assert(servers.status === 200, `状态码 ${servers.status}`)
  const serverBody = await servers.json()
  assert(Array.isArray(serverBody.items), 'items 应为数组')

  const tools = await get('/api/mcp/tools')
  assert(tools.status === 200, `状态码 ${tools.status}`)
  const toolBody = await tools.json()
  assert(Array.isArray(toolBody.tools), 'tools 应为数组')
})

await check('GET /api/usage 返回用量结构', async () => {
  const body = await (await get('/api/usage?days=7')).json()
  if (body.available === false) return
  assert(body.totals && typeof body.totals.requests === 'number', '缺少 totals.requests')
  assert(Array.isArray(body.byDay), 'byDay 不是数组')
})

await check('非法参数返回 400 而不是 500', async () => {
  const res = await post('/api/chat', { provider: 'nope', messages: [] })
  assert(res.status === 400, `期望 400，实际 ${res.status}`)
  const body = await res.json()
  assert(typeof body.error === 'string', '缺少 error 文案')
})

await check('非法 Base URL 被拒绝（SSRF 防护）', async () => {
  const res = await post('/api/providers/custom', {
    name: '冒烟-非法',
    type: 'openai-compat',
    baseUrl: 'http://169.254.169.254/latest',
    models: ['x'],
  })
  assert(res.status === 400, `期望 400，实际 ${res.status}`)
})

await check('未知接口返回 JSON 404', async () => {
  const res = await get('/api/definitely-not-here')
  assert(res.status === 404, `状态码 ${res.status}`)
  const body = await res.json()
  assert(body.code === 'route_not_found', '缺少 code')
})

await check('GET /api/metrics 返回计数器', async () => {
  const body = await (await get('/api/metrics')).json()
  assert(body.counters && typeof body.counters === 'object', '缺少 counters')
  assert(typeof body.uptimeSeconds === 'number', '缺少 uptimeSeconds')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
  process.exit(1)
}
