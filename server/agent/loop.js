import { streamChat } from '../providers/stream.js'
import { executeTool } from '../tools/index.js'

/**
 * 服务端 agent 循环。
 *
 * 模型说「我要调 web_search」→ 服务端执行 → 把结果塞回对话 → 模型继续，
 * 直到它给出最终回答或步数用尽。整个过程对前端仍然只是一条 SSE 流。
 *
 * 为什么要有步数上限：模型可能反复调同一个工具（尤其参数理解错时），
 * 没有上限就是无限烧钱。这里还额外做了「同参数重复调用」检测。
 */
export async function runAgentLoop({
  provider,
  model,
  messages,
  system,
  toolDefs,
  maxSteps = 4,
  signal,
  fallbacks,
  onFallback,
  onDelta,
  onReasoning,
  onUsage,
  onToolCallStart,
  onToolCallDelta,
  onToolCall,
  onToolResult,
  onCitations,
  onNotice,
  /** 工具产出的图片：直接推给前端，不塞进模型上下文 */
  onImages,
  /** MCP 工具索引：name → {serverId, toolName, serverName, trusted, destructive} */
  mcpIndex,
  /** MCP 工具执行回调（由路由层注入，避免这里直接依赖 MCP 运行时） */
  onExecuteMcp,
}) {
  const history = [...messages]
  const seenCalls = new Set()
  let steps = 0

  for (; steps < maxSteps; steps += 1) {
    const result = await streamChat(provider, {
      model,
      messages: history,
      system,
      tools: toolDefs,
      abortSignal: signal,
      fallbacks,
      onFallback,
      onDelta,
      onReasoning,
      onUsage,
      onToolCallStart: (index, call) => onToolCallStart?.(steps, index, call),
      onToolCallDelta: (index, chunk) => onToolCallDelta?.(steps, index, chunk),
    })

    const calls = result?.toolCalls || []
    if (result?.finishReason !== 'tool_calls' || calls.length === 0) {
      return {
        steps: steps + 1,
        usedTools: steps > 0,
        finishReason: result?.finishReason || 'stop',
        provider: result?.provider || provider,
        model: result?.model || model,
      }
    }

    // 把「模型要调工具」这件事写回历史，否则下一轮它看不到自己调过什么
    history.push({ role: 'assistant', content: '', tool_calls: calls })

    let executedAny = false
    for (const call of calls) {
      const signature = `${call.name}:${JSON.stringify(call.arguments || {})}`
      if (seenCalls.has(signature)) {
        // 同参数重复调用：直接回一条提示，别让它无限转圈
        history.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify({ ok: false, error: '这个工具已经用相同参数调用过了，请直接基于已有结果作答' }),
        })
        continue
      }
      seenCalls.add(signature)
      executedAny = true

      onNotice?.(describeCall(call))
      onToolCall?.(call)

      // MCP 工具交给注入的执行器（未信任的 server 会被它挡下）
      const mcpMeta = mcpIndex?.get(call.name)
      const outcome = mcpMeta
        ? await onExecuteMcp?.({ ...mcpMeta, call, arguments: call.arguments })
        : await executeTool(call.name, call.arguments, {
            signal,
            emitCitations: onCitations,
            emitImages: onImages,
            // 让工具知道「当前在跟哪个服务商对话」（图像生成会优先用它出图）
            providerId: provider.id,
          })
      onToolResult?.(call, outcome)

      history.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: JSON.stringify(outcome).slice(0, 20_000),
      })
    }

    if (!executedAny) {
      // 全是重复调用，再循环也没意义：让模型直接作答
      break
    }
  }

  // 步数用尽 / 全是重复调用：不给工具，强制它基于已有信息收尾
  const finalResult = await streamChat(provider, {
    model,
    messages: [
      ...history,
      {
        role: 'user',
        content: '请基于以上已经获得的信息直接给出最终回答，不要再调用工具。如果信息不足，就说明缺少什么。',
      },
    ],
    system,
    tools: [],
    abortSignal: signal,
    fallbacks,
    onFallback,
    onDelta,
    onReasoning,
    onUsage,
  })

  return {
    steps: steps + 1,
    usedTools: true,
    finishReason: 'max_steps',
    provider: finalResult?.provider || provider,
    model: finalResult?.model || model,
  }
}

/** 给用户看的一句话进度提示 */
function describeCall(call) {
  const args = call.arguments || {}
  if (call.name === 'web_search') return `正在联网搜索：${args.query || ''}`
  if (call.name === 'fetch_url') return `正在读取网页：${args.url || ''}`
  if (call.name === 'current_time') return '正在获取当前时间'
  return `正在调用工具：${call.name}`
}
