import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareEnv } from './helpers/setup.js'

prepareEnv()

const { initStorage, getDb } = await import('../store/db.js')
const { search } = await import('../rag/store.js')
const { vectorToBuffer } = await import('../rag/embeddings.js')

initStorage()
const db = getDb()

/**
 * 和测试用假上游一致的「字符袋」向量：
 * 相同字符越多余弦越高，够用来验证排序逻辑，又不依赖真模型。
 */
function embed(text, dim = 96) {
  const vec = new Float32Array(dim)
  for (const ch of String(text)) {
    vec[ch.codePointAt(0) % dim] += 1
  }
  let norm = 0
  for (let i = 0; i < dim; i += 1) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i += 1) vec[i] /= norm
  return vec
}

const WS = 'ws-rank-test'

/** 造一个文档 + 若干块 */
function seed({ docId, docName, chunks }) {
  const t = Date.now()
  db.prepare(
    `INSERT OR REPLACE INTO documents
     (id, workspace_id, name, mime, size, chars, chunk_count, status, progress, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'text/plain', 0, 0, ?, 'ready', 100, 0, ?, ?)`
  ).run(docId, WS, docName, chunks.length, t, t)

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO chunks (id, document_id, workspace_id, seq, heading, text, dim, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  chunks.forEach((c, i) => {
    const vec = embed(`${c.heading || ''} ${c.text}`)
    stmt.run(`${docId}-c${i}`, docId, WS, i, c.heading || null, c.text, vec.length, vectorToBuffer(vec), t)
  })
}

test.before(() => {
  db.prepare('INSERT OR REPLACE INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    WS,
    '排序测试',
    Date.now(),
    Date.now()
  )
  db.prepare('DELETE FROM chunks WHERE workspace_id = ?').run(WS)
  db.prepare('DELETE FROM documents WHERE workspace_id = ?').run(WS)

  // 文档 A：讲向量库，其中一块明确写了 HNSW
  seed({
    docId: 'doc-a',
    docName: '向量库选型.md',
    chunks: [
      { heading: '原理', text: 'HNSW 是分层可导航小世界图，用于近似最近邻搜索。' },
      { heading: '选型', text: '常见的向量库有 Pinecone、Milvus、Qdrant 与 LanceDB。' },
    ],
  })
  // 文档 B：同样的主题词，但没有那个型号
  seed({
    docId: 'doc-b',
    docName: '数据库概览.md',
    chunks: [{ heading: '概览', text: '向量数据库是一类专门存储与检索向量的系统。' }],
  })
})

test('按文档过滤：只返回指定文档的块', () => {
  const query = '向量数据库'
  const onlyA = search(WS, embed(query), { query, topK: 10, documentIds: ['doc-a'], minScore: 0 })
  assert.ok(onlyA.length > 0, '应该有命中')
  assert.ok(
    onlyA.every((c) => c.documentId === 'doc-a'),
    `不该混进其它文档：${onlyA.map((c) => c.documentId).join(',')}`
  )

  const onlyB = search(WS, embed(query), { query, topK: 10, documentIds: ['doc-b'], minScore: 0 })
  assert.ok(onlyB.every((c) => c.documentId === 'doc-b'))

  // 传一个不存在的文档 → 空结果，而不是退回全库
  const none = search(WS, embed(query), { query, topK: 10, documentIds: ['doc-nope'], minScore: 0 })
  assert.equal(none.length, 0)
})

test('硬词加权：问型号时，含该型号的块必须排第一', () => {
  const query = 'HNSW 是什么'
  const results = search(WS, embed(query), { query, topK: 5, minScore: 0 })
  assert.ok(results.length > 0)
  assert.equal(results[0].documentId, 'doc-a', `第一条应该是含 HNSW 的文档：${JSON.stringify(results[0])}`)
  assert.ok(results[0].phraseScore > 0, '硬词命中应该被记到 phraseScore')
})

test('MMR 去重：同样的内容不会占满所有名额', () => {
  db.prepare('DELETE FROM chunks WHERE workspace_id = ?').run('ws-mmr')
  db.prepare('DELETE FROM documents WHERE workspace_id = ?').run('ws-mmr')
  db.prepare('INSERT OR REPLACE INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'ws-mmr',
    'MMR 测试',
    Date.now(),
    Date.now()
  )

  const repeated = '限流器的实现要点是令牌桶与漏桶。'
  seedFor('ws-mmr', {
    docId: 'mmr-a',
    docName: '限流.md',
    chunks: [
      { heading: '要点', text: repeated },
      { heading: '要点', text: repeated },
      { heading: '要点', text: repeated },
    ],
  })
  seedFor('ws-mmr', {
    docId: 'mmr-b',
    docName: '限流方案对比.md',
    chunks: [{ heading: '对比', text: '限流器的实现要点还包括滑动窗口与固定窗口计数。' }],
  })

  const query = '限流器实现要点'
  const top2 = search('ws-mmr', embed(query), { query, topK: 2, minScore: 0 })
  assert.equal(top2.length, 2)
  const docs = new Set(top2.map((c) => c.documentId))
  assert.equal(docs.size, 2, `topK=2 时应该覆盖两个不同文档，实际：${[...docs].join(',')}`)
})

test('调试视图：能看出每条候选为什么被选中或淘汰', () => {
  const query = '向量数据库'
  const out = search(WS, embed(query), { query, topK: 2, minScore: 0, debug: true })
  assert.ok(!Array.isArray(out), 'debug 模式返回对象')
  assert.ok(out.total >= 3, '应统计参与打分的块数')
  assert.ok(Array.isArray(out.candidates) && out.candidates.length > 0)

  const first = out.candidates[0]
  for (const key of ['score', 'vectorScore', 'keywordScore', 'phraseScore', 'headingScore']) {
    assert.equal(typeof first[key], 'number', `候选里应包含 ${key}`)
  }
  assert.equal(typeof first.picked, 'boolean')
  assert.equal(typeof first.belowThreshold, 'boolean')
  assert.equal(out.chunks.length, 2, 'chunks 仍按 topK 返回')
})

test('向量化失败（queryVector=null）时退化为纯关键词，不崩', () => {
  const query = 'HNSW'
  const results = search(WS, null, { query, topK: 5, minScore: 0 })
  assert.ok(results.length > 0, '纯关键词也要能召回')
  assert.ok(results[0].vectorScore === 0, '没有查询向量时向量分应为 0')
  assert.ok(results[0].keywordScore > 0)
})

test('空知识库返回空结果而不是报错', () => {
  db.prepare('INSERT OR REPLACE INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    'ws-empty',
    '空库',
    Date.now(),
    Date.now()
  )
  assert.deepEqual(search('ws-empty', embed('随便'), { query: '随便' }), [])
  const dbg = search('ws-empty', embed('随便'), { query: '随便', debug: true })
  assert.deepEqual(dbg.chunks, [])
  assert.deepEqual(dbg.candidates, [])
})

/** 指定 workspace 的 seed（上面那个默认用 WS） */
function seedFor(workspaceId, { docId, docName, chunks }) {
  const t = Date.now()
  db.prepare(
    `INSERT OR REPLACE INTO documents
     (id, workspace_id, name, mime, size, chars, chunk_count, status, progress, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'text/plain', 0, 0, ?, 'ready', 100, 0, ?, ?)`
  ).run(docId, workspaceId, docName, chunks.length, t, t)

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO chunks (id, document_id, workspace_id, seq, heading, text, dim, embedding, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  chunks.forEach((c, i) => {
    const vec = embed(`${c.heading || ''} ${c.text}`)
    stmt.run(`${docId}-c${i}`, docId, workspaceId, i, c.heading || null, c.text, vec.length, vectorToBuffer(vec), t)
  })
}
