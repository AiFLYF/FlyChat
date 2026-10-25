import express from 'express'
import cors from 'cors'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config, configWarnings, ROOT_DIR } from './config.js'
import { AppError, toErrorResponse } from './lib/errors.js'
import { createLogger, logger } from './lib/logger.js'
import { inc, observe } from './lib/metrics.js'
import chatRoutes from './routes/chat.js'
import providerRoutes from './routes/providers.js'
import modelRoutes from './routes/models.js'
import conversationRoutes from './routes/conversations.js'
import shareRoutes from './routes/share.js'
import audioRoutes from './routes/audio.js'
import ragRoutes from './routes/rag.js'
import mcpRoutes from './routes/mcp.js'
import presetRoutes from './routes/presets.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/users.js'
import folderRoutes from './routes/folders.js'
import taskRoutes from './routes/tasks.js'
import imageRoutes from './routes/images.js'
import { attachUser, requireUser } from './lib/auth.js'
import { buildShareMeta, injectMeta } from './lib/og.js'
import { peekShare } from './store/shares.js'
import { storageStatus } from './store/db.js'
import openaiApiRoutes from './routes/openai-api.js'
import systemRoutes from './routes/system.js'
import extractRoutes from './routes/extract.js'

const PUBLIC_PATHS = new Set(['/api/health', '/api/config', '/api/metrics'])
/** 分享读取是公开能力：别人拿到链接就能看，不需要访问令牌 */
const PUBLIC_SHARE = /^\/api\/share\/[A-Za-z0-9_-]+$/

/** 登录相关端点本身不能要求登录，否则永远进不去 */
const AUTH_PUBLIC = new Set(['/api/auth/me', '/api/auth/setup', '/api/auth/login', '/api/auth/logout'])

