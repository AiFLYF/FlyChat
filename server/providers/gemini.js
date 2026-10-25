import { consumeSSE, assertOk } from './sse.js'
import { buildTextContent, imageAttachments, parseDataUrl } from './format.js'

/** 组装 Gemini 的 parts（文本 + inlineData 图片 + functionCall / functionResponse） */
function toParts(message) {
  if (message.role === 'tool') {
    const payload = typeof message.content === 'string' ? safeParse(message.content) : message.content
    return [{ functionResponse: { name: message.name || 'tool', response: { result: payload } } }]
  }

  const parts = []
  const text = buildTextContent(message)
  if (text) parts.push({ text })
  for (const img of imageAttachments(message)) {
    const parsed = parseDataUrl(img.dataUrl)
    if (parsed) parts.push({ inlineData: { mimeType: parsed.mime, data: parsed.data } })
  }
  for (const tc of message.tool_calls || []) {
    parts.push({
      functionCall: {
        name: tc.name,
        args: typeof tc.arguments === 'string' ? safeParse(tc.arguments) : tc.arguments || {},
      },
    })
  }
  if (parts.length === 0) parts.push({ text: ' ' })
  return parts
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Google Gemini generateContent 流式调用 */
export async function streamGemini(
  provider,
  {
    model,
    messages,
    system,
    temperature,
    topP,
    maxTokens,
    tools,
    toolChoice,
    abortSignal,
    onDelta,
    onReasoning,
    onUsage,
    onToolCallStart,
  }
) {
  const contents = messages.map((m) => ({
    // Gemini 只接受 user / model 两种角色
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: toParts(m),
  }))

  const body = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (tools?.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ]
    if (toolChoice === 'required') body.toolConfig = { functionCallingConfig: { mode: 'ANY' } }
  }

  const generationConfig = {}
  if (temperature != null) generationConfig.temperature = temperature
  if (topP != null) generationConfig.topP = topP
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

  const toolCalls = []
  let finishReason = null

  await consumeSSE(res, (json) => {
    const candidate = json?.candidates?.[0]
    const parts = candidate?.content?.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part?.thought && part?.text) {
          if (onReasoning) onReasoning(part.text)
        } else if (part?.functionCall) {
          // Gemini 的函数调用是一次性给全的，没有增量片段
          const call = {
            id: `call_${toolCalls.length}`,
            name: part.functionCall.name,
            arguments: part.functionCall.args || {},
            rawArguments: JSON.stringify(part.functionCall.args || {}),
          }
          toolCalls.push(call)
          onToolCallStart?.(toolCalls.length - 1, call)
        } else if (part?.text) {
          onDelta(part.text)
        }
      }
    }
    if (candidate?.finishReason) finishReason = candidate.finishReason
    if (json?.usageMetadata && onUsage) {
      onUsage({
        prompt: json.usageMetadata.promptTokenCount ?? 0,
        completion: json.usageMetadata.candidatesTokenCount ?? 0,
        total: json.usageMetadata.totalTokenCount ?? 0,
      })
    }
  })

  return {
    finishReason: toolCalls.length ? 'tool_calls' : finishReason === 'STOP' ? 'stop' : finishReason || 'stop',
    toolCalls,
  }
}
