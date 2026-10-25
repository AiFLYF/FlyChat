import { Router } from 'express'
import { asyncHandler, badRequest, unavailable } from '../lib/errors.js'
import { storageStatus } from '../store/db.js'
import { createShare, deleteShare, listShares, readShare } from '../store/shares.js'
import { currentUserId } from '../lib/auth.js'
import { inc } from '../lib/metrics.js'

const router = Router()

/** 存储不可用时给明确原因（作为中间件使用，必须调 next 或抛错） */
const requireStorage = (req, _res, next) => {
  if (!storageStatus().available) {
    return next(unavailable('服务端持久化不可用（需要 Node 22.5+ 内置 SQLite）', 'storage_unavailable'))
  }
  next()
}

/**
 * 创建分享链接。
 * body: { conversationId?, snapshot?, title?, password?, expiresInDays? }
 * 传 snapshot 可以直接分享还没存到服务端的本地会话（前端离线优先场景）。
 */
router.post(
  '/share',
  requireStorage,
  asyncHandler(async (req, res) => {
    // 传入创建者 id：按 conversationId 分享时服务端会校验会话归属（防跨用户 IDOR）
    const share = createShare(req.body || {}, { userId: currentUserId(req) })
    inc('share_created_total')
    res.status(201).json(share)
  })
)

/** 公开读取：不需要访问令牌，但可以设置密码 */
router.get(
  '/share/:id',
  requireStorage,
  asyncHandler(async (req, res) => {
    const password = req.query.password || req.get('x-share-password') || ''
    const data = readShare(req.params.id, password)
    // 分享页是公开内容，允许被任意站点嵌入/抓取
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.json(data)
  })
)

router.get(
  '/shares',
  requireStorage,
  asyncHandler(async (req, res) => {
    // 多用户模式下普通用户只看到自己创建的分享；管理员看全部（含老数据里的无主分享）
    const userId = currentUserId(req)
    const isAdmin = userId && req.user?.role === 'admin'
    res.json({ items: listShares({ userId: isAdmin ? null : userId }) })
  })
)

router.delete(
  '/share/:id',
  requireStorage,
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const ok = deleteShare(req.params.id, { userId, isAdmin: !!userId && req.user?.role === 'admin' })
    if (!ok) return res.status(404).json({ error: '分享不存在或无权删除' })
    res.json({ ok: true })
  })
)

export default router
