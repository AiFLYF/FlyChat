import { Router } from 'express'
import { badRequest, notFound, unavailable } from '../lib/errors.js'
import { storageStatus } from '../store/db.js'
import {
  deleteAllConversations,
  deleteConversation,
  exportMarkdown,
  getConversation,
  listConversations,
  saveMessages,
  upsertConversation,
  updateConversation,
} from '../store/conversations.js'
import { inc } from '../lib/metrics.js'
import { currentUserId, requireAdmin } from '../lib/auth.js'
import { claimOwnerlessConversations } from '../store/users.js'
import { cleanTags, getFolder } from '../store/folders.js'

const router = Router()

/** 存储不可用时给出明确原因，而不是 500 */
router.use((_req, _res, next) => {
  if (!storageStatus().available) {
    return next(unavailable('服务端持久化不可用（需要 Node 22.5+ 内置 SQLite），聊天功能不受影响', 'storage_unavailable'))
  }
  next()
})

/** 列表：默认不带消息体，避免一次拉几百 KB。多用户模式只返回自己的 */
router.get('/conversations', (req, res) => {
  const { limit, offset, q, folderId, tag, unfiled } = req.query
  res.json(
    listConversations({
      limit,
      offset,
      q,
      userId: currentUserId(req),
      // 注意：`folderId` 不传 → 不按文件夹过滤；传空串 → 只看未分类
      folderId: folderId === undefined ? undefined : String(folderId),
      tag: tag ? String(tag) : '',
      unfiled: unfiled === '1' || unfiled === 'true',
    })
  )
})

router.post('/conversations', (req, res, next) => {
  try {
    // 归属由服务端盖，不信任请求体里的 userId（否则可以伪造别人的会话）
    const body = { ...(req.body || {}), userId: currentUserId(req) }
    if (body.tags !== undefined) body.tags = cleanTags(body.tags)
    const conv = upsertConversation(body)
    inc('conversation_saved_total')
    res.status(201).json(conv)
  } catch (err) {
    next(err.status ? err : badRequest(err?.message || '保存失败'))
  }
})

router.get('/conversations/:id', (req, res, next) => {
  const conv = getConversation(req.params.id, { userId: currentUserId(req) })
  if (!conv) return next(notFound('会话不存在'))
  res.json(conv)
})

/** 更新会话属性。PATCH 与 PUT 等价（前端两种习惯都有） */
function updateHandler(req, res, next) {
  try {
    const userId = currentUserId(req)
    const patch = { ...(req.body || {}) }
    // 标签在入口统一清洗：去空白、去重、限长、限数量
    if (patch.tags !== undefined) patch.tags = cleanTags(patch.tags)
    // 只能放进自己建的文件夹
    if (patch.folderId) {
      if (!getFolder(patch.folderId, { userId })) {
        return next(badRequest('文件夹不存在', 'folder_not_found'))
      }
    }
    res.json(updateConversation(req.params.id, patch, { userId }))
  } catch (err) {
    next(err.status ? err : badRequest(err?.message || '更新失败'))
  }
}
router.patch('/conversations/:id', updateHandler)
router.put('/conversations/:id', updateHandler)

router.delete('/conversations/:id', (req, res) => {
  const ok = deleteConversation(req.params.id, { userId: currentUserId(req) })
  res.json({ ok, deleted: ok ? 1 : 0 })
})

/** 清空全部会话：要求 body.confirm === 'DELETE'，避免误触 */
router.delete('/conversations', (req, res, next) => {
  if (req.body?.confirm !== 'DELETE') {
    return next(badRequest('需要 confirm: "DELETE" 才允许清空全部会话', 'confirm_required'))
  }
  const n = deleteAllConversations({ userId: currentUserId(req) })
  res.json({ ok: true, deleted: n })
})

