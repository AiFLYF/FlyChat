import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry, CircuitBreaker, Semaphore, isRetryable, isFallbackEligible, describeUpstreamError } from '../lib/resilience.js'
import { AppError, UpstreamError } from '../lib/errors.js'

const upstream = (status, message = 'boom') =>
  new UpstreamError(message, { status, retryable: status >= 500 || status === 429 })

test('Semaphore：排队中的请求可被 abort，槽位让给下一个人', async () => {
  const sem = new Semaphore(1)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const first = sem.run(() => gate)
  const controller = new AbortController()
  const queued = sem.run(async () => 'never', { signal: controller.signal })
  const next = sem.run(async () => 'next')
  await Promise.resolve()
  assert.equal(sem.pending, 2)

  controller.abort()
  await assert.rejects(queued, (err) => err.code === 'client_aborted')
  assert.equal(sem.pending, 1, 'abort 后必须从队列里摘掉')

  release()
  await first
  assert.equal(await next, 'next', '被取消的请求不能吞掉后面的槽位')
})

test('Semaphore：队列有上限，超限立即拒绝而不是无限堆积', async () => {
  const sem = new Semaphore(1, { maxQueue: 1 })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const first = sem.run(() => gate)
  const queued = sem.run(async () => 'queued')
  await Promise.resolve()
  await assert.rejects(
    sem.run(async () => 'overflow'),
    (err) => err.code === 'semaphore_queue_full'
  )
  release()
  await first
  assert.equal(await queued, 'queued')
})

test('withRetry：前两次 500，第三次成功', async () => {
  let calls = 0
  const result = await withRetry(
    async () => {
      calls += 1
      if (calls < 3) throw upstream(500)
      return 'ok'
    },
    { retries: 3, baseMs: 1, maxMs: 5 }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
})

test('withRetry：不可重试的错误立即抛出，不浪费时间', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1
          throw upstream(401, 'unauthorized')
        },
        { retries: 3, baseMs: 1 }
      ),
    /unauthorized/
  )
  assert.equal(calls, 1)
})

test('withRetry：重试次数用尽后抛出最后一次错误', async () => {
  let calls = 0
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1
          throw upstream(503)
        },
        { retries: 2, baseMs: 1, maxMs: 2 }
      ),
    /boom/
  )
  assert.equal(calls, 3) // 首次 + 2 次重试
})

test('withRetry：客户端已中断时不再重试', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls += 1
        throw upstream(503)
      },
      { retries: 3, baseMs: 1, signal: controller.signal }
    )
  )
  assert.equal(calls, 1)
})

test('isRetryable：429/5xx 可重试，4xx 不可', () => {
  assert.equal(isRetryable(upstream(429)), true)
  assert.equal(isRetryable(upstream(500)), true)
  assert.equal(isRetryable(upstream(404)), false)
  assert.equal(isRetryable(Object.assign(new Error('net'), { cause: { code: 'ECONNRESET' } })), true)
  assert.equal(isRetryable(new Error('随便什么错')), false)
})

test('bad port：直接、cause 和 AggregateError 包装均不原地重试但允许降级', async () => {
  const badPort = new Error('bad port')
  const errors = [
    badPort,
    new TypeError('fetch failed', { cause: badPort }),
    new TypeError('fetch failed', { cause: new AggregateError([badPort]) }),
  ]
  for (const error of errors) {
    assert.equal(isRetryable(error), false)
    assert.equal(isFallbackEligible(error), true)
    let calls = 0
    await assert.rejects(
      withRetry(async () => {
        calls += 1
        throw error
      }, { retries: 3, baseMs: 1 }),
      (err) => err === error
    )
    assert.equal(calls, 1)
    assert.match(describeUpstreamError(error, { providerName: '备用' }), /「备用」.*端口.*禁止/)
  }
})

test('isFallbackEligible：熔断可降级，但认证、额度、取消和普通错误不可', () => {
  const circuit = new AppError('已熔断', { status: 503, code: 'provider_circuit_open' })
  assert.equal(isRetryable(circuit), false)
  assert.equal(isFallbackEligible(circuit), true)
  assert.equal(isFallbackEligible(upstream(503)), true)
  assert.equal(isFallbackEligible(upstream(429)), true)
  for (const error of [
    upstream(401),
    upstream(400),
    new UpstreamError('额度不足', { status: 429, retryable: false }),
    Object.assign(new Error('bad port'), { name: 'AbortError' }),
    new Error('普通错误'),
    null,
  ]) assert.equal(isFallbackEligible(error), false)
})

test('describeUpstreamError：cause 的具体网络原因优先于 fetch failed', () => {
  for (const [code, hint] of [
    ['ECONNRESET', /连接被中断/],
    ['UND_ERR_SOCKET', /连接被中断/],
    ['ECONNREFUSED', /拒绝连接/],
    ['ENOTFOUND', /域名解析失败/],
    ['EAI_AGAIN', /域名解析失败/],
    ['ETIMEDOUT', /连接超时/],
    ['UND_ERR_CONNECT_TIMEOUT', /连接超时/],
  ]) {
    const cause = Object.assign(new Error(code), { code })
    for (const nested of [cause, new AggregateError([cause])]) {
      const message = describeUpstreamError(new TypeError('fetch failed', { cause: nested }), { providerName: '备用' })
      assert.match(message, hint)
      assert.match(message, /「备用」/)
      assert.doesNotMatch(message, /网络不可达/)
    }
  }
  assert.match(describeUpstreamError(new TypeError('fetch failed')), /网络不可达/)
})

test('describeUpstreamError：保留上游提示和取消语义', () => {
  assert.equal(describeUpstreamError(upstream(401, '密钥无效')), '密钥无效')
  assert.equal(describeUpstreamError(Object.assign(new Error('fetch failed'), { name: 'AbortError' })), '请求已取消')
  // 上游整体超时（AbortSignal.timeout 的 TimeoutError）必须翻译成人话，不能透传英文 DOMException
  assert.match(
    describeUpstreamError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), { providerName: '测试商' }),
    /「测试商」响应超时/
  )
})

test('CircuitBreaker：连续失败到阈值后打开，冷却后进入半开', () => {
  let now = 1000
  const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 100, now: () => now })
  assert.equal(breaker.state, 'closed')
  assert.equal(breaker.check(), null)

  breaker.onFailure()
  assert.equal(breaker.state, 'closed')
  breaker.onFailure()
  assert.equal(breaker.state, 'open')
  assert.ok(breaker.check() > 0)

  now += 101
  assert.equal(breaker.state, 'half-open')
  assert.equal(breaker.check(), null)

  breaker.onSuccess()
  assert.equal(breaker.state, 'closed')
  assert.equal(breaker.failures, 0)
})

test('Semaphore：并发不超过上限，超出的排队执行', async () => {
  const sem = new Semaphore(2)
  let running = 0
  let peak = 0
  await Promise.all(
    Array.from({ length: 6 }, () =>
      sem.run(async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 10))
        running -= 1
      })
    )
  )
  assert.equal(peak, 2)
})
