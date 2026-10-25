import { configuredProviders, resolveProvider } from '../providers/registry.js'
import { classifyUpstreamError } from '../providers/sse.js'
import { AppError, badRequest } from '../lib/errors.js'
import { logger } from '../lib/logger.js'

/**
 * 图像生成代理。
 *
 * 定位和聊天代理一致：服务端只做转发与归一化，Key 留在服务端。
 * 这样两件事同时成立：
 * 1. 网页里可以让模型通过 `generate_image` 工具直接出图；
 * 2. `/v1/images/generations` 让 Cherry Studio / Cursor 这类客户端把 FlyChat 当图像后端。
 *
 * 只支持 **OpenAI 兼容的 `/images/generations`**（DALL·E、gpt-image-1、硅基流动 FLUX、
 * 智谱 CogView、通义万相、火山 Seedream 的兼容接口都走这个协议）。
 * SD WebUI 的 `/sdapi/v1/txt2img` 协议不同，暂不支持——猜 base_url 形状太脆弱，
 * 不如以后单独加一个 provider type。
 */

const TIMEOUT_MS = 120_000
const MAX_PROMPT = 4000
const MAX_N = 4

/** 常见图像模型名特征：用来在用户没指定时自动挑一个 */
const IMAGE_MODEL_RE =
  /dall-?e|gpt-image|flux|stable-?diffusion|sdxl|sd3|cogview|wanx|seedream|kolors|imagen|image-preview|grok-2-image|hunyuan-image|janus/i

/** 尺寸白名单：不同上游支持的尺寸不一样，但传个明显错的进去只会拿到 400 */
const SIZE_RE = /^\d{2,4}x\d{2,4}$/

function clampPrompt(prompt) {
  const p = String(prompt || '').trim()
  if (!p) throw badRequest('缺少 prompt', 'missing_prompt')
  if (p.length > MAX_PROMPT) throw badRequest(`prompt 过长（上限 ${MAX_PROMPT} 字）`, 'prompt_too_long')
  return p
}

/**
 * 挑一个能做图像的服务商。
 * 优先级：请求里显式指定 > 环境变量 > 模型名匹配 > 报错（不瞎猜）
 */
export function resolveImageTarget({ provider: providerId, model, preferProvider } = {}) {
  if (providerId) {
    const provider = resolveProvider(providerId)
    if (!provider) throw badRequest(`提供商 "${providerId}" 未配置或不可用`, 'provider_unavailable')
    const picked = model || provider.models?.find((m) => IMAGE_MODEL_RE.test(m)) || provider.models?.[0]
    if (!picked) throw badRequest(`提供商 "${providerId}" 没有可用模型`, 'no_model')
    return { provider, model: picked }
  }

  const envProvider = (process.env.IMAGE_PROVIDER || '').trim()
  const envModel = (process.env.IMAGE_MODEL || '').trim()
  if (envProvider) {
    const provider = resolveProvider(envProvider)
    if (!provider) {
      throw badRequest(`IMAGE_PROVIDER="${envProvider}" 未配置或不可用`, 'provider_unavailable')
    }
    const picked = envModel || provider.models?.find((m) => IMAGE_MODEL_RE.test(m)) || provider.models?.[0]
    if (!picked) throw badRequest('IMAGE_PROVIDER 指向的服务商没有可用模型', 'no_model')
    return { provider, model: picked }
  }

  /**
   * 优先用「当前对话用的那个服务商」。
   * 用户在 DeepSeek 上聊天，图片却来自某个随机配置的服务商，是很难解释的行为；
   * 只要这个服务商自己有图像模型，就用它的。
   */
  if (preferProvider) {
    const entry = configuredProviders().find((p) => p.id === preferProvider)
    const hit = entry?.models?.find((m) => IMAGE_MODEL_RE.test(m))
    if (hit) {
      const provider = resolveProvider(preferProvider)
      if (provider) return { provider, model: envModel || hit }
    }
  }

  // 自动探测：在已配置服务商的模型列表里找图像模型
  for (const p of configuredProviders()) {
    const hit = (p.models || []).find((m) => IMAGE_MODEL_RE.test(m))
    if (hit) {
      const provider = resolveProvider(p.id)
      if (provider) return { provider, model: envModel || hit }
    }
  }

  throw new AppError(
    '还没有可用的图像模型：请先在「设置 → 模型服务」里配置一个支持图像生成的服务商，' +
      '或设置 IMAGE_PROVIDER / IMAGE_MODEL 环境变量',
    { status: 400, code: 'image_unavailable' }
  )
}

