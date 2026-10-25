import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp } from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'

prepareEnv({ BREAKER_THRESHOLD: '100', UPSTREAM_RETRIES: '0' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
initStorage()

const server = await listen(createApp())

const post = (path, body) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test.after(() => server.close())

/** 注册一个「图像模型」服务商（模型名要能匹配到图像特征） */
async function addImageProvider(options = {}) {
  // 名字里带 dall-e，resolveImageTarget 才认得出这是图像模型
  const models = options.models || ['mock-dall-e']
  const upstream = await startMockUpstream({ models, ...options })
  const res = await post('/api/providers/custom', {
    name: `img-${Math.random().toString(36).slice(2, 7)}`,
    type: 'openai-compat',
    baseUrl: upstream.baseUrl,
    apiKey: 'sk-test',
    models,
  })
  const providerId = (await res.json()).id
  return { upstream, providerId }
}

test('没有图像模型时：status 报不可用，生成接口给可执行的错误', async () => {
  const status = await (await fetch(`${server.url}/api/images/status`)).json()
  assert.equal(status.available, false)
  assert.match(status.reason, /图像/)

  const res = await post('/api/images/generations', { prompt: '一只猫' })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.code, 'image_unavailable')
  assert.match(body.error, /IMAGE_PROVIDER/, '错误里要告诉用户怎么配')
})

test('生成图片：返回 OpenAI 形状的 { created, data:[{url}] }', async (t) => {
  const { upstream, providerId } = await addImageProvider()
  t.after(() => upstream.close())

  const status = await (await fetch(`${server.url}/api/images/status`)).json()
  assert.equal(status.available, true)
  assert.equal(status.provider, providerId)

  const res = await post('/api/images/generations', {
    provider: providerId,
    prompt: '一只戴墨镜的猫',
    size: '1024x1024',
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.data.length, 1)
  assert.equal(body.data[0].url, 'https://img.example.com/1.png')
  assert.equal(body.data[0].revisedPrompt, 'revised prompt')
  assert.equal(typeof body.created, 'number')

  // 上游收到的 body 要符合 OpenAI 协议
  const sent = upstream.state.lastImageBody
  assert.equal(sent.prompt, '一只戴墨镜的猫')
  assert.equal(sent.size, '1024x1024')
  assert.equal(sent.model, 'mock-dall-e')
})

test('n 参数生效，且被夹在 1–4', async (t) => {
  const { upstream, providerId } = await addImageProvider()
  t.after(() => upstream.close())

  const two = await (await post('/api/images/generations', { provider: providerId, prompt: 'x', n: 2 })).json()
  assert.equal(two.data.length, 2)

  const tooMany = await (
    await post('/api/images/generations', { provider: providerId, prompt: 'x', n: 99 })
  ).json()
  assert.equal(tooMany.data.length, 4, '上限 4 张')
  assert.equal(upstream.state.lastImageBody.n, 4)
})

test('上游只给 base64 时原样透传，不假装成 url', async (t) => {
  const { upstream, providerId } = await addImageProvider({ imageMode: 'b64' })
  t.after(() => upstream.close())

  const body = await (await post('/api/images/generations', { provider: providerId, prompt: 'x' })).json()
  assert.ok(body.data[0].b64_json, '应带 b64_json')
  assert.equal(body.data[0].url, undefined)
})

test('缺 prompt 直接 400，不去打上游', async (t) => {
  const { upstream, providerId } = await addImageProvider()
  t.after(() => upstream.close())
  const before = upstream.state.imageHits

  const res = await post('/api/images/generations', { provider: providerId })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).code, 'missing_prompt')
  assert.equal(upstream.state.imageHits, before, '不该发出上游请求')
})

