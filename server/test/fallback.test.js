import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp } from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'

prepareEnv({ BREAKER_THRESHOLD: '100', UPSTREAM_RETRIES: '2' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
const { streamChat } = await import('../providers/stream.js')
const { breakerFor, resetResilience } = await import('../lib/resilience.js')

beforeEach(() => resetResilience())
afterEach(() => resetResilience())

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

  // 9 号端口在 fetch 规范的屏蔽名单里：undici 压根不会去建连接，直接抛 `fetch failed`/`bad port`。
  // 效果就是「主服务商完全不可达」，而且比随便挑一个空闲端口更稳定（不用担心真有人监听）。
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

const candidateProvider = (id) => ({ id, name: id, type: 'openai-compat', baseUrl: `https://${id}.invalid/v1` })
const badPortError = () => new TypeError('fetch failed', { cause: new Error('bad port') })
const successfulResponse = () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '备用回答' } }] })}\n\ndata: [DONE]\n\n`)

function fallbackOptions(t, backup) {
  return {
    model: 'primary-model',
    messages: [{ role: 'user', content: 'hi' }],
    fallbacks: [{ provider: backup, model: 'backup-model' }],
    onDelta: t.mock.fn(),
    onReasoning: t.mock.fn(),
    onToolCallStart: t.mock.fn(),
    onToolCallDelta: t.mock.fn(),
    onRetry: t.mock.fn(),
    onFallback: t.mock.fn(),
  }
}

test('streamChat：bad port 不原地重试，只向下一候选降级一次', async (t) => {
  const primary = candidateProvider('bad-port')
  const backup = candidateProvider('backup')
  const error = badPortError()
  const request = t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.startsWith(primary.baseUrl)) throw error
    return successfulResponse()
  })
  const options = fallbackOptions(t, backup)
  const result = await streamChat(primary, options)
  assert.deepEqual(request.mock.calls.map((call) => call.arguments[0]), [
    `${primary.baseUrl}/chat/completions`, `${backup.baseUrl}/chat/completions`,
  ])
  assert.equal(options.onRetry.mock.callCount(), 0)
  assert.equal(options.onFallback.mock.callCount(), 1)
  assert.equal(options.onFallback.mock.calls[0].arguments[0].error, error)
  assert.equal(error.failedProviderId, primary.id)
  assert.equal(error.failedModel, 'primary-model')
  assert.equal(result.provider, backup)
  assert.equal(result.model, 'backup-model')
  assert.equal(result.usedFallback, true)
  assert.equal(options.onDelta.mock.calls[0].arguments[0], '备用回答')
})

test('streamChat：已打开的熔断器跳过原候选，直接调用备用服务商', async (t) => {
  const primary = candidateProvider('open-circuit')
  const backup = candidateProvider('backup')
  breakerFor(primary.id, { threshold: 1, cooldownMs: 60_000 }).onFailure()
  const request = t.mock.method(globalThis, 'fetch', async () => successfulResponse())
  const options = fallbackOptions(t, backup)
  const result = await streamChat(primary, options)
  assert.equal(request.mock.callCount(), 1)
  assert.equal(request.mock.calls[0].arguments[0], `${backup.baseUrl}/chat/completions`)
  assert.equal(options.onRetry.mock.callCount(), 0)
  assert.equal(options.onFallback.mock.callCount(), 1)
  assert.equal(options.onFallback.mock.calls[0].arguments[0].error.code, 'provider_circuit_open')
  assert.equal(result.provider, backup)
  assert.equal(result.usedFallback, true)
})

for (const [name, delta, callback] of [
  ['delta', { content: '部分回答' }, 'onDelta'],
  ['reasoning', { reasoning_content: '部分思考' }, 'onReasoning'],
  ['tool start', { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup' } }] }, 'onToolCallStart'],
  ['tool delta', { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{' } }] }, 'onToolCallDelta'],
]) {
  test(`streamChat：输出 ${name} 后连接中断，绝不重试或降级`, async (t) => {
    const primary = candidateProvider('partial-output')
    const options = fallbackOptions(t, candidateProvider('backup'))
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) })
    const request = t.mock.method(globalThis, 'fetch', async () => {
      let sent = false
      return new Response(new ReadableStream({
        pull(controller) {
          if (sent) return controller.error(error)
          sent = true
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`))
        },
      }, { highWaterMark: 0 }))
    })
    await assert.rejects(streamChat(primary, options), (err) => {
      assert.equal(err, error)
      assert.equal(err.failedProviderId, primary.id)
      assert.equal(err.failedModel, 'primary-model')
      return true
    })
    assert.equal(options[callback].mock.callCount(), 1)
    assert.equal(request.mock.callCount(), 1)
    assert.equal(options.onRetry.mock.callCount(), 0)
    assert.equal(options.onFallback.mock.callCount(), 0)
  })
}