/** 当前有没有可用的图像能力（前端据此决定是否显示开关） */
export function imageStatus() {
  try {
    const { provider, model } = resolveImageTarget()
    return { available: true, provider: provider.id, providerName: provider.name, model }
  } catch (err) {
    return { available: false, reason: err?.message || '未配置图像模型' }
  }
}

/** 上游返回的 data 项 → 统一结构（url 或 b64_json 二选一，原样保留） */
function normalizeItem(item, index) {
  if (!item || typeof item !== 'object') return null
  const url = typeof item.url === 'string' && item.url ? item.url : undefined
  const b64 = typeof item.b64_json === 'string' && item.b64_json ? item.b64_json : undefined
  if (!url && !b64) return null
  return {
    index,
    ...(url ? { url } : {}),
    ...(b64 ? { b64_json: b64 } : {}),
    ...(item.revised_prompt ? { revisedPrompt: String(item.revised_prompt) } : {}),
  }
}

/**
 * 生成图像。
 *
 * @param {{ prompt: string, n?: number, size?: string, provider?: string, model?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ created: number, data: object[], provider: string, model: string, tookMs: number }>}
 */
export async function generateImage({
  prompt,
  n,
  size,
  provider: providerId,
  model,
  preferProvider,
  signal,
} = {}) {
  const text = clampPrompt(prompt)
  const target = resolveImageTarget({ provider: providerId, model, preferProvider })
  const count = Math.min(MAX_N, Math.max(1, Number(n) || 1))
  const safeSize = size && SIZE_RE.test(String(size)) ? String(size) : undefined

  const startedAt = Date.now()
  const url = `${String(target.provider.baseUrl).replace(/\/+$/, '')}/images/generations`

  const signals = [AbortSignal.timeout(TIMEOUT_MS)]
  if (signal) signals.push(signal)

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.provider.apiKey}`,
      },
      body: JSON.stringify({
        model: target.model,
        prompt: text,
        n: count,
        ...(safeSize ? { size: safeSize } : {}),
      }),
      signal: AbortSignal.any(signals),
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new AppError(`图像服务连接失败：${err?.message || err}`, {
      status: 502,
      code: 'image_upstream_unreachable',
    })
  }

  if (!response.ok) {
    let detail = ''
    try {
      detail = await response.text()
    } catch {
      /* ignore */
    }
    // 复用聊天那套错误归一化：用户看到的是「该怎么处理」而不是原始堆栈
    const classified = classifyUpstreamError(response.status, detail)
    logger.warn('图像生成失败', {
      provider: target.provider.id,
      model: target.model,
      status: response.status,
      code: classified.code,
    })
    /**
     * 4xx 原样透传（401/403/429 是用户能处理的事，比如换 Key、等一会儿），
     * 5xx 归一成 502——上游 500 跟我们的网关没关系，别让用户以为是我们的问题。
     * 状态码还决定了错误文案是否对外暴露（AppError 里 expose = status < 500）。
     */
    const status = response.status >= 400 && response.status < 500 ? response.status : 502
    throw new AppError(`${target.provider.name} 图像接口错误 · ${classified.hint}: ${String(detail).slice(0, 300)}`, {
      status,
      code: classified.code,
    })
  }

  let body
  try {
    body = await response.json()
  } catch {
    throw new AppError('图像服务返回的不是合法 JSON', { status: 502, code: 'image_bad_response' })
  }

  const data = Array.isArray(body?.data) ? body.data.map(normalizeItem).filter(Boolean) : []
  if (data.length === 0) {
    throw new AppError('图像服务没有返回任何图片', { status: 502, code: 'image_empty' })
  }

  return {
    created: Number(body?.created) || Math.floor(Date.now() / 1000),
    data,
    provider: target.provider.id,
    model: target.model,
    tookMs: Date.now() - startedAt,
  }
}
