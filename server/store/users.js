import crypto from 'node:crypto'
import { getDb, transaction } from './db.js'
import { badRequest, notFound } from '../lib/errors.js'

/**
 * 用户与密码。
 *
 * 设计取舍：
 * - **默认单用户**：`MULTI_USER` 不开时这张表是空的，所有请求照旧不鉴权，
 *   老部署升级上来不会突然被登录页挡住。
 * - **密码用 scrypt**（Node 内置，零依赖），不引 bcrypt/argon2 —— 那两个都要编译原生模块，
 *   与「零原生依赖、单进程部署」的定位冲突。
 * - **第一个用户靠 setup 接口创建**，不预置 admin/admin 这种默认账号。
 *   有默认密码的自托管产品是安全事件的头号来源。
 */

const ROLES = new Set(['admin', 'user'])
const USERNAME_RE = /^[a-zA-Z0-9_.@-]{2,40}$/

/** scrypt 参数：N=16384 在普通机器上约 40ms，够挡住暴力破解又不至于让登录变慢 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

function now() {
  return Date.now()
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const derived = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const [, N, r, p, saltB64, hashB64] = parts
    const salt = Buffer.from(saltB64, 'base64')
    const expected = Buffer.from(hashB64, 'base64')
    const derived = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    })
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

function rowToUser(row) {
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || undefined,
    role: row.role === 'admin' ? 'admin' : 'user',
    disabled: !!row.disabled,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at || undefined,
  }
}

export function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM users').get()?.c || 0
}

export function listUsers() {
  return getDb()
    .prepare('SELECT * FROM users ORDER BY created_at ASC')
    .all()
    .map(rowToUser)
}

export function getUser(id) {
  return rowToUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(String(id)))
}

export function findUserByUsername(username) {
  return rowToUser(
    getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username))
  )
}

/** 内部用：要校验密码时必须拿 hash，所以单独一个函数，绝不通过 API 返回 */
function rowByUsername(username) {
  return getDb()
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(String(username))
}

function cleanUsername(username) {
  const name = String(username || '').trim()
  if (!USERNAME_RE.test(name)) {
    throw badRequest('用户名只能是 2–40 位的字母、数字或 _ . @ -', 'invalid_username')
  }
  return name
}

function cleanPassword(password) {
  const pwd = String(password || '')
  if (pwd.length < 8) throw badRequest('密码至少 8 位', 'weak_password')
  if (pwd.length > 200) throw badRequest('密码过长', 'invalid_password')
  return pwd
}

export function createUser({ username, password, role = 'user', displayName } = {}) {
  const db = getDb()
  const name = cleanUsername(username)
  const pwd = cleanPassword(password)
  if (findUserByUsername(name)) throw badRequest('用户名已存在', 'username_taken')
  if (!ROLES.has(role)) throw badRequest('角色只能是 admin 或 user', 'invalid_role')

  const id = `user-${crypto.randomBytes(6).toString('hex')}`
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).run(id, name, displayName ? String(displayName).slice(0, 60) : null, hashPassword(pwd), role, now())
  return getUser(id)
}

export function updateUser(id, patch = {}) {
  const db = getDb()
  const existing = getUser(id)
  if (!existing) throw notFound('用户不存在')

  const sets = []
  const params = []

  if (patch.displayName !== undefined) {
    sets.push('display_name = ?')
    params.push(patch.displayName ? String(patch.displayName).slice(0, 60) : null)
  }
  if (patch.role !== undefined) {
    if (!ROLES.has(patch.role)) throw badRequest('角色只能是 admin 或 user', 'invalid_role')
    // 不能把最后一个管理员降级，否则没人能再管理用户
    if (existing.role === 'admin' && patch.role !== 'admin' && countAdmins() <= 1) {
      throw badRequest('至少要保留一个管理员', 'last_admin')
    }
    sets.push('role = ?')
    params.push(patch.role)
  }
  if (patch.disabled !== undefined) {
    if (existing.role === 'admin' && patch.disabled && countAdmins() <= 1) {
      throw badRequest('至少要保留一个启用的管理员', 'last_admin')
    }
    sets.push('disabled = ?')
    params.push(patch.disabled ? 1 : 0)
  }
  if (patch.password !== undefined) {
    sets.push('password_hash = ?')
    params.push(hashPassword(cleanPassword(patch.password)))
  }

  if (sets.length === 0) return existing
  params.push(String(id))
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params)

  // 改密码 / 禁用 → 把该用户所有会话踢掉
  if (patch.password !== undefined || patch.disabled) revokeUserSessions(id)
  return getUser(id)
}

export function countAdmins() {
  return getDb().prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").get()?.c || 0
}

export function deleteUser(id) {
  const user = getUser(id)
  if (!user) throw notFound('用户不存在')
  if (user.role === 'admin' && countAdmins() <= 1) {
    throw badRequest('不能删除最后一个管理员', 'last_admin')
  }
  const db = getDb()
  const userId = String(id)
  // “彻底删除用户”必须同时清理其会话、文件夹和公开分享。
  // 只删 users 行会留下可继续访问的公开分享，以及无人可认领的会话数据。
  const conversationIds = db
    .prepare('SELECT id FROM conversations WHERE user_id = ?')
    .all(userId)
    .map((row) => row.id)

  transaction((tx) => {
    tx.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
    for (const conversationId of conversationIds) {
      tx.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversationId)
      tx.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
    }
    tx.prepare('DELETE FROM shares WHERE user_id = ?').run(userId)
    tx.prepare('DELETE FROM folders WHERE user_id = ?').run(userId)
    tx.prepare('DELETE FROM users WHERE id = ?').run(userId)
  })
  return true
}

