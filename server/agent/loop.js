import { streamChat } from '../providers/stream.js'
import { executeTool } from '../tools/index.js'
import { estimateMessagesTokens, estimateMessageTokens, estimateTokens, truncateToTokens } from '../lib/tokens.js'

const FINAL_PROMPT = '请基于以上已经获得的信息直接给出最终回答，不要再调用工具。如果信息不足，就说明缺少什么。'

const OMITTED_TOOL_RESULT = JSON.stringify({
  ok: false,
  omitted: true,
  error: '较早的工具结果已被省略以适配上下文；如需该信息请重新调用工具',
})

/**
 * 工具轮次会往历史里不断追加结果，几轮之后可能撑爆小窗口模型的上下文。
 * 预算口径与 lib/tokens.js 一致：窗口 − 输出预留 − 5% 安全余量。
 *
 * 按「信息价值从低到高」处理：
 * 1. 较早的工具结果整条换成省略标记；
 * 2. 最新一条工具结果中段截断（保留头尾）；
 * 3. 仍放不下就整组丢弃最早的「助手 tool_calls + 结果」，但始终保留最后一组。
 * 原地修改 history，确保 assistant.tool_calls 与 tool.tool_call_id 始终配对。
 */
export function fitHistoryForWindow(history, {
  system = '',
  contextWindow,
  maxTokens = 4096,
  toolDefs = [],
  reserveTokens = 0,
} = {}) {
  const window = Number(contextWindow)
  if (!Number.isFinite(window) || window <= 0) return { trimmed: false, omitted: 0, dropped: 0 }

  const budget = window - Math.max(1, Number(maxTokens) || 1) - Math.ceil(window * 0.05)
  const fixed = estimateTokens(system)
    + (toolDefs.length ? estimateTokens(JSON.stringify(toolDefs)) : 0)
    + Math.max(0, Number(reserveTokens) || 0)
  let total = fixed + estimateMessagesTokens(history)
  if (total <= budget) return { trimmed: false, omitted: 0, dropped: 0 }

  const toolIndexes = []
  for (let i = 0; i < history.length; i += 1) {
    if (history[i]?.role === 'tool') toolIndexes.push(i)
  }
  const newestTool = toolIndexes[toolIndexes.length - 1]
  let omitted = 0

  for (const i of toolIndexes) {
    if (total <= budget) break
    // 最新一条通常就是模型下一步要用的，留到第二遍做中段截断
    if (i === newestTool) continue
    const before = estimateMessageTokens(history[i])
    const next = { ...history[i], content: OMITTED_TOOL_RESULT }
    const after = estimateMessageTokens(next)
    if (after >= before) continue
    history[i] = next
    total -= before - after
    omitted += 1
  }

  if (total > budget && newestTool !== undefined && history[newestTool].content !== OMITTED_TOOL_RESULT) {
    const msg = history[newestTool]
    const before = estimateMessageTokens(msg)
    // 留给正文的预算要把这条消息的固定开销再扣掉，否则会超预算几个 token
    const allowed = budget - (total - before) - 16
    const content = allowed > 16
      ? truncateToTokens(String(msg.content || ''), allowed)
      : OMITTED_TOOL_RESULT
    const next = { ...msg, content }
    const after = estimateMessageTokens(next)
    if (after < before) {
      history[newestTool] = next
      total -= before - after
      omitted += 1
    }
  }

  let dropped = 0
  while (total > budget) {
    const groups = []
    for (let i = 0; i < history.length; i += 1) {
      const m = history[i]
      if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue
      const ids = new Set(m.tool_calls.map((c) => c.id))
      let end = i + 1
      while (end < history.length && history[end]?.role === 'tool' && ids.has(history[end].tool_call_id)) end += 1
      groups.push({ start: i, end })
    }
    if (groups.length <= 1) break
    const group = groups[0]
    total -= estimateMessagesTokens(history.slice(group.start, group.end))
    history.splice(group.start, group.end - group.start)
    dropped += group.end - group.start
  }

  return { trimmed: omitted > 0 || dropped > 0, omitted, dropped }
}

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
  maxTokens,
  toolDefs,
  maxSteps = 4,
  /** 模型上下文窗口；不传则不做轮次间裁剪（兼容直接调用） */
  contextWindow,
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
  let historyTrimmed = false

  const fitHistory = (reserveTokens = 0) => {
    const fitted = fitHistoryForWindow(history, {
      system,
      contextWindow,
      maxTokens,
      toolDefs: toolDefs || [],
      reserveTokens,
    })
    if (fitted.trimmed && !historyTrimmed) {
      historyTrimmed = true
      onNotice?.(`工具返回的内容较多，已压缩较早的工具结果以适配 ${Number(contextWindow).toLocaleString()} token 上下文`)
    }
    return fitted
  }

  for (; steps < maxSteps; steps += 1) {
    fitHistory()
    const result = await streamChat(provider, {
      model,
      messages: history,
      system,
      maxTokens,
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
  fitHistory(estimateTokens(FINAL_PROMPT))
  const finalResult = await streamChat(provider, {
    model,
    messages: [
      ...history,
      {
        role: 'user',
        content: FINAL_PROMPT,
      },
    ],
    system,
    maxTokens,
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
