import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp} from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'

prepareEnv({ BREAKER_THRESHOLD: '100' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
const { resolveTools, executeTool, TOOLS } = await import('../tools/index.js')

let server

before(async () => {
  initStorage()
  server = await listen(createApp())
})

after(async () => {
  await server.close()
})

async function createProvider(baseUrl, type = 'openai-compat') {
  const res = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Tool ${Date.now()}`, type, baseUrl, apiKey: 'sk-mock', models: ['mock-model'] }),
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  return body.id
}

function chat(body) {
  return fetch(`${server.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('工具注册表：默认工具都有合法 JSON Schema', () => {
  const defs = resolveTools()
  assert.ok(defs.length >= 3)
  for (const d of defs) {
    assert.ok(d.name, '缺少 name')
    assert.ok(d.description, `${d.name} 缺少 description`)
    assert.equal(d.parameters.type, 'object')
  }
})

test('executeTool：未知工具返回结构化错误而不是抛异常', async () => {
  const result = await executeTool('not_a_tool', {})
  assert.equal(result.ok, false)
  assert.match(result.error, /未知工具/)
})

test('executeTool：current_time 可用且不需要外部配置', async () => {
  const result = await executeTool('current_time', {})
  assert.equal(result.ok, true)
  assert.ok(result.result.iso)
  assert.ok(result.result.local)
})

test('fetch_url：拒绝内网与云元数据地址（防模型被诱导）', async () => {
  const meta = await executeTool('fetch_url', { url: 'http://169.254.169.254/latest/meta-data' })
  assert.equal(meta.ok, false)
  assert.match(meta.error, /禁止/)

  const loopback = await executeTool('fetch_url', { url: 'http://127.0.0.1:3001/api/health' })
  assert.equal(loopback.ok, false)
  assert.match(loopback.error, /内网|回环/)
})

test('fetch_url：重定向跳到内网/元数据必须被拦（逐跳校验）', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  let hops = []
  globalThis.fetch = async (url) => {
    hops.push(String(url))
    return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } })
  }

  const result = await executeTool('fetch_url', { url: 'http://public.example.com/redirect' })
  assert.equal(result.ok, false, '302 到云元数据地址绝不能成功')
  assert.match(result.error, /禁止|链路本地/)
  assert.equal(hops.length, 1, '第二跳的请求根本不应该发出去')
})

test('fetch_url：公网 → 公网的重定向正常跟随并解析正文', async (t) => {
  const realFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = realFetch
  })
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/jump')) {
      return new Response(null, { status: 302, headers: { Location: 'https://public.example.com/final' } })
    }
    const res = new Response('<html><title>达标页</title><body><p>正文内容在这里</p></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
    // new Response() 的 url 恒为空串；真实 undici 会把最终请求地址填进去，这里手动补上
    Object.defineProperty(res, 'url', { value: 'https://public.example.com/final' })
    return res
  }

  const result = await executeTool('fetch_url', { url: 'https://public.example.com/jump' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.result.title, '达标页')
  assert.match(result.result.text, /正文内容/)
  assert.equal(result.result.url, 'https://public.example.com/final')
})

test('agent 循环：模型调工具 → 服务端执行 → 模型继续作答（OpenAI 协议）', async (t) => {
  const upstream = await startMockUpstream({
    toolPlan: [
      { toolCalls: [{ name: 'current_time', arguments: {} }] },
      { text: '现在是本地时间下午三点。' },
    ],
  })
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const events = await readSse(
    await chat({
      provider: providerId,
      model: 'mock-model',
      messages: [{ role: 'user', content: '现在几点了？' }],
      tools: true,
    })
  )
  const types = events.map((e) => e.type)

  assert.ok(types.includes('tool_call'), `应有 tool_call 事件：${types.join(',')}`)
  const call = events.find((e) => e.type === 'tool_call')
  assert.equal(call.name, 'current_time')

  const result = events.find((e) => e.type === 'tool_result')
  assert.ok(result, '应有 tool_result 事件')
  assert.equal(result.ok, true)

  const text = events
    .filter((e) => e.type === 'delta')
    .map((e) => e.content)
    .join('')
  assert.equal(text, '现在是本地时间下午三点。')
  assert.equal(types.at(-1), 'done')

  // 第二次请求必须带上工具结果，模型才知道工具返回了什么
  assert.equal(upstream.state.hits, 2)
  const second = upstream.state.lastBody
  assert.ok(second.tools?.length, '第二轮仍要带工具定义')
  const toolMessage = second.messages.find((m) => m.role === 'tool')
  assert.ok(toolMessage, '第二轮必须包含 role=tool 的消息')
  assert.equal(toolMessage.tool_call_id, 'call_0')
  assert.match(toolMessage.content, /"ok":true/)

  // 多轮 usage 要累加，否则成本统计少一半
  const usage = events.find((e) => e.type === 'usage')
  assert.equal(usage.usage.total, 40)
})

test('agent 循环：Anthropic 协议的 tool_use 增量也能正确拼装', async (t) => {
  const upstream = await startMockUpstream({
    toolPlan: [
      { toolCalls: [{ name: 'current_time', arguments: { timezone: 'Asia/Shanghai' } }] },
      { text: '上海时间已获取。' },
    ],
  })
  t.after(() => upstream.close())
  const providerId = await createProvider(`${upstream.baseUrl}`, 'anthropic')

  const events = await readSse(
    await chat({
      provider: providerId,
      model: 'mock-model',
      messages: [{ role: 'user', content: '上海现在几点' }],
      tools: true,
    })
  )
  const call = events.find((e) => e.type === 'tool_call')
  assert.ok(call, '应有 tool_call')
  assert.equal(call.name, 'current_time')
  assert.equal(call.arguments.timezone, 'Asia/Shanghai')

  const result = events.find((e) => e.type === 'tool_result')
  assert.equal(result.ok, true)

  // 第二轮里 Anthropic 要求 tool_result 是 user 消息里的 block
  const second = upstream.state.lastBody
  const hasToolResult = JSON.stringify(second.messages).includes('tool_result')
  assert.ok(hasToolResult, 'Anthropic 第二轮必须包含 tool_result block')
})

test('不支持工具的模型：降级为普通对话并提示', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  // embed 类模型按启发式会被判定为不支持工具
  const events = await readSse(
    await chat({
      provider: providerId,
      model: 'text-embedding-3-small',
      messages: [{ role: 'user', content: '你好' }],
      tools: true,
    })
  )
  const notice = events.find((e) => e.type === 'notice')
  assert.ok(notice)
  assert.match(notice.message, /不支持工具调用/)
  assert.equal(events.at(-1).type, 'done')
  assert.equal(upstream.state.lastBody.tools, undefined, '降级后不应带 tools')
})

test('TOOLS 表里的每个工具名与定义名一致', () => {
  for (const [key, tool] of Object.entries(TOOLS)) {
    assert.equal(tool.definition.name, key)
    assert.equal(typeof tool.run, 'function')
  }
})
