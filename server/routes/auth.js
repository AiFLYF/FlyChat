import { Router } from 'express'
import { asyncHandler, badRequest, AppError } from '../lib/errors.js'
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
import { claimOwnerlessFolders } from '../store/folders.js'
import { claimOwnerlessWorkspaces } from '../rag/store.js'
import { inc } from '../lib/metrics.js'
import { logger } from '../lib/logger.js'

const router = Router()

const TTL_MS = () => config.auth.sessionDays * 24 * 60 * 60 * 1000

// 登录防暴力破解：按「来源 IP + 用户名」连续失败计数，达到上限后锁定一段时间。
// 只按 IP 计数会让同一出口 NAT 下的所有人一起被锁；带上用户名只锁正在被猜的账号。
const loginFailures = new Map()
const MAX_LOGIN_FAILURES = 10
const LOCKOUT_MS = 10 * 60 * 1000
// 来源 IP / 用户名都不可控，表必须有上限，否则长期运行只涨不消
const LOGIN_FAILURE_CAP = 2000

function loginKey(ip, username) {
  return `${ip}:${username}`
}

function checkLoginLockout(key) {
  const record = loginFailures.get(key)
  if (!record) return
  if (Date.now() - record.firstFailedAt > LOCKOUT_MS) {
    loginFailures.delete(key)
    return
  }
  if (record.count >= MAX_LOGIN_FAILURES) {
    const remainingSec = Math.ceil((LOCKOUT_MS - (Date.now() - record.firstFailedAt)) / 1000)
    throw new AppError(`登录失败次数过多，请在 ${remainingSec} 秒后再试`, {
      status: 429,
      code: 'login_locked_out',
    })
  }
}

function recordLoginFailure(key) {
  const now = Date.now()
  const record = loginFailures.get(key)
  if (!record || now - record.firstFailedAt > LOCKOUT_MS) {
    if (loginFailures.size >= LOGIN_FAILURE_CAP) {
      for (const [k, value] of loginFailures) {
        if (now - value.firstFailedAt > LOCKOUT_MS) loginFailures.delete(k)
      }
      // 全是未过期项时整表丢弃：只是重置计数，比让内存无限增长划算
      if (loginFailures.size >= LOGIN_FAILURE_CAP) loginFailures.clear()
    }
    loginFailures.set(key, { count: 1, firstFailedAt: now })
  } else {
    record.count += 1
  }
}

function clearLoginFailure(key) {
  loginFailures.delete(key)
}

/** 生产环境默认跟随实际协议加 Secure；反代场景需开 TRUST_PROXY 才能识别 X-Forwarded-Proto */
function cookieFor(req, token) {
  const secure =
    config.auth.cookieSecure === 'on' ? true : config.auth.cookieSecure === 'off' ? false : req.secure
  return sessionCookie(token, { maxAgeMs: TTL_MS(), secure })
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

    // 老的无主会话/文件夹/知识库认领给第一个管理员，否则用户会以为历史全丢了
    const claimed = claimOwnerlessConversations(user.id)
    if (claimed > 0) logger.info('已把历史会话认领给首个管理员', { userId: user.id, count: claimed })
    const claimedFolders = claimOwnerlessFolders(user.id)
    if (claimedFolders > 0) logger.info('已把历史文件夹认领给首个管理员', { userId: user.id, count: claimedFolders })
    try {
      const claimedWorkspaces = claimOwnerlessWorkspaces(user.id)
      if (claimedWorkspaces > 0) {
        logger.info('已把历史知识库认领给首个管理员', { userId: user.id, count: claimedWorkspaces })
      }
    } catch {
      // 知识库表还没建好时不影响初始化
    }

    const { token } = createSession(user.id, { userAgent: req.get('user-agent'), ttlMs: TTL_MS() })
    res.setHeader('Set-Cookie', cookieFor(req, token))
    inc('auth_setup_total')
    res.status(201).json({ ok: true, user, claimedConversations: claimed, claimedFolders })
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
    const clientIp = req.ip || 'unknown'
    const { username, password } = req.body || {}
    if (!username || !password) throw badRequest('请输入用户名和密码', 'missing_credentials')
    const failureKey = loginKey(clientIp, String(username).trim())
    checkLoginLockout(failureKey)

    const user = authenticate(String(username).trim(), String(password))
    if (!user) {
      inc('auth_login_failed_total')
      recordLoginFailure(failureKey)
      // 不区分「用户不存在」与「密码错」，避免被拿来枚举账号
      throw badRequest('用户名或密码不正确', 'invalid_credentials')
    }

    clearLoginFailure(failureKey)
    cleanupSessions()
    const { token } = createSession(user.id, { userAgent: req.get('user-agent'), ttlMs: TTL_MS() })
    res.setHeader('Set-Cookie', cookieFor(req, token))
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
