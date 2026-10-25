import crypto from 'node:crypto'
import { getDb } from './db.js'
import { getConversation } from './conversations.js'
import { badRequest, notFound } from '../lib/errors.js'

/**
 * 会话分享。
 *
 * 设计取舍：
 * - 存**快照**而不是引用会话。会话后续被编辑/删除，分享出去的页面不应该跟着变；
 *   这也是商业产品里「分享链接」的通常语义。
 * - 密码只存 scrypt 哈希（带盐），不存明文。
 * - 支持过期时间，过期后一律 410。
 */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  if (!stored) return true
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  const calc = crypto.scryptSync(String(password || ''), salt, 32).toString('hex')
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(calc, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function publicView(row, { includeMessages = true } = {}) {
  let payload = {}
  try {
    payload = JSON.parse(row.payload)
  } catch {
    payload = {}
  }
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    views: row.views,
    hasPassword: !!row.password_hash,
    model: payload.model || null,
    messages: includeMessages ? payload.messages || [] : [],
    messageCount: (payload.messages || []).length,
  }
}

/**
 * 创建分享。
 * @param {{conversationId?: string, snapshot?: object, title?: string, password?: string, expiresInDays?: number}} input
 * @param {{userId?: string|null}} opts 多用户模式下传入创建者 id，用于归属校验与列表隔离。
 *   传 conversationId 时会校验会话归属——不校验的话任何登录用户都能把别人的会话做成公开链接（IDOR）。
 */
export function createShare(input = {}, { userId = null } = {}) {
  const db = getDb()

  let snapshot = input.snapshot
  if (!snapshot) {
    if (!input.conversationId) throw badRequest('需要 conversationId 或 snapshot', 'missing_conversation')
    snapshot = getConversation(input.conversationId, { userId })
    if (!snapshot) throw notFound('要分享的会话不存在')
  }
  if (!Array.isArray(snapshot.messages)) throw badRequest('分享内容缺少 messages', 'invalid_snapshot')

  const id = crypto.randomBytes(10).toString('base64url')
  const now = Date.now()
  const days = Number(input.expiresInDays)
  const expiresAt = Number.isFinite(days) && days > 0 ? now + days * 86_400_000 : null
  const title = String(input.title || snapshot.title || '分享的对话').slice(0, 200)

  db.prepare(
    `INSERT INTO shares (id, conversation_id, user_id, title, payload, password_hash, views, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    input.conversationId ? String(input.conversationId) : snapshot.id || null,
    userId ? String(userId) : null,
    title,
    JSON.stringify({ model: snapshot.model, messages: snapshot.messages }),
    input.password ? hashPassword(input.password) : null,
    now,
    expiresAt
  )

  return { id, title, createdAt: now, expiresAt, hasPassword: !!input.password, url: `/s/${id}` }
}

/** 读取分享（公开接口）。过期 → 410，密码错 → 401 */
export function readShare(id, password) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(String(id))
  if (!row) throw notFound('分享不存在或已被取消')

  if (row.expires_at && Date.now() > row.expires_at) {
    const err = notFound('分享已过期')
    err.status = 410
    err.code = 'share_expired'
    throw err
  }
  if (!verifyPassword(password, row.password_hash)) {
    const err = badRequest('分享需要密码', 'share_password_required')
    err.status = 401
    throw err
  }

  db.prepare('UPDATE shares SET views = views + 1 WHERE id = ?').run(String(id))
  return publicView({ ...row, views: row.views + 1 })
}

/**
 * 只读取、不校验密码、不计数——给分享页的 meta 注入用。
 *
 * 密码保护的分享连 messages 都不返回：meta 生成逻辑虽然不会用，
 * 但「读出来再不用」和「根本不读」在安全上是两回事。
 */
export function peekShare(id) {
  const row = getDb().prepare('SELECT * FROM shares WHERE id = ?').get(String(id))
  if (!row) return null
  const expired = !!row.expires_at && Date.now() > row.expires_at
  return {
    ...publicView(row, { includeMessages: !row.password_hash }),
    expired,
  }
}

/**
 * 分享列表。传 `userId` 时只返回该用户创建的分享（多用户模式）；
 * 不传则返回全部（单用户模式 / 管理员）。
 * 老库里 user_id 为 NULL 的历史分享归「无主」：只对管理员与单用户可见，
 * 不属于任何普通用户——宁可看不见，也不越权。
 */
export function listShares({ limit = 50, userId = null } = {}) {
  const db = getDb()
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
  const rows = userId
    ? db
        .prepare('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(String(userId), safeLimit)
    : db
        .prepare('SELECT * FROM shares ORDER BY created_at DESC LIMIT ?')
        .all(safeLimit)
  return rows.map((row) => publicView(row, { includeMessages: false }))
}

/**
 * 取消分享。传 `userId` 时只能删自己创建的（admin 可以删任何人的）。
 * 返回 false 表示「不存在或无权删除」，路由层据此返回 404——不区分两种原因，防探测。
 */
export function deleteShare(id, { userId = null, isAdmin = false } = {}) {
  const db = getDb()
  if (userId && !isAdmin) {
    const row = db.prepare('SELECT user_id FROM shares WHERE id = ?').get(String(id))
    if (!row || row.user_id !== String(userId)) return false
  }
  const result = db.prepare('DELETE FROM shares WHERE id = ?').run(String(id))
  return (result?.changes ?? 0) > 0
}
