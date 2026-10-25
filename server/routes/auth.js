import { Router } from 'express'
import { asyncHandler, badRequest } from '../lib/errors.js'
import { config } from '../config.js'
import {
  authenticate,
  changePassword,
  claimOwnerlessConversations,
  cleanupSessions,
  countUsers,
  createSession,
  createUser,
  hasApiToken,
  issueApiToken,
  revokeApiToken,
  revokeSession,
  updateUser,
} from '../store/users.js'
import { clearSessionCookie, readCookie, requireUser, SESSION_COOKIE, sessionCookie } from '../lib/auth.js'
import { storageStatus } from '../store/db.js'
import { inc } from '../lib/metrics.js'
import { logger } from '../lib/logger.js'

const router = Router()

const TTL_MS = () => config.auth.sessionDays * 24 * 60 * 60 * 1000

/** 生产环境走 HTTPS 时加 Secure；本机 http 调试不能加，否则 cookie 不会被保存 */
function cookieFor(token) {
  return sessionCookie(token, {
    maxAgeMs: TTL_MS(),
    secure: config.env === 'production' && config.server.host !== '127.0.0.1' && config.server.host !== 'localhost',
  })
}

/**
 * 当前登录态。前端启动时先调这个决定「显示登录页 / 初始化页 / 主界面」。
 * 单用户模式下 `multiUser: false`，前端直接进主界面。
 */
router.get('/auth/me', (req, res) => {
  const multiUser = !!req.app?.locals?.multiUser
  let needsSetup = false
  if (multiUser && storageStatus().available) {
    try {
      needsSetup = countUsers() === 0
    } catch {
      needsSetup = false
    }
  }
  res.json({
    multiUser,
    needsSetup,
    user: req.user || null,
    // 有没有生成过第三方客户端用的令牌（明文不在任何接口里出现）
    hasApiToken: req.user && multiUser ? safeHasApiToken(req.user.id) : false,
    // 这次请求是用 cookie 还是 Bearer 令牌认证的（排查客户端问题时有用）
    authVia: req.authVia || null,
  })
})

function safeHasApiToken(userId) {
  try {
    return hasApiToken(userId)
  } catch {
    return false
  }
}

/**
 * 生成个人访问令牌（PAT）。
 *
 * 用途：多用户模式下 `/v1` 只认 cookie，而 Cherry Studio / Cursor / SDK
 * 走不了浏览器登录流程。没有 PAT，开了多用户就等于把网关关掉了。
 *
 * **明文只返回这一次**，之后库里只有 sha256。重复调用会作废旧令牌。
 */
router.post(
  '/auth/token',
  // 注意：authRoutes 挂在全局登录守卫**之前**，所以这里必须自己要求登录，
  // 否则未登录请求会走到下面的业务逻辑里（一开始就漏了这一层，测试抓到的）
  requireUser,
  asyncHandler(async (req, res) => {
    if (!req.app.locals.multiUser) {
      throw badRequest('单用户模式不需要访问令牌（设置 MULTI_USER=true 后才需要）', 'multi_user_disabled')
    }
    const { token } = issueApiToken(req.user.id)
    inc('api_token_issued_total')
    res.status(201).json({
      ok: true,
      token,
      // 前端直接把这段贴给用户，告诉他「只显示这一次」
      hint: '请立即复制保存，之后无法再次查看。用法：Authorization: Bearer <token>',
      // 第三方客户端的 base_url 就是当前站点的 /v1
      baseUrl: `${req.protocol}://${req.get('host') || ''}/v1`,
    })
  })
)

router.delete('/auth/token', requireUser, (req, res) => {
  if (!req.app.locals.multiUser) {
    return res.status(400).json({ error: '单用户模式没有访问令牌', code: 'multi_user_disabled' })
  }
  revokeApiToken(req.user.id)
  res.json({ ok: true })
})

/**
 * 创建第一个管理员。
 * 只在「库里一个用户都没有」时可用——这既是初始化入口，也避免了默认口令。
 */
router.post(
  '/auth/setup',
  asyncHandler(async (req, res) => {
    if (!req.app?.locals?.multiUser) {
      throw badRequest('当前是单用户模式，不需要初始化账号（设置 MULTI_USER=true 开启多用户）', 'multi_user_disabled')
    }
    if (!storageStatus().available) {
      throw badRequest('服务端持久化不可用，无法创建账号', 'storage_unavailable')
    }
    if (countUsers() > 0) {
      throw badRequest('已经初始化过了，请直接登录', 'already_setup')
    }

    const { username, password } = req.body || {}
    const user = createUser({ username, password, role: 'admin', displayName: req.body?.displayName })

    // 老的无主会话认领给第一个管理员，否则用户会以为历史全丢了
    const claimed = claimOwnerlessConversations(user.id)
    if (claimed > 0) logger.info('已把历史会话认领给首个管理员', { userId: user.id, count: claimed })

    const { token } = createSession(user.id, { userAgent: req.get('user-agent') })
    res.setHeader('Set-Cookie', cookieFor(token))
    inc('auth_setup_total')
    res.status(201).json({ ok: true, user, claimedConversations: claimed })
  })
)

router.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    if (!req.app?.locals?.multiUser) {
      throw badRequest('当前是单用户模式，不需要登录', 'multi_user_disabled')
    }
    if (!storageStatus().available) {
      throw badRequest('服务端持久化不可用，无法登录', 'storage_unavailable')
    }
    const { username, password } = req.body || {}
    if (!username || !password) throw badRequest('请输入用户名和密码', 'missing_credentials')

    const user = authenticate(String(username).trim(), String(password))
    if (!user) {
      inc('auth_login_failed_total')
      // 不区分「用户不存在」与「密码错」，避免被拿来枚举账号
      throw badRequest('用户名或密码不正确', 'invalid_credentials')
    }

    cleanupSessions()
    const { token } = createSession(user.id, { userAgent: req.get('user-agent') })
    res.setHeader('Set-Cookie', cookieFor(token))
    inc('auth_login_total')
    res.json({ ok: true, user })
  })
)

router.post('/auth/logout', (req, res) => {
  const token = readCookie(req, SESSION_COOKIE)
  if (token) revokeSession(token)
  res.setHeader('Set-Cookie', clearSessionCookie())
  res.json({ ok: true })
})

/** 改自己的密码；改完把这个用户的所有会话踢掉，强制重新登录 */
router.post(
  '/auth/password',
  asyncHandler(async (req, res) => {
    if (!req.user) throw badRequest('请先登录', 'login_required')
    const { oldPassword, newPassword } = req.body || {}
    changePassword(req.user.id, oldPassword, newPassword)
    res.setHeader('Set-Cookie', clearSessionCookie())
    res.json({ ok: true, relogin: true })
  })
)

/** 改自己的显示名 */
router.patch(
  '/auth/profile',
  asyncHandler(async (req, res) => {
    if (!req.user) throw badRequest('请先登录', 'login_required')
    const user = updateUser(req.user.id, { displayName: req.body?.displayName })
    res.json(user)
  })
)

export default router