test('上游 401：错误里带「该怎么处理」而不是原始堆栈', async (t) => {
  const { upstream, providerId } = await addImageProvider({ imageStatus: 401 })
  t.after(() => upstream.close())

  const res = await post('/api/images/generations', { provider: providerId, prompt: 'x' })
  assert.ok(res.status >= 400)
  const body = await res.json()
  assert.equal(body.code, 'auth_failed')
  assert.match(body.error, /密钥/)
})

test('/v1/images/generations 也能用（第三方客户端接的就是这个）', async (t) => {
  const { upstream, providerId } = await addImageProvider()
  t.after(() => upstream.close())

  const res = await post('/v1/images/generations', { provider: providerId, prompt: '一只柴犬' })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.data[0].url, 'https://img.example.com/1.png')
})

/* ——— 工具调用 ——— */

test('不开 imageGeneration 时，工具列表里没有 generate_image', async (t) => {
  const { upstream, providerId } = await addImageProvider({ models: ['mock-model', 'mock-dall-e'] })
  t.after(() => upstream.close())

  const res = await post('/api/chat', {
    provider: providerId,
    model: 'mock-model',
    messages: [{ role: 'user', content: '画一只猫' }],
    agent: true,
  })
  const events = await readSse(res)

  const offered = (upstream.state.lastBody?.tools || []).map((x) => x.function?.name || x.name)
  assert.ok(offered.length > 0, '默认工具应该还在')
  assert.ok(!offered.includes('generate_image'), `不该默认提供图像工具：${offered.join(',')}`)
})

test('打开 imageGeneration 后模型能调用 generate_image，图片走 SSE 而不是进上下文', async (t) => {
  // 第一轮让模型请求生成图片，第二轮给最终回答
  const { upstream, providerId } = await addImageProvider({
    models: ['mock-model', 'mock-dall-e'],
    toolPlan: [
      { toolCalls: [{ name: 'generate_image', arguments: { prompt: '一只戴墨镜的猫' } }] },
      { text: '图片已经生成好了。' },
    ],
  })
  t.after(() => upstream.close())

  const res = await post('/api/chat', {
    provider: providerId,
    model: 'mock-model',
    messages: [{ role: 'user', content: '帮我画一只戴墨镜的猫' }],
    agent: true,
    imageGeneration: true,
  })
  const events = await readSse(res)

  assert.equal(events.at(-1).type, 'done')

  const imageEvent = events.find((e) => e.type === 'image')
  assert.ok(imageEvent, `应该有 image 事件：${events.map((e) => e.type).join(',')}`)
  assert.equal(imageEvent.images[0].url, 'https://img.example.com/1.png')
  assert.equal(imageEvent.prompt, '一只戴墨镜的猫')

  // 工具被真的调用了
  assert.equal(upstream.state.imageHits, 1)

  // 关键：喂回模型的工具结果里不能有图片本体
  const toolMsg = (upstream.state.lastBody?.messages || []).find((m) => m.role === 'tool')
  assert.ok(toolMsg, '应该有工具结果消息')
  assert.ok(!String(toolMsg.content).includes('iVBORw0KGgo'), 'base64 不能进模型上下文')
  assert.ok(!String(toolMsg.content).includes('img.example.com'), '图片链接也不该让模型复述')
  assert.match(String(toolMsg.content), /图片已经直接展示给用户/)
})

test('显式把 generate_image 写进 tools 也生效（预设绑定用这条路）', async (t) => {
  const { upstream, providerId } = await addImageProvider({
    models: ['mock-model', 'mock-dall-e'],
    toolPlan: [{ text: '好的' }],
  })
  t.after(() => upstream.close())

  const res = await post('/api/chat', {
    provider: providerId,
    model: 'mock-model',
    messages: [{ role: 'user', content: '你好' }],
    agent: true,
    tools: ['generate_image'],
  })
  const events = await readSse(res)

  const offered = (upstream.state.lastBody?.tools || []).map((x) => x.function?.name || x.name)
  assert.ok(offered.includes('generate_image'), `工具列表里应有 generate_image：${offered.join(',')}`)
})
