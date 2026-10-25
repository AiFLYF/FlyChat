import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp } from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'

prepareEnv({ BREAKER_THRESHOLD: '100', CONTEXT_COMPACT: 'true' })

// 必须动态 import：静态 import 会被提升到 prepareEnv() 之前执行，
// 那样 config 会用默认的 server/data，测试数据会写进项目真实数据库。
const { buildPrefixKey, wrapSummary } = await import('../lib/compact.js')

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')

let server
let mainUpstream
let summaryUpstream
let mainProvider
let summaryProvider

before(async () => {
  initStorage()
  server = await listen(createApp())
  mainUpstream = await startMockUpstream({ chunks: ['最终回答'], models: ['mock-8k'] })
  summaryUpstream = await startMockUpstream({ chunks: ['摘要：用户此前在讨论向量数据库与 HNSW 索引。'] })

  const make = async (name, baseUrl, models) => {
    const res = await fetch(`${server.url}/api/providers/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 'openai-compat', baseUrl, apiKey: 'sk-mock', models }),
    })
    return (await res.json()).id
  }
  mainProvider = await make('主模型', mainUpstream.baseUrl, ['mock-8k'])
  summaryProvider = await make('小模型', summaryUpstream.baseUrl, ['mock-mini'])
  // 明确指定摘要模型，避免测试依赖启发式选择
  process.env.SUMMARY_MODEL = `${summaryProvider}:mock-mini`
})

after(async () => {
  delete process.env.SUMMARY_MODEL
  await mainUpstream.close()
  await summaryUpstream.close()
  await server.close()
})

const chat = (messages, extra = {}) =>
  fetch(`${server.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: mainProvider,
      model: 'mock-8k',
      messages,
      ...extra,
    }),
  })

/** 构造一条注定要触发裁剪的长历史 */
function longHistory() {
  const messages = []
  for (let i = 0; i < 40; i += 1) {
    messages.push({ id: `h${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: '这是一段很长的历史对话内容。'.repeat(40) })
  }
  messages.push({ id: 'h-last', role: 'user', content: '最后一个问题' })
  return messages
}

test('buildPrefixKey：同样的消息集合得到同样的 key', () => {
  const a = [{ id: 'a' }, { id: 'b' }]
  assert.equal(buildPrefixKey(a), buildPrefixKey([...a]))
  assert.notEqual(buildPrefixKey(a), buildPrefixKey([{ id: 'a' }, { id: 'c' }]))
})

test('wrapSummary：有明确的起止标记', () => {
  const wrapped = wrapSummary('用户之前问过向量数据库')
  assert.ok(wrapped.includes('【早期对话摘要】'))
  assert.ok(wrapped.includes('【摘要结束】'))
  assert.ok(wrapped.includes('用户之前问过向量数据库'))
})

test('裁剪时生成摘要并注入 system，而不是直接丢历史', async () => {
  const events = await readSse(await chat(longHistory()))
  const types = events.map((e) => e.type)

  assert.equal(types.at(-1), 'done')
  const notices = events.filter((e) => e.type === 'notice').map((e) => e.message)
  assert.ok(notices.some((m) => /摘要/.test(m)), `应提示发生了摘要压缩，实际：${notices.join(' | ')}`)

  const compaction = events.find((e) => e.compaction)
  assert.ok(compaction, '应回传 compaction 元信息')
  assert.equal(compaction.compaction.applied, true)

  // 摘要必须真的进了主模型的 system，否则毫无意义
  const system = mainUpstream.state.lastBody.messages.find((m) => m.role === 'system')
  assert.ok(system, '主模型应收到 system 消息')
  assert.match(system.content, /早期对话摘要/)
  assert.match(system.content, /向量数据库/)

  // 而且确实裁剪掉了原文
  assert.ok(mainUpstream.state.lastBody.messages.length < 41, '长历史应被裁掉一部分')
  assert.equal(summaryUpstream.state.hits >= 1, true, '摘要模型应被调用过')
})

test('同样的被丢弃前缀：第二次沿用缓存，不再调摘要模型', async () => {
  const before = summaryUpstream.state.hits
  const noticeCount = (await readSse(await chat(longHistory()))).filter((e) => e.type === 'notice')
  assert.equal(summaryUpstream.state.hits, before, '命中缓存后不应再调摘要模型')
  assert.ok(noticeCount.some((e) => /摘要/i.test(e.message)))
})

test('CONTEXT_COMPACT=false：退回纯裁剪，不生成摘要', async () => {
  process.env.CONTEXT_COMPACT = 'false'
  const hitsBefore = summaryUpstream.state.hits
  const events = await readSse(await chat(longHistory()))
  const meta = events.find((e) => e.compaction)
  assert.equal(meta, undefined, '关闭压缩后不应回传 compaction')
  assert.equal(summaryUpstream.state.hits, hitsBefore, '不应调摘要模型')
  const trimmedNotice = events.find((e) => e.type === 'notice' && /省略/.test(e.message))
  assert.ok(trimmedNotice, '应改为提示直接裁剪')
  process.env.CONTEXT_COMPACT = 'true'
})

test('摘要模型失败：对话照常完成，只降级为纯裁剪', async (t) => {
  // 指向一个必然连不上的地址
  const broken = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '坏摘要',
      type: 'openai-compat',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: ['mock-mini'],
    }),
  })
  const brokenId = (await broken.json()).id
  process.env.SUMMARY_MODEL = `${brokenId}:mock-mini`
  t.after(() => {
    process.env.SUMMARY_MODEL = `${summaryProvider}:mock-mini`
  })

  const events = await readSse(await chat(longHistory()))
  const types = events.map((e) => e.type)
  assert.equal(types.at(-1), 'done', '摘要失败不能影响对话本身')
  const notices = events.filter((e) => e.type === 'notice').map((e) => e.message)
  assert.ok(
    notices.some((m) => /摘要/.test(m)),
    `应告知用户摘要失败、已降级，实际：${notices.join(' | ')}`
  )
})
