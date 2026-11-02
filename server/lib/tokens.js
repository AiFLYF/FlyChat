/**
 * Token 估算与上下文预算。
 *
 * 为什么不引 tiktoken：它是 WASM/原生依赖，装不上还拖慢冷启动；
 * 这里用「CJK 按字计、ASCII 按 3.6 字符计」的经验估算，刻意略微高估。
 * 高估的后果是多裁一点历史，低估的后果是上游直接 400 —— 宁可高估。
 */

import { badRequest } from './errors.js'

/** 中日韩字符（含全角标点）：主流分词器基本 1 字 ≈ 1 token 或更少 */
const CJK = /[\u1100-\u11ff\u2e80-\u9fff\u3000-\u303f\u3040-\u30ff\u3130-\u318f\uac00-\ud7af\uff00-\uffef]/

/** 每条消息在协议里还有 role、分隔符等固定开销 */
const MESSAGE_OVERHEAD = 4
/** 一张图片按低清估算；高清图实际更高，但留了安全余量 */
const IMAGE_TOKENS = 1100

export function estimateTokens(text) {
  if (!text) return 0
  const str = String(text)
  let cjk = 0
  for (let i = 0; i < str.length; i += 1) {
    if (CJK.test(str[i])) cjk += 1
  }
  const ascii = str.length - cjk
  return Math.ceil(cjk * 1.05 + ascii / 3.6)
}

/** 单条消息的 token：正文 + 工具调用 + 附件文本 + 图片 */
export function estimateMessageTokens(message) {
  if (!message) return 0
  let total = MESSAGE_OVERHEAD
  total += estimateTokens(message.content || '')
  // agent 轮次里助手的 tool_calls 会原样回传给上游，参数可能很大，不能漏算
  for (const call of message.tool_calls || []) {
    total += 8 + estimateTokens(call?.name || '')
    const args = typeof call?.arguments === 'string' ? call.arguments : JSON.stringify(call?.arguments || {})
    total += estimateTokens(args)
  }
  for (const att of message.attachments || []) {
    if (att?.type === 'image') total += IMAGE_TOKENS
    else if (att?.text) total += estimateTokens(att.text) + estimateTokens(att.name || '文档') + 8
  }
  return total
}

export function estimateMessagesTokens(messages) {
  let total = 0
  for (const m of messages || []) total += estimateMessageTokens(m)
  return total
}

/**
 * 中段截断：保留头尾，中间用标记代替。
 * 用于单条消息就超预算的极端情况（例如粘贴了整个日志文件），
 * 头尾都留着是因为结论往往在开头或结尾。
 */
export function truncateMiddle(text, maxChars, keepRatio = 0.5) {
  const str = String(text || '')
  if (str.length <= maxChars) return { text: str, truncated: false, removed: 0 }
  const chars = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0
  const ratio = Number.isFinite(keepRatio) ? Math.min(1, Math.max(0, keepRatio)) : 0.5
  const headChars = Math.floor(chars * ratio)
  const tailChars = chars - headChars
  const removed = str.length - chars
  const marker = `\n\n…（此处省略 ${removed.toLocaleString()} 字符，原文过长已中段截断）…\n\n`
  return { text: str.slice(0, headChars) + marker + str.slice(str.length - tailChars), truncated: true, removed }
}

/** maxChars 仍表示保留的原文字符数；token 限制必须连中段标记一起实测。 */
export function truncateToTokens(text, maxTokens, keepRatio) {
  const str = String(text || '')
  if (estimateTokens(str) <= maxTokens) return str
  // 小预算放不下完整标记时，用短标记（零预算只能清空），不能设置最小字符数。
  let result = maxTokens >= estimateTokens('…') ? '…' : ''
  let low = 0
  let high = str.length - 1
  while (low <= high) {
    const chars = Math.floor((low + high) / 2)
    const cut = truncateMiddle(str, chars, keepRatio)
    if (estimateTokens(cut.text) <= maxTokens) {
      result = cut.text
      low = chars + 1
    } else {
      high = chars - 1
    }
  }
  return result
}

