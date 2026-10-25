import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp} from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'

prepareEnv({ BREAKER_THRESHOLD: '100' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')

let server
let upstream
let providerId

before(async () => {
  initStorage()
  server = await listen(createApp())
  upstream = await startMockUpstream({ chunks: ['你好', '，我是网关'] })
  const res = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '网关测试',
      type: 'openai-compat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-mock',
      models: ['mock-model'],
    }),
  })
  providerId = (await res.json()).id
})

after(async () => {
  await upstream.close()
  await server.close()
})

const v1 = (path, options) => fetch(`${server.url}/v1${path}`, options)

test('GET /v1/models：暴露 provider:model 与裸模型名', async () => {
  const body = await (await v1('/models')).json()
  assert.equal(body.object, 'list')
  const ids = body.data.map((m) => m.id)
  assert.ok(ids.includes(`${providerId}:mock-model`))
  assert.ok(ids.includes('mock-model'))
})

test('POST /v1/chat/completions（非流式）：返回标准 completion 结构', async () => {
  const res = await v1('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `${providerId}:mock-model`,
      messages: [{ role: 'user', content: '你好' }],
      temperature: 0.5,
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.object, 'chat.completion')
  assert.match(body.id, /^chatcmpl-/)
  assert.equal(body.choices[0].message.role, 'assistant')
  assert.equal(body.choices[0].message.content, '你好，我是网关')
  assert.equal(body.choices[0].finish_reason, 'stop')
  assert.equal(body.usage.total_tokens, 20)
})

test('POST /v1/chat/completions（流式）：chunk 格式 + [DONE]', async () => {
  const res = await v1('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'mock-model', // 只有一个服务商时允许裸模型名
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
    }),
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  const raw = await res.text()
  assert.ok(raw.trim().endsWith('data: [DONE]'), '必须以 [DONE] 结尾')

  const chunks = raw
    .split('\n')
    .filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(5).trim()))

  assert.equal(chunks[0].object, 'chat.completion.chunk')
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')

  const text = chunks
    .map((c) => c.choices?.[0]?.delta?.content || '')
    .join('')
  assert.equal(text, '你好，我是网关')

  // 最后一个带 choices 的 chunk 才是 finish；usage-only chunk 的 choices 是空数组
  const finishChunk = [...chunks].reverse().find((c) => c.choices?.length)
  assert.equal(finishChunk.choices[0].finish_reason, 'stop')
  // usage 单独一个 chunk（与 OpenAI 行为一致）
  const usageChunk = chunks.find((c) => c.usage)
  assert.ok(usageChunk, '应有一个 usage chunk')
  assert.equal(usageChunk.usage.total_tokens, 20)
})

test('POST /v1/chat/completions：工具调用按标准格式透传（由调用方执行）', async (t) => {
  const toolUpstream = await startMockUpstream({
    toolPlan: [{ toolCalls: [{ name: 'get_weather', arguments: { city: '北京' } }] }],
  })
  t.after(() => toolUpstream.close())
  const created = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '网关工具',
      type: 'openai-compat',
      baseUrl: toolUpstream.baseUrl,
      apiKey: 'sk-mock',
      models: ['mock-model'],
    }),
  })
  const id = (await created.json()).id

  const res = await v1('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `${id}:mock-model`,
      messages: [{ role: 'user', content: '北京天气' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查天气',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    }),
  })
  const body = await res.json()
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  const call = body.choices[0].message.tool_calls[0]
  assert.equal(call.type, 'function')
  assert.equal(call.function.name, 'get_weather')
  assert.deepEqual(JSON.parse(call.function.arguments), { city: '北京' })
})

test('未知模型：返回 OpenAI 风格的 404 错误', async () => {
  const res = await v1('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nope:nope', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.error.code, 'model_not_found')
  assert.equal(body.error.type, 'invalid_request_error')
})

test('参数非法：400 且提示可读', async () => {
  const res = await v1('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `${providerId}:mock-model`, messages: [] }),
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  // 错误必须是 OpenAI 的形状，SDK 才读得到 message
  assert.equal(typeof body.error, 'object')
  assert.match(body.error.message, /messages/)
  assert.equal(body.error.type, 'invalid_request_error')
})

test('未知 /v1 路径返回 JSON 404（不是前端 HTML）', async () => {
  const res = await v1('/completions', { method: 'POST' })
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.error.type, 'invalid_request_error')
})
