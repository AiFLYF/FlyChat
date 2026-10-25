import { configuredProviders, resolveProvider } from '../providers/registry.js'

/**
 * 子任务专用模型选择。
 *
 * 背景（LobeChat #17902 的原话）：标题、摘要、追问建议这类「小活」如果复用主模型，
 * 一来贵（用 o3 / opus 生成 12 个字的标题），二来慢（首字延迟决定用户体感），
 * 三来占主模型的并发额度。所以这些任务应该有自己的模型。
 *
 * 优先级：
 * 1. 环境变量显式指定（`TITLE_MODEL=deepseek:deepseek-chat`）
 * 2. 已配置服务商里名字带 mini/flash/haiku 这类「便宜快」特征的模型（且尽量避开主服务商）
 * 3. 第一个已配置服务商的首个模型
 *
 * 返回 `{ provider, model }` 或 `null`（一个服务商都没配）。
 */

/** 每个任务对应的环境变量名 */
const ENV_KEYS = {
  summary: 'SUMMARY_MODEL',
  title: 'TITLE_MODEL',
  suggest: 'SUGGEST_MODEL',
}

/** 「便宜快」模型的命名特征，按出现频率排 */
const CHEAP = /mini|flash|haiku|nano|turbo|lite|small|8b|1\.5b|air|pro-32k/i

function parseModelSpec(spec) {
  const idx = spec.indexOf(':')
  if (idx > 0) return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) }
  return { provider: null, model: spec }
}

/**
 * @param {'summary'|'title'|'suggest'} task
 * @param {string} [primaryProviderId] 主模型的服务商，用于「尽量别用同一个」的偏好
 */
export function resolveTaskModel(task, primaryProviderId) {
  const envKey = ENV_KEYS[task]
  const explicit = envKey ? (process.env[envKey] || '').trim() : ''
  if (explicit) {
    const { provider, model } = parseModelSpec(explicit)
    if (provider) {
      const resolved = resolveProvider(provider)
      if (resolved) return { provider: resolved, model }
    } else {
      // 只写了模型名（如 `TITLE_MODEL=gpt-4o-mini`）：在已配置服务商里找哪个有它
      const owner = configuredProviders().find((p) => p.models?.includes(model))
      const resolved = owner ? resolveProvider(owner.id) : null
      if (resolved) return { provider: resolved, model }
    }
    // 显式配置写错了（服务商没配 / 模型不存在）就继续走自动挑选，不让标题功能直接挂掉
  }

  const providers = configuredProviders()
  if (providers.length === 0) return null

  const picked =
    providers.find((p) => p.models?.some((m) => CHEAP.test(m)) && p.id !== primaryProviderId) ||
    providers.find((p) => p.models?.some((m) => CHEAP.test(m))) ||
    providers.find((p) => p.id !== primaryProviderId) ||
    providers[0]

  const model = picked.models?.find((m) => CHEAP.test(m)) || picked.models?.[0]
  if (!model) return null
  return { provider: resolveProvider(picked.id), model }
}
