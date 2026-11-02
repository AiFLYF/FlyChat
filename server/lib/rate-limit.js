import { AppError } from './errors.js'

/**
 * 内存限流：按 IP 的固定窗口计数，单机自托管够用，多实例部署请交给网关。
 *
 * 默认只拦写操作（GET/HEAD/OPTIONS 直接放行）；传 `methods` 可改成只对指定方法计数，
 * 用于给「重读」接口（如全量导出）单独设一个更严的上限。
 */
export function createRateLimiter({ windowMs, max, methods = null }) {
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
    const counted = methods ? methods.has(req.method) : !(req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
    if (!counted) return next()

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
