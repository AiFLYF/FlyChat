import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, loadApp } from './helpers/setup.js'

prepareEnv()

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
const { cleanTags } = await import('../store/folders.js')
initStorage()

const server = await listen(createApp())

const req = (path, { method = 'GET', body } = {}) =>
  fetch(`${server.url}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })

const json = async (path, opts) => {
  const res = await req(path, opts)
  return { status: res.status, body: await res.json().catch(() => null) }
}

test.after(() => server.close())

/** 建一个会话 */
async function addConv(id, title, extra = {}) {
  const res = await json('/api/conversations', {
    method: 'POST',
    body: { id, title, messages: [{ id: `${id}-m1`, role: 'user', content: 'hi' }], ...extra },
  })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body
}

test('文件夹 CRUD：建、列（带会话数）、改名、删', async () => {
  const created = await json('/api/folders', { method: 'POST', body: { name: '工作', icon: '💼' } })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.ok(created.body.id.startsWith('folder-'))
  assert.equal(created.body.icon, '💼')

  await addConv('f-conv-1', '周报')
  await json('/api/conversations/f-conv-1', { method: 'PATCH', body: { folderId: created.body.id } })

  const list = await json('/api/folders')
  const folder = list.body.items.find((f) => f.id === created.body.id)
  assert.ok(folder)
  assert.equal(folder.count, 1, '应显示文件夹里的会话数')

  const renamed = await json(`/api/folders/${created.body.id}`, { method: 'PATCH', body: { name: '工作（新）' } })
  assert.equal(renamed.body.name, '工作（新）')

  const del = await json(`/api/folders/${created.body.id}`, { method: 'DELETE' })
  assert.equal(del.body.ok, true)
  assert.equal(del.body.moved, 1, '删除文件夹要把里面的会话移出来')
  assert.equal((await json(`/api/folders/${created.body.id}`)).status, 404)

  // 会话本身必须还在
  const conv = await json('/api/conversations/f-conv-1')
  assert.equal(conv.status, 200)
  assert.equal(conv.body.folderId, undefined, '应回到未分类')
})

test('删除文件夹绝不删会话（这是最容易失去信任的操作）', async () => {
  const folder = (await json('/api/folders', { method: 'POST', body: { name: '临时' } })).body
  await addConv('f-keep-1', '要保留的会话')
  await json('/api/conversations/f-keep-1', { method: 'PATCH', body: { folderId: folder.id } })

  await json(`/api/folders/${folder.id}`, { method: 'DELETE' })

  const conv = await json('/api/conversations/f-keep-1')
  assert.equal(conv.status, 200, '会话不能被连带删除')
  assert.equal(conv.body.title, '要保留的会话')
})

test('按文件夹过滤：folderId / unfiled 两种视图', async () => {
  const folder = (await json('/api/folders', { method: 'POST', body: { name: '项目A' } })).body
  await addConv('f-a-1', 'A 里的会话')
  await json('/api/conversations/f-a-1', { method: 'PATCH', body: { folderId: folder.id } })
  await addConv('f-a-2', '没放进文件夹的')

  const inFolder = await json(`/api/conversations?folderId=${folder.id}`)
  assert.deepEqual(inFolder.body.items.map((c) => c.id), ['f-a-1'])
  assert.equal(inFolder.body.total, 1, 'total 要跟过滤条件一致')

  const unfiled = await json('/api/conversations?unfiled=1')
  const ids = unfiled.body.items.map((c) => c.id)
  assert.ok(ids.includes('f-a-2'))
  assert.ok(!ids.includes('f-a-1'), '未分类视图不该包含已归档的会话')

  // 不带参数 → 不按文件夹过滤
  const all = await json('/api/conversations')
  const allIds = all.body.items.map((c) => c.id)
  assert.ok(allIds.includes('f-a-1') && allIds.includes('f-a-2'))
})

test('标签：清洗（去空、去重、限长、限数量）', () => {
  assert.deepEqual(cleanTags([' 重要 ', '重要', '', '待跟进']), ['重要', '待跟进'])
  assert.deepEqual(cleanTags('不是数组'), [])
  // 逗号会被换成空格，避免「a,b」变成一个奇怪的标签
  assert.deepEqual(cleanTags(['a,b']), ['a b'])
  const many = Array.from({ length: 30 }, (_, i) => `t${i}`)
  assert.equal(cleanTags(many).length, 12, '最多 12 个标签')
  assert.equal(cleanTags(['x'.repeat(100)])[0].length, 24, '单个标签最长 24 字')
})

test('标签：写入后能按标签过滤，且不做子串误伤', async () => {
  await addConv('f-tag-1', '带标签的会话', { tags: ['重要', '待跟进'] })
  await addConv('f-tag-2', '另一个会话', { tags: ['不重要'] })

  const byTag = await json('/api/conversations?tag=重要')
  const ids = byTag.body.items.map((c) => c.id)
  assert.ok(ids.includes('f-tag-1'))
  assert.ok(!ids.includes('f-tag-2'), '「重要」不能匹配到「不重要」')

  const tags = await json('/api/tags')
  const names = tags.body.items.map((t) => t.name)
  assert.ok(names.includes('重要') && names.includes('不重要') && names.includes('待跟进'))
  const pending = tags.body.items.find((t) => t.name === '待跟进')
  assert.equal(pending.count, 1)

  // 更新标签（覆盖语义）
  const updated = await json('/api/conversations/f-tag-1', { method: 'PATCH', body: { tags: ['已归档'] } })
  assert.deepEqual(updated.body.tags, ['已归档'])

  // 传空数组 = 清空
  const cleared = await json('/api/conversations/f-tag-1', { method: 'PATCH', body: { tags: [] } })
  assert.deepEqual(cleared.body.tags, [])
})

test('批量移动：进文件夹、移出（folderId = none）', async () => {
  const folder = (await json('/api/folders', { method: 'POST', body: { name: '批量' } })).body
  await addConv('f-m-1', '批量一')
  await addConv('f-m-2', '批量二')

  const moved = await json(`/api/folders/${folder.id}/move`, {
    method: 'POST',
    body: { conversationIds: ['f-m-1', 'f-m-2'] },
  })
  assert.equal(moved.body.moved, 2)

  const inFolder = await json(`/api/conversations?folderId=${folder.id}`)
  assert.equal(inFolder.body.items.length, 2)

  const out = await json('/api/folders/none/move', {
    method: 'POST',
    body: { conversationIds: ['f-m-1'] },
  })
  assert.equal(out.body.moved, 1)
  const after = await json(`/api/conversations?folderId=${folder.id}`)
  assert.deepEqual(after.body.items.map((c) => c.id), ['f-m-2'])
})

test('不能把会话放进不存在的文件夹', async () => {
  await addConv('f-bad-1', '目标不存在')
  const res = await json('/api/conversations/f-bad-1', {
    method: 'PATCH',
    body: { folderId: 'folder-does-not-exist' },
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'folder_not_found')
})

test('文件夹名为空时拒绝创建', async () => {
  const res = await json('/api/folders', { method: 'POST', body: { name: '   ' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'missing_name')
})

test('会话列表项带上 folderId 与 tags', async () => {
  const folder = (await json('/api/folders', { method: 'POST', body: { name: '展示用' } })).body
  await addConv('f-show-1', '展示', { tags: ['演示'] })
  await json('/api/conversations/f-show-1', { method: 'PATCH', body: { folderId: folder.id } })

  const list = await json('/api/conversations')
  const conv = list.body.items.find((c) => c.id === 'f-show-1')
  assert.equal(conv.folderId, folder.id)
  assert.deepEqual(conv.tags, ['演示'])
})
