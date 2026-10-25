import crypto from 'node:crypto'
import { resolveTaskModel } from './task-model.js'
import { streamChat } from '../providers/stream.js'
import { getSummary, saveSummary } from '../store/summary.js'

/**
 * 摘要式上下文压缩。
 *
 * 原来的做法是「丢最早的 N 条」——用户会感觉助手突然失忆。
 * 这里改成：被丢弃的那段历史先让一个小模型总结成一段文字，作为背景注入，
 * 这样即使裁掉了原文，结论和承诺仍然延续。
 *
 * 三个关键点：
 * 1. **用便宜的小模型**做摘要，别用主模型（主模型可能是 o3/claude-opus 级别的）。
 * 2. **按被丢弃消息集合缓存**，命中就不再花钱。
 * 3. **失败不致命**：摘要失败就退回纯裁剪，绝不因此让对话失败。
 */

const SUMMARY_SYSTEM = [
  '你是对话压缩器。把用户给定的多轮对话压缩成一段连贯的背景说明，供后续对话续接使用。',
  '要求：',
  '1. 保留所有仍然有效的事实、决定、用户偏好、未完成的任务；',
  '2. 省略寒暄、重复的尝试过程、已经被推翻的方案；',
  '3. 用第三人称客观叙述（"用户…"/"助手…"），不要出现"这段对话"之类的元描述；',
  '4. 控制在 300 字以内，超出时优先保留近期内容。',
].join('\n')

const SUMMARY_MAX_TOKENS = 800

/** 被丢弃消息的 id 集合 → 稳定 key（同样的前缀就用缓存里的摘要） */
export function buildPrefixKey(messages) {
  const ids = (messages || []).map((m) => m.id || `${m.role}:${m.createdAt || ''}`).join('|')
  return crypto.createHash('sha1').update(ids).digest('hex').slice(0, 24)
}

/** 把消息转成喂给摘要器的纯文本 */
function toTranscript(messages) {
  return (messages || [])
    .map((m) => `${m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role}：${String(m.content || '').slice(0, 2000)}`)
    .join('\n\n')
}

/**
 * 摘要用哪个模型 —— 复用子任务模型选择器（见 lib/task-model.js）。
 * 保留这个名字是因为调用方读起来更直接：「我要一个摘要器」。
 */
export function resolveSummarizer(primaryProviderId) {
  return resolveTaskModel('summary', primaryProviderId)
}

/**
 * 压缩被丢弃的历史。
 * @param {{dropped: Array, provider?: object, signal?: AbortSignal, useCache?: boolean}} options
 * @returns {Promise<{summary: string, cached: boolean, tokens: number, model: string} | null>}
 */
export async function summarizeDropped({ dropped, provider, signal, useCache = true }) {
  if (!Array.isArray(dropped) || dropped.length === 0) return null
  const prefixKey = buildPrefixKey(dropped)
  if (useCache) {
    const cached = getSummary(prefixKey)
    if (cached) return { ...cached, cached: true }
  }

  const choice = resolveSummarizer(provider?.id)
  if (!choice?.provider?.id || !choice.model) return null
  const summarizer = choice.provider
  const summarizerModel = choice.model
  const transcript = toTranscript(dropped)
  if (!transcript) return null

  let summary = ''
  try {
    await streamChat(summarizer, {
      model: summarizerModel,
      messages: [{ role: 'user', content: transcript }],
      system: SUMMARY_SYSTEM,
      temperature: 0.2,
      topP: 1,
      maxTokens: SUMMARY_MAX_TOKENS,
      abortSignal: signal,
      onDelta: (t) => {
        summary += t
      },
    })
  } catch (err) {
    // 摘要失败不该让对话失败：退回纯裁剪
    return { summary: '', cached: false, failed: true, error: err?.message || String(err), tokens: 0, model: summarizerModel }
  }

  summary = summary.trim().slice(0, 4000)
  if (!summary) return null
  if (useCache) {    saveSummary({
      prefixKey,
      summary,
      messageCount: dropped.length,
      tokens: Math.ceil(summary.length / 2),
      model: summarizerModel,
    })
  }
  return { summary, cached: false, tokens: Math.ceil(summary.length / 2), model: summarizerModel }
}

/** 注入到 system 提示里的包裹块 */
export function wrapSummary(summary) {
  return [
    '【早期对话摘要】',
    '以下是本段对话较早内容的摘要，用于替代被裁剪掉的原文。请把它当作已知背景延续对话：',
    summary,
    '【摘要结束】',
  ].join('\n')
}

