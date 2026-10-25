import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consumeSSE, assertOk, classifyUpstreamError } from '../providers/sse.js'
import { UpstreamError } from '../lib/errors.js'

/** 把若干文本片段包装成 fetch 风格的 Response */
function responseFromChunks(chunks) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

test('consumeSSE：一行 JSON 被拆成多个 chunk 也能正确解析', async () => {
  const payload = JSON.stringify({ choices: [{ delta: { content: '你好' } }] })
  const mid = Math.floor(payload.length / 2)
  const res = responseFromChunks([`data: ${payload.slice(0, mid)}`, `${payload.slice(mid)}\n\n`])
  const events = []
  await consumeSSE(res, (e) => events.push(e))
  assert.equal(events.length, 1)
  assert.equal(events[0].choices[0].delta.content, '你好')
})

test('consumeSSE：忽略注释行、空行与 [DONE]', async () => {
  const res = responseFromChunks([
    ': ping\n\n',
    '\n',
    `data: ${JSON.stringify({ n: 1 })}\n\n`,
    'data: [DONE]\n\n',
    `data: ${JSON.stringify({ n: 2 })}\n\n`,
  ])
  const events = []
  await consumeSSE(res, (e) => events.push(e))
  assert.deepEqual(events, [{ n: 1 }, { n: 2 }])
})

test('consumeSSE：回调抛错会向上传播，不会被「坏行忽略」吞掉', async () => {
  const res = responseFromChunks([`data: ${JSON.stringify({ type: 'error' })}\n\n`])
  await assert.rejects(
    () =>
      consumeSSE(res, (e) => {
        if (e.type === 'error') throw new Error('上游报错')
      }),
    /上游报错/
  )
})

test('assertOk：5xx 标记为可重试，并解析 Retry-After', async () => {
  const res = new Response('{"error":{"message":"busy"}}', {
    status: 503,
    headers: { 'retry-after': '2' },
  })
  const err = await assertOk(res, 'Mock').catch((e) => e)
  assert.ok(err instanceof UpstreamError)
  assert.equal(err.status, 503)
  assert.equal(err.retryable, true)
  assert.equal(err.retryAfterMs, 2000)
})

test('assertOk：401 不可重试，并给出可操作提示', async () => {
  const res = new Response('{"error":{"message":"invalid key"}}', { status: 401 })
  const err = await assertOk(res, 'Mock').catch((e) => e)
  assert.equal(err.retryable, false)
  assert.match(err.message, /密钥无效/)
})

test('assertOk：ok 响应不抛错', async () => {
  await assert.doesNotReject(() => assertOk(new Response('ok'), 'Mock'))
})

test('错误归类：各家错误归一成可执行的 code 与提示', () => {
  assert.equal(classifyUpstreamError(401, 'invalid api key').code, 'auth_failed')
  assert.equal(classifyUpstreamError(403, 'forbidden').transient, false)

  const quota = classifyUpstreamError(429, 'insufficient_quota')
  assert.equal(quota.code, 'quota_exceeded')
  assert.equal(quota.transient, false)
  assert.match(quota.hint, /额度/)

  const rate = classifyUpstreamError(429, 'too many requests')
  assert.equal(rate.code, 'rate_limited')
  assert.equal(rate.transient, true, '限流值得重试')

  assert.equal(classifyUpstreamError(404, 'model not found').code, 'model_not_found')
  assert.equal(classifyUpstreamError(500, 'internal error').code, 'server_error')
  assert.equal(classifyUpstreamError(500, '').transient, true)

  // 上下文超长：可修但不值得重试（同样请求还会超）
  const overflow = classifyUpstreamError(400, 'maximum context length is 65536')
  assert.equal(overflow.code, 'context_overflow')
  assert.equal(overflow.transient, false)
  assert.equal(overflow.fixable, true)
  assert.match(overflow.hint, /上下文/)

  assert.equal(classifyUpstreamError(400, 'messages: invalid role').code, 'invalid_request')
  assert.equal(classifyUpstreamError(400, '内容违规 content filter').code, 'content_filtered')
})

test('assertOk：错误信息里带可操作提示，而不是原始堆栈', async () => {
  const res = new Response('{"error":{"message":"maximum context length is 65536"}}', { status: 400 })
  const err = await assertOk(res, 'Mock').catch((e) => e)
  assert.equal(err.code, 'context_overflow')
  assert.match(err.message, /上下文窗口/)
  assert.match(err.message, /Mock API 错误 \(400\)/)
})
