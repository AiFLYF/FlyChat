import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp } from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'
import { startMockMcpHttp, writeMcpServerScript } from './helpers/mock-mcp.js'
import { mcpToolName, parseToolName, contentToText } from '../mcp/protocol.js'

prepareEnv({ BREAKER_THRESHOLD: '100' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
const { closeAll, resetMcpPool } = await import('../mcp/manager.js')

let server
let upstream
let providerId
let stdioScript

before(async () => {
  initStorage()
  server = await listen(createApp())
  upstream = await startMockUpstream({ chunks: ['好的'] })
  const res = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'MCP 测试',
      type: 'openai-compat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-mock',
      models: ['mock-model'],
    }),
  })
  providerId = (await res.json()).id
  stdioScript = writeMcpServerScript()
})

after(async () => {
  await closeAll()
  await upstream.close()
  await server.close()
})

const post = (path, body) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

const createStdioServer = (name = 'fake-mcp') =>
  post('/api/mcp/servers', {
    name,
    transport: 'stdio',
    command: process.execPath,
    args: [stdioScript],
  }).then((r) => r.json())

test('协议工具函数：命名空间与反解析', () => {
  // 中文名会被转写成 ASCII，并拼上 id 短哈希保证不撞车
  const name = mcpToolName('mcp-1a2b', '我的 Server', 'get_weather')
  assert.match(name, /^mcp__[a-z0-9_-]+-1a2b__get_weather$/)
  assert.equal(parseToolName(name), 'get_weather')

  // 两个中文名相同的 server 不会互相覆盖
  const a = mcpToolName('mcp-aaaa', '我的 Server', 'get_weather')
  const b = mcpToolName('mcp-bbbb', '我的 Server', 'get_weather')
  assert.notEqual(a, b)

  assert.equal(name, mcpToolName('mcp-1a2b', '我的 Server', 'get_weather'), '同输入必须稳定')

  // 图片返回占位说明而不是把 base64 灌进上下文，但也不会被悄悄丢掉
  assert.equal(
    contentToText([
      { type: 'text', text: '第一段' },
      { type: 'image', data: 'base64...' },
      { type: 'text', text: '第二段' },
    ]),
    '第一段\n\n[image content]\n\n第二段'
  )
})

test('stdio 传输：探测能连上并列出工具', async () => {
  const created = await createStdioServer()
  assert.ok(created.id)
  assert.equal(created.enabled, false)

  const probe = await (await post(`/api/mcp/servers/${created.id}/probe`)).json()
  assert.equal(probe.ok, true, probe.error)
  assert.equal(probe.tools.length, 2)
  assert.equal(probe.tools[0].name, 'get_weather')
  assert.equal(probe.tools[1].annotations.destructiveHint, true)
})

test('参数校验：不合法配置返回 400 而不是 500', async () => {
  const bad = await post('/api/mcp/servers', { name: 'x', transport: 'ftp' })
  assert.equal(bad.status, 400)

  const noCommand = await post('/api/mcp/servers', { name: 'x', transport: 'stdio' })
  assert.equal(noCommand.status, 400)

  const badUrl = await post('/api/mcp/servers', { name: 'x', transport: 'http', baseUrl: 'ftp://x' })
  assert.equal(badUrl.status, 400)
})

test('启用后工具进入 agent 工具箱，且带命名空间', async (t) => {
  const created = await createStdioServer('weather-srv')
  await post(`/api/mcp/servers/${created.id}/enable`, { enabled: true })

  const tools = await (await fetch(`${server.url}/api/mcp/tools`)).json()
  const names = tools.tools.map((t) => t.name)
  t.after(() => post(`/api/mcp/servers/${created.id}/enable`, { enabled: false }))
  assert.ok(names.some((n) => /^mcp__weather-srv-[a-z0-9]+__get_weather$/.test(n)), names.join(','))
  assert.ok(names.some((n) => /^mcp__weather-srv-[a-z0-9]+__write_file$/.test(n)))

  const weather = tools.tools.find((t) => t.name.endsWith('get_weather'))
  assert.match(weather.description, /MCP: weather-srv/)
  assert.equal(weather.parameters.type, 'object')
  assert.ok(weather.parameters.properties.city)
})

