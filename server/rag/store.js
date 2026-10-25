import crypto from 'node:crypto'
import { getDb, transaction } from '../store/db.js'
import { badRequest, notFound } from '../lib/errors.js'
import { bufferToVector, vectorToBuffer, cosine } from './embeddings.js'

/**
 * 知识库存储。
 *
 * 向量直接存 SQLite BLOB，检索时在 Node 里做一次全量余弦扫描。
 * 为什么不上专用向量库：LanceDB / Chroma 都是原生依赖，装不上就整个功能不可用；
 * 个人/小团队规模（几万块）用 Float32Array 扫描只要几十毫秒，换来的「零依赖」更值钱。
 * 规模再大时的升级路径：把 search() 换成调用外部向量库，接口不变。
 */

export const DEFAULT_WORKSPACE_ID = 'default'

function now() {
  return Date.now()
}

export function ensureDefaultWorkspace() {
  const db = getDb()
  const row = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(DEFAULT_WORKSPACE_ID)
  if (!row) {
    const t = now()
    db.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      DEFAULT_WORKSPACE_ID,
      '默认知识库',
      t,
      t
    )
  }
}

export function listWorkspaces() {
  ensureDefaultWorkspace()
  const db = getDb()
  return db
    .prepare(
      `SELECT w.*,
              (SELECT COUNT(*) FROM documents d WHERE d.workspace_id = w.id) AS doc_count,
              (SELECT COUNT(*) FROM chunks c WHERE c.workspace_id = w.id) AS chunk_count
       FROM workspaces w ORDER BY w.created_at ASC`
    )
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      docCount: r.doc_count,
      chunkCount: r.chunk_count,
    }))
}

