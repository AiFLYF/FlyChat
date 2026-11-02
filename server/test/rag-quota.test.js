import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, loadApp } from './helpers/setup.js'

// 配额调到能在测试里触发的大小：2 篇、总共 1MB
prepareEnv({ RAG_MAX_DOCS: '2', RAG_MAX_MB: '1', BREAKER_THRESHOLD: '100' })

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

const upload = (body) =>
  fetch(`${server.url}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

test('上传配额：先卡总字节，再卡文档数；判重优先于配额', async () => {
  // 内容不同才不会命中判重（hash 按完整正文算）
  const bigA = 'x'.repeat(700 * 1024)
  const bigB = 'y'.repeat(700 * 1024)

  const first = await upload({ name: '大文档A.txt', text: bigA })
  assert.equal(first.status, 202)
  const firstBody = await first.json()

  // size 是服务端落盘后的实测值，不采信客户端传的 size
  const detail = await (await fetch(`${server.url}/api/documents/${firstBody.id}`)).json()
  assert.equal(detail.size, Buffer.byteLength(bigA))

  const second = await upload({ name: '大文档B.txt', text: bigB })
  assert.equal(second.status, 413, '第二篇 700KB 会超过 1MB 总上限')
  assert.equal((await second.json()).code, 'document_bytes_exceeded')

  // 小文档仍可入：磁盘上只有 700KB + 5B
  const small = await upload({ name: '小文档.txt', text: 'hello' })
  assert.equal(small.status, 202)

  const third = await upload({ name: '第三篇.txt', text: 'world' })
  assert.equal(third.status, 413, '已有 2 篇，第三篇应被文档数上限拦住')
  assert.equal((await third.json()).code, 'document_quota_exceeded')

  // 配额已满时重传同一篇：判重先于配额，仍返回 200 + duplicate
  const dup = await upload({ name: '小文档.txt', text: 'hello' })
  assert.equal(dup.status, 200)
  assert.equal((await dup.json()).duplicate, true)
})

test('删除文档后配额释放，可以继续上传', async () => {
  const list = await (await fetch(`${server.url}/api/documents`)).json()
  const docs = list.items
  assert.equal(docs.length, 2)

  const res = await fetch(`${server.url}/api/documents/${docs[0].id}`, { method: 'DELETE' })
  assert.equal(res.status, 200)

  const next = await upload({ name: '新文档.txt', text: 'after delete' })
  assert.equal(next.status, 202, '删掉一篇后应回到配额之内')
})
