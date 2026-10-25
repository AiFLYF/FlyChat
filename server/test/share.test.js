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
  await fetch(`${server.url}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'conv-share-1',
      title: '分享测试会话',
      model: 'gpt-4o',
      messages: [
        { id: 'sm1', role: 'user', content: '什么是向量数据库？' },
        { id: 'sm2', role: 'assistant', content: '一种专门存向量、按相似度检索的数据库。', model: 'gpt-4o' },
      ],
    }),
  })
})

after(async () => {
  await server.close()
})

const post = (path, body) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test('分享会话：创建 → 公开读取 → 删除', async () => {
  const created = await post('/api/share', { conversationId: 'conv-share-1' })
  assert.equal(created.status, 201)
  const share = await created.json()
  assert.ok(share.id)
  assert.equal(share.hasPassword, false)
  assert.equal(share.url, `/s/${share.id}`)

  const read = await fetch(`${server.url}/api/share/${share.id}`)
  assert.equal(read.status, 200)
  const data = await read.json()
  assert.equal(data.title, '分享测试会话')
  assert.equal(data.messages.length, 2)
  assert.equal(data.messages[1].model, 'gpt-4o')
  assert.equal(data.views, 1)

  const del = await fetch(`${server.url}/api/share/${share.id}`, { method: 'DELETE' })
  assert.equal(del.status, 200)

  const gone = await fetch(`${server.url}/api/share/${share.id}`)
  assert.equal(gone.status, 404)
})

test('分享快照：不依赖服务端已有会话（离线优先场景）', async () => {
  const created = await post('/api/share', {
    snapshot: {
      id: 'local-only-1',
      title: '本地会话',
      model: 'deepseek-chat',
      messages: [{ id: 'a1', role: 'user', content: '离线内容' }],
    },
  })
  assert.equal(created.status, 201)
  const share = await created.json()

  const data = await (await fetch(`${server.url}/api/share/${share.id}`)).json()
  assert.equal(data.title, '本地会话')
  assert.equal(data.messages[0].content, '离线内容')

  await fetch(`${server.url}/api/share/${share.id}`, { method: 'DELETE' })
})

test('分享密码：没密码 401，密码正确 200，错误 401', async () => {
  const created = await post('/api/share', { conversationId: 'conv-share-1', password: 'open-sesame' })
  const share = await created.json()
  assert.equal(share.hasPassword, true)

  const noPw = await fetch(`${server.url}/api/share/${share.id}`)
  assert.equal(noPw.status, 401)

  const wrong = await fetch(`${server.url}/api/share/${share.id}?password=nope`)
  assert.equal(wrong.status, 401)

  const ok = await fetch(`${server.url}/api/share/${share.id}?password=open-sesame`)
  assert.equal(ok.status, 200)
  const data = await ok.json()
  assert.equal(data.hasPassword, true)

  await fetch(`${server.url}/api/share/${share.id}`, { method: 'DELETE' })
})

test('分享列表：不含消息正文', async () => {
  const created = await post('/api/share', { conversationId: 'conv-share-1' })
  const share = await created.json()

  const list = await (await fetch(`${server.url}/api/shares`)).json()
  const item = list.items.find((s) => s.id === share.id)
  assert.ok(item)
  assert.equal(item.messages.length, 0)
  assert.equal(item.messageCount, 2)

  await fetch(`${server.url}/api/share/${share.id}`, { method: 'DELETE' })
})

test('分享不存在的会话：404', async () => {
  const res = await post('/api/share', { conversationId: 'nope-nope' })
  assert.equal(res.status, 404)
})
