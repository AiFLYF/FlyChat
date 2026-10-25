import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp } from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'

prepareEnv({ BREAKER_THRESHOLD: '100', UPSTREAM_RETRIES: '0' })

// 动态 import：静态 import 会被提升到 prepareEnv() 之前，config 会用默认的 server/data
const { applyPreset, parseModelRef } = await import('../lib/preset.js')

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
initStorage()
const server = await listen(createApp())
const upstream = await startMockUpstream({ chunks: ['好', '的'] })

const post = (path, body) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test.after(async () => {
  await upstream.close()
  server.close()
})

/** 注册一个可用的服务商，返回 id */
async function addProvider(name, models = ['mock-model']) {
  const res = await post('/api/providers/custom', {
    name,
    type: 'openai-compat',
    baseUrl: upstream.baseUrl,
    apiKey: 'sk-test',
    models,
  })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()).id
}

const providerId = await addProvider('preset-srv')

test('预设 CRUD：建、列、读、改、删', async (t) => {
  const created = await post('/api/presets', {
    name: '代码助手',
    description: '专注写代码',
    icon: '⌨️',
    provider: providerId,
    model: 'mock-model',
    systemPrompt: '你是一个严谨的工程师，回答要给出可运行的代码。',
    params: { temperature: 0.2, maxTokens: 2048 },
  })
  const preset = await created.json()
  assert.equal(created.status, 201, JSON.stringify(preset))
  assert.ok(preset.id.startsWith('preset-'))
  assert.equal(preset.params.temperature, 0.2)

  const list = await (await fetch(`${server.url}/api/presets`)).json()
  assert.ok(list.items.some((p) => p.id === preset.id))

  const one = await (await fetch(`${server.url}/api/presets/${preset.id}`)).json()
  assert.equal(one.name, '代码助手')
  assert.equal(one.icon, '⌨️')

  const updated = await (await post('/api/presets', { id: preset.id, name: '代码助手 2' })).json()
  assert.equal(updated.name, '代码助手 2')
  assert.equal(updated.systemPrompt, '你是一个严谨的工程师，回答要给出可运行的代码。', '没传的字段不能被清掉')

  const del = await (await fetch(`${server.url}/api/presets/${preset.id}`, { method: 'DELETE' })).json()
  assert.equal(del.ok, true)
  assert.equal((await fetch(`${server.url}/api/presets/${preset.id}`)).status, 404)
})

test('参数校验：不认识的键丢掉，越界值夹紧', async (t) => {
  const res = await post('/api/presets', {
    name: '脏参数',
    params: { temperature: 99, topP: -1, evil: 'x', maxTokens: 100, mcpMode: 'selected' },
  })
  const preset = await res.json()
  t.after(() => fetch(`${server.url}/api/presets/${preset.id}`, { method: 'DELETE' }))

  assert.equal(preset.params.temperature, 2, 'temperature 上限 2')
  assert.equal(preset.params.topP, 0, 'topP 下限 0')
  assert.equal(preset.params.evil, undefined, '不认识的参数必须丢掉')
  assert.equal(preset.params.maxTokens, 100)
  assert.equal(preset.params.mcpMode, 'selected')
})

test('名称为空时拒绝创建（避免列表里出现无名条目）', async () => {
  const res = await post('/api/presets', { name: '   ' })
  assert.equal(res.status, 400)
})

test('applyPreset：显式字段覆盖预设，缺省字段用预设', () => {
  const preset = {
    id: 'preset-x',
    name: 'x',
    provider: 'p1',
    model: 'm1',
    systemPrompt: '预设提示',
    workspaceId: 'default',
    mcpServers: ['mcp-a'],
    params: { temperature: 0.2, topP: 0.5, maxTokens: 1000, webSearch: true, mcpMode: 'selected' },
  }

  const merged = applyPreset({ messages: [] }, preset)
  assert.equal(merged.provider, 'p1')
  assert.equal(merged.model, 'm1')
  assert.equal(merged.system, '预设提示')
  assert.equal(merged.temperature, 0.2)
  assert.equal(merged.workspaceId, 'default')
  assert.deepEqual(merged.mcpServers, ['mcp-a'])

  // 用户临时换了模型、改了温度、关掉联网 —— 都要生效
  const overridden = applyPreset(
    { messages: [], provider: 'p2', model: 'm2', temperature: 0.9, webSearch: false, system: '临时提示' },
    preset
  )
  assert.equal(overridden.provider, 'p2')
  assert.equal(overridden.model, 'm2')
  assert.equal(overridden.temperature, 0.9)
  assert.equal(overridden.webSearch, false)
  assert.equal(overridden.system, '临时提示', '请求里带了系统提示就以请求为准')

  // knowledge:false 表示这一轮不检索，不能被预设的 workspaceId 拉回来
  const noKnowledge = applyPreset({ messages: [], knowledge: false }, preset)
  assert.equal(noKnowledge.workspaceId, undefined)
})

test('parseModelRef：preset: 前缀与普通模型名要能区分', () => {
  assert.deepEqual(parseModelRef('preset:abc'), { presetId: 'abc' })
  assert.deepEqual(parseModelRef('openai:gpt-4o'), { spec: 'openai:gpt-4o' })
  assert.deepEqual(parseModelRef(' gpt-4o '), { spec: 'gpt-4o' })
})

