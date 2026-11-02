import { AppError, UpstreamError } from './errors.js'
import { logger } from './logger.js'

/**
 * 弹性设施：并发闸门、熔断、指数退避重试。
 *
 * 这些不是「有了更好」的东西——商用场景里上游 429/503 是常态，
 * 没有重试就是直接把错误甩给用户；没有并发限制就是被上游限流打死。
 */

/** 简单信号量：限制同时打给同一服务商的请求数，超出排队 */
export class Semaphore {
  constructor(max, { maxQueue = 100, waitTimeoutMs = 30_000 } = {}) {
    this.max = Math.max(1, max)
    this.maxQueue = Math.max(1, maxQueue)
    this.waitTimeoutMs = waitTimeoutMs
    this.active = 0
    this.queue = []
  }

  /**
   * 排队必须可取消、有上限：
   * 上游卡死时无界排队会拖住所有后续请求；客户端已经断开还占着队，
   * 拿到槽位后照样去打上游并计费。
   */
  acquire({ signal, timeoutMs = this.waitTimeoutMs } = {}) {
    if (signal?.aborted) {
      return Promise.reject(new AppError('请求已取消', { status: 499, code: 'client_aborted' }))
    }
    if (this.active < this.max) {
      this.active += 1
      return Promise.resolve()
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(
        new UpstreamError('当前并发已满，请稍后重试', { status: 429, code: 'semaphore_queue_full', retryable: true })
      )
    }
    return new Promise((resolve, reject) => {
      let timer = null
      const entry = { grant: null, fail: null, signal, onAbort: null }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        timer = null
        if (signal && entry.onAbort) signal.removeEventListener('abort', entry.onAbort)
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
      }
      entry.grant = () => {
        cleanup()
        this.active += 1
        resolve()
      }
      entry.fail = (err) => {
        cleanup()
        reject(err)
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          entry.fail(
            new UpstreamError('等待上游并发槽位超时', { status: 503, code: 'semaphore_timeout', retryable: true })
          )
        }, timeoutMs)
        timer.unref?.()
      }
      if (signal) {
        entry.onAbort = () => entry.fail(new AppError('请求已取消', { status: 499, code: 'client_aborted' }))
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.queue.push(entry)
    })
  }

  release() {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next) next.grant()
  }

  async run(fn, options) {
    await this.acquire(options)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  get pending() {
    return this.queue.length
  }
}

/**
 * 熔断器：某服务商连续失败到阈值后，短时间内直接拒绝请求，
 * 避免每个用户都去撞一个已经挂掉的上游（把 30 秒的等待变成 0 秒报错）。
 */
export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 30_000, now = Date.now } = {}) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
    this.now = now
    this.failures = 0
    this.openedAt = 0
  }

  get state() {
    if (this.openedAt === 0) return 'closed'
    return this.now() - this.openedAt >= this.cooldownMs ? 'half-open' : 'open'
  }

  /** 返回 null 表示放行，否则返回剩余冷却毫秒数 */
  check() {
    if (this.openedAt === 0) return null
    const elapsed = this.now() - this.openedAt
    if (elapsed >= this.cooldownMs) return null // half-open：放一个请求试探
    return this.cooldownMs - elapsed
  }

  onSuccess() {
    this.failures = 0
    this.openedAt = 0
  }

  onFailure() {
    this.failures += 1
    if (this.failures >= this.threshold && this.openedAt === 0) {
      this.openedAt = this.now()
    }
  }

  snapshot() {
    return { state: this.state, failures: this.failures }
  }
}

/** 是否值得重试：429/5xx/网络抖动值得，401/400 重试只会浪费时间 */
export function isRetryable(err) {
  if (!err) return false
  if (err.name === 'AbortError') return false
  if (err instanceof UpstreamError) {
    if (err.retryable !== undefined) return err.retryable
    const s = err.status
    return s === 408 || s === 409 || s === 425 || s === 429 || s >= 500
  }

  // bad port 是 fetch 在连接前拒绝的配置错误，原地址重试永远不会成功。
  if (isBadPortError(err)) return false

  // undici 的网络错误统一是 TypeError: fetch failed，
  // cause 可能是单个错误，也可能是多地址尝试后的 AggregateError（errors 数组）
  if (err.name === 'TypeError' && /fetch failed/i.test(err.message || '')) return true

  const codes = errorCodes(err)

  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'EAI_AGAIN',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ].some((code) => codes.has(code))
}

/** 跨候选降级不同于原地址重试：熔断和坏端口可以换候选，但认证/额度错误仍不放宽。 */
export function isFallbackEligible(err) {
  if (!err || err.name === 'AbortError' || err instanceof UpstreamError) return isRetryable(err)
  return err.code === 'provider_circuit_open' || isBadPortError(err) || isRetryable(err)
}