test('agent 调用 MCP 只读工具：未信任也放行', async (t) => {
  const created = await createStdioServer('readonly-srv')
  await post(`/api/mcp/servers/${created.id}/enable`, { enabled: true })
  t.after(() => post(`/api/mcp/servers/${created.id}/enable`, { enabled: false }))

  const upstream2 = await startMockUpstream({
    toolPlan: [
      { toolCalls: [{ name: mcpToolName(created.id, 'readonly-srv', 'get_weather'), arguments: { city: '北京' } }] },
      { text: '北京今天晴，26℃。' },
    ],
  })
  t.after(() => upstream2.close())
  const provider2 = await (
    await fetch(`${server.url}/api/providers/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'MCP 对话',
        type: 'openai-compat',
        baseUrl: upstream2.baseUrl,
        apiKey: 'k',
        models: ['mock-model'],
      }),
    })
  ).json()

  const events = await readSse(
    await post('/api/chat', {
      provider: provider2.id,
      model: 'mock-model',
      messages: [{ role: 'user', content: '北京天气如何？' }],
      tools: true,
    })
  )

  const call = events.find((e) => e.type === 'tool_call')
  assert.ok(call, '应发出 tool_call')
  assert.equal(call.name, mcpToolName(created.id, 'readonly-srv', 'get_weather'))

  const result = events.find((e) => e.type === 'tool_result')
  assert.equal(result.ok, true)
  assert.match(result.preview, /北京 晴 26℃/)

  const text = events
    .filter((e) => e.type === 'delta')
    .map((e) => e.content)
    .join('')
  assert.equal(text, '北京今天晴，26℃。')
})

test('MCP 可写工具：未信任 server 被拦下，并告知怎么开', async (t) => {
  const created = await createStdioServer('write-srv')
  await post(`/api/mcp/servers/${created.id}/enable`, { enabled: true })
  t.after(() => post(`/api/mcp/servers/${created.id}/enable`, { enabled: false }))

  const upstream2 = await startMockUpstream({
    toolPlan: [
      { toolCalls: [{ name: mcpToolName(created.id, 'write-srv', 'write_file'), arguments: { path: '/tmp/x', content: 'hi' } }] },
      { text: '已尝试写入。' },
    ],
  })
  t.after(() => upstream2.close())
  const provider2 = await (
    await fetch(`${server.url}/api/providers/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MCP 写', type: 'openai-compat', baseUrl: upstream2.baseUrl, apiKey: 'k', models: ['mock-model'] }),
    })
  ).json()

  const events = await readSse(
    await post('/api/chat', {
      provider: provider2.id,
      model: 'mock-model',
      messages: [{ role: 'user', content: '帮我写个文件' }],
      tools: true,
    })
  )

  const result = events.find((e) => e.type === 'tool_result')
  assert.ok(result, '应发出 tool_result')
  assert.equal(result.ok, false, '未信任时写操作必须被拒绝')
  assert.match(result.preview, /信任/)

  // 错误信息必须回给模型，它才能换个方式回答
  const sent = JSON.stringify(upstream2.state.lastBody.messages)
  assert.match(sent, /信任/)
  assert.equal(events.at(-1).type, 'done')
})