/** 登录校验：成功返回用户，失败返回 null（不区分「用户不存在」和「密码错」，避免枚举账号） */
export function authenticate(username, password) {
  const row = rowByUsername(username)
  if (!row) {
    // 用户不存在时也算一次哈希，让耗时与密码错误一致
    verifyPassword(String(password || ''), hashPassword('dummy-password-for-timing'))
    return null
  }
  if (!verifyPassword(password, row.password_hash)) return null
  if (row.disabled) return null
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), row.id)
  return rowToUser({ ...row, last_login_at: now() })
}

export function changePassword(id, oldPassword, newPassword) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(String(id))
  if (!row) throw notFound('用户不存在')
  if (!verifyPassword(oldPassword, row.password_hash)) {
    throw badRequest('原密码不正确', 'wrong_password')
  }
  const pwd = cleanPassword(newPassword)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pwd), String(id))
  // 改密码等于「所有设备下线」：不踢会话的话，别人偷到的旧 cookie 还能继续用
  revokeUserSessions(id)
  return true
}

/* ——— 会话（登录态） ——— */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

/** 创建登录会话，返回明文 token（只在这一次返回，之后库里只有 hash） */
export function createSession(userId, { userAgent } = {}) {
  const token = crypto.randomBytes(32).toString('base64url')
  const t = now()
  getDb()
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(tokenHash(token), String(userId), t, t + SESSION_TTL_MS, t, userAgent ? String(userAgent).slice(0, 200) : null)
  return { token, expiresAt: t + SESSION_TTL_MS }
}

/** 用 token 查用户；过期或用户被禁用都视为无效 */
export function userBySession(token) {
  if (!token) return null
  const db = getDb()
  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash(token))
  if (!row) return null
  if (row.expires_at <= now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash)
    return null
  }
  if (row.disabled) return null

  // last_seen 每 10 分钟更新一次就够，别每个请求都写库
  if (now() - (row.last_seen_at || 0) > 10 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now(), row.token_hash)
  }
  return rowToUser(row)
}

export function revokeSession(token) {
  if (!token) return
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token))
}

export function revokeUserSessions(userId) {
  getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(String(userId))
}

/** 清理过期会话，启动时调一次即可 */
export function cleanupSessions() {
  try {
    return getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes
  } catch {
    return 0
  }
}

/* ——— 个人访问令牌（PAT） ——— */

/**
 * 给第三方客户端用的长期令牌。
 *
 * 为什么需要：多用户模式下 `/v1` 只认 cookie，而 Cherry Studio / Cursor / 各种 SDK
 * 没法走浏览器的登录流程。没有 PAT，开启多用户就等于把网关关掉了。
 *
 * 与登录会话的区别：
 * - 会话有 30 天有效期、跟着浏览器走；PAT 长期有效、可以随时单独吊销。
 * - 一个用户同时只有一个 PAT（够用，也避免「到底哪个 token 在泄漏」说不清）。
 * - 同样只存 sha256。
 */
export function issueApiToken(userId) {
  const db = getDb()
  const user = getUser(userId)
  if (!user) throw notFound('用户不存在')
  // `fcp_` 前缀：万一 token 被贴到公开仓库，secret scanning 能认出来
  const token = `fcp_${crypto.randomBytes(32).toString('base64url')}`
  db.prepare('UPDATE users SET api_token_hash = ? WHERE id = ?').run(
    crypto.createHash('sha256').update(token).digest('hex'),
    String(userId)
  )
  // 明文只在这里返回一次，之后库里只有 hash
  return { token, createdAt: now() }
}

export function revokeApiToken(userId) {
  getDb().prepare('UPDATE users SET api_token_hash = NULL WHERE id = ?').run(String(userId))
  return true
}

export function hasApiToken(userId) {
  const row = getDb().prepare('SELECT api_token_hash FROM users WHERE id = ?').get(String(userId))
  return !!row?.api_token_hash
}

/** 用 PAT 反查用户；被禁用的用户令牌同样失效 */
export function userByApiToken(token) {
  const raw = String(token || '').trim()
  if (!raw) return null
  const row = getDb()
    .prepare('SELECT * FROM users WHERE api_token_hash = ?')
    .get(crypto.createHash('sha256').update(raw).digest('hex'))
  if (!row) return null
  if (row.disabled) return null
  return rowToUser(row)
}

/**
 * 首次部署把「无主会话」认领给第一个管理员。
 *
 * 不开多用户时建的会话 `user_id` 是 NULL，开了之后如果不认领，
 * 用户会以为自己的历史全丢了。这个函数只在创建第一个管理员时调用一次。
 */
export function claimOwnerlessConversations(userId) {
  try {
    return getDb()
      .prepare('UPDATE conversations SET user_id = ? WHERE user_id IS NULL')
      .run(String(userId)).changes
  } catch {
    return 0
  }
}
