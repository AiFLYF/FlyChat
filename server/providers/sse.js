/**
 * 统一的 SSE 流式解析器
 * 将上游 fetch 响应按 "data: {...}" 事件逐行解析并回调
 */
export async function consumeSSE(response, onData) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE 事件以空行分隔
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trimEnd()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        onData(JSON.parse(payload))
      } catch {
        // 忽略无法解析的行（如注释或心跳）
      }
    }
  }
}

export class UpstreamError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UpstreamError'
  }
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
  } catch { /* ignore */ }
  throw new UpstreamError(`${providerName} API 错误 (${response.status}): ${detail.slice(0, 500)}`)
}