/** 递归遍历错误链（undici 会套 cause / AggregateError.errors），限制深度防止循环引用。 */
function* errorChain(err, depth = 0) {
  if (!err || depth > 3) return
  yield err
  if (Array.isArray(err.errors)) {
    for (const nested of err.errors) yield* errorChain(nested, depth + 1)
  }
  if (err.cause) yield* errorChain(err.cause, depth + 1)
}

function errorCodes(err) {
  return new Set([...errorChain(err)].map((e) => e.code).filter(Boolean))
}

function isBadPortError(err) {
  return [...errorChain(err)].some((e) => /^bad port$/i.test(e.message?.trim() || ''))
}

/**
 * 把上游错误翻译成「用户看完知道该干什么」的中文提示。
 *
 * 背景：undici 连不上目标时只会抛 `TypeError: fetch failed`，
 * 原样透传等于让用户面对一句英文报错；常见于 Base URL 填错、
 * 本地代理网关没启动、断网——这些恰好都能靠一句提示自助解决。
 *
 * 注意：HTTP 级错误（UpstreamError）不动——sse.js 的 classifyUpstreamError
 * 已经给出了「密钥无效 / 请求过于频繁」这类具体提示，这里再包一层反而丢信息。
 * 原始 message 仍写进日志，排查时不受影响。
 */
export function describeUpstreamError(err, { providerName } = {}) {
  const who = providerName ? `「${providerName}」` : '服务商'

  if (err?.name === 'AbortError') return '请求已取消'
  if (err instanceof UpstreamError) return err.message

  // AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) 触发的是 TimeoutError 而不是 AbortError，
  // 不走翻译就会把英文 DOMException 原文（"The operation was aborted due to timeout"）
  // 直接怼到用户脸上
  if (err?.name === 'TimeoutError' || /aborted due to timeout/i.test(err?.message || '')) {
    return `${who}响应超时，请稍后重试或缩短问题长度`
  }

  if (isBadPortError(err)) {
    return `${who}的 Base URL 端口被 fetch 安全策略禁止，请在模型服务设置中改用允许的 HTTP/HTTPS 端口`
  }

  // 先看 cause 的具体原因，再兜底 fetch failed，避免连接中断被误报成网络不可达。
  const codes = errorCodes(err)
  if (codes.has('ECONNRESET') || codes.has('UND_ERR_SOCKET')) {
    return `与${who}的连接被中断，请重试`
  }
  const detail = codes.has('ECONNREFUSED')
    ? '目标地址拒绝连接，通常是网关没启动或端口不对'
    : codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')
      ? '域名解析失败，请检查 Base URL 是否写对'
      : codes.has('UND_ERR_CONNECT_TIMEOUT') || codes.has('ETIMEDOUT')
        ? '连接超时，请检查网络或代理'
        : null
  if (detail || /fetch failed/i.test(err?.message || '')) {
    return `无法连接${who}的上游地址：${detail || '网络不可达'}`
  }

  return err?.message || '上游请求失败'
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason || new Error('aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 带退避的重试。`shouldRetry(err)` 可以额外否决重试——
 * 流式请求一旦已经吐出字节就不能重试，否则用户会看到重复内容。
 */
export async function withRetry(fn, options = {}) {
  const {
    retries = 2,
    baseMs = 400,
    maxMs = 8000,
    signal,
    shouldRetry = isRetryable,
    onRetry,
    label = 'upstream',
  } = options

  let attempt = 0
  for (;;) {
    try {
      return await fn(attempt)
    } catch (err) {
      attempt += 1
      if (attempt > retries || signal?.aborted || !shouldRetry(err)) throw err
      // 上游给了 Retry-After 就尊重它，但不超过 maxMs
      const hinted = Number(err?.retryAfterMs) || 0
      const backoff = Math.min(maxMs, hinted || baseMs * 2 ** (attempt - 1))
      const jitter = Math.round(backoff * (0.8 + Math.random() * 0.4))
      logger.warn('上游请求失败，准备重试', {
        label,
        attempt,
        status: err?.status,
        message: err?.message,
        waitMs: jitter,
      })
      onRetry?.(err, attempt, jitter)
      await sleep(jitter, signal)
    }
  }
}

const semaphores = new Map()
const breakers = new Map()

export function semaphoreFor(key, max) {
  if (!semaphores.has(key)) semaphores.set(key, new Semaphore(max))
  return semaphores.get(key)
}

export function breakerFor(key, { threshold, cooldownMs } = {}) {
  if (!breakers.has(key)) {
    breakers.set(key, new CircuitBreaker({ threshold, cooldownMs }))
  }
  return breakers.get(key)
}

/** 运维视角：所有熔断器状态 */
export function breakerSnapshot() {
  return Object.fromEntries([...breakers.entries()].map(([k, v]) => [k, v.snapshot()]))
}

/** 测试用：清空所有闸门与熔断状态 */
export function resetResilience() {
  semaphores.clear()
  breakers.clear()
}
