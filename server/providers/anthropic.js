import { consumeSSE, assertOk } from './sse.js'
import { buildTextContent, imageAttachments, parseDataUrl } from './format.js'

/** 组装 Anthropic Messages 的 content blocks（支持图片、工具调用与工具结果） */
function toBlocks(message) {
  if (message.role === 'tool') {
    return [
      {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      },
    ]
  }

  const blocks = []
  const text = buildTextContent(message)
  if (text) blocks.push({ type: 'text', text })
  for (const img of imageAttachments(message)) {
    const parsed = parseDataUrl(img.dataUrl)
    if (parsed) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mime, data: parsed.data } })
    }
  }
  for (const tc of message.tool_calls || []) {
    blocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: typeof tc.arguments === 'string' ? safeParse(tc.arguments) : tc.arguments || {},
    })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: ' ' })
  return blocks
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * 内部消息 → Anthropic messages。
 * Anthropic 要求 user/assistant 交替，且多条 tool_result 必须合并进同一个 user 消息，
 * 所以这里做一次合并，否则上游直接 400。
 */
function toMessages(messages) {
  const out = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const blocks = toBlocks(m)
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content.push(...blocks)
    } else {
      out.push({ role, content: blocks })
    }
  }
  return out
}

/** Anthropic Claude Messages API 流式调用 */
export async function streamAnthropic(
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
    max_tokens: maxTokens ?? 4096,
    messages: toMessages(messages),
    stream: true,
  }
  if (system) body.system = system
  if (temperature != null) body.temperature = temperature
  if (topP != null) body.top_p = topP
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
    if (toolChoice === 'required' || toolChoice === 'auto') {
      body.tool_choice = { type: toolChoice === 'required' ? 'any' : 'auto' }
    }
  }

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

  let promptTokens = 0
  let completionTokens = 0
  let stopReason = null
  /** content block index → 正在累积的 tool_use */
  const blocks = new Map()
  const toolCalls = []

  await consumeSSE(res, (json) => {
    if (json?.type === 'content_block_start') {
      const block = json.content_block
      if (block?.type === 'tool_use') {
        blocks.set(json.index, { id: block.id, name: block.name, arguments: '' })
        onToolCallStart?.(json.index, { id: block.id, name: block.name })
      }
    } else if (json?.type === 'content_block_delta') {
      const delta = json.delta
      if (delta?.type === 'text_delta' && delta.text) onDelta(delta.text)
      else if (delta?.type === 'thinking_delta' && delta.thinking && onReasoning) onReasoning(delta.thinking)
      else if (delta?.type === 'input_json_delta') {
        const pending = blocks.get(json.index)
        if (pending) {
          pending.arguments += delta.partial_json || ''
          onToolCallDelta?.(json.index, delta.partial_json || '')
        }
      }
    } else if (json?.type === 'content_block_stop') {
      const pending = blocks.get(json.index)
      if (pending) {
        toolCalls.push({
          id: pending.id,
          name: pending.name,
          arguments: safeParse(pending.arguments),
          rawArguments: pending.arguments,
        })
        blocks.delete(json.index)
      }
    } else if (json?.type === 'message_start' && json.message?.usage) {
      promptTokens = json.message.usage.input_tokens ?? 0
    } else if (json?.type === 'message_delta') {
      if (json.usage) completionTokens = json.usage.output_tokens ?? 0
      if (json.delta?.stop_reason) stopReason = json.delta.stop_reason
    } else if (json?.type === 'error') {
      throw new Error(json?.error?.message || 'Anthropic 流式错误')
    }
  })

  if (onUsage && (promptTokens || completionTokens)) {
    onUsage({ prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens })
  }

  return {
    finishReason: stopReason === 'tool_use' ? 'tool_calls' : stopReason || 'stop',
    toolCalls,
  }
}