/** 定长比较，避免通过响应时间猜令牌 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/** 内存限流：只拦写操作。单机自托管够用，多实例部署请交给网关 */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map()
  // 定期清理，避免长时间运行后 Map 无限增长
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of hits) {
      if (now - entry.start > windowMs) hits.delete(key)
    }
  }, windowMs)
  timer.unref?.()

  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
    const key = req.ip || 'unknown'
    const now = Date.now()
    const entry = hits.get(key)
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 })
      return next()
    }
    entry.count += 1
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((windowMs - (now - entry.start)) / 1000))
      return next(new AppError('请求过于频繁，请稍后再试', { status: 429, code: 'rate_limited' }))
    }
    next()
  }
}

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  if (config.server.trustProxy) app.set('trust proxy', 1)

  // —— 请求上下文与访问日志 ——
  app.use((req, res, next) => {
    const id = crypto.randomUUID()
    req.id = id
    res.setHeader('X-Request-Id', id)
    const startedAt = process.hrtime.bigint()
    const log = createLogger({ requestId: id })

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
      observe('http_request_ms', ms, { route: req.path })
      inc('http_requests_total', { status: String(res.statusCode) })
      // 静态资源不记日志，避免刷屏
      if (!req.path.startsWith('/api/')) return
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
      log[level](`${req.method} ${req.path} ${res.statusCode}`, { ms: Math.round(ms) })
    })
    next()
  })

  // —— 基础安全响应头 ——
  // 这是 API 服务，不用 helmet 全套；只补上真正有意义的几个
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    next()
  })

  // —— CORS ——
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true) // curl / 同源请求
        if (config.cors.origins.length === 0) return callback(null, true)
        if (config.cors.origins.includes(origin)) return callback(null, true)
        return callback(new AppError(`来源 ${origin} 不在 CORS_ORIGINS 白名单内`, { status: 403, code: 'cors_denied' }))
      },
      credentials: false,
    })
  )

  app.use(express.json({ limit: config.limits.bodyBytes }))

  // —— 登录态（多用户模式才生效） ——
  app.locals.multiUser = !!config.auth.multiUser
  app.use(attachUser)

  // —— 可选访问令牌 ——
  app.use((req, res, next) => {
    if (!config.auth.token) return next()
    if (PUBLIC_PATHS.has(req.path)) return next()
    if (req.method === 'GET' && PUBLIC_SHARE.test(req.path)) return next()
    const header = req.get('authorization') || ''
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    const provided = bearer || req.get('x-flychat-token') || ''
    if (provided && safeEqual(provided, config.auth.token)) return next()
    next(new AppError('需要访问令牌', { status: 401, code: 'unauthorized' }))
  })

  const writeLimiter = createRateLimiter(config.limits.writeRate)
  app.use('/api', writeLimiter)
  // OpenAI 兼容网关：第三方客户端直接把 base_url 指到这里
  app.use('/v1', writeLimiter)

  // —— 登录相关路由（必须在「要求登录」之前挂） ——
  app.use('/api', authRoutes)

  /**
   * 多用户模式下，除公开端点外一律要求登录。
   *
   * 注意用 req.path（挂载前的完整路径）判断：如果写成 `app.use('/api', mw)`，
   * 里面的 req.path 已经被剥掉前缀，PUBLIC_PATHS 里的 '/api/health' 就永远匹配不上。
   */
  app.use((req, res, next) => {
    if (!req.app.locals.multiUser) return next()
    const p = req.path
    const guarded = p.startsWith('/api/') || p.startsWith('/v1/')
    if (!guarded) return next()
    if (PUBLIC_PATHS.has(p) || AUTH_PUBLIC.has(p)) return next()
    if (req.method === 'GET' && PUBLIC_SHARE.test(p)) return next()
    return requireUser(req, res, next)
  })

  // —— 业务路由 ——
  app.use('/api', userRoutes)
  app.use('/api', folderRoutes)
  app.use('/api', taskRoutes)
  app.use('/api', imageRoutes)
  app.use('/api', systemRoutes)
  app.use('/api', chatRoutes)
  app.use('/api', providerRoutes)
  app.use('/api', modelRoutes)
  app.use('/api', extractRoutes)
  app.use('/api', audioRoutes)
  app.use('/api', mcpRoutes)
  app.use('/api', presetRoutes)
  app.use('/api', ragRoutes)
  app.use('/api', shareRoutes)
  app.use('/api', conversationRoutes)

  app.use('/v1', imageRoutes)
  app.use('/v1', openaiApiRoutes)

  /**
   * `/v1` 的错误必须是 OpenAI 的形状 `{error:{message,type,code}}`。
   *
   * 各家 SDK（openai-python / openai-node / 各种客户端）都按这个结构读错误，
   * 如果返回 `/api` 那套 `{error:"...", code}`，客户端会拿不到 message，
   * 用户只看到一句「unknown error」，排查起来非常痛苦。
   * 必须挂在通用错误中间件之前。
   */
  app.use('/v1', (err, req, res, _next) => {
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
      return
    }
    const status = Number.isInteger(err?.status) ? err.status : 500
    const code = err?.code || (status >= 500 ? 'server_error' : 'invalid_request_error')
    const type =
      status === 401 || status === 403
        ? 'authentication_error'
        : status === 404
          ? 'invalid_request_error'
          : status === 429
            ? 'rate_limit_error'
            : status >= 500
              ? 'server_error'
              : 'invalid_request_error'
    if (status >= 500) {
      logger.error('/v1 请求处理失败', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        message: err?.message,
        stack: err?.stack?.split('\n').slice(0, 4).join(' | '),
      })
    }
    res.status(status).json({
      error: {
        message: status >= 500 && err?.expose === false ? '服务器内部错误' : err?.message || '请求处理失败',
        type,
        code,
      },
    })
  })

  // —— API 404：统一 JSON，不要返回前端 HTML ——
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `接口不存在：${req.method} ${req.originalUrl}`, code: 'route_not_found' })
  })
  app.use('/v1', (req, res) => {
    res.status(404).json({
      error: { message: `接口不存在：${req.method} ${req.originalUrl}`, type: 'invalid_request_error', code: 'route_not_found' },
    })
  })

  // —— 生产环境单端口部署：同一个进程同时提供前端静态文件 ——
  const distDir = path.join(ROOT_DIR, 'dist')
  const indexFile = path.join(distDir, 'index.html')
  if (fs.existsSync(indexFile)) {
    // 带 hash 的静态资源可以长缓存；index.html 必须每次校验
    app.use(
      '/assets',
      express.static(path.join(distDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: true })
    )
    app.use(
      express.static(distDir, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache')
        },
      })
    )
    /**
     * 分享页：把 OG/Twitter meta 注入 index.html 再返回。
     *
     * 前端是 SPA，微信/Slack/Twitter 这些抓取器不执行 JS，只读 HTML 里的 meta——
     * 不注入的话分享出去的链接永远是一张白卡片。
     * 浏览器拿到的仍然是完整的 SPA，所以前端不用改任何东西。
     */
    app.get('/s/:id', (req, res, next) => {
      try {
        const share = storageStatus().available ? peekShare(req.params.id) : null
        // 找不到 / 已过期时**不要 404**：让 SPA 自己去展示它的错误页，
        // 抓取器看到一个 404 反而会缓存成「这个链接坏了」
        const base = `${req.protocol}://${req.get('host') || ''}`
        const meta = share
          ? share.expired
            ? { title: '分享已过期', description: '这条分享链接已过期。', noindex: true }
            : buildShareMeta(share)
          : { title: '分享不存在', description: '这条分享链接不存在或已被取消。', noindex: true }

        const html = fs.readFileSync(indexFile, 'utf8')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.send(injectMeta(html, meta, { url: `${base}/s/${encodeURIComponent(req.params.id)}` }))
      } catch (err) {
        // 注入失败不能影响用户打开页面：退回原始 index.html
        logger.warn('分享页 meta 注入失败，退回 SPA', { message: err?.message })
        next()
      }
    })

    // SPA 兜底：非 API 的 GET 一律回 index.html，交给前端路由
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next()
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(indexFile)
    })
  }

  // —— 集中错误处理 ——
  app.use((err, req, res, _next) => {
    // body-parser 的两类常见错误翻译成人话
    if (err?.type === 'entity.too.large') {
      err = new AppError(`请求体过大（上限 ${Math.round(config.limits.bodyBytes / 1024 / 1024)}MB）`, {
        status: 413,
        code: 'payload_too_large',
      })
    } else if (err?.type === 'entity.parse.failed') {
      err = new AppError('请求体不是合法 JSON', { status: 400, code: 'invalid_json' })
    }

    const { status, body } = toErrorResponse(err)
    if (status >= 500) {
      logger.error('请求处理失败', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        message: err?.message,
        stack: err?.stack?.split('\n').slice(0, 4).join(' | '),
      })
    }

    if (res.headersSent) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
      return
    }
    res.status(status).json(body)
  })

  for (const warning of configWarnings()) logger.warn(warning)

  return app
}