test('/api/chat 传 presetId：模型、系统提示、参数都按预设走', async (t) => {
  const preset = await (
    await post('/api/presets', {
      name: '聊天预设',
      provider: providerId,
      model: 'mock-model',
      systemPrompt: '你是预设里的角色。',
      params: { temperature: 0.15 },
    })
  ).json()
  t.after(() => fetch(`${server.url}/api/presets/${preset.id}`, { method: 'DELETE' }))

  const before = upstream.state.hits
  const res = await post('/api/chat', { presetId: preset.id, messages: [{ role: 'user', content: '你好' }] })
  const events = await readSse(res)
  assert.equal(events.at(-1).type, 'done')
  assert.ok(upstream.state.hits > before, '应该真的请求了上游')

  const sent = upstream.state.lastBody
  assert.equal(sent.model, 'mock-model')
  assert.equal(sent.messages[0].role, 'system')
  assert.equal(sent.messages[0].content, '你是预设里的角色。')
  assert.equal(sent.temperature, 0.15)

  // meta 里要告诉前端这次用的是哪个预设
  const meta = events.find((e) => e.type === 'meta')
  assert.equal(meta.preset.id, preset.id)
})

test('/api/chat 用预设但同时临时改温度：以请求为准', async (t) => {
  const preset = await (
    await post('/api/presets', {
      name: '可覆盖预设',
      provider: providerId,
      model: 'mock-model',
      params: { temperature: 0.15 },
    })
  ).json()
  t.after(() => fetch(`${server.url}/api/presets/${preset.id}`, { method: 'DELETE' }))

  const res = await post('/api/chat', {
    presetId: preset.id,
    temperature: 1.2,
    messages: [{ role: 'user', content: '你好' }],
  })
  await readSse(res)
  assert.equal(upstream.state.lastBody.temperature, 1.2)
})

test('/api/chat 用不存在的预设：404 且带可读 code', async () => {
  const res = await post('/api/chat', {
    presetId: 'preset-nope',
    messages: [{ role: 'user', content: '你好' }],
  })
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.code, 'preset_not_found')
})

test('/v1/models 把预设当成一个「模型」暴露出来', async (t) => {
  const preset = await (
    await post('/api/presets', { name: '外部可用', provider: providerId, model: 'mock-model' })
  ).json()
  t.after(() => fetch(`${server.url}/api/presets/${preset.id}`, { method: 'DELETE' }))

  const list = await (await fetch(`${server.url}/v1/models`)).json()
  const entry = list.data.find((m) => m.id === `preset:${preset.id}`)
  assert.ok(entry, `应包含 preset:${preset.id}`)
  assert.equal(entry.owned_by, 'preset')
})

test('/v1/chat/completions 用 preset:<id>：系统提示被注入，模型按预设解析', async (t) => {
  const preset = await (
    await post('/api/presets', {
      name: '网关预设',
      provider: providerId,
      model: 'mock-model',
      systemPrompt: '来自预设的系统提示。',
      params: { temperature: 0.3, maxTokens: 512 },
    })
  ).json()
  t.after(() => fetch(`${server.url}/api/presets/${preset.id}`, { method: 'DELETE' }))

  const res = await post('/v1/chat/completions', {
    model: `preset:${preset.id}`,
    messages: [{ role: 'user', content: '你好' }],
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.model, 'mock-model')

  const sent = upstream.state.lastBody
  assert.equal(sent.messages[0].role, 'system')
  assert.equal(sent.messages[0].content, '来自预设的系统提示。')
  assert.equal(sent.temperature, 0.3)
  assert.equal(sent.max_tokens, 512)
})

test('/v1 里预设没绑模型：明确报错而不是随便挑一个模型', async (t) => {
  const preset = await (await post('/api/presets', { name: '空预设' })).json()
  t.after(() => fetch(`${server.url}/api/presets/${preset.id}`, { method: 'DELETE' }))

  const res = await post('/v1/chat/completions', {
    model: `preset:${preset.id}`,
    messages: [{ role: 'user', content: '你好' }],
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, 'preset_incomplete')
})

test('复制预设：内容一致但 id 不同', async (t) => {
  const origin = await (
    await post('/api/presets', {
      name: '原版',
      provider: providerId,
      model: 'mock-model',
      systemPrompt: '提示词',
      params: { temperature: 0.4 },
      mcpServers: ['mcp-1'],
    })
  ).json()
  const copy = await (await post(`/api/presets/${origin.id}/duplicate`, {})).json()
  t.after(async () => {
    await fetch(`${server.url}/api/presets/${origin.id}`, { method: 'DELETE' })
    await fetch(`${server.url}/api/presets/${copy.id}`, { method: 'DELETE' })
  })

  assert.notEqual(copy.id, origin.id)
  assert.equal(copy.name, '原版 副本')
  assert.equal(copy.systemPrompt, '提示词')
  assert.equal(copy.params.temperature, 0.4)
  assert.deepEqual(copy.mcpServers, ['mcp-1'])
})
