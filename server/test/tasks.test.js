import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, loadApp } from './helpers/setup.js'
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

/** 起一个假上游 + 注册服务商，返回 providerId */
async function providerWith(chunks, model = 'mock-model') {
  const upstream = await startMockUpstream({ chunks })
  const res = await post('/api/providers/custom', {
    name: `task-${Math.random().toString(36).slice(2, 7)}`,
    type: 'openai-compat',
    baseUrl: upstream.baseUrl,
    apiKey: 'sk-test',
    models: [model],
  })
  const providerId = (await res.json()).id
  return { upstream, providerId }
}

test('GET /api/tasks：列出任务类型与改写风格', async () => {
  const res = await fetch(`${server.url}/api/tasks`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.kinds.sort(), ['rewrite', 'suggest', 'summary', 'title'])
  const toneKeys = body.tones.map((t) => t.key)
  assert.ok(toneKeys.includes('concise'))
  assert.ok(toneKeys.includes('formal'))
  assert.ok(toneKeys.includes('translate'))
})

test('title：生成短标题并清掉引号与句号', async (t) => {
  const { upstream, providerId } = await providerWith(['“向量数据库入门”。'])
  t.after(() => upstream.close())

  const res = await post('/api/tasks/title', { provider: providerId, model: 'mock-model', text: '请讲讲向量数据库' })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.title, '向量数据库入门')
  assert.equal(body.kind, 'title')
  assert.ok(body.usage.total > 0)
  assert.equal(typeof body.costUsd, 'number')
})

test('summary：生成摘要并压掉多余空白', async (t) => {
  const { upstream, providerId } = await providerWith(['讨论了限流方案，', '最终选了令牌桶。', '还没定容量。'])
  t.after(() => upstream.close())

  const res = await post('/api/tasks/summary', {
    provider: providerId,
    model: 'mock-model',
    messages: [
      { role: 'user', content: '怎么做限流？' },
      { role: 'assistant', content: '可以用令牌桶。' },
    ],
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.match(body.summary, /令牌桶/)
  assert.ok(body.summary.length <= 400)
})

test('suggest：最多 3 条，去掉编号与空行', async (t) => {
  const { upstream, providerId } = await providerWith([
    '1. 怎么选分片数\n\n2. 索引重建要多久\n- 数据怎么迁移\n4. 这条应该被截掉',
  ])
  t.after(() => upstream.close())

  const res = await post('/api/tasks/suggest', {
    provider: providerId,
    model: 'mock-model',
    messages: [{ role: 'user', content: '讲讲向量库' }],
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.suggestions.length, 3, '最多给 3 条')
  assert.deepEqual(body.suggestions, ['怎么选分片数', '索引重建要多久', '数据怎么迁移'])
})

test('rewrite：按风格改写，直接返回正文', async (t) => {
  const { upstream, providerId } = await providerWith(['优化后的句子。'])
  t.after(() => upstream.close())

  const res = await post('/api/tasks/rewrite', {
    provider: providerId,
    model: 'mock-model',
    text: '这个这个功能呢，就是那个，能用的。',
    tone: 'concise',
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.text, '优化后的句子。')
})

test('rewrite：不支持的风格给可读错误并列出可选项', async (t) => {
  const { upstream, providerId } = await providerWith(['x'])
  t.after(() => upstream.close())

  const res = await post('/api/tasks/rewrite', {
    provider: providerId,
    model: 'mock-model',
    text: '内容',
    tone: '不存在的风格',
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.code, 'invalid_tone')
  assert.match(body.error, /concise/, '错误里要告诉用户有哪些可选')
})

test('未知任务类型 / 缺少输入：都是 400 而不是 500', async () => {
  const unknown = await post('/api/tasks/whatever', { text: 'x' })
  assert.equal(unknown.status, 400)
  assert.equal((await unknown.json()).code, 'unknown_task')

  const empty = await post('/api/tasks/summary', {})
  assert.equal(empty.status, 400)
  assert.equal((await empty.json()).code, 'missing_text')
})

test('不指定模型时走子任务模型（dedicatedModel=true）', async (t) => {
  // 用带 mini 的模型名，让它成为「唯一的便宜模型」，
  // 否则可能选中前面用例里已经关掉的假上游
  const { upstream } = await providerWith(['标题'], 'mock-mini')
  t.after(() => upstream.close())

  const res = await post('/api/tasks/title', { text: '随便聊聊' })
  const body = await res.json()
  // 前面几个用例已经注册过服务商，所以一定能挑出一个
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.dedicatedModel, true)
  assert.ok(body.model)
})

test('小任务也记账：调用后用量表里能看到', async (t) => {
  const { upstream, providerId } = await providerWith(['摘要'])
  t.after(() => upstream.close())

  await post('/api/tasks/summary', { provider: providerId, model: 'mock-model', text: '一段对话' })
  const usage = await (await fetch(`${server.url}/api/usage`)).json()
  assert.ok(usage.totals.requests >= 1, `用量表里应记到这次调用：${JSON.stringify(usage.totals)}`)
})
