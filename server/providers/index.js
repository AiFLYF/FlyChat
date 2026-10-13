import { streamOpenAICompat } from './openai-compat.js'
import { streamAnthropic } from './anthropic.js'
import { streamGemini } from './gemini.js'

const ADAPTERS = {
  'openai-compat': streamOpenAICompat,
  anthropic: streamAnthropic,
  gemini: streamGemini,
}

/** 上游请求整体超时上限（毫秒），避免上游挂起导致连接无限等待 */
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000

export function streamChat(provider, options) {
  const adapter = ADAPTERS[provider.type]
  if (!adapter) {
    throw new Error(`未知的提供商类型: ${provider.type}`)
  }
  // 组合「客户端中断」与「超时中断」两个信号
  const signals = [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]
  if (options.abortSignal) signals.push(options.abortSignal)
  return adapter(provider, {
    ...options,
    abortSignal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  })
}
