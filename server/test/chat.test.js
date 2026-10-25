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
  await server.close()
})

async function createProvider(baseUrl, models = ['mock-model']) {
  const res = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Mock ${Date.now()}`, type: 'openai-compat', baseUrl, apiKey: 'sk-mock', models }),
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

test('流式对话：meta → delta → usage → done，顺序正确', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const res = await chat({
    provider: providerId,
    model: 'mock-model',
    messages: [{ role: 'user', content: '你好' }],
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  const events = await readSse(res)
  const types = events.map((e) => e.type)

  assert.equal(types[0], 'meta')
  assert.equal(events[0].model, 'mock-model')
  assert.ok(events[0].contextWindow > 0)
  assert.equal(types.at(-1), 'done')

  const text = events
    .filter((e) => e.type === 'delta')
    .map((e) => e.content)
    .join('')
  assert.equal(text, '你好，世界')

  const usage = events.find((e) => e.type === 'usage')
  assert.ok(usage, '必须回传 usage')
  assert.equal(usage.usage.total, 20)
  assert.ok(typeof usage.costUsd === 'number')

  // usage 必须在 done 之前，前端靠 done 收尾
  assert.ok(types.indexOf('usage') < types.indexOf('done'))

})

test('上游 500：自动重试后成功，用户无感', async (t) => {
  const upstream = await startMockUpstream({ statuses: [500] })
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const events = await readSse(
    await chat({ provider: providerId, model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] })
  )
  const types = events.map((e) => e.type)
  assert.ok(!types.includes('error'), `不应出现错误：${JSON.stringify(events)}`)
  assert.equal(types.at(-1), 'done')
  assert.equal(upstream.state.hits, 2, '应该请求了两次（首次 500 + 重试成功）')

})

test('上游吐了一半断流：报错且不重试（避免重复输出）', async (t) => {
  const upstream = await startMockUpstream({ truncateAtRequest: 1 })
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const events = await readSse(
    await chat({ provider: providerId, model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] })
  )
  const types = events.map((e) => e.type)
  assert.ok(types.includes('error'), '中途断流必须报错')
  assert.ok(!types.includes('done'), '出错时不应发 done')
  assert.equal(upstream.state.hits, 1, '已经开始输出就不能重试')

})

test('超长历史：自动裁剪并发出 notice', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl, ['mock-8k'])

  const messages = []
  for (let i = 0; i < 40; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '这是一段很长的历史对话内容。'.repeat(40) })
  }
  messages.push({ role: 'user', content: '最后一个问题' })

  const events = await readSse(await chat({ provider: providerId, model: 'mock-8k', messages }))
  const meta = events.find((e) => e.type === 'meta')
  assert.equal(meta.contextWindow, 8000, 'mock-8k 应被推断为 8k 上下文')
  assert.equal(meta.context.trimmed, true)
  assert.ok(meta.context.dropped > 0)

  const notice = events.find((e) => e.type === 'notice')
  assert.ok(notice, '裁剪后应提示用户')
  assert.match(notice.message, /省略/)

  // 上游实际收到的消息数应该被裁掉了
  assert.ok(upstream.state.lastBody.messages.length < messages.length)

})

test('参数越界：温度、topP、maxTokens 会被夹到合法区间', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  await readSse(
    await chat({
      provider: providerId,
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 99,
      topP: -3,
      maxTokens: 999999,
    })
  )
  const sent = upstream.state.lastBody
  assert.equal(sent.temperature, 2)
  assert.equal(sent.top_p, 0)
  assert.ok(sent.max_tokens <= 32768)

})

test('缺少参数时返回可读的 400', async () => {
  const res = await chat({ provider: 'nope', messages: [] })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.ok(body.error)
})

test('POST /api/title：生成短标题并清理标点', async (t) => {
  const upstream = await startMockUpstream({ chunks: ['“向量数据库入门”'] })
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const res = await fetch(`${server.url}/api/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: providerId, model: 'mock-model', text: '请讲讲向量数据库' }),
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.title, '向量数据库入门')

})

