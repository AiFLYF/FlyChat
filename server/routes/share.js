import { Router } from 'express'
import { AppError, asyncHandler, unavailable } from '../lib/errors.js'
import { storageStatus } from '../store/db.js'
import { createShare, deleteShare, listShares, readShare } from '../store/shares.js'
import { currentUserId } from '../lib/auth.js'
import { inc } from '../lib/metrics.js'

const router = Router()

/**
 * 公开分享页的密码尝试限流。
 *
 * 分享 id 是公开可枚举的（链接本身要发给别人），密码校验又是高成本的 scrypt；
 * 没有限流时，一个脚本就能把「猜密码」和「拖慢事件循环」同时做了。
 * 按 IP + 分享 id 计数，成功一次即清零，避免误伤正常用户。
 */
const passwordFailures = new Map()
const MAX_PASSWORD_FAILURES = 8
const PASSWORD_LOCKOUT_MS = 10 * 60 * 1000
const PASSWORD_FAILURE_CAP = 2000

function passwordKey(req) {
  return `${req.ip || 'unknown'}:${req.params.id}`
}

function checkPasswordLockout(key) {
  const record = passwordFailures.get(key)
  if (!record) return
  if (Date.now() - record.firstFailedAt > PASSWORD_LOCKOUT_MS) {
    passwordFailures.delete(key)
    return
  }
  if (record.count >= MAX_PASSWORD_FAILURES) {
    const remainingSec = Math.ceil((PASSWORD_LOCKOUT_MS - (Date.now() - record.firstFailedAt)) / 1000)
    throw new AppError(`密码尝试次数过多，请在 ${remainingSec} 秒后再试`, {
      status: 429,
      code: 'share_locked_out',
    })
  }
}

function recordPasswordFailure(key) {
  const now = Date.now()
  const record = passwordFailures.get(key)
  if (!record || now - record.firstFailedAt > PASSWORD_LOCKOUT_MS) {
    // 大量随机 id 不能把内存撑爆：过期项优先清，仍然超限就整表丢弃（只是重置计数）
    if (passwordFailures.size >= PASSWORD_FAILURE_CAP) {
      for (const [k, v] of passwordFailures) {
        if (now - v.firstFailedAt > PASSWORD_LOCKOUT_MS) passwordFailures.delete(k)
      }
      if (passwordFailures.size >= PASSWORD_FAILURE_CAP) passwordFailures.clear()
    }
    passwordFailures.set(key, { count: 1, firstFailedAt: now })
  } else {
    record.count += 1
  }
}

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
    const key = passwordKey(req)
    checkPasswordLockout(key)
    const password = req.query.password || req.get('x-share-password') || ''
    let data
    try {
      data = readShare(req.params.id, password)
    } catch (err) {
      if (err?.status === 401) recordPasswordFailure(key)
      throw err
    }
    passwordFailures.delete(key)
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
