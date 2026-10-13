import { consumeSSE, assertOk } from './sse.js'

/** Google Gemini generateContent 流式调用 */
export async function streamGemini(provider, { model, messages, system, temperature, maxTokens, abortSignal, onDelta }) {
  const contents = messages.map(({ role, content }) => ({
    // Gemini 只接受 user / model 两种角色
    role: role === 'assistant' ? 'model' : 'user',
    parts: [{ text: content }],
  }))

  const body = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  const generationConfig = {}
  if (temperature != null) generationConfig.temperature = temperature
  if (maxTokens != null) generationConfig.maxOutputTokens = maxTokens
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig

  const url = `${provider.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': provider.apiKey,
    },
    body: JSON.stringify(body),
    signal: abortSignal,
  })
  await assertOk(res, provider.name)

  await consumeSSE(res, (json) => {
    const parts = json?.candidates?.[0]?.content?.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part?.text) onDelta(part.text)
      }
    }
  })
}
