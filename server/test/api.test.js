import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, loadApp} from './helpers/setup.js'

prepareEnv()

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

const api = (path, options) => fetch(`${server.url}${path}`, options)
const json = async (res) => ({ status: res.status, body: await res.json() })

test('GET /api/health：存储、服务商、搜索状态一屏可见', async () => {
  const { status, body } = await json(await api('/api/health'))
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.storage.available, true)
  assert.equal(body.storage.driver, 'sqlite')
  assert.ok(Array.isArray(body.providers.ids))
})

test('GET /api/providers：永不返回 API Key', async () => {
  const res = await api('/api/providers')
  const text = await res.text()
  assert.equal(res.status, 200)
  assert.ok(!/apiKey/i.test(text), '响应体里不应出现 apiKey 字段')
  const body = JSON.parse(text)
  assert.ok(Array.isArray(body.providers))
  for (const p of body.providers) {
    assert.ok('hasKey' in p)
    assert.ok(!('apiKey' in p))
  }
})

test('POST /api/providers/custom：拒绝非 http(s) 的 Base URL', async () => {
  const { status, body } = await json(
    await api('/api/providers/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '坏地址', type: 'openai-compat', baseUrl: 'ftp://x.com', models: ['m'] }),
    })
  )
  assert.equal(status, 400)
  assert.match(body.error, /http/)
})

test('POST /api/providers/custom：拒绝云元数据地址（SSRF）', async () => {
  const { status, body } = await json(
    await api('/api/providers/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '元数据',
        type: 'openai-compat',
        baseUrl: 'http://169.254.169.254/latest',
        models: ['m'],
      }),
    })
  )
  assert.equal(status, 400)
  assert.match(body.error, /禁止/)
})

test('POST /api/providers/custom：全角字符的 Key 给出可读错误', async () => {
  const { status, body } = await json(
    await api('/api/providers/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '全角',
        type: 'openai-compat',
        baseUrl: 'http://127.0.0.1:9999/v1',
        apiKey: 'ｓｋ－１２３',
        models: ['m'],
      }),
    })
  )
  assert.equal(status, 400)
  assert.match(body.error, /非 ASCII/)
})

test('自定义服务商：新增 → 列表可见 → 模型覆盖 → 删除', async () => {
  const created = await json(
    await api('/api/providers/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '本地网关',
        type: 'openai-compat',
        baseUrl: 'http://127.0.0.1:9999/v1',
        apiKey: 'sk-test',
        models: ['m1', 'm2'],
      }),
    })
  )
  assert.equal(created.status, 200)
  const id = created.body.id
  assert.ok(id)

  const list = await json(await api('/api/providers'))
  const found = list.body.providers.find((p) => p.id === id)
  assert.ok(found, '新增的服务商应出现在列表里')
  assert.deepEqual(found.models, ['m1', 'm2'])
  assert.equal(found.source, 'custom')
  assert.equal(found.hasKey, true)

  const updated = await json(
    await api(`/api/providers/${id}/models`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: ['m3'] }),
    })
  )
  assert.equal(updated.status, 200)
  assert.deepEqual(updated.body.models, ['m3'])

  const afterUpdate = await json(await api('/api/providers'))
  assert.deepEqual(afterUpdate.body.providers.find((p) => p.id === id).models, ['m3'])

  const deleted = await json(await api(`/api/providers/custom/${id}`, { method: 'DELETE' }))
  assert.equal(deleted.status, 200)

  const afterDelete = await json(await api('/api/providers'))
  assert.equal(
    afterDelete.body.providers.find((p) => p.id === id),
    undefined
  )
})

test('GET /api/models：返回上下文窗口与能力，未知模型标记 known=false', async () => {
  const created = await json(
    await api('/api/providers/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '目录测试',
        type: 'openai-compat',
        baseUrl: 'http://127.0.0.1:9999/v1',
        models: ['gpt-4o', 'totally-unknown-model'],
      }),
    })
  )
  const id = created.body.id

  const { status, body } = await json(await api('/api/models'))
  assert.equal(status, 200)
  const known = body.models.find((m) => m.provider === id && m.model === 'gpt-4o')
  assert.equal(known.known, true)
  assert.equal(known.contextWindow, 128000)
  assert.equal(known.capabilities.vision, true)
  assert.ok(known.pricing.input > 0)

  const unknown = body.models.find((m) => m.provider === id && m.model === 'totally-unknown-model')
  assert.equal(unknown.known, false)
  assert.ok(unknown.contextWindow >= 8000)

  await api(`/api/providers/custom/${id}`, { method: 'DELETE' })
})

test('会话 CRUD：创建 → 列表 → 详情 → 改名 → 追加消息 → 导出 → 删除', async () => {
  const created = await json(
    await api('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'conv-test-1', title: '第一个会话', messages: [{ id: 'm1', role: 'user', content: '你好' }] }),
    })
  )
  assert.equal(created.status, 201)
  assert.equal(created.body.title, '第一个会话')
  assert.equal(created.body.messages.length, 1)

  const list = await json(await api('/api/conversations'))
  assert.ok(list.body.items.some((c) => c.id === 'conv-test-1'))
  assert.ok(list.body.total >= 1)

  const patched = await json(
    await api('/api/conversations/conv-test-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '改过的标题', pinned: true }),
    })
  )
  assert.equal(patched.body.title, '改过的标题')
  assert.equal(patched.body.pinned, true)

  const appended = await json(
    await api('/api/conversations/conv-test-1/messages', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { id: 'm2', role: 'assistant', content: '你好，有什么可以帮你？', model: 'gpt-4o' },
          { id: 'm3', role: 'user', content: '讲讲 React', citations: [{ index: 1, title: 't', url: 'https://a.b' }] },
        ],
      }),
    })
  )
  assert.equal(appended.body.saved, 2)

  const detail = await json(await api('/api/conversations/conv-test-1'))
  assert.equal(detail.body.messages.length, 3)
  assert.equal(detail.body.messages[1].model, 'gpt-4o')
  assert.equal(detail.body.messages[2].citations[0].url, 'https://a.b')

  const md = await api('/api/conversations/conv-test-1/export?format=md')
  const text = await md.text()
  assert.equal(md.status, 200)
  assert.match(text, /# 改过的标题/)
  assert.match(text, /讲讲 React/)

  const removed = await json(await api('/api/conversations/conv-test-1', { method: 'DELETE' }))
  assert.equal(removed.body.ok, true)

  const gone = await api('/api/conversations/conv-test-1')
  assert.equal(gone.status, 404)
})

