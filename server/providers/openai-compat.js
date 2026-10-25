import { consumeSSE, assertOk } from './sse.js'
import { buildTextContent, imageAttachments } from './format.js'

/** 组装 OpenAI 兼容的 content（纯文本或 多模态 parts 数组） */
function toContent(message) {
  const text = buildTextContent(message)
  const images = imageAttachments(message)
  if (images.length === 0) return text
  const parts = [{ type: 'text', text: text || ' ' }]
  for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
  return parts
}

/**
 * 内部消息 → OpenAI 消息。
 * 工具相关的三种形态必须原样还原，否则模型看不到自己上一轮的工具调用：
 *   assistant + tool_calls / tool（工具结果）
 */
function toMessage(message) {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    }
  }
  if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
        },
      })),
    }
  }
  return { role: message.role, content: toContent(message) }
}

/** o 系列 / gpt-5 用 max_completion_tokens，其余仍用 max_tokens */
function tokenLimitField(model) {
  return /^(o\d|gpt-5)/i.test(String(model)) ? 'max_completion_tokens' : 'max_tokens'
}

/**
 * OpenAI 兼容接口流式调用（OpenAI / DeepSeek / Kimi / GLM / Qwen / 豆包 / 硅基流动 / Groq / OpenRouter / Ollama）
 *
 * 支持 function calling：把 delta.tool_calls 按 index 累积成完整调用，
 * 流结束后通过返回值交给上层（agent loop）执行。
 */
export async function streamOpenAICompat(
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
    onToolCallDelta,
  }
) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map(toMessage),
    ],
    stream: true,
  }
  if (provider.supportsUsage) body.stream_options = { include_usage: true }
  if (temperature != null) body.temperature = temperature
  if (topP != null) body.top_p = topP
  if (maxTokens != null) body[tokenLimitField(model)] = maxTokens
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    if (toolChoice) body.tool_choice = toolChoice
  }

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

  /** 按 index 累积，OpenAI 会把同一个调用的 name/arguments 拆成多个 chunk 发 */
  const pending = []
  let finishReason = null

  await consumeSSE(res, (json) => {
    const choice = json?.choices?.[0]
    const delta = choice?.delta
    if (delta) {
      // DeepSeek-R1 / reasoner 等把思考过程放在 reasoning_content
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (reasoning && onReasoning) onReasoning(reasoning)
      if (delta.content) onDelta(delta.content)

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = Number.isInteger(tc.index) ? tc.index : pending.length
          if (!pending[index]) {
            pending[index] = { id: tc.id || `call_${index}`, name: '', arguments: '' }
            onToolCallStart?.(index, pending[index])
          }
          if (tc.id) pending[index].id = tc.id
          if (tc.function?.name) pending[index].name += tc.function.name
          if (tc.function?.arguments) {
            pending[index].arguments += tc.function.arguments
            onToolCallDelta?.(index, tc.function.arguments)
          }
        }
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (json?.usage && onUsage) {
      onUsage({
        prompt: json.usage.prompt_tokens ?? 0,
        completion: json.usage.completion_tokens ?? 0,
        total: json.usage.total_tokens ?? 0,
      })
    }
  })

  return {
    finishReason: finishReason || (pending.length ? 'tool_calls' : 'stop'),
    toolCalls: pending.filter(Boolean).map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.name,
      // 上游偶尔给出不合法 JSON，原样保留让上层报错更清楚
      arguments: safeParse(tc.arguments),
      rawArguments: tc.arguments,
    })),
  }
}

function safeParse(text) {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { __raw: text }
  }
}