/** 批量写入 / 覆盖消息（前端全量同步或增量追加都走这里） */
router.put('/conversations/:id/messages', (req, res, next) => {
  const { messages, replace } = req.body || {}
  if (!Array.isArray(messages)) return next(badRequest('messages 必须是数组', 'invalid_messages'))
  // 先确认会话存在且属于自己，否则等于给了「往别人会话里塞消息」的口子
  const userId = currentUserId(req)
  if (userId && !getConversation(req.params.id, { userId })) return next(notFound('会话不存在'))
  const result = saveMessages(req.params.id, messages, { replace: !!replace })
  res.json({ ok: true, ...result })
})

/** 导出：Markdown 便于粘贴/归档，JSON 便于迁移 */
router.get('/conversations/:id/export', (req, res, next) => {
  const format = String(req.query.format || 'md').toLowerCase()
  if (format === 'json') {
    const conv = getConversation(req.params.id, { userId: currentUserId(req) })
    if (!conv) return next(notFound('会话不存在'))
    res.setHeader('Content-Disposition', `attachment; filename="flychat-${conv.id}.json"`)
    return res.json(conv)
  }
  if (format !== 'md' && format !== 'markdown') {
    return next(badRequest('format 只支持 md 或 json', 'invalid_format'))
  }
  const md = exportMarkdown(req.params.id, { userId: currentUserId(req) })
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="flychat-${req.params.id}.md"`)
  res.send(md)
})

/**
 * 全量导出：把整个实例的会话打包成一个 JSON。
 * 「数据是我的」是自托管产品的底线能力，也方便换机/迁移到别的实例。
 */
router.get('/export', (req, res) => {
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 500))
  const userId = currentUserId(req)
  const { items } = listConversations({ limit, offset: 0, userId })
  const conversations = items
    .map((c) => getConversation(c.id, { userId }))
    .filter(Boolean)

  const payload = {
    format: 'flychat-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: conversations.length,
    conversations,
  }
  res.setHeader('Content-Disposition', `attachment; filename="flychat-export-${Date.now()}.json"`)
  res.json(payload)
})

/**
 * 导入：接受 /api/export 的产物。
 * mode=merge（默认）按 id 覆盖同 id 会话；mode=replace 需要 confirm:"REPLACE"，会先清空。
 */
router.post('/import', (req, res, next) => {
  const body = req.body || {}
  const conversations = Array.isArray(body.conversations)
    ? body.conversations
    : Array.isArray(body)
      ? body
      : null
  if (!conversations) return next(badRequest('缺少 conversations 数组', 'invalid_import'))
  if (conversations.length > 1000) return next(badRequest('单次最多导入 1000 个会话', 'too_many_conversations'))

  const mode = body.mode === 'replace' ? 'replace' : 'merge'
  if (mode === 'replace' && body.confirm !== 'REPLACE') {
    return next(badRequest('replace 模式需要 confirm: "REPLACE"', 'confirm_required'))
  }

  if (mode === 'replace') deleteAllConversations({ userId: currentUserId(req) })

  let imported = 0
  const failed = []
  for (const conv of conversations) {
    try {
      if (!conv || typeof conv !== 'object' || !conv.id) throw new Error('缺少 id')
      // 导入的会话一律归当前用户，忽略文件里的 userId（避免把别人的数据导成自己的）
      upsertConversation({ ...conv, userId: currentUserId(req) })
      imported += 1
    } catch (err) {
      failed.push({ id: conv?.id || null, error: err?.message || '导入失败' })
    }
  }

  res.json({ ok: failed.length === 0, mode, imported, failed })
})

/**
 * 把「没有归属」的历史会话认领给当前管理员。
 *
 * 只有多用户模式才需要：从单用户升级上来时，老会话的 user_id 是 NULL，
 * 严格归属校验会让它们对所有人都不可见。setup 时已自动认领一次，
 * 这个接口用于「后来又出现无主会话」的情况（比如中途关掉过多用户模式）。
 */
router.post('/conversations/claim-orphans', requireAdmin, (req, res) => {
  const claimed = claimOwnerlessConversations(req.user.id)
  res.json({ ok: true, claimed })
})

export default router
