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
  upstream = await startMockUpstream({ chunks: ['回答'] })
  const res = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '预算测试',
      type: 'openai-compat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-mock',
      models: ['mock-model', 'gpt-4o'],
    }),
  })
  providerId = (await res.json()).id
})

after(async () => {
  await upstream.close()
  await server.close()
})

const post = (path, body) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

// 用 gpt-4o 是为了有非零单价，否则估算花费永远是 0、预算测不出来
const chat = (model = 'gpt-4o') =>
  post('/api/chat', { provider: providerId, model, messages: [{ role: 'user', content: 'hi' }] })

const setBudget = (dailyUsd, monthlyUsd = 0) =>
  fetch(`${server.url}/api/budget`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dailyUsd, monthlyUsd }),
  })

test('默认没有预算：不限制', async () => {
  const res = await post('/api/chat', { provider: providerId, model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] })
  const events = await readSse(res)
  assert.equal(events.at(-1).type, 'done')
})

test('设置日预算：超支后对话被 429 拒绝', async (t) => {
  t.after(() => setBudget(0, 0))
  // 一次对话约 $0.0001，把日预算压到比这更低，一次就会超
  const set = await setBudget(0.0000001, 0)
  assert.equal(set.status, 200)
  const budget = await set.json()
  assert.equal(budget.enabled, true)
  assert.equal(budget.dailyUsd, 0.0000001)

  // 先跑一次真实对话把花费攒起来
  const first = await chat()
  const firstEvents = await readSse(first)
  assert.equal(firstEvents.at(-1).type, 'done')

  const res = await chat()
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.equal(body.code, 'daily_budget_exceeded')
  assert.match(body.error, /上限/)

  // 网关同样被拦住
  const viaApi = await fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `${providerId}:gpt-4o`, messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(viaApi.status, 429)

  // 侧门也要锁上：/api/complete 与 /api/title 不能成为绕过预算的口子
  const complete = await post('/api/complete', {
    provider: providerId,
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(complete.status, 429, 'complete 超预算必须 429')
  assert.equal((await complete.json()).code, 'daily_budget_exceeded')

  const title = await post('/api/title', { messages: [{ role: 'user', content: '起个标题' }] })
  assert.equal(title.status, 429, 'title 超预算必须 429')
})

test('预算接口：花费与百分比计算正确', async (t) => {
  t.after(() => setBudget(0, 0))
  await setBudget(0.05, 0)
  const withBudget = await (await fetch(`${server.url}/api/budget`)).json()
  assert.equal(withBudget.enabled, true)
  assert.ok(withBudget.spend.daily > 0, '前面几轮对话应该已经记了花费')
  assert.ok(withBudget.percent.daily >= 0 && withBudget.percent.daily <= 100)
})

test('非法预算值：400', async () => {
  const res = await fetch(`${server.url}/api/budget`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dailyUsd: -1, monthlyUsd: 0 }),
  })
  assert.equal(res.status, 400)
})

test('预算放开后恢复对话', async (t) => {
  t.after(() => setBudget(0, 0))
  await setBudget(0.000001, 0)
  await setBudget(0, 0)
  const res = await chat()
  const events = await readSse(res)
  assert.equal(events.at(-1).type, 'done')
})