/** 最新消息不能丢：先预留图片及附件包装开销，再按文本大小分配剩余预算。 */
function truncateMessage(message, budget, keepRatio) {
  const attachments = message.attachments || []
  let fixed = MESSAGE_OVERHEAD
  let textTokens = estimateTokens(message.content || '')
  for (const att of attachments) {
    if (att?.type === 'image') fixed += IMAGE_TOKENS
    else if (att?.text) {
      fixed += estimateTokens(att.name || '文档') + 8
      textTokens += estimateTokens(att.text)
    }
  }
  if (fixed > budget) {
    throw badRequest('消息的图片、附件或协议开销超出上下文预算，请减少附件或预留输出，或更换长上下文模型', 'context_overflow')
  }
  const available = budget - fixed
  const cutText = (text) => truncateToTokens(
    text,
    textTokens > 0 ? Math.floor(available * estimateTokens(text) / textTokens) : 0,
    keepRatio,
  )
  return {
    ...message,
    content: cutText(message.content || ''),
    ...(message.attachments ? {
      attachments: attachments.map((att) => att?.type !== 'image' && att?.text
        ? { ...att, text: cutText(att.text) }
        : att),
    } : {}),
  }
}

/**
 * 规划一次请求的上下文。
 *
 * @param {object} opts
 * @param {string} opts.system 系统提示词
 * @param {Array} opts.messages 内部消息数组（旧 → 新）
 * @param {number} opts.contextWindow 模型上下文窗口
 * @param {number} opts.maxOutput 本次请求预留的输出 token
 * @param {number} [opts.minKeepMessages] 尽量保留的最近消息数，允许截短但绝不突破预算
 * @returns {{messages: Array, system: string, trimmed: boolean, dropped: number,
 *            truncated: number, estimatedInputTokens: number, budget: number}}
 * truncated 统计截短的消息数（含附件），system 截短另计一次；trimmed 表示发生任何裁剪。
 */
export function planContext({
  system = '',
  messages = [],
  contextWindow = 32768,
  maxOutput = 4096,
  minKeepMessages = 4,
  middleOutKeep = 0.5,
}) {
  // 安全余量：估算误差 + 协议开销 + 系统提示词的隐藏部分
  const safety = Math.ceil(contextWindow * 0.05)
  const budget = contextWindow - Math.max(1, maxOutput) - safety
  if (!Number.isFinite(budget) || budget <= 0) {
    throw badRequest('预留输出和安全余量后没有可用的上下文空间，请减少预留输出或更换长上下文模型', 'context_overflow')
  }

  const originalSystem = String(system || '')
  // 系统提示词最多占 40%；截断标记也必须计入预算。
  const systemText = truncateToTokens(originalSystem, Math.floor(budget * 0.4), middleOutKeep)
  const systemTokens = estimateTokens(systemText)
  let truncated = Number(systemText !== originalSystem)
  const available = budget - systemTokens
  const list = Array.isArray(messages) ? messages : []
  const total = estimateMessagesTokens(list)

  if (total <= available) {
    return {
      messages: list,
      system: systemText,
      trimmed: truncated > 0,
      dropped: 0,
      truncated,
      estimatedInputTokens: systemTokens + total,
      budget,
    }
  }

  // 最新消息优先；minKeepMessages 仅尝试截短较早的消息，不挤占已保留消息的预算。
  const keepTarget = Number.isFinite(minKeepMessages) ? Math.max(1, Math.floor(minKeepMessages)) : 1
  const kept = []
  let used = 0
  for (let i = list.length - 1; i >= 0; i -= 1) {
    let msg = list[i]
    let cost = estimateMessageTokens(msg)
    const remaining = available - used
    if (cost > remaining) {
      if (kept.length >= keepTarget) break
      try {
        msg = truncateMessage(msg, remaining, middleOutKeep)
      } catch (err) {
        // 旧消息连固定开销都放不下时停止；最新消息放不下必须明确报 400。
        if (kept.length > 0 && err?.code === 'context_overflow') break
        throw err
      }
      cost = estimateMessageTokens(msg)
      truncated += 1
    }
    kept.push(msg)
    used += cost
  }
  kept.reverse()

  return {
    messages: kept,
    system: systemText,
    trimmed: kept.length < list.length || truncated > 0,
    dropped: list.length - kept.length,
    truncated,
    estimatedInputTokens: systemTokens + used,
    budget,
  }
}
