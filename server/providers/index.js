import { streamOpenAICompat } from './openai-compat.js'
import { streamAnthropic } from './anthropic.js'
import { streamGemini } from './gemini.js'

const ADAPTERS = {
  'openai-compat': streamOpenAICompat,
  anthropic: streamAnthropic,
  gemini: streamGemini,
}

export function streamChat(provider, options) {
  const adapter = ADAPTERS[provider.type]
  if (!adapter) {
    throw new Error(`未知的提供商类型: ${provider.type}`)
  }
  return adapter(provider, options)
}
