/**
 * 统一的应用错误类型。
 * 路由里只管 throw new AppError(...)，由 app.js 的错误中间件翻译成 JSON，
 * 保证前端永远拿到 { error, code } 这种可读结构，而不是 Express 的 HTML 堆栈。
 */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details = undefined, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
    this.expose = status < 500
  }
}

export const badRequest = (message, code = 'bad_request', details) =>
  new AppError(message, { status: 400, code, details })

export const unauthorized = (message = '需要访问令牌', code = 'unauthorized') =>
  new AppError(message, { status: 401, code })

export const notFound = (message = '资源不存在', code = 'not_found') =>
  new AppError(message, { status: 404, code })

export const tooLarge = (message, code = 'payload_too_large') =>
  new AppError(message, { status: 413, code })

export const unavailable = (message, code = 'service_unavailable') =>
  new AppError(message, { status: 503, code })

/** 上游错误：保留 HTTP 状态，便于重试策略判断 */
export class UpstreamError extends AppError {
  constructor(message, { status = 502, code = 'upstream_error', retryable = false, retryAfterMs } = {}) {
    super(message, { status, code })
    this.name = 'UpstreamError'
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

/** 把任意异常转成可返回给前端的结构，避免泄露堆栈 */
export function toErrorResponse(err) {
  const status = err?.status && Number.isInteger(err.status) ? err.status : 500
  const body = {
    error: err?.expose === false ? '服务器内部错误' : err?.message || '服务器内部错误',
    code: err?.code || 'internal_error',
  }
  if (err?.details !== undefined) body.details = err.details
  return { status, body }
}

/**
 * Express 4 不会自动接住 async 函数里 reject 的 Promise，
 * 不包一层的话一个 await 抛错就变成「请求挂住不返回」。所有异步路由都要用它。
 */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