test('信任开关打开后可写工具放行', async (t) => {
  const created = await createStdioServer('trusted-srv')
  await post(`/api/mcp/servers/${created.id}/enable`, { enabled: true })
  await post(`/api/mcp/servers/${created.id}/trust`, { trusted: true })
  t.after(() => {
    post(`/api/mcp/servers/${created.id}/enable`, { enabled: false })
    post(`/api/mcp/servers/${created.id}/trust`, { trusted: false })
  })

  const upstream2 = await startMockUpstream({
    toolPlan: [
      { toolCalls: [{ name: mcpToolName(created.id, 'trusted-srv', 'write_file'), arguments: { path: '/tmp/x', content: 'hi' } }] },
      { text: '已写入。' },
    ],
  })
  t.after(() => upstream2.close())
  const provider2 = await (
    await fetch(`${server.url}/api/providers/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MCP 信任', type: 'openai-compat', baseUrl: upstream2.baseUrl, apiKey: 'k', models: ['mock-model'] }),
    })
  ).json()

  const events = await readSse(
    await post('/api/chat', {
      provider: provider2.id,
      model: 'mock-model',
      messages: [{ role: 'user', content: '帮我写个文件' }],
      tools: true,
    })
  )
  const result = events.find((e) => e.type === 'tool_result')
  assert.equal(result.ok, true, '信任后应放行')
})

test('单工具禁用后不再出现', async (t) => {
  const created = await createStdioServer('disable-srv')
  await post(`/api/mcp/servers/${created.id}/enable`, { enabled: true })
  await post(`/api/mcp/servers/${created.id}/tools/get_weather/disable`, { disabled: true })
  t.after(() => post(`/api/mcp/servers/${created.id}/enable`, { enabled: false }))

  const tools = await (await fetch(`${server.url}/api/mcp/tools`)).json()
  const names = tools.tools
    .filter((x) => x.name.includes('disable-srv'))
    .map((x) => x.name)
  assert.equal(names.length, 1, `该 server 应只剩 1 个工具，实际：${names.join(',')}`)
  assert.ok(!names.some((n) => /__get_weather$/.test(n)), '被禁用的工具不应出现')
  assert.ok(names.some((n) => /__write_file$/.test(n)))
})

test('HTTP 传输：探测与调用都走 Streamable HTTP', async (t) => {
  const httpMcp = await startMockMcpHttp()
  t.after(() => httpMcp.close())

  const created = await (await post('/api/mcp/servers', { name: 'http-srv', transport: 'http', baseUrl: httpMcp.baseUrl, headers: { Authorization: 'Bearer test' } })).json()
  assert.ok(created.id)

  const probe = await (await post(`/api/mcp/servers/${created.id}/probe`)).json()
  assert.equal(probe.ok, true, probe.error)
  assert.equal(probe.tools.length, 2)
  assert.ok(httpMcp.state.hits >= 2, 'initialize + tools/list')

  await post(`/api/mcp/servers/${created.id}/enable`, { enabled: true })
  t.after(() => post(`/api/mcp/servers/${created.id}/enable`, { enabled: false }))

  const upstream2 = await startMockUpstream({
    toolPlan: [
      { toolCalls: [{ name: mcpToolName(created.id, 'http-srv', 'write_file'), arguments: { path: '/tmp/a.txt', content: 'x' } }] },
      { text: '已通过 HTTP 写入。' },
    ],
  })
  t.after(() => upstream2.close())
  const provider2 = await (
    await fetch(`${server.url}/api/providers/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'http chat', type: 'openai-compat', baseUrl: upstream2.baseUrl, apiKey: 'k', models: ['mock-model'] }),
    })
  ).json()

  await post(`/api/mcp/servers/${created.id}/trust`, { trusted: true })
  t.after(() => post(`/api/mcp/servers/${created.id}/trust`, { trusted: false }))

  const events = await readSse(
    await post('/api/chat', {
      provider: provider2.id,
      model: 'mock-model',
      messages: [{ role: 'user', content: '写文件' }],
      tools: true,
    })
  )
  const result = events.find((e) => e.type === 'tool_result')
  assert.equal(result.ok, true, result?.preview)
  assert.match(result.preview, /HTTP 已写入/)
})

test('server 挂了：不拖垮对话，只跳过它的工具', async (t) => {
  // 指向一个必然连不上的地址
  const created = await (
    await post('/api/mcp/servers', { name: 'dead-srv', transport: 'http', baseUrl: 'http://127.0.0.1:9/mcp' })
  ).json()
  await post(`/api/mcp/servers/${created.id}/enable`, { enabled: true })
  t.after(() => post(`/api/mcp/servers/${created.id}/enable`, { enabled: false }))

  const events = await readSse(
    await post('/api/chat', {
      provider: providerId,
      model: 'mock-model',
      messages: [{ role: 'user', content: '你好' }],
      tools: true,
    })
  )
  assert.equal(events.at(-1).type, 'done', 'MCP 挂了也不能影响对话')
})

test('CRUD：修改与删除', async () => {
  const created = await createStdioServer('crud-srv')
  const updated = await (await fetch(`${server.url}/api/mcp/servers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: created.id, name: '改名了', transport: 'stdio', command: process.execPath, args: [stdioScript] }) })).json()
  assert.equal(updated.name, '改名了')

  const del = await fetch(`${server.url}/api/mcp/servers/${created.id}`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  const gone = await fetch(`${server.url}/api/mcp/servers/${created.id}`, { method: 'DELETE' })
  assert.equal(gone.status, 404)
})

test('密钥不回传：env / headers 只给 key 名', async () => {
  const created = await post('/api/mcp/servers', {
    name: 'secret-srv',
    transport: 'stdio',
    command: process.execPath,
    args: [stdioScript],
    env: { API_KEY: 'sk-super-secret' },
  })
  const text = JSON.stringify(await created.json())
  assert.ok(!text.includes('sk-super-secret'), '密钥绝不能出现在响应里')
  assert.ok(text.includes('API_KEY') || text.includes('env'))
})
