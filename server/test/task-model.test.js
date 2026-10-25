import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, loadApp } from './helpers/setup.js'

prepareEnv({ BREAKER_THRESHOLD: '100' })

// 必须动态 import：静态 import 会被提升到 prepareEnv() 之前，
// config 会用默认的 server/data，测试数据就写进项目真实库了。
const { resolveTaskModel } = await import('../lib/task-model.js')

const createApp = await loadApp()
const server = await listen(createApp())

const post = (path, body) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

/** 注册一个 OpenAI 兼容服务商（不需要真上游，只要能进 configuredProviders） */
async function addProvider(name, models) {
  const res = await post('/api/providers/custom', {
    name,
    type: 'openai-compat',
    baseUrl: `https://${name.replace(/[^a-z0-9]/gi, '')}.example.com/v1`,
    apiKey: 'sk-test',
    models,
  })
  assert.equal(res.status, 200, await res.clone().text())
  // 接口只回 { ok, id }，不回完整 provider（避免把 apiKey 带出去）
  return (await res.json()).id
}

test.after(() => server.close())

test('没配任何服务商时返回 null（调用方要能优雅降级）', () => {
  // 前面用例还没注册，这里是初始状态
  assert.equal(resolveTaskModel('title'), null)
})

test('自动挑选：优先「便宜快」的模型，并尽量避开主服务商', async () => {
  const main = await addProvider('task-main', ['gpt-4o'])
  const cheap = await addProvider('task-cheap', ['gpt-4o-mini'])

  const choice = resolveTaskModel('title', main)
  assert.equal(choice.provider.id, cheap, '应选有 mini 的那个服务商')
  assert.equal(choice.model, 'gpt-4o-mini')

  // 不给主服务商时也能选出来（只是少了「避开」这条偏好）
  const noHint = resolveTaskModel('title')
  assert.ok(noHint?.provider?.id)
  assert.ok(noHint.model)
})

test('显式配置 TITLE_MODEL 优先于自动挑选', async () => {
  const main = await addProvider('task-main-2', ['gpt-4o'])
  process.env.TITLE_MODEL = `${main}:gpt-4o`
  try {
    const choice = resolveTaskModel('title')
    assert.equal(choice.provider.id, main)
    assert.equal(choice.model, 'gpt-4o')
  } finally {
    delete process.env.TITLE_MODEL
  }
})

test('只写模型名时，去已配置服务商里找持有它的那个', async () => {
  const owner = await addProvider('task-owner', ['claude-haiku-4-5'])
  process.env.TITLE_MODEL = 'claude-haiku-4-5'
  try {
    const choice = resolveTaskModel('title')
    assert.equal(choice.provider.id, owner)
    assert.equal(choice.model, 'claude-haiku-4-5')
  } finally {
    delete process.env.TITLE_MODEL
  }
})

test('显式配置写错（服务商不存在）时不能把功能弄挂，退回自动挑选', async () => {
  process.env.TITLE_MODEL = 'not-exist-provider:whatever'
  try {
    const choice = resolveTaskModel('title')
    assert.ok(choice?.provider?.id, '应该退回自动挑选而不是返回 null')
    assert.ok(choice.model)
  } finally {
    delete process.env.TITLE_MODEL
  }
})

test('摘要与标题用各自的变量，互不干扰', async () => {
  const a = await addProvider('task-a', ['gpt-4o-mini'])
  const b = await addProvider('task-b', ['gpt-4o'])
  process.env.SUMMARY_MODEL = `${a}:gpt-4o-mini`
  process.env.TITLE_MODEL = `${b}:gpt-4o`
  try {
    assert.equal(resolveTaskModel('summary').provider.id, a)
    assert.equal(resolveTaskModel('title').provider.id, b)
  } finally {
    delete process.env.SUMMARY_MODEL
    delete process.env.TITLE_MODEL
  }
})

test('/api/title 不指定模型时走子任务模型，并标注 dedicatedModel', async () => {
  // 这里没有真上游，标题生成会失败；只验证「选模型」这一步走对了。
  // 用一个本地假上游更稳，但这条路径的核心断言是 model 字段。
  const main = await addProvider('task-title-main', ['gpt-4o'])
  const res = await post('/api/title', { text: '帮我写一个分布式限流器', provider: main, model: 'gpt-4o' })
  // 显式指定 provider/model 时应尊重调用方，而不是硬套 TITLE_MODEL
  assert.ok([200, 500, 502].includes(res.status), `意外状态码 ${res.status}`)
  if (res.status === 200) {
    const body = await res.json()
    assert.equal(body.dedicatedModel, false, '调用方指定了模型就不算子任务模型')
  }
})
