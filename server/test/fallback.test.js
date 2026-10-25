import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp} from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'

prepareEnv({ BREAKER_THRESHOLD: '100' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')

let server

before(async () => {
  initStorage()
  server = await listen(createApp())
})

after(async () => {
  delete process.env.FALLBACK_MODELS
  await server.close()
})

async function createProvider(name, baseUrl) {
  const res = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: 'openai-compat', baseUrl, apiKey: 'sk-mock', models: ['mock-model'] }),
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

test('主服务商连接失败：自动降级到备用模型，用户仍拿到完整回答', async (t) => {
  const upstream = await startMockUpstream({ chunks: ['来自备用模型的回答'] })
  t.after(() => upstream.close())

  // 9 号端口基本可以确定没人监听 → ECONNREFUSED（可重试错误）
  const primary = await createProvider('主服务商-坏的', 'http://127.0.0.1:9/v1')
  const backup = await createProvider('备用服务商', upstream.baseUrl)
  process.env.FALLBACK_MODELS = `${primary}:mock-model,${backup}:mock-model`

  const events = await readSse(
    await chat({
      provider: primary,
      model: 'mock-model',
      messages: [{ role: 'user', content: '你好' }],
    })
  )
  const types = events.map((e) => e.type)

  assert.ok(types.includes('model_switch'), `应有 model_switch 事件：${types.join(',')}`)
  const sw = events.find((e) => e.type === 'model_switch')
  assert.equal(sw.from.provider, primary)
  assert.equal(sw.to.provider, backup)

  const notice = events.find((e) => e.type === 'notice')
  assert.ok(notice, '应提示用户发生了切换')

  const text = events
    .filter((e) => e.type === 'delta')
    .map((e) => e.content)
    .join('')
  assert.equal(text, '来自备用模型的回答')
  assert.equal(types.at(-1), 'done')
  assert.equal(upstream.state.hits, 1, '备用模型应收到一次请求')
})

test('没有配置降级链时，主服务商失败就直接报错', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  delete process.env.FALLBACK_MODELS

  const primary = await createProvider('无降级-坏的', 'http://127.0.0.1:9/v1')
  const events = await readSse(
    await chat({ provider: primary, model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] })
  )
  const error = events.find((e) => e.type === 'error')
  assert.ok(error, '应返回 error 事件')
  assert.ok(!events.some((e) => e.type === 'model_switch'))
  assert.ok(!events.some((e) => e.type === 'done'))
})

test('降级链里的未知服务商被忽略，不会抛错', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const primary = await createProvider('链-主', upstream.baseUrl)
  process.env.FALLBACK_MODELS = '不存在的服务商:某个模型'

  const events = await readSse(
    await chat({ provider: primary, model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] })
  )
  assert.equal(events.at(-1).type, 'done')
  assert.ok(!events.some((e) => e.type === 'model_switch'))
})
