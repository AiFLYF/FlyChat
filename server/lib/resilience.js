import { UpstreamError } from './errors.js'
import { logger } from './logger.js'

/**
 * 弹性设施：并发闸门、熔断、指数退避重试。
 *
 * 这些不是「有了更好」的东西——商用场景里上游 429/503 是常态，
 * 没有重试就是直接把错误甩给用户；没有并发限制就是被上游限流打死。
 */

/** 简单信号量：限制同时打给同一服务商的请求数，超出排队 */
export class Semaphore {
  constructor(max) {
    this.max = Math.max(1, max)
    this.active = 0
    this.queue = []
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1
      return
    }
    await new Promise((resolve) => this.queue.push(resolve))
    this.active += 1
  }

  release() {
    this.active -= 1
    const next = this.queue.shift()
    if (next) next()
  }

  async run(fn) {
    await this.acquire()
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

/** 递归收集错误链上的 code（undici 会套 cause / AggregateError.errors） */
function errorCodes(err) {
  const codes = new Set()
  const collect = (e, depth = 0) => {
    if (!e || depth > 3) return
    if (e.code) codes.add(e.code)
    if (Array.isArray(e.errors)) e.errors.forEach((x) => collect(x, depth + 1))
    if (e.cause) collect(e.cause, depth + 1)
  }
  collect(err)
  return codes
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

  if (/fetch failed/i.test(err?.message || '')) {
    const codes = errorCodes(err)
    const detail = codes.has('ECONNREFUSED')
      ? '目标地址拒绝连接，通常是网关没启动或端口不对'
      : codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')
        ? '域名解析失败，请检查 Base URL 是否写对'
        : codes.has('UND_ERR_CONNECT_TIMEOUT') || codes.has('ETIMEDOUT')
          ? '连接超时，请检查网络或代理'
          : '网络不可达'
    return `无法连接${who}的上游地址：${detail}`
  }

  const codes = errorCodes(err)
  if (codes.has('ECONNRESET') || codes.has('UND_ERR_SOCKET')) {
    return `与${who}的连接被中断，请重试`
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