test('POST /api/complete：非流式补全返回文本与用量', async (t) => {
  const upstream = await startMockUpstream({ chunks: ['摘要内容'] })
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const res = await fetch(`${server.url}/api/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: providerId,
      model: 'mock-model',
      system: '你是摘要助手',
      messages: [{ role: 'user', content: '把这段话缩成一句' }],
      maxTokens: 64,
    }),
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.text, '摘要内容')
  assert.equal(body.usage.total, 20)
  assert.ok(body.costUsd >= 0)

})

test('用量记账：对话结束后 /api/usage 能看到记录', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  await readSse(
    await chat({
      provider: providerId,
      model: 'mock-model',
      conversationId: 'conv-usage-1',
      messages: [{ role: 'user', content: 'hi' }],
    })
  )

  const res = await fetch(`${server.url}/api/usage?days=1`)
  const body = await res.json()
  assert.equal(body.available, true)
  assert.ok(body.totals.requests >= 1)
  assert.ok(body.totals.totalTokens >= 20)
  assert.ok(body.byModel.some((m) => m.model === 'mock-model'))

  const recent = await (await fetch(`${server.url}/api/usage/recent`)).json()
  assert.ok(recent.items.some((i) => i.conversationId === 'conv-usage-1'))

})

test('上游 401：直接失败并给出密钥提示，不重试', async (t) => {
  const upstream = await startMockUpstream({ statuses: [401] })
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const events = await readSse(
    await chat({ provider: providerId, model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] })
  )
  const error = events.find((e) => e.type === 'error')
  assert.ok(error)
  assert.match(error.message, /密钥无效/)
  assert.equal(upstream.state.hits, 1)

})

test('语音转写：base64 音频被转成 multipart 转发给上游', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const audio = Buffer.from([1, 2, 3, 4]).toString('base64')
  const res = await fetch(`${server.url}/api/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: providerId, model: 'whisper-1', audio, name: 'a.webm' }),
  })
  const body = await res.json()
  assert.equal(res.status, 200)
  assert.equal(body.text, '这是转写出来的文字')
  assert.match(upstream.state.lastAudio.contentType, /multipart\/form-data/)
  assert.ok(upstream.state.lastAudio.size > 4, 'multipart 包体应大于原始音频')
})

test('语音合成：返回音频字节与正确的 Content-Type', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const res = await fetch(`${server.url}/api/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: providerId, input: '你好', voice: 'alloy' }),
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /audio\/mpeg/)
  const buf = Buffer.from(await res.arrayBuffer())
  assert.equal(buf.length, 4)
  assert.equal(upstream.state.lastBody.input, '你好')
})

test('视界（多模态）：带图消息被转成 image_url 内容块发给上游', async (t) => {
  const upstream = await startMockUpstream({ chunks: ['图里是一个红点。'] })
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const res = await chat({
    provider: providerId,
    model: 'mock-model',
    messages: [
      {
        role: 'user',
        content: '这张图里是什么',
        attachments: [
          {
            id: 'att-1',
            type: 'image',
            name: 'dot.png',
            mime: 'image/png',
            size: 95,
            dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          },
        ],
      },
    ],
  })
  const events = await readSse(res)
  assert.equal(events.at(-1).type, 'done')

  // 适配器必须把 dataUrl 展开成 OpenAI 的多模态 content 数组
  const sent = upstream.state.lastBody.messages
  const last = sent[sent.length - 1]
  assert.ok(Array.isArray(last.content), '带图消息的 content 应是 parts 数组')
  const textPart = last.content.find((p) => p.type === 'text')
  const imagePart = last.content.find((p) => p.type === 'image_url')
  assert.ok(textPart, '文本 part 必须保留')
  assert.match(imagePart?.image_url?.url || '', /^data:image\/png;base64,/, '图片 part 必须是 dataUrl')
})

test('视界（多模态）：纯文本消息不受影响，content 仍是字符串', async (t) => {
  const upstream = await startMockUpstream()
  t.after(() => upstream.close())
  const providerId = await createProvider(upstream.baseUrl)

  const res = await chat({ provider: providerId, model: 'mock-model', messages: [{ role: 'user', content: '纯文本' }] })
  await readSse(res)
  const last = upstream.state.lastBody.messages.at(-1)
  assert.equal(typeof last.content, 'string', '没有图片时不应退化为数组')
})
