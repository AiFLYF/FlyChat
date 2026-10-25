import { UpstreamError } from '../lib/errors.js'

/**
 * 统一的 SSE 流式解析器
 * 将上游 fetch 响应按 "data: {...}" 事件逐行解析并回调。
 *
 * 注意：上游可能把一行 JSON 拆成多个 chunk 发过来，也可能一次给多行，
 * 所以必须用 buffer 累积到换行符再解析；按 chunk 直接 JSON.parse 是最常见的坑。
 */
export async function consumeSSE(response, onData) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trimEnd()
        buffer = buffer.slice(idx + 1)
        // 只处理 data: 行；注释行（: ping）与 event: 行直接跳过
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let evt
        try {
          evt = JSON.parse(payload)
        } catch {
          // 无法解析的行（心跳、日志）忽略，但不能吞掉回调抛出的错误
          continue
        }
        onData(evt)
      }
    }
  } finally {
    // 提前退出时释放连接，避免上游一直往一个没人读的流里写
    try {
      await reader.cancel()
    } catch {
      /* 已经读完或已断开 */
    }
  }
}

/** 从 Retry-After 头解析毫秒数（支持秒数与 HTTP 日期两种格式） */
function parseRetryAfter(value) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

/**
 * 把上游错误归一到「可执行的错误码」。
 *
 * 为什么要单独做这一层：直接抛给用户的原始错误形如
 * `deepseek API 错误 (400): {"error":{"code":"invalid_request_error",...}}`，
 * 用户看完不知道该怎么办。归一之后可以：
 * - 给前端可操作的提示（换 Key / 降 token / 换个模型 / 等一会再试）
 * - 决定要不要重试或降级（瞬时错误才值得，永久错误只会浪费时间）
 * - 统一各家措辞（Cherry Studio 的 ErrorClassifier 也是这么做的）
 */
export function classifyUpstreamError(status, detail) {
  const text = String(detail || '')
  const s = Number(status) || 0
  const has = (re) => re.test(text)

  if (s === 401 || s === 403) {
    return { code: 'auth_failed', transient: false, hint: '密钥无效或无权限，请检查服务端配置' }
  }
  if (s === 429 || s === 402) {
    if (has(/insufficient[_ ]?(quota|balance)|billing|欠费|余额不足/i)) {
      return { code: 'quota_exceeded', transient: false, hint: '账户额度不足，请充值或更换服务商' }
    }
    return { code: 'rate_limited', transient: true, hint: '触发上游限流，稍后再试或降低并发' }
  }
  if (s === 404) {
    if (has(/model/i)) return { code: 'model_not_found', transient: false, hint: '模型不存在，请检查模型名' }
    return { code: 'endpoint_not_found', transient: false, hint: '接口路径不存在，请检查 Base URL' }
  }
  if (s === 400 || s === 422) {
    if (has(/context.?length|too (long|many) tokens|maximum context|超出|token 数/i)) {
      return {
        code: 'context_overflow',
        // 可修但重试无意义（同样的请求还是会超），交给上层裁剪或换模型
        transient: false,
        fixable: true,
        hint: '内容超出模型上下文窗口，可减少历史或更换长上下文模型',
      }
    }
    if (has(/content.?filter|safety|敏感|违规/i)) {
      return { code: 'content_filtered', transient: false, hint: '内容被上游安全策略拦截' }
    }
    return { code: 'invalid_request', transient: false, hint: '请求参数有误' }
  }
  if (s === 408) return { code: 'timeout', transient: true, hint: '上游响应超时' }
  if (s >= 500) return { code: 'server_error', transient: true, hint: '上游服务异常，稍后会自动重试' }
  return { code: 'upstream_error', transient: s >= 408, hint: '上游返回错误' }
}

export async function assertOk(response, providerName) {
  if (response.ok) return
  let detail = ''
  try {
    const text = await response.text()
    try {
      const json = JSON.parse(text)
      detail = json?.error?.message || json?.message || text
    } catch {
      detail = text
    }
  } catch {
    /* ignore */
  }

  const status = response.status
  const { code, transient, hint } = classifyUpstreamError(status, detail)

  throw new UpstreamError(`${providerName} API 错误 (${status}) · ${hint}: ${String(detail).slice(0, 500)}`, {
    status,
    code,
    transient,
    retryable: transient,
    retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
  })
}
