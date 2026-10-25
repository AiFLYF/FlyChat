import crypto from 'node:crypto'
import {
  DEFAULT_WORKSPACE_ID,
  createDocument,
  deleteDocument,
  findDocumentByHash,
  search as searchChunks,
  updateDocumentStatus,
} from './store.js'
import { saveUpload, saveUploadText, enqueueDocument } from './jobs.js'
import { embedTexts } from './embeddings.js'

/**
 * 知识库主流程：解析 → 切块 → 向量化 → 入库。
 * 检索时反向：查询向量化 → 混合检索 → 拼上下文。
 *
 * 注意：真正的解析/切块/向量化在 `jobs.js` 的后台流水线里，
 * 这里只负责「提交」（落盘 + 入队）与「检索」。
 */

/**
 * 提交一篇文档（异步）。
 * 只做「建行 + 源文件落盘 + 入队」三件事，立即返回，不解析不向量化——
 * 真正的重活在后台 worker 里跑，进度写回 documents 表。
 */
export function submitDocument(input) {
  const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID
  const url = input.url ? String(input.url).trim() : ''

  let name = String(input.name || '').slice(0, 200)
  let size = 0
  let hashSource = null

  if (url) {
    // 网页入库：内容在抓取时才知道，所以按 URL 判重（同一个链接不重复入库）
    hashSource = `url:${url}`
    if (!name) {
      try {
        const u = new URL(url)
        name = `${u.hostname}${u.pathname}`.slice(0, 200)
      } catch {
        name = url.slice(0, 200)
      }
    }
  } else if (input.text != null && input.text !== '') {
    hashSource = String(input.text)
    if (!name) name = '粘贴的文本'
  } else if (input.dataUrl) {
    // 必须对完整内容做哈希：只取前缀的话，两份不同的 PDF
    // 因为文件头（%PDF-1.x 与同样的字体表）相同会被误判成重复上传。
    hashSource = String(input.dataUrl)
  } else {
    throw new Error('缺少 dataUrl、text 或 url')
  }
  const hash = crypto.createHash('sha256').update(hashSource).digest('hex').slice(0, 32)

  const existing = findDocumentByHash(workspaceId, hash)
  if (existing) {
    return { duplicate: true, documentId: existing.id, name: existing.name }
  }

  const { id } = createDocument({
    workspaceId,
    name: name || '未命名文档',
    mime: url ? 'text/html' : input.mime,
    size: Number(input.size) || 0,
    hash,
    sourceUrl: url || undefined,
  })

  // 落盘失败必须把刚建的行删掉：
  // 否则会留下一条永远 pending 的记录，而且它的 hash 已经占位，
  // 用户改成正确的文件重传也会被判成「重复上传」。
  if (!url) {
    try {
      if (input.text != null && input.text !== '') {
        size = saveUploadText(id, input.text)
      } else {
        size = saveUpload(id, input.dataUrl)
      }
    } catch (err) {
      deleteDocument(id)
      throw err
    }
    updateDocumentStatus(id, { size })
  }

  enqueueDocument(id)
  return { id, workspaceId, name, size, queued: true, duplicate: false, sourceUrl: url || undefined }
}

/**
 * 检索。
 * @returns {{chunks: any[], context: string}}
 */
/**
 * 检索。
 *
 * @param {object} options
 * @param {string[]} [options.documentIds] 只在这些文档里检索（前端做「限定范围提问」用）
 * @param {boolean} [options.debug] 返回每条候选的分数明细，用于调参/排查「为什么搜不到」
 */
export async function retrieve({
  workspaceId = DEFAULT_WORKSPACE_ID,
  query,
  topK = 6,
  signal,
  minScore,
  documentIds = null,
  debug = false,
} = {}) {
  const q = String(query || '').trim()
  if (!q) return { chunks: [], context: '', timings: { totalMs: 0 } }

  const startedAt = Date.now()
  let queryVector = null
  let embedMs = 0
  try {
    const t = Date.now()
    const { vectors } = await embedTexts([q], { signal })
    queryVector = vectors[0] || null
    embedMs = Date.now() - t
  } catch {
    // 向量化不可用时退回纯关键词检索，至少还能用
    queryVector = null
  }

  const searchStarted = Date.now()
  const outcome = searchChunks(workspaceId, queryVector, { query: q, topK, minScore, documentIds, debug })
  const searchMs = Date.now() - searchStarted

  // debug 时 search 返回 { chunks, candidates, total, passed }；否则直接是数组
  const chunks = Array.isArray(outcome) ? outcome : outcome.chunks
  const result = {
    chunks,
    context: buildContextBlock(chunks),
    timings: { embedMs, searchMs, totalMs: Date.now() - startedAt },
  }
  if (debug && !Array.isArray(outcome)) {
    result.debug = {
      totalChunks: outcome.total,
      passedThreshold: outcome.passed,
      candidates: outcome.candidates,
      // 向量化失败时会退化成纯关键词，这个标记让排查时一眼看出原因
      vectorUsed: !!queryVector,
    }
  }
  return result
}

/** 把检索结果拼成注入 system 的上下文块 */
export function buildContextBlock(chunks) {
  if (!chunks?.length) return ''
  const lines = chunks.map(
    (c, i) =>
      `[资料 ${i + 1}] 来源：《${c.documentName}》${c.heading ? ` · ${c.heading}` : ''}\n${c.text}`
  )
  return [
    '以下是从用户知识库检索到的资料。请优先依据这些资料回答，并在引用处标注 [资料 N]；',
    '如果资料里没有答案，请明确说明「知识库中没有找到相关内容」，不要编造。',
    '',
    ...lines,
  ].join('\n')
}

/** 转成前端展示用的来源列表 */
export function toSources(chunks) {
  return (chunks || []).map((c, i) => ({
    index: i + 1,
    title: `${c.documentName}${c.heading ? ` · ${c.heading}` : ''}`,
    documentId: c.documentId,
    documentName: c.documentName,
    heading: c.heading || null,
    snippet: String(c.text || '').slice(0, 200),
    score: c.score,
  }))
}