test('会话搜索：标题与消息内容都能命中', async () => {
  await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'conv-search-1',
      title: '关于向量数据库',
      messages: [{ id: 's1', role: 'user', content: '请解释 HNSW 索引' }],
    }),
  })
  const byTitle = await json(await api('/api/conversations?q=向量'))
  assert.ok(byTitle.body.items.some((c) => c.id === 'conv-search-1'))

  const byMessage = await json(await api('/api/conversations?q=HNSW'))
  assert.ok(byMessage.body.items.some((c) => c.id === 'conv-search-1'))

  const none = await json(await api('/api/conversations?q=完全不存在的关键词xyz'))
  assert.equal(none.body.items.length, 0)

  await api('/api/conversations/conv-search-1', { method: 'DELETE' })
})

test('清空全部会话需要 confirm', async () => {
  const denied = await json(await api('/api/conversations', { method: 'DELETE' }))
  assert.equal(denied.status, 400)
  assert.match(denied.body.error, /confirm/)
})

test('未知 API 返回 JSON 404，而不是 HTML', async () => {
  const res = await api('/api/nope')
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.code, 'route_not_found')
})

test('非法 JSON 请求体返回 400 而不是挂住', async () => {
  const res = await api('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"provider":',
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.code, 'invalid_json')
})

test('会话重复同步（前端整条 POST）：第二次也要更新消息', async () => {
  const body = (messages, extra = {}) => ({
    id: 'conv-resync-1',
    title: '重复同步',
    summary: '这是摘要',
    model: 'gpt-4o',
    messages,
    ...extra,
  })

  await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body([{ id: 'r1', role: 'user', content: '第一句' }])),
  })

  // 第二次同步：多了一条助手回复
  await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      body([
        { id: 'r1', role: 'user', content: '第一句' },
        { id: 'r2', role: 'assistant', content: '第一句的回答' },
      ])
    ),
  })

  const after = await json(await api('/api/conversations/conv-resync-1'))
  assert.equal(after.body.messages.length, 2, '第二次同步必须把新消息写进去')
  assert.equal(after.body.messages[1].content, '第一句的回答')
  assert.equal(after.body.summary, '这是摘要', 'summary 要能持久化')

  // 第三次：编辑历史消息内容（replace 语义）
  await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      body([
        { id: 'r1', role: 'user', content: '第一句（改过）' },
        { id: 'r2', role: 'assistant', content: '第一句的回答' },
      ])
    ),
  })

  const edited = await json(await api('/api/conversations/conv-resync-1'))
  assert.equal(edited.body.messages[0].content, '第一句（改过）', '编辑后的内容要覆盖旧值')

  await api('/api/conversations/conv-resync-1', { method: 'DELETE' })
})

test('全量导出 → 导入（merge / replace）', async () => {
  await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'conv-export-1',
      title: '导出测试',
      messages: [{ id: 'e1', role: 'user', content: '导出我' }],
    }),
  })

  const exported = await json(await api('/api/export'))
  assert.equal(exported.status, 200)
  assert.equal(exported.body.format, 'flychat-export')
  const conv = exported.body.conversations.find((c) => c.id === 'conv-export-1')
  assert.ok(conv, '导出里应包含目标会话')
  assert.equal(conv.messages.length, 1)

  // 先删掉，再导入回来
  await api('/api/conversations/conv-export-1', { method: 'DELETE' })
  assert.equal((await api('/api/conversations/conv-export-1')).status, 404)

  const imported = await json(
    await api('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exported.body),
    })
  )
  assert.equal(imported.body.imported >= 1, true)
  assert.equal(imported.body.failed.length, 0)

  const restored = await json(await api('/api/conversations/conv-export-1'))
  assert.equal(restored.body.title, '导出测试')
  assert.equal(restored.body.messages[0].content, '导出我')

  // replace 模式必须带 confirm
  const denied = await json(
    await api('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'replace', conversations: [] }),
    })
  )
  assert.equal(denied.status, 400)

  await api('/api/conversations/conv-export-1', { method: 'DELETE' })
})

test('默认单用户模式：不需要登录，/api/auth/me 明确说 multiUser=false', async () => {
  const me = await json(await api('/api/auth/me'))
  assert.equal(me.status, 200)
  assert.equal(me.body.multiUser, false, '默认必须是单用户，否则老部署升级上来会被登录页挡住')
  assert.equal(me.body.user, null)

  // 会话接口照旧不需要任何凭证
  const list = await api('/api/conversations')
  assert.equal(list.status, 200)

  // 单用户模式下也不该能「初始化账号」
  const setup = await api('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'admin-pass-123' }),
  })
  assert.equal(setup.status, 400)
  assert.equal((await setup.json()).code, 'multi_user_disabled')
})
