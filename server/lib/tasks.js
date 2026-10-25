import { estimateCost, getModelInfo } from '../catalog/models.js'
import { estimateMessagesTokens, estimateTokens } from './tokens.js'
import { streamChat } from '../providers/stream.js'
import { recordUsage } from '../store/usage.js'
import { resolveProvider } from '../providers/registry.js'
import { resolveTaskModel } from './task-model.js'
import { badRequest } from './errors.js'

/**
 * 「小任务」统一入口。
 *
 * 为什么单独抽一层：标题、摘要、追问建议、改写选中段落这些活，
 * 入参出参都不一样，但骨架完全一样——选一个便宜的模型、跑一次短请求、
 * 解析结果、记用量。分散写会变成四份几乎相同的代码，然后各自漂移。
 *
 * 每个任务只描述三件事：系统提示、用户消息怎么拼、输出怎么解析。
 */

/** 把消息数组压成纯文本（只保留有内容的 user/assistant） */
function transcript(messages, { maxPerMessage = 800, maxMessages = 12 } = {}) {
  if (!Array.isArray(messages)) return ''
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .slice(-maxMessages)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content).slice(0, maxPerMessage)}`)
    .join('\n\n')
}

/**
 * 去掉编号、首尾引号、句末标点。
 *
 * 要跑两轮：`“标题”。` 这种「引号里面还包着句号」的情况，
 * 单轮处理会先剥掉句号、把引号留在末尾（真实踩到过）。
 */
function cleanLine(text) {
  let out = String(text || '').trim()
  for (let i = 0; i < 2; i += 1) {
    out = out
      .replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, '')
      .replace(/[。！？!?.,，;；:：]+$/g, '')
      .replace(/^["'“”‘’「」《》\s]+|["'“”‘’「」《》\s]+$/g, '')
      .trim()
  }
  return out
}

const TONES = {
  concise: '把这段话改得更简洁，删掉冗余修饰与重复表达，保留全部关键信息。',
  formal: '把这段话改得更正式、更书面化，适合写在文档或邮件里。',
  casual: '把这段话改得更口语、更自然，像面对面聊天。',
  expand: '把这段话扩写得更详细，补充必要的解释与例子，但不要编造事实。',
  polish: '润色这段话：修正语病、让表达更通顺，意思不要变。',
  translate: '把这段话翻译成英文，保持原意与语气。',
  translate_zh: '把这段话翻译成简体中文，保持原意与语气。',
}

const KINDS = {
  title: {
    maxTokens: 64,
    temperature: 0.2,
    system:
      '你是一个标题生成器。用不超过 12 个汉字概括用户这段话的主题，直接输出标题本身，不要引号、不要句号、不要解释。',
    build(input) {
      const text = String(input.text || '').trim() || transcript(input.messages, { maxMessages: 6 })
      if (!text) throw badRequest('缺少 text 或 messages', 'missing_text')
      return [{ role: 'user', content: text.slice(0, 2000) }]
    },
    parse(raw, input) {
      const maxChars = Math.min(60, Math.max(4, Number(input.maxChars) || 24))
      return { title: cleanLine(raw.split('\n')[0]).slice(0, maxChars) || '新会话' }
    },
  },

  summary: {
    maxTokens: 400,
    temperature: 0.3,
    system:
      '你是一个对话摘要器。用 2–3 句话概括这段对话：讨论了什么、得出了什么结论、还有什么没解决。' +
      '不超过 120 字。直接输出摘要本身，不要「这段对话」之类的开头，不要 Markdown。',
    build(input) {
      const text = String(input.text || '').trim() || transcript(input.messages)
      if (!text) throw badRequest('缺少 text 或 messages', 'missing_text')
      return [{ role: 'user', content: text.slice(0, 8000) }]
    },
    parse(raw) {
      const summary = String(raw || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400)
      return { summary }
    },
  },

  suggest: {
    maxTokens: 200,
    temperature: 0.7,
    system:
      '你是对话助手的「下一步建议」生成器。基于这段对话，给出用户最可能接着问的 3 个问题。\n' +
      '要求：\n' +
      '1. 每个问题不超过 20 个字；\n' +
      '2. 必须具体，能从对话内容直接推出来，不要泛泛而谈；\n' +
      '3. 不要重复用户已经问过的；\n' +
      '4. 只输出问题，每行一个，不要编号、不要解释。',
    build(input) {
      const text = String(input.text || '').trim() || transcript(input.messages)
      if (!text) throw badRequest('缺少 text 或 messages', 'missing_text')
      return [{ role: 'user', content: text.slice(0, 6000) }]
    },
    parse(raw) {
      const suggestions = String(raw || '')
        .split('\n')
        .map(cleanLine)
        .filter((line) => line.length >= 2 && line.length <= 40)
        .slice(0, 3)
      return { suggestions }
    },
  },

  rewrite: {
    maxTokens: 1200,
    temperature: 0.5,
    system: '你是一个文字编辑。只输出改写后的正文本身，不要解释、不要加引号、不要「以下是改写后的版本」这类前缀。',
    build(input) {
      const text = String(input.text || '').trim()
      if (!text) throw badRequest('缺少 text', 'missing_text')
      if (text.length > 20000) throw badRequest('要改写的内容过长（上限 20000 字）', 'text_too_long')

      const tone = String(input.tone || 'polish')
      const instruction = TONES[tone]
      if (!instruction) {
        throw badRequest(`不支持的改写风格：${tone}（可选：${Object.keys(TONES).join(' / ')}）`, 'invalid_tone')
      }
      const extra = input.instruction ? `\n\n额外要求：${String(input.instruction).slice(0, 500)}` : ''
      return [{ role: 'user', content: `${instruction}${extra}\n\n原文：\n${text}` }]
    },
    parse(raw) {
      return { text: String(raw || '').trim() }
    },
  },
}

export const TASK_KINDS = Object.keys(KINDS)

export function describeTones() {
  return Object.entries(TONES).map(([key, instruction]) => ({ key, instruction }))
}

/** 统一解析「用哪个模型」：显式指定优先，否则按子任务选便宜模型 */
function pickModel(kind, { provider: providerId, model } = {}) {
  if (providerId && model) {
    const provider = resolveProvider(providerId)
    if (!provider) {
      throw badRequest(`提供商 "${providerId}" 未配置或不可用`, 'provider_unavailable')
    }
    return { provider, model, dedicated: false }
  }
  const choice = resolveTaskModel(kind)
  if (!choice?.provider?.id || !choice.model) {
    throw badRequest('还没有可用的服务商，请先在「设置 → 模型服务」里配置', 'provider_unavailable')
  }
  return { provider: choice.provider, model: choice.model, dedicated: true }
}

/**
 * 跑一个小任务。
 *
 * @param {string} kind 见 TASK_KINDS
 * @param {object} input 任务入参
 * @param {{ provider?: string, model?: string, signal?: AbortSignal, record?: boolean }} options
 * @returns {Promise<{ result: object, model: string, provider: string, dedicated: boolean, usage: object, costUsd: number }>}
 */
export async function runTask(kind, input = {}, { provider: providerId, model, signal, record = true } = {}) {
  const task = KINDS[kind]
  if (!task) {
    throw badRequest(`不支持的任务类型：${kind}（可选：${TASK_KINDS.join(' / ')}）`, 'unknown_task')
  }

  const messages = task.build(input)
  const picked = pickModel(kind, { provider: providerId, model })
  const info = getModelInfo(picked.provider.id, picked.model)

  let raw = ''
  let usage = null
  await streamChat(picked.provider, {
    model: picked.model,
    messages,
    system: task.system,
    temperature: task.temperature,
    topP: 1,
    maxTokens: Math.min(task.maxTokens, info.maxOutput),
    abortSignal: signal,
    onDelta: (t) => {
      raw += t
    },
    onUsage: (u) => {
      usage = { prompt: u.prompt || 0, completion: u.completion || 0, total: u.total || 0 }
    },
  })

  const finalUsage = usage || {
    prompt: estimateMessagesTokens(messages) + estimateTokens(task.system),
    completion: estimateTokens(raw),
    total: 0,
    estimated: true,
  }
  if (!finalUsage.total) finalUsage.total = finalUsage.prompt + finalUsage.completion
  const costUsd = estimateCost(info, finalUsage)

  // 小任务也要记账：不然「一天几百次标题生成」的成本在报表里完全看不见
  if (record) {
    recordUsage({
      provider: picked.provider.id,
      model: picked.model,
      ...finalUsage,
      costUsd,
      status: 'ok',
    })
  }

  return {
    result: task.parse(raw, input),
    model: picked.model,
    provider: picked.provider.id,
    dedicated: picked.dedicated,
    usage: finalUsage,
    costUsd,
  }
}
