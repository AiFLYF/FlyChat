import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { extractText, extractUrl } from '../extract.js'
import { chunkText, decorateChunk } from './chunk.js'
import { embedTexts } from './embeddings.js'
import { documentRow, saveDocumentResult, updateDocumentStatus } from './store.js'
import { logger } from '../lib/logger.js'

/**
 * 文档入库流水线（异步）。
 *
 * 原来的问题是：上传接口同步做完「解析 → 切块 → 向量化 → 入库」，
 * 一个 20MB 的 PDF 能把 HTTP 请求挂住一分钟以上，用户既看不到进度也没法取消。
 * 现在改成：接口只负责落盘并入队（202），后台 worker 逐步推进并更新进度。
 *
 * 设计要点：
 * - **源文件落盘**到 `server/data/uploads/<docId>`：失败可重试，进程重启也不丢任务
 * - **并发受控**（默认 2）：不会一下把 embedding 配额打满
 * - **失败保留现场**：状态写 failed + error + attempts + 1，用户点「重试」即可
 * - **成功清临时文件**
 */

const MAX_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.INGEST_CONCURRENCY) || 2))
const MAX_DOC_CHARS = 400_000
const MAX_CHUNKS = 400

function uploadDir() {
  return path.join(config.storage.dataDir, 'uploads')
}

export function uploadPath(docId) {
  return path.join(uploadDir(), String(docId))
}

/** 把前端传来的 dataUrl 落盘 */
export function saveUpload(docId, dataUrl) {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const buffer = Buffer.from(b64, 'base64')
  if (buffer.length === 0) throw new Error('文件内容为空')
  if (buffer.length > config.limits.bodyBytes) {
    throw new Error(`文件过大（上限 ${Math.round(config.limits.bodyBytes / 1024 / 1024)}MB）`)
  }
  fs.mkdirSync(uploadDir(), { recursive: true })
  fs.writeFileSync(uploadPath(docId), buffer)
  return buffer.length
}

export function saveUploadText(docId, text) {
  fs.mkdirSync(uploadDir(), { recursive: true })
  fs.writeFileSync(uploadPath(docId), String(text), 'utf8')
  return Buffer.byteLength(String(text))
}

export function removeUpload(docId) {
  try {
    fs.unlinkSync(uploadPath(docId))
    return true
  } catch {
    return false
  }
}

const queue = []
const running = new Set()

export function pendingCount() {
  return queue.length + running.size
}

export function enqueueDocument(docId) {
  if (!queue.includes(docId) && !running.has(docId)) queue.push(docId)
  setImmediate(drain)
  return { queued: true, position: queue.length }
}

function drain() {
  while (running.size < MAX_CONCURRENCY && queue.length > 0) {
    const docId = queue.shift()
    running.add(docId)
    processDocument(docId)
      .catch((err) => logger.error('文档处理任务异常', { docId, message: err?.message }))
      .finally(() => {
        running.delete(docId)
        if (queue.length > 0) drain()
      })
  }
}

/**
 * 处理一篇文档：解析 → 切块 → 向量化 → 入库。
 * 导出来是为了测试可以直接调用，不依赖队列时序。
 */
export async function processDocument(docId) {
  const row = documentRow(docId)
  if (!row) return { ok: false, error: '文档不存在' }
  if (row.status === 'ready') return { ok: true, skipped: true }

  const attempts = (row.attempts || 0) + 1
  updateDocumentStatus(docId, { status: 'processing', stage: '解析文件', progress: 5, attempts })

  try {
    let extracted
    if (row.source_url) {
      // 网页入库：抓取与解析都在这里做，失败可重试（URL 存着，随时能再抓）
      updateDocumentStatus(docId, { stage: '抓取网页', progress: 15 })
      extracted = await extractUrl(row.source_url)
    } else {
      const file = uploadPath(docId)
      if (!fs.existsSync(file)) throw new Error('源文件已丢失，请重新上传')
      const buffer = fs.readFileSync(file)

      updateDocumentStatus(docId, { stage: '解析文件', progress: 15 })
      extracted = await extractText({ name: row.name, mime: row.mime, buffer })
    }

    let text = String(extracted.text || '').trim()
    if (!text) throw new Error('文档没有可用文本（可能是扫描版 PDF 或空文件）')
    if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS)

    updateDocumentStatus(docId, { stage: '切块', progress: 30 })
    const chunks = chunkText(text).slice(0, MAX_CHUNKS)
    if (chunks.length === 0) throw new Error('文档切块后为空')

    updateDocumentStatus(docId, { stage: '向量化', progress: 45 })
    const payloads = chunks.map((c) => decorateChunk(c, row.name))
    const { vectors, dim, model } = await embedTexts(payloads)

    updateDocumentStatus(docId, { stage: '写入数据库', progress: 90 })
    saveDocumentResult(docId, { chunks, vectors, dim, chars: text.length })

    removeUpload(docId)
    logger.info('文档入库完成', { docId, name: row.name, chunks: chunks.length, model, attempts })
    return { ok: true, docId, chunkCount: chunks.length }
  } catch (err) {
    const message = err?.message || String(err)
    updateDocumentStatus(docId, { status: 'failed', stage: '失败', error: message })
    logger.warn('文档入库失败', { docId, name: row.name, message, attempts })
    return { ok: false, error: message }
  }
}

/** 重试：清掉错误状态重新入队 */
export function retryDocument(docId) {
  const row = documentRow(docId)
  if (!row) return { ok: false, error: '文档不存在' }
  if (row.status !== 'failed' && row.status !== 'pending') {
    return { ok: false, error: `当前状态 ${row.status} 不能重试` }
  }
  updateDocumentStatus(docId, { status: 'pending', stage: '已重新入队', progress: 0, error: null })
  enqueueDocument(docId)
  return { ok: true }
}

/**
 * 进程启动时调用：把上次中断的任务复位。
 * 不留「永远卡在 processing」的行——那种状态用户点不了重试，也看不懂。
 */
export async function resetStaleJobs() {
  try {
    const { getDb } = await import('../store/db.js')
    getDb()
      .prepare(
        `UPDATE documents SET status = 'failed', error = COALESCE(error, '服务重启导致任务中断，请点击重试'),
           stage = '中断', progress = 0
         WHERE status IN ('processing', 'pending')`
      )
      .run()
  } catch {
    // 数据库还没初始化，什么都不做
  }
}
