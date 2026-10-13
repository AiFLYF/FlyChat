import { consumeSSE, assertOk } from './sse.js'

/** Anthropic Claude Messages API 流式调用 */
export async function streamAnthropic(provider, { model, messages, system, temperature, maxTokens, abortSignal, onDelta }) {
  const body = {
    model,
    max_tokens: maxTokens ?? 4096,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream: true,
  }
  if (system) body.system = system
  if (temperature != null) body.temperature = temperature

  const res = await fetch(`${provider.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: abortSignal,
  })
  await assertOk(res, provider.name)

  await consumeSSE(res, (json) => {
    if (json?.type === 'content_block_delta' && json?.delta?.type === 'text_delta') {
      onDelta(json.delta.text)
    }
    if (json?.type === 'error') {
      throw new Error(json?.error?.message || 'Anthropic 流式错误')
    }
  })
}
