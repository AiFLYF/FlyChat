import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv, listen, readSse, loadApp} from './helpers/setup.js'
import { startMockUpstream } from './helpers/mock-upstream.js'

prepareEnv({ BREAKER_THRESHOLD: '100' })

const createApp = await loadApp()
const { initStorage } = await import('../store/db.js')
const { chunkText, decorateChunk } = await import('../rag/chunk.js')

let server
let upstream

before(async () => {
  initStorage()
  server = await listen(createApp())
  upstream = await startMockUpstream()
  // 建一个指向假上游的服务商，向量化与对话都走它
  const res = await fetch(`${server.url}/api/providers/custom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '知识库测试',
      type: 'openai-compat',
      baseUrl: upstream.baseUrl,
      apiKey: 'sk-mock',
      models: ['mock-model'],
    }),
  })
  assert.equal(res.status, 200)
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

/** 轮询文档处理进度，直到 ready / failed / 超时 */
async function waitForDocument(id, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await (await fetch(`${server.url}/api/documents/${id}`)).json()
    if (last.status === 'ready' || last.status === 'failed') return last
    await new Promise((r) => setTimeout(r, 50))
  }
  return last
}

test('切块：按标题分段，块带章节名，且不把段落劈开', () => {
  const text = `# 向量数据库

## 原理

${'HNSW 是一种分层可导航小世界图，用于近似最近邻搜索。它通过多层图结构在精度和速度之间取得平衡。'.repeat(8)}

## 选型

${'常见的向量库有 Pinecone、Milvus、Qdrant 和 LanceDB。个人项目更看重零依赖和部署简单。'.repeat(8)}
`
  const chunks = chunkText(text, { maxChars: 300, overlap: 40 })
  assert.ok(chunks.length >= 2, `应切成多块，实际 ${chunks.length}`)
  const all = chunks.map((c) => c.text).join('\n')
  assert.ok(all.includes('HNSW'), '内容不能丢')
  assert.ok(chunks.some((c) => c.heading?.includes('原理')), '应记录章节名')
  assert.ok(chunks.some((c) => c.heading?.includes('选型')), '应记录章节名')
  // 段落完整性：不能出现半个词
  for (const c of chunks) {
    assert.ok(!c.text.endsWith('HNS'), '不应在词中间截断')
  }
})

test('切块：超长单段会硬切但保留重叠', () => {
  const long = '甲'.repeat(5000)
  const chunks = chunkText(long, { maxChars: 500, overlap: 50 })
  assert.ok(chunks.length > 5)
  for (const c of chunks) assert.ok(c.chars <= 600)
})

test('decorateChunk：抬头包含文档名与章节', () => {
  const out = decorateChunk({ text: '正文', heading: '原理' }, '技术手册.pdf')
  assert.match(out, /文档: 技术手册\.pdf/)
  assert.match(out, /章节: 原理/)
  assert.match(out, /正文/)
})

test('知识库状态：能识别出可用的向量化服务商', async () => {
  const status = await (await fetch(`${server.url}/api/knowledge/status`)).json()
  assert.equal(status.enabled, true)
  assert.ok(status.embedding.model)
})

test('上传文档 → 切块入库 → 检索命中正确内容', async () => {
  const text = `# 报销制度

## 差旅报销

员工出差住宿标准为一线城市每晚不超过 600 元，二线城市不超过 400 元。超标部分需部门负责人审批。

## 餐饮报销

工作日加班餐补每人每餐 40 元，需提供发票。
`
  const created = await post('/api/documents', { name: '报销制度.md', mime: 'text/markdown', text })
  const body = await created.json()
  assert.equal(created.status, 202, JSON.stringify(body))
  assert.equal(body.status, 'pending', '应立即返回 pending 而不是同步处理完')

  // 等后台流水线跑完
  const done = await waitForDocument(body.id)
  assert.equal(done.status, 'ready', `入库失败：${done.error}`)
  assert.ok(done.chunkCount >= 1)
  assert.equal(done.progress, 100)
  assert.ok(done.chars > 0)
  const docId = body.id

  const found = await (await post('/api/retrieve', { query: '出差住宿标准是多少', topK: 3 })).json()
  assert.ok(found.count > 0, '应检索到内容')
  assert.match(found.chunks[0].text, /600 元|住宿标准/)
  assert.equal(found.chunks[0].documentName, '报销制度.md')
  assert.ok(found.sources[0].title.includes('报销制度'))

  // 重复上传同一内容：仍然不重复入库
  const again = await post('/api/documents', { name: '报销制度.md', mime: 'text/markdown', text })
  const againBody = await again.json()
  assert.equal(again.status, 200)
  assert.equal(againBody.duplicate, true)
  assert.equal(againBody.documentId, docId)

  // 列表可见
  const list = await (await fetch(`${server.url}/api/documents`)).json()
  assert.ok(list.items.some((d) => d.id === docId))

  // 删除后检索不到
  const del = await fetch(`${server.url}/api/documents/${docId}`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  const afterDelete = await (await post('/api/retrieve', { query: '出差住宿标准是多少' })).json()
  assert.equal(afterDelete.count, 0)
})

test('对话带 workspaceId：注入知识库上下文并回传 sources', async (t) => {
  const text = 'FlyChat 的默认端口是 3001，前端开发端口是 5173。'
  const created = await post('/api/documents', { name: '端口说明.txt', mime: 'text/plain', text })
  const submitted = await created.json()
  const doc = await waitForDocument(submitted.id)
  assert.equal(doc.status, 'ready', doc.error)

  const res = await post('/api/chat', {
    provider: (await (await fetch(`${server.url}/api/providers`)).json()).providers[0].id,
    model: 'mock-model',
    messages: [{ role: 'user', content: 'FlyChat 后端端口是多少？' }],
    workspaceId: 'default',
  })
  const events = await readSse(res)
  const types = events.map((e) => e.type)

  assert.ok(types.includes('sources'), `应有 sources 事件：${types.join(',')}`)
  const sources = events.find((e) => e.type === 'sources')
  assert.ok(sources.sources.length > 0)
  assert.ok(sources.sources[0].title.includes('端口说明'))

  // 上下文必须真的注入了 system，否则模型看不到资料
  const systemPrompt = JSON.stringify(upstream.state.lastBody.messages)
  assert.match(systemPrompt, /资料 1/)
  assert.match(systemPrompt, /3001/)

  assert.equal(types.at(-1), 'done')
  await fetch(`${server.url}/api/documents/${submitted.id}`, { method: 'DELETE' })
})

test('知识库为空时：给出提示而不是编造', async () => {
  const res = await post('/api/chat', {
    provider: (await (await fetch(`${server.url}/api/providers`)).json()).providers[0].id,
    model: 'mock-model',
    messages: [{ role: 'user', content: '完全不相关的问题 xyz' }],
    workspaceId: 'default',
  })
  const events = await readSse(res)
  const notice = events.find((e) => e.type === 'notice')
  assert.ok(notice)
  assert.match(notice.message, /没有检索到/)
})

test('多知识库隔离：A 库的文档不会出现在 B 库检索里', async () => {
  const ws = await (await post('/api/workspaces', { name: '项目 B' })).json()
  assert.ok(ws.id)

  const submitted = await post('/api/documents', { workspaceId: ws.id, name: 'B库文档.txt', text: '这是 B 库独有的内容：蓝鲸计划。' })
  const docB = await waitForDocument((await submitted.json()).id)
  assert.equal(docB.status, 'ready', docB.error)

  const inB = await (await post('/api/retrieve', { workspaceId: ws.id, query: '蓝鲸计划' })).json()
  assert.ok(inB.count > 0)

  const inDefault = await (await post('/api/retrieve', { workspaceId: 'default', query: '蓝鲸计划' })).json()
  assert.equal(inDefault.count, 0, '默认库不应看到 B 库内容')

  const del = await fetch(`${server.url}/api/workspaces/${ws.id}`, { method: 'DELETE' })
  assert.equal(del.status, 200)
})

test('默认知识库不能删除', async () => {
  const res = await fetch(`${server.url}/api/workspaces/default`, { method: 'DELETE' })
  assert.equal(res.status, 400)
})

test('无法解析的文件：标为 failed 并带可读错误，可重试', async (t) => {
  // 一段随机二进制：既不是文本也不支持的类型
  const binary = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256)).toString('base64')
  const created = await post('/api/documents', {
    name: '坏文件.bin',
    mime: 'application/octet-stream',
    dataUrl: `data:application/octet-stream;base64,${binary}`,
  })
  const submitted = await created.json()
  assert.equal(created.status, 202)

  const done = await waitForDocument(submitted.id)
  assert.equal(done.status, 'failed', '应该标记失败')
  assert.ok(done.error, '应带上错误信息')
  assert.equal(done.attempts, 1)

  // 失败也能重试（会再次失败，但状态机要能转）
  const retry = await post(`/api/documents/${submitted.id}/retry`, {})
  assert.equal(retry.status, 200)
  const afterRetry = await waitForDocument(submitted.id)
  assert.equal(afterRetry.status, 'failed')
  assert.equal(afterRetry.attempts, 2)

  await fetch(`${server.url}/api/documents/${submitted.id}`, { method: 'DELETE' })
})

test('文档状态接口：不存在返回 404', async () => {
  const res = await fetch(`${server.url}/api/documents/nope-nope`)
  assert.equal(res.status, 404)
})

test('判重按完整内容：前缀相同但内容不同的两份文件都要入库', async () => {
  // 造两份前 200 个字符完全一致的文本（模拟「同样的 PDF 文件头」）
  const head = 'A'.repeat(240)
  const a = `${head}——这是第一份文档的独有正文。`
  const b = `${head}——这是第二份文档的独有正文。`

  const first = await post('/api/documents', { name: '前件.txt', mime: 'text/plain', text: a })
  const firstBody = await first.json()
  assert.equal(first.status, 202, JSON.stringify(firstBody))

  const second = await post('/api/documents', { name: '后件.txt', mime: 'text/plain', text: b })
  const secondBody = await second.json()
  assert.equal(second.status, 202, '内容不同就不能判重')
  assert.notEqual(secondBody.id, firstBody.id)

  // 真的传同一份，仍然要判重
  const same = await post('/api/documents', { name: '前件副本.txt', mime: 'text/plain', text: a })
  assert.equal(same.status, 200)
  assert.equal((await same.json()).duplicate, true)

  await waitForDocument(firstBody.id)
  await waitForDocument(secondBody.id)
  await fetch(`${server.url}/api/documents/${firstBody.id}`, { method: 'DELETE' })
  await fetch(`${server.url}/api/documents/${secondBody.id}`, { method: 'DELETE' })
})

test('落盘失败不留孤儿行：修好之后能用同一内容重新上传', async () => {
  // 空文件：解码后 0 字节，saveUpload 会抛错
  const bad = await post('/api/documents', {
    name: '空文件.txt',
    mime: 'text/plain',
    dataUrl: 'data:text/plain;base64,',
  })
  assert.equal(bad.status, 400, '空文件应直接拒绝')

  // 关键：列表里不能留下一条 pending 的僵尸记录
  const list = await (await fetch(`${server.url}/api/documents`)).json()
  assert.ok(
    !list.items.some((d) => d.name === '空文件.txt'),
    `不应留下孤儿行：${JSON.stringify(list.items.map((d) => d.name))}`
  )

  // 也不能因为占位了 hash 而挡住后续正常上传
  const ok = await post('/api/documents', { name: '空文件.txt', mime: 'text/plain', text: '现在有内容了' })
  assert.equal(ok.status, 202)
  const body = await ok.json()
  const done = await waitForDocument(body.id)
  assert.equal(done.status, 'ready', done.error)
  await fetch(`${server.url}/api/documents/${body.id}`, { method: 'DELETE' })
})

test('网页入库：抓取 → 去标签 → 切块入库，且脚本内容不进去', async (t) => {
  const http = await import('node:http')
  const page = `<!doctype html><html><head><title>内部部署规范</title>
    <style>body{margin:0}</style><script>var secret='不该入库'</script></head>
    <body><h1>部署规范</h1><p>FlyChat 生产环境使用单进程部署，端口 3001。</p>
    <script>console.log('也不该入库')</script></body></html>`

  const site = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/doc' })
      return res.end()
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  await new Promise((r) => site.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${site.address().port}`
  t.after(() => new Promise((r) => site.close(r)))

  // 跟随一次重定向，验证「逐跳校验」这条路径能正常走通
  const created = await post('/api/documents', { url: `${base}/redirect` })
  const submitted = await created.json()
  assert.equal(created.status, 202, JSON.stringify(submitted))
  assert.ok(submitted.name, '没给文档名时应从 URL 推导')

  const done = await waitForDocument(submitted.id)
  assert.equal(done.status, 'ready', done.error)
  assert.ok(done.sourceUrl, '应记录来源 URL')
  assert.ok(done.chunkCount >= 1)

  const ret = await (await post('/api/retrieve', { query: '生产环境端口' })).json()
  assert.ok(ret.count >= 1, '入库后应能检索到')
  const text = ret.chunks.map((c) => c.text).join('\n')
  assert.match(text, /单进程部署/)
  assert.ok(!text.includes('不该入库'), '脚本内容不能进知识库')
  assert.ok(!text.includes('margin:0'), '样式不能进知识库')

  // 同一个链接重复提交 → 判重（按提交的 URL 判，不是按重定向后的最终地址）
  const again = await (await post('/api/documents', { url: `${base}/redirect` })).json()
  assert.equal(again.duplicate, true, JSON.stringify(again))

  await fetch(`${server.url}/api/documents/${submitted.id}`, { method: 'DELETE' })
})

test('网页入库：内网/元数据地址在提交时就被拒绝', async () => {
  const metadata = await post('/api/documents', { url: 'http://169.254.169.254/latest/meta-data/' })
  assert.equal(metadata.status, 400)
  assert.equal((await metadata.json()).code, 'unsafe_url')

  const notHttp = await post('/api/documents', { url: 'file:///etc/passwd' })
  assert.equal(notHttp.status, 400)
  assert.equal((await notHttp.json()).code, 'unsafe_url')
})
