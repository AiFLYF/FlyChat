import { AppError } from './errors.js'
import { userByApiToken, userBySession } from '../store/users.js'

/**
 * 登录态与鉴权中间件。
 *
 * 不引 cookie-parser：我们只需要读一个 cookie、写一个 cookie，
 * 自己解析比多一个依赖划算（也和项目「零多余依赖」的定位一致）。
 */

export const SESSION_COOKIE = 'flychat_session'

/** 从 Cookie 头里取一个值 */
export function readCookie(req, name) {
  const raw = req.headers?.cookie
  if (!raw) return ''
  for (const part of String(raw).split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim())
    }
  }
  return ''
}

/**
 * 构造 Set-Cookie。
 * HttpOnly 防 XSS 读取；SameSite=Lax 让普通链接跳转也能带上，
 * 同时挡掉跨站 POST（CSRF 的基本防线）。
 */
export function sessionCookie(token, { maxAgeMs, secure } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (maxAgeMs) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`)
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** 取 `Authorization: Bearer <token>` 里的值 */
export function bearerToken(req) {
  const header = req.get?.('authorization') || req.headers?.authorization || ''
  return String(header).toLowerCase().startsWith('bearer ') ? String(header).slice(7).trim() : ''
}

/**
 * 把当前用户挂到 req.user 上（多用户模式才生效）。
 * 不做拒绝——拒绝交给 requireUser，这样公开接口也能知道「有没有登录」。
 *
 * 两种凭证都认：
 * 1. 浏览器：`flychat_session` cookie
 * 2. 第三方客户端（Cherry Studio / Cursor / SDK）：`Authorization: Bearer fcp_...`
 */
export function attachUser(req, _res, next) {
  req.user = null
  req.authVia = null
  if (!req.app?.locals?.multiUser) return next()
  try {
    const cookie = readCookie(req, SESSION_COOKIE)
    if (cookie) {
      req.user = userBySession(cookie)
      if (req.user) req.authVia = 'cookie'
    }
    if (!req.user) {
      const token = bearerToken(req)
      if (token) {
        req.user = userByApiToken(token)
        if (req.user) req.authVia = 'token'
      }
    }
  } catch {
    // 数据库还没就绪时不要因为鉴权把整个服务打挂
    req.user = null
  }
  next()
}

/** 要求已登录 */
export function requireUser(req, _res, next) {
  if (!req.app?.locals?.multiUser) return next()
  if (req.user) return next()
  next(new AppError('请先登录', { status: 401, code: 'login_required' }))
}

/** 要求管理员 */
export function requireAdmin(req, _res, next) {
  if (!req.app?.locals?.multiUser) return next()
  if (!req.user) return next(new AppError('请先登录', { status: 401, code: 'login_required' }))
  if (req.user.role !== 'admin') {
    return next(new AppError('需要管理员权限', { status: 403, code: 'forbidden' }))
  }
  next()
}

/** 当前用户 id；单用户模式下返回 null（表示「不隔离」） */
export function currentUserId(req) {
  return req.app?.locals?.multiUser ? req.user?.id || null : null
}
