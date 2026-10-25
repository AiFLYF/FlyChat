import { Router } from 'express'
import { asyncHandler, badRequest, notFound, unavailable } from '../lib/errors.js'
import { storageStatus } from '../store/db.js'
import { inc } from '../lib/metrics.js'
import {
  DEFAULT_WORKSPACE_ID,
  createWorkspace,
  deleteDocument,
  deleteWorkspace,
  documentStats,
  getDocument,
  listDocuments,
  listWorkspaces,
} from '../rag/store.js'
import { pendingCount, removeUpload, retryDocument } from '../rag/jobs.js'
import { retrieve, submitDocument, toSources } from '../rag/index.js'
import { resolveEmbeddingProvider, defaultEmbeddingModel } from '../rag/embeddings.js'
import { inspectBaseUrl } from '../lib/ssrf.js'

const router = Router()

/** 只拦知识库自己的路径：放在 router.use 顶层会误伤同挂载点下的其它路由 */
const requireStorage = (req, _res, next) => {
  if (!storageStatus().available) {
    return next(unavailable('服务端持久化不可用，知识库功能不可用', 'storage_unavailable'))
  }
  next()
}

/** 知识库总览：是否可用、用哪个模型做向量化、有多少文档 */
router.get('/knowledge/status', requireStorage, (_req, res) => {
  const provider = resolveEmbeddingProvider()
  res.json({
    enabled: !!provider,
    embedding: provider
      ? { provider: provider.id, name: provider.name, model: defaultEmbeddingModel(provider) }
      : null,
    ...documentStats(),
    workspaces: listWorkspaces().length,
    pending: pendingCount(),
  })
})

router.get('/workspaces', requireStorage, (_req, res) => {
  res.json({ items: listWorkspaces(), defaultId: DEFAULT_WORKSPACE_ID })
})

router.post('/workspaces', requireStorage, (req, res) => {
  const ws = createWorkspace(req.body?.name)
  inc('workspace_created_total')
  res.status(201).json(ws)
})

router.delete('/workspaces/:id', requireStorage, (req, res) => {
  res.json({ ok: deleteWorkspace(req.params.id) })
})

router.get('/documents', requireStorage, (req, res) => {
  const workspaceId = String(req.query.workspaceId || DEFAULT_WORKSPACE_ID)
  res.json({ items: listDocuments(workspaceId), workspaceId })
})

/**
 * 上传文档：立即返回 202，后台流水线逐步解析/切块/向量化。
 * 进度通过 `GET /api/documents/:id` 轮询（status / stage / progress）。
 *
 * 三种来源任选其一：
 * - `dataUrl`：文件（base64），与附件一致
 * - `text`：直接粘贴的文本
 * - `url`：网页链接，后台会抓取并抽取正文（走 SSRF 校验，逐跳校验重定向）
 */
router.post('/documents', requireStorage, (req, res, next) => {
  const { workspaceId = DEFAULT_WORKSPACE_ID, name, mime, dataUrl, text, url } = req.body || {}
  if (!dataUrl && !text && !url) {
    return next(badRequest('缺少 dataUrl、text 或 url', 'missing_document'))
  }
  // 传 url 时文档名可以由服务端从链接推出来，不强制要求
  if (!name && !url) return next(badRequest('缺少文档名', 'missing_name'))

  // URL 先做同步结构校验：明显不合法的直接 400，
  // 别让它变成一条「排队半天然后失败」的记录（DNS 校验在后台抓取时再做）
  if (url) {
    const inspected = inspectBaseUrl(url)
    if (!inspected.ok) return next(badRequest(inspected.reason, 'unsafe_url'))
  }

  try {
    const result = submitDocument({ workspaceId, name, mime, dataUrl, text, url, size: req.body?.size })
    if (result.duplicate) {
      inc('document_ingested_total', { duplicate: 'true' })
      return res.status(200).json({ ok: true, ...result })
    }
    inc('document_ingested_total', { duplicate: 'false' })
    // 202：已接受，但还没处理完
    return res.status(202).json({
      ok: true,
      id: result.id,
      name: result.name,
      status: 'pending',
      stage: '已入队',
      progress: 0,
      queueLength: pendingCount(),
    })
  } catch (err) {
    next(badRequest(err?.message || '提交失败', 'submit_failed'))
  }
})

/** 单个文档的处理进度（前端轮询用） */
router.get('/documents/:id', requireStorage, (req, res, next) => {
  const doc = getDocument(req.params.id)
  if (!doc) return next(notFound('文档不存在'))
  res.json(doc)
})

/** 失败重试：源文件还留着，重新入队即可 */
router.post('/documents/:id/retry', requireStorage, (req, res, next) => {
  const result = retryDocument(req.params.id)
  if (!result.ok) return next(badRequest(result.error, 'retry_failed'))
  res.json({ ok: true })
})

router.delete('/documents/:id', requireStorage, (req, res) => {
  const ok = deleteDocument(req.params.id)
  // 行删没删掉都顺手清掉临时文件
  removeUpload(req.params.id)
  res.json({ ok })
})

/** 单独检索：前端做「搜索知识库」或调试检索质量时用 */
router.post(
  '/retrieve',
  requireStorage,
  asyncHandler(async (req, res) => {
    const {
      workspaceId = DEFAULT_WORKSPACE_ID,
      query,
      topK = 6,
      documentIds,
      minScore,
      debug,
    } = req.body || {}
    if (!String(query || '').trim()) throw badRequest('缺少 query', 'missing_query')

    const result = await retrieve({
      workspaceId,
      query,
      topK,
      documentIds: Array.isArray(documentIds) ? documentIds : null,
      minScore: Number.isFinite(Number(minScore)) ? Number(minScore) : undefined,
      // 调试模式要显式传 true：默认多返回一堆分数明细没意义，还容易泄露正文
      debug: debug === true,
    })

    res.json({
      query,
      count: result.chunks.length,
      chunks: result.chunks,
      sources: toSources(result.chunks),
      timings: result.timings,
      // 只在 debug:true 时出现：每条候选的分数构成，用来回答「为什么这条没召回」
      debug: result.debug,
    })
  })
)

export default router
