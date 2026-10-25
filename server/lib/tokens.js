/**
 * Token 估算与上下文预算。
 *
 * 为什么不引 tiktoken：它是 WASM/原生依赖，装不上还拖慢冷启动；
 * 这里用「CJK 按字计、ASCII 按 3.6 字符计」的经验估算，刻意略微高估。
 * 高估的后果是多裁一点历史，低估的后果是上游直接 400 —— 宁可高估。
 */

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

/** 单条消息的 token：正文 + 附件文本 + 图片 */
export function estimateMessageTokens(message) {
  if (!message) return 0
  let total = MESSAGE_OVERHEAD
  total += estimateTokens(message.content || '')
  for (const att of message.attachments || []) {
    if (att?.type === 'image') total += IMAGE_TOKENS
    else if (att?.text) total += estimateTokens(String(att.text).slice(0, 100_000)) + 8
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
  const headChars = Math.max(1, Math.floor(maxChars * keepRatio))
  const tailChars = Math.max(1, maxChars - headChars)
  const removed = str.length - headChars - tailChars
  const marker = `\n\n…（此处省略 ${removed.toLocaleString()} 字符，原文过长已中段截断）…\n\n`
  return { text: str.slice(0, headChars) + marker + str.slice(str.length - tailChars), truncated: true, removed }
}

/** 按 token 预算反推可用字符数（保守：按纯 ASCII 最省的情况也不超过） */
function charsForTokens(tokens) {
  return Math.max(200, Math.floor(tokens * 3.2))
}

/**
 * 规划一次请求的上下文。
 *
 * @param {object} opts
 * @param {string} opts.system 系统提示词
 * @param {Array} opts.messages 内部消息数组（旧 → 新）
 * @param {number} opts.contextWindow 模型上下文窗口
 * @param {number} opts.maxOutput 本次请求预留的输出 token
 * @param {number} [opts.minKeepMessages] 至少保留最近多少条
 * @returns {{messages: Array, system: string, trimmed: boolean, dropped: number,
 *            truncated: number, estimatedInputTokens: number, budget: number}}
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
  const budget = Math.max(1024, contextWindow - Math.max(1, maxOutput) - safety)

  let systemText = system || ''
  let systemTokens = estimateTokens(systemText)
  // 系统提示词自己就超预算：中段截断，至少还能保留指令头尾
  if (systemTokens > budget * 0.4) {
    const cut = truncateMiddle(systemText, charsForTokens(Math.floor(budget * 0.4)), middleOutKeep)
    systemText = cut.text
    systemTokens = estimateTokens(systemText)
  }

  const available = budget - systemTokens
  const list = Array.isArray(messages) ? messages : []
  const total = estimateMessagesTokens(list)

  if (total <= available) {
    return {
      messages: list,
      system: systemText,
      trimmed: false,
      dropped: 0,
      truncated: 0,
      estimatedInputTokens: systemTokens + total,
      budget,
    }
  }

  // 从最新往前装，装不下就停；最后一条（当前提问）必须保留
  const kept = []
  let used = 0
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i]
    const cost = estimateMessageTokens(msg)
    if (kept.length > 0 && used + cost > available && kept.length >= minKeepMessages) break
    if (used + cost > available && kept.length === 0) {
      // 单条就爆预算：中段截断这一条
      const maxChars = charsForTokens(available)
      const cut = truncateMiddle(msg.content || '', maxChars, middleOutKeep)
      kept.push({ ...msg, content: cut.text })
      used += estimateMessageTokens({ ...msg, content: cut.text })
      break
    }
    kept.push(msg)
    used += cost
  }
  kept.reverse()

  return {
    messages: kept,
    system: systemText,
    trimmed: kept.length < list.length,
    dropped: list.length - kept.length,
    truncated: kept.some((m) => String(m.content || '').includes('原文过长已中段截断')) ? 1 : 0,
    estimatedInputTokens: systemTokens + used,
    budget,
  }
}
