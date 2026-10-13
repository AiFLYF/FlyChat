import { consumeSSE, assertOk } from './sse.js'

/** OpenAI 兼容接口流式调用（OpenAI / DeepSeek / Kimi / GLM 等） */
export async function streamOpenAICompat(provider, { model, messages, system, temperature, maxTokens, abortSignal, onDelta }) {
  const body = {
    model,
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    stream: true,
  }
  if (temperature != null) body.temperature = temperature
  if (maxTokens != null) body.max_tokens = maxTokens

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: abortSignal,
  })
  await assertOk(res, provider.name)

  await consumeSSE(res, (json) => {
    const text = json?.choices?.[0]?.delta?.content
    if (text) onDelta(text)
  })
}