test('streamChat：重试耗尽后实际抛出最后失败候选的 Error，保留 cause 与归因', async (t) => {
  const primary = candidateProvider('primary-failure')
  const backup = candidateProvider('backup-failure')
  const cause = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
  const error = new TypeError('fetch failed', { cause })
  const request = t.mock.method(globalThis, 'fetch', async (url) => {
    throw url.startsWith(primary.baseUrl) ? badPortError() : error
  })
  const options = fallbackOptions(t, backup)
  await assert.rejects(streamChat(primary, options), (err) => {
    assert.equal(err, error)
    assert.equal(err.cause, cause)
    assert.equal(err.failedProviderId, backup.id)
    assert.equal(err.failedModel, 'backup-model')
    return true
  })
  assert.deepEqual(request.mock.calls.map((call) => call.arguments[0]), [
    `${primary.baseUrl}/chat/completions`,
    ...Array(3).fill(`${backup.baseUrl}/chat/completions`),
  ])
  assert.equal(options.onRetry.mock.callCount(), 2)
  assert.equal(options.onFallback.mock.callCount(), 1)
})

for (const [status, message] of [[401, 'unauthorized'], [429, 'insufficient_quota']]) {
  test(`streamChat：${message} 不重试也不降级`, async (t) => {
    const primary = candidateProvider('terminal-error')
    const options = fallbackOptions(t, candidateProvider('backup'))
    const request = t.mock.method(globalThis, 'fetch', async () => new Response(
      JSON.stringify({ error: { message } }), { status }
    ))
    await assert.rejects(streamChat(primary, options), (err) => {
      assert.equal(err.status, status)
      assert.equal(err.failedProviderId, primary.id)
      return true
    })
    assert.equal(request.mock.callCount(), 1)
    assert.equal(options.onRetry.mock.callCount(), 0)
    assert.equal(options.onFallback.mock.callCount(), 0)
  })
}

test('streamChat：客户端取消后，即使错误允许降级也立即停止', async (t) => {
  const controller = new AbortController()
  const options = { ...fallbackOptions(t, candidateProvider('backup')), abortSignal: controller.signal }
  const error = badPortError()
  const request = t.mock.method(globalThis, 'fetch', async () => {
    controller.abort()
    throw error
  })
  await assert.rejects(streamChat(candidateProvider('cancelled'), options), (err) => err === error)
  assert.equal(request.mock.callCount(), 1)
  assert.equal(options.onRetry.mock.callCount(), 0)
  assert.equal(options.onFallback.mock.callCount(), 0)
})

test('streamChat：非 Error 异常归一后，在实际抛出的对象上记录归因', async (t) => {
  const primary = candidateProvider('non-error')
  t.mock.method(globalThis, 'fetch', async () => { throw 'adapter failure' })
  await assert.rejects(streamChat(primary, fallbackOptions(t, candidateProvider('backup'))), (err) => {
    assert.ok(err instanceof Error)
    assert.equal(err.message, 'adapter failure')
    assert.equal(err.failedProviderId, primary.id)
    assert.equal(err.failedModel, 'primary-model')
    return true
  })
})