export function createWorkspace(name) {
  const db = getDb()
  const clean = String(name || '').trim()
  if (!clean) throw badRequest('知识库名称不能为空', 'invalid_workspace_name')
  if (clean.length > 60) throw badRequest('知识库名称不能超过 60 个字符', 'invalid_workspace_name')
  const id = `ws-${crypto.randomBytes(6).toString('hex')}`
  const t = now()
  db.prepare('INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, clean, t, t)
  return { id, name: clean, createdAt: t, updatedAt: t, docCount: 0, chunkCount: 0 }
}

export function deleteWorkspace(id) {
  if (id === DEFAULT_WORKSPACE_ID) throw badRequest('默认知识库不能删除', 'cannot_delete_default')
  const db = getDb()
  return transaction((tx) => {
    tx.prepare('DELETE FROM chunks WHERE workspace_id = ?').run(id)
    tx.prepare('DELETE FROM documents WHERE workspace_id = ?').run(id)
    const r = tx.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    return (r?.changes ?? 0) > 0
  })
}

function ensureWorkspace(id) {
  const db = getDb()
  const row = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(id)
  if (!row) throw notFound('知识库不存在')
}

export function listDocuments(workspaceId = DEFAULT_WORKSPACE_ID) {
  const db = getDb()
  return db
    .prepare(
      `SELECT id, workspace_id, name, mime, size, chars, chunk_count, status, stage, progress, attempts, error, source_url, created_at, updated_at
       FROM documents WHERE workspace_id = ? ORDER BY created_at DESC`
    )
    .all(workspaceId)
    .map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      mime: r.mime,
      size: r.size,
      chars: r.chars,
      chunkCount: r.chunk_count,
      status: r.status,
      stage: r.stage || undefined,
      progress: r.progress || 0,
      attempts: r.attempts || 0,
      error: r.error || undefined,
      sourceUrl: r.source_url || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
}

/** 单个文档的详情（含切块进度），前端轮询用 */
export function getDocument(id) {
  const db = getDb()
  const r = db
    .prepare(
      `SELECT id, workspace_id, name, mime, size, chars, chunk_count, status, stage, progress, attempts, error, source_url, created_at, updated_at
       FROM documents WHERE id = ?`
    )
    .get(String(id))
  if (!r) return null
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    chars: r.chars,
    chunkCount: r.chunk_count,
    status: r.status,
    stage: r.stage || undefined,
    progress: r.progress || 0,
    attempts: r.attempts || 0,
    error: r.error || undefined,
    sourceUrl: r.source_url || undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 内部用：拿完整行（含 hash），供任务流水线判断与重试 */
export function documentRow(id) {
  return getDb().prepare('SELECT * FROM documents WHERE id = ?').get(String(id)) || null
}

/** 创建待处理的文档行（异步流水线的第一步，文件此时还没解析） */
export function createDocument(input) {
  const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID
  ensureWorkspace(workspaceId)
  const db = getDb()
  const id = `doc-${crypto.randomBytes(8).toString('hex')}`
  const t = now()
  db.prepare(
    `INSERT INTO documents (id, workspace_id, name, mime, size, chars, chunk_count, status, stage, progress, attempts, error, hash, source_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 'pending', '已入队', 0, 0, NULL, ?, ?, ?, ?)`
  ).run(
    id,
    workspaceId,
    String(input.name || '未命名文档').slice(0, 200),
    input.mime || null,
    Number(input.size) || 0,
    input.hash || null,
    input.sourceUrl ? String(input.sourceUrl).slice(0, 2000) : null,
    t,
    t
  )
  return { id, workspaceId }
}

/** 更新流水线状态（进度百分比与阶段文案给前端展示） */
export function updateDocumentStatus(id, { status, stage, progress, error, chunkCount, attempts }) {
  const db = getDb()
  const sets = []
  const params = []
  if (status !== undefined) {
    sets.push('status = ?')
    params.push(String(status))
  }
  if (stage !== undefined) {
    sets.push('stage = ?')
    params.push(stage ? String(stage).slice(0, 60) : null)
  }
  if (progress !== undefined) {
    sets.push('progress = ?')
    params.push(Math.max(0, Math.min(100, Math.round(Number(progress) || 0))))
  }
  if (error !== undefined) {
    sets.push('error = ?')
    params.push(error ? String(error).slice(0, 500) : null)
  }
  if (chunkCount !== undefined) {
    sets.push('chunk_count = ?')
    params.push(Math.max(0, Number(chunkCount) || 0))
  }
  if (attempts !== undefined) {
    sets.push('attempts = ?')
    params.push(Math.max(0, Number(attempts) || 0))
  }
  sets.push('updated_at = ?')
  params.push(now())
  params.push(String(id))
  db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getDocument(id)
}

/** 流水线收尾：把切块与向量一次性写入（单事务，失败不留半截数据） */
export function saveDocumentResult(id, { chunks, vectors, dim, chars }) {
  const db = getDb()
  const t = now()
  transaction((tx) => {
    const doc = tx.prepare('SELECT workspace_id FROM documents WHERE id = ?').get(String(id))
    if (!doc) throw new Error('文档不存在')
    // 重跑时要先清掉旧切块，否则会重复
    tx.prepare('DELETE FROM chunks WHERE document_id = ?').run(String(id))
    const insertChunk = tx.prepare(
      `INSERT INTO chunks (id, document_id, workspace_id, seq, heading, text, dim, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    ;(chunks || []).forEach((chunk, i) => {
      const vector = vectors?.[i]
      insertChunk.run(
        `chk-${crypto.randomBytes(8).toString('hex')}`,
        String(id),
        doc.workspace_id,
        i,
        chunk.heading || null,
        chunk.text,
        vector ? vector.length : dim || 0,
        vector ? vectorToBuffer(vector) : null,
        t
      )
    })
    tx.prepare(
      `UPDATE documents SET chars = ?, chunk_count = ?, status = 'ready', stage = '已完成', progress = 100, error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(Math.max(0, Number(chars) || 0), (chunks || []).length, t, String(id))
  })
  return getDocument(id)
}

export function findDocumentByHash(workspaceId, hash) {
  const db = getDb()
  const row = db.prepare('SELECT id, name FROM documents WHERE workspace_id = ? AND hash = ?').get(workspaceId, hash)
  return row ? { id: row.id, name: row.name } : null
}

export function deleteDocument(id) {
  const db = getDb()
  return transaction((tx) => {
    const doc = tx.prepare('SELECT workspace_id FROM documents WHERE id = ?').get(id)
    if (!doc) return false
    tx.prepare('DELETE FROM chunks WHERE document_id = ?').run(id)
    tx.prepare('DELETE FROM documents WHERE id = ?').run(id)
    tx.prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(now(), doc.workspace_id)
    return true
  })
}

/**
 * 知识库总览。
 * `documents` 只算可用（ready）的，另外单独给出处理中与失败的数量——
 * 否则「文档 12 篇」里混着 5 篇失败的和 2 篇还在跑的，用户会以为检索坏了。
 */
export function documentStats() {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
         SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS working,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         COALESCE(SUM(CASE WHEN status = 'ready' THEN chunk_count ELSE 0 END), 0) AS chunks
       FROM documents`
    )
    .get()
  return {
    documents: row?.ready ?? 0,
    chunks: row?.chunks ?? 0,
    processing: row?.working ?? 0,
    failed: row?.failed ?? 0,
  }
}

/**
 * 关键词得分：查询词在块里出现的比例。
 * 没有分词器也能用——中文按 2 字滑窗、英文按空格切，够 hybrid 检索用了。
 */
function keywordScore(text, query) {
  const haystack = String(text || '').toLowerCase()
  if (!haystack) return 0
  const terms = new Set()
  const lowered = String(query || '').toLowerCase()

  for (const token of lowered.split(/[\s,，。、;；:：!！?？()（）\[\]{}"'“”‘’]+/)) {
    if (!token) continue
    if (/[\u4e00-\u9fff]/.test(token)) {
      // 中文：2 字滑窗，覆盖「向量数据库」→ 向量/量数/数据/据库
      if (token.length <= 2) terms.add(token)
      else for (let i = 0; i + 2 <= token.length; i += 1) terms.add(token.slice(i, i + 2))
    } else if (token.length >= 2) {
      terms.add(token)
    }
  }
  if (terms.size === 0) return 0

  let hit = 0
  for (const term of terms) if (haystack.includes(term)) hit += 1
  return hit / terms.size
}

/**
 * 查询里的「硬词」：型号、编号、缩写、长中文词。
 *
 * 注意**不能在 lowercase 之后判断**——`HNSW` 一旦被降成 `hnsw`，
 * 就再也分不出它是不是缩写了。所以按原始大小写切词、判断「硬不硬」，
 * 存进去时再统一转小写用于匹配。
 */
function hardPhrases(query) {
  const out = new Set()
  for (const raw of String(query || '').split(/[\s,，。、;；:：!！?？()（）\[\]{}"'“”‘’]+/)) {
    if (!raw) continue
    const token = raw.toLowerCase()
    // 型号 / 编号 / 版本号：a100、gpt-4o、v1.2、max_tokens
    if (/[0-9]/.test(token) && token.length >= 2) out.add(token)
    else if (/[_\-.]/.test(token) && token.length >= 3) out.add(token)
    // 全大写缩写（HNSW / SQL / GPU）与驼峰标识符（Float32Array）：
    // 这类词恰恰是向量检索最容易失手、而用户最在意的地方
    else if (/^[A-Za-z][A-Za-z0-9]*$/.test(raw) && raw.length >= 2 && /[A-Z]/.test(raw)) out.add(token)
    // 长中文词：整词命中比 2 字滑窗更有说服力
    else if (/[\u4e00-\u9fff]/.test(token) && token.length >= 3) out.add(token)
  }
  return [...out].slice(0, 8)
}

/** 硬词命中的比例：专有名词、型号靠这个救回来 */
function phraseScore(text, query) {
  const haystack = String(text || '').toLowerCase()
  const phrases = hardPhrases(query)
  if (phrases.length === 0) return 0
  let hit = 0
  for (const p of phrases) if (haystack.includes(p)) hit += 1
  return hit / phrases.length
}

/** 章节名命中的比例：块抬头写着「选型」，那问「怎么选」时它就该排前面 */
function headingScore(heading, query) {
  const h = String(heading || '').toLowerCase()
  if (!h) return 0
  const lowered = String(query || '').toLowerCase()
  let hit = 0
  let total = 0
  for (const token of lowered.split(/[\s,，。、;；:：!！?？()（）\[\]{}"'“”‘’]+/)) {
    if (!token) continue
    total += 1
    const pieces = /[\u4e00-\u9fff]/.test(token) && token.length > 2
      ? Array.from({ length: token.length - 1 }, (_, i) => token.slice(i, i + 2))
      : [token]
    if (pieces.some((p) => h.includes(p))) hit += 1
  }
  return total === 0 ? 0 : hit / total
}

const round3 = (n) => Math.round(n * 1000) / 1000

/**
 * 混合检索：向量 + 关键词 + 硬词 + 章节，再 MMR 去重。
 *
 * 为什么要这么多路信号：纯向量在「型号 / 编号 / 专有名词」上经常失手
 * （AnythingLLM #4338 就是这个抱怨），纯关键词又不懂语义。
 *
 * 为什么最后要 MMR：同一段话被切成 3 块时，纯按分数取 topK 会把 3 个位置
 * 全给这段内容，其他文档一句都进不来。MMR 在「相关性」和「和已选内容的差异度」
 * 之间折中，同样的预算能覆盖更多信息。
 *
 * @param {string} workspaceId
 * @param {Float32Array|null} queryVector 向量化失败时传 null，退化为纯关键词检索
 * @param {{ query?: string, topK?: number, minScore?: number, documentIds?: string[], lambda?: number, debug?: boolean }} options
 */
export function search(
  workspaceId,
  queryVector,
  { query = '', topK = 6, minScore = 0.12, documentIds = null, lambda = 0.72, debug = false } = {}
) {
  const db = getDb()
  const limit = Math.max(1, Math.min(20, topK))

  // 按文档过滤在 SQL 里做：命中少量文档时不必把整个库的向量读进内存
  const filterIds = Array.isArray(documentIds) && documentIds.length > 0 ? documentIds.map(String).slice(0, 200) : null
  const sql = filterIds
    ? `SELECT c.id, c.document_id, c.seq, c.heading, c.text, c.embedding, c.dim, d.name AS doc_name
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.workspace_id = ? AND c.document_id IN (${filterIds.map(() => '?').join(',')})`
    : `SELECT c.id, c.document_id, c.seq, c.heading, c.text, c.embedding, c.dim, d.name AS doc_name
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.workspace_id = ?`
  const rows = db.prepare(sql).all(workspaceId, ...(filterIds || []))

  if (rows.length === 0) {
    return debug ? { chunks: [], candidates: [], total: 0 } : []
  }

  // —— 第一遍：给所有块打分 ——
  const scored = []
  let dimMismatch = 0
  for (const row of rows) {
    let vec = row.embedding ? bufferToVector(row.embedding) : null
    // 维度与查询向量不符 = 老块是换 embedding 模型之前入的库。
    // cosine 对不上会静默返回 0，「语义检索悄悄失效」就是从这里来的——
    // 显式跳过并计数，调试视图里能看见原因；MMR 相似度也只在同维度向量间比较。
    if (vec && queryVector && vec.length !== queryVector.length) {
      dimMismatch += 1
      vec = null
    }
    const vecScore = vec && queryVector ? cosine(queryVector, vec) : 0
    const kwScore = keywordScore(row.text, query)
    const phScore = phraseScore(`${row.heading || ''} ${row.text}`, query)
    const hdScore = headingScore(row.heading, query)

    // 权重：语义为主，关键词与硬词用来救「向量差一点但精确命中」的块
    let score = vecScore * 0.62 + kwScore * 0.2 + phScore * 0.14 + hdScore * 0.04
    // 关键词大面积命中时给保底，避免整段照抄问句的块被埋掉
    if (kwScore > 0.6) score += 0.06
    // 完全没有语义分又没关键词命中，基本是噪声
    if (vecScore === 0 && kwScore === 0 && phScore === 0) score = 0

    scored.push({
      id: row.id,
      documentId: row.document_id,
      documentName: row.doc_name,
      seq: row.seq,
      heading: row.heading || undefined,
      text: row.text,
      _vec: vec,
      score,
      vectorScore: round3(vecScore),
      keywordScore: round3(kwScore),
      phraseScore: round3(phScore),
      headingScore: round3(hdScore),
    })
  }

  scored.sort((a, b) => b.score - a.score)
  const passed = scored.filter((c) => c.score >= minScore)

  // —— 第二遍：MMR 选 topK，避免同一段话的多个块占满名额 ——
  const picked = []
  const pool = passed.slice(0, Math.max(limit * 6, 30))
  while (picked.length < limit && pool.length > 0) {
    let bestIdx = 0
    let bestValue = -Infinity
    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i]
      let maxSim = 0
      for (const chosen of picked) {
        const sim = candidate._vec && chosen._vec ? cosine(candidate._vec, chosen._vec) : 0
        if (sim > maxSim) maxSim = sim
      }
      const value = lambda * candidate.score - (1 - lambda) * maxSim
      if (value > bestValue) {
        bestValue = value
        bestIdx = i
      }
    }
    picked.push(pool[bestIdx])
    pool.splice(bestIdx, 1)
  }

  const chunks = picked.map((c) => ({
    id: c.id,
    documentId: c.documentId,
    documentName: c.documentName,
    seq: c.seq,
    heading: c.heading,
    text: c.text,
    score: round3(c.score),
    vectorScore: c.vectorScore,
    keywordScore: c.keywordScore,
    phraseScore: c.phraseScore,
    headingScore: c.headingScore,
  }))

  if (!debug) return chunks

  // 调试视图：让人能回答「为什么这条没被召回 / 为什么那条排第一」
  const pickedIds = new Set(picked.map((c) => c.id))
  return {
    chunks,
    total: rows.length,
    passed: passed.length,
    // 大于 0 = 库里混着别的 embedding 模型的块，语义信号对这些块不生效
    dimMismatch,
    candidates: scored
      .slice(0, 40)
      .map((c) => ({
        id: c.id,
        documentName: c.documentName,
        seq: c.seq,
        heading: c.heading,
        preview: String(c.text).slice(0, 80),
        score: round3(c.score),
        vectorScore: c.vectorScore,
        keywordScore: c.keywordScore,
        phraseScore: c.phraseScore,
        headingScore: c.headingScore,
        belowThreshold: c.score < minScore,
        picked: pickedIds.has(c.id),
      })),
  }
}
