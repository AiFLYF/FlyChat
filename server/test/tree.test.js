import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp} from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'

prepareEnv({ BREAKER_THRESHOLD: '100' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
const { messageChain } = await import('../store/conversations.js')

let server
let upstream
let providerId

before(async () => {
  initStorage()
  server = await listen(createApp())
  upstream = await startMockUpstream({ chunks: ['好的'] })
  const res = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '消息树测试',
      type: 'openai-compat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-mock',
      models: ['mock-model'],
    }),
  })
  providerId = (await res.json()).id
})

after(async () => {
  await upstream.close()
  await server.close()
})

const putMessages = (convId, messages) =>
  fetch(`${server.url}/api/conversations/${convId}/messages`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, replace: false }),
  })

const post = (path, body, method = 'POST') =>
  fetch(`${server.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test('纯线性对话：没有 parentId 时行为与之前完全一致', async () => {
  const conv = {
    id: 'tree-linear',
    title: '线性',
    messages: [
      { id: 'l1', role: 'user', content: '第一问' },
      { id: 'l2', role: 'assistant', content: '第一答' },
      { id: 'l3', role: 'user', content: '第二问' },
      { id: 'l4', role: 'assistant', content: '第二答' },
    ],
  }
  await post('/api/conversations', conv)

  const got = await (await fetch(`${server.url}/api/conversations/tree-linear`)).json()
  assert.deepEqual(
    got.messages.map((m) => m.id),
    ['l1', 'l2', 'l3', 'l4'],
    '顺序必须保持原样'
  )
  assert.equal(got.messages[0].variantCount, 1)
  assert.equal(got.leafMessageId, 'l4')
  assert.deepEqual(got.activePath, ['l1', 'l2', 'l3', 'l4'])

  await post('/api/conversations/tree-linear', undefined, 'DELETE')
})

test('分叉：同一个 parent 下的多条消息构成 variants，可轮播', async () => {
  await post('/api/conversations', {
    id: 'tree-fork',
    title: '分叉',
    messages: [
      { id: 'f1', role: 'user', content: '讲个笑话' },
      { id: 'f2', role: 'assistant', content: '版本 A', parentId: 'f1' },
    ],
  })
  // 编辑重生成：再生成一个版本，parent 仍然是 f1
  await putMessages('tree-fork', [{ id: 'f3', role: 'assistant', content: '版本 B', parentId: 'f1' }])
  // 在版本 B 上继续
  await putMessages('tree-fork', [
    { id: 'f4', role: 'user', content: '再来一个', parentId: 'f3' },
    { id: 'f5', role: 'assistant', content: '版本 B 的回答', parentId: 'f4' },
  ])

  const got = await (await fetch(`${server.url}/api/conversations/tree-fork`)).json()
  const byId = Object.fromEntries(got.messages.map((m) => [m.id, m]))

  assert.equal(byId.f2.variantCount, 2, 'f2/f3 应该是同一 parent 的两个兄弟节点')
  assert.equal(byId.f2.variantIndex, 0)
  assert.equal(byId.f3.variantIndex, 1)
  assert.equal(byId.f4.variantCount, 1, '挂在 f3 下的子节点父不同，不是兄弟')
  assert.equal(byId.f1.hasChildren, true)

  // 前序展开：f1, f2(分支A), f3(分支B), f4, f5 —— 新分支接在后面
  assert.deepEqual(
    got.messages.map((m) => m.id),
    ['f1', 'f2', 'f3', 'f4', 'f5']
  )
  assert.equal(got.leafMessageId, 'f5')
  assert.deepEqual(got.activePath, ['f1', 'f3', 'f4', 'f5'])
})

test('messageChain：只取根 → 目标消息这一条链', async () => {
  assert.deepEqual(
    messageChain('tree-fork', 'f2').map((m) => m.id),
    ['f1', 'f2']
  )
  assert.deepEqual(
    messageChain('tree-fork', 'f5').map((m) => m.id),
    ['f1', 'f3', 'f4', 'f5']
  )
})

test('messageChain：parentId 成环时必须终止，不能挂死', async () => {
  // 客户端可以 PUT 任意 parentId：两条消息互相指向会构成环。
  // 没有环检测时 while 循环永远退不出去——请求挂死、内存涨满。
  await post('/api/conversations', { id: 'tree-cycle', title: '环' })
  await putMessages('tree-cycle', [
    { id: 'c1', role: 'user', content: 'A', parentId: 'c2' },
    { id: 'c2', role: 'assistant', content: 'B', parentId: 'c1' },
  ])

  const chain = messageChain('tree-cycle', 'c1')
  const ids = new Set(chain.map((m) => m.id))
  assert.equal(chain.length, ids.size, '链上不允许出现重复消息（环被截断）')
  assert.equal(chain.length, 2, '两条互指的消息各自成链，都只取到自己')

  await post('/api/conversations/tree-cycle', undefined, 'DELETE')
})

test('对话带 parentId：上游只会收到链上的消息，不会混入旧分支', async () => {
  const res = await post('/api/chat', {
    provider: providerId,
    model: 'mock-model',
    conversationId: 'tree-fork',
    parentId: 'f4', // 从 f3 这条分支继续
    messages: [{ id: 'f6', role: 'user', content: '在版本 B 分支里提问' }],
  })
  const events = await readSse(res)
  assert.equal(events.at(-1).type, 'done')

  const sent = upstream.state.lastBody.messages
  const contents = sent.map((m) => m.content)
  assert.ok(contents.includes('讲个笑话'), '链上的祖先必须在上下文中')
  assert.ok(contents.includes('再来一个'), 'f3 分支的消息必须在')
  assert.ok(contents.includes('在版本 B 分支里提问'), '新提问必须在')
  assert.ok(!contents.includes('版本 A'), '旧分支 f2 的内容不应出现')
})

test('按 parentId 分叉：导出只包含当前激活分支', async () => {
  const md = await (await fetch(`${server.url}/api/conversations/tree-fork/export?format=md`)).text()
  assert.ok(md.includes('版本 B'))
  assert.ok(!md.includes('版本 A'), '已归档的旧分支不应导出去')

  await post('/api/conversations/tree-fork', undefined, 'DELETE')
})
