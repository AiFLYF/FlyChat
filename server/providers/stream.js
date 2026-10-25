import { streamOpenAICompat } from './openai-compat.js'
import { streamAnthropic } from './anthropic.js'
import { streamGemini } from './gemini.js'
import { isRetryable, breakerFor, semaphoreFor, withRetry } from '../lib/resilience.js'
import { AppError } from '../lib/errors.js'
import { config } from '../config.js'

const ADAPTERS = {
  'openai-compat': streamOpenAICompat,
  anthropic: streamAnthropic,
  gemini: streamGemini,
}

/** 组合多个 AbortSignal（兼容尚未提供 AbortSignal.any 的 Node 版本） */
function combineSignals(signals) {
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason)
      break
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

/**
 * 对单个候选（provider + model）做一次完整尝试：
 * 并发闸门 → 熔断 → 指数退避重试 → 协议适配器。
 */
async function attempt({ provider, model, options, onStarted }) {
  const adapter = ADAPTERS[provider.type]
  if (!adapter) {
    throw new AppError(`未知的提供商类型: ${provider.type}`, { status: 500, code: 'unknown_provider_type' })
  }

  const key = provider.id || provider.name
  const breaker = breakerFor(key, {
    threshold: config.chat.breakerThreshold,
    cooldownMs: config.chat.breakerCooldownMs,
  })

  const cooldown = breaker.check()
  if (cooldown != null) {
    throw new AppError(
      `${provider.name} 连续失败已临时停用，请 ${Math.ceil(cooldown / 1000)} 秒后重试`,
      { status: 503, code: 'provider_circuit_open' }
    )
  }

  const sem = semaphoreFor(key, config.chat.concurrency)

  return sem.run(async () => {
    let started = false
    const markStarted = () => {
      started = true
      onStarted?.()
    }

    const wrapped = {
      ...options,
      model,
      onDelta: (text) => {
        markStarted()
        options.onDelta?.(text)
      },
      onReasoning: (text) => {
        markStarted()
        options.onReasoning?.(text)
      },
      // 工具调用一旦开始往外发，同样不能重试（否则前端会收到两份调用）
      onToolCallStart: (index, call) => {
        markStarted()
        options.onToolCallStart?.(index, call)
      },
      onToolCallDelta: (index, chunk) => {
        markStarted()
        options.onToolCallDelta?.(index, chunk)
      },
    }

    try {
      const result = await withRetry(
        async () => {
          started = false
          const signals = [AbortSignal.timeout(config.chat.timeoutMs)]
          if (options.abortSignal) signals.push(options.abortSignal)
          return await adapter(provider, { ...wrapped, abortSignal: combineSignals(signals) })
        },
        {
          retries: config.chat.retries,
          baseMs: config.chat.retryBaseMs,
          maxMs: config.chat.retryMaxMs,
          signal: options.abortSignal,
          shouldRetry: (err) => !started && isRetryable(err),
          onRetry: options.onRetry,
          label: key,
        }
      )
      breaker.onSuccess()
      return result || { finishReason: 'stop', toolCalls: [] }
    } catch (err) {
      // 客户端主动取消不算上游故障，不能计入熔断
      if (!options.abortSignal?.aborted) breaker.onFailure()
      throw err
    }
  })
}

/**
 * 统一流式入口。
 *
 * 容错分三层，顺序不能乱：
 * 1. **重试**：同一个模型 429/5xx/网络抖动，退避后再试（还没吐字节才试）；
 * 2. **熔断**：连续失败的服务商直接摘除一段时间，不再让每个用户去撞；
 * 3. **降级**：主模型彻底不可用时，按 `options.fallbacks` 换下一个模型/服务商。
 *
 * 第 3 层只在「一个字都还没发出去」时发生，否则用户会看到两段拼接的回答。
 */
export async function streamChat(provider, options) {
  const candidates = [
    { provider, model: options.model },
    ...(options.fallbacks || []).filter(Boolean),
  ]

  let emittedAny = false
  let lastError = null

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]
    try {
      const result = await attempt({
        provider: candidate.provider,
        model: candidate.model,
        options,
        onStarted: () => {
          emittedAny = true
        },
      })
      return { ...result, provider: candidate.provider, model: candidate.model, usedFallback: i > 0 }
    } catch (err) {
      lastError = err
      const isLast = i === candidates.length - 1
      const canFallback =
        !isLast && !emittedAny && !options.abortSignal?.aborted && isRetryable(err)
      if (!canFallback) throw err
      options.onFallback?.({
        from: { provider: candidate.provider, model: candidate.model },
        to: candidates[i + 1],
        error: err,
      })
    }
  }

  throw lastError
}
