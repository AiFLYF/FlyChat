import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry, CircuitBreaker, Semaphore, isRetryable } from '../lib/resilience.js'
import { UpstreamError } from '../lib/errors.js'

const upstream = (status, message = 'boom') =>
  new UpstreamError(message, { status, retryable: status >= 500 || status === 429 })

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
