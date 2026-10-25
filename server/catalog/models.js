import path from 'node:path'
import fs from 'node:fs'
import { config } from '../config.js'
import { readJsonSafe } from '../lib/atomic.js'

/**
 * 模型目录（model catalog）。
 *
 * 上下文窗口、最大输出、是否支持图片/工具、单价——这些是「能不能发出去」
 * 和「这次花了多少钱」的依据，必须由服务端统一掌握，不能让前端各写一份。
 *
 * 价格单位：美元 / 百万 token，公开标价的近似值，仅用于成本估算展示。
 * 允许用 server/data/model-catalog.json 覆盖（自建网关、折扣价、新模型）。
 */

const M = 1_000_000

/** 内置目录：按 provider::model 精确匹配 */
const BUILTIN = {
  // —— OpenAI ——
  'openai::gpt-4o': {
    contextWindow: 128_000,
    maxOutput: 16_384,
    capabilities: { vision: true, tools: true, reasoning: false, json: true },
    pricing: { input: 2.5, output: 10 },
  },
  'openai::gpt-4o-mini': {
    contextWindow: 128_000,
    maxOutput: 16_384,
    capabilities: { vision: true, tools: true, reasoning: false, json: true },
    pricing: { input: 0.15, output: 0.6 },
  },
  'openai::gpt-4.1': {
    contextWindow: 1_047_576,
    maxOutput: 32_768,
    capabilities: { vision: true, tools: true, reasoning: false, json: true },
    pricing: { input: 2, output: 8 },
  },
  'openai::gpt-4.1-mini': {
    contextWindow: 1_047_576,
    maxOutput: 32_768,
    capabilities: { vision: true, tools: true, reasoning: false, json: true },
    pricing: { input: 0.4, output: 1.6 },
  },
  'openai::gpt-4.1-nano': {
    contextWindow: 1_047_576,
    maxOutput: 32_768,
    capabilities: { vision: true, tools: true, reasoning: false, json: true },
    pricing: { input: 0.1, output: 0.4 },
  },
  'openai::o3-mini': {
    contextWindow: 200_000,
    maxOutput: 100_000,
    capabilities: { vision: false, tools: true, reasoning: true, json: true },
    pricing: { input: 1.1, output: 4.4 },
  },
  'openai::o4-mini': {
    contextWindow: 200_000,
    maxOutput: 100_000,
    capabilities: { vision: true, tools: true, reasoning: true, json: true },
    pricing: { input: 1.1, output: 4.4 },
  },

  // —— DeepSeek ——
  'deepseek::deepseek-chat': {
    contextWindow: 65_536,
    maxOutput: 8192,
    capabilities: { vision: false, tools: true, reasoning: false, json: true },
    pricing: { input: 0.27, output: 1.1 },
  },
  'deepseek::deepseek-reasoner': {
    contextWindow: 65_536,
    maxOutput: 65_536,
    capabilities: { vision: false, tools: true, reasoning: true, json: true },
    pricing: { input: 0.55, output: 2.19 },
  },

  // —— Anthropic ——
  'anthropic::claude-sonnet-4-5-20250929': {
    contextWindow: 200_000,
    maxOutput: 64_000,
    capabilities: { vision: true, tools: true, reasoning: true, json: true },
    pricing: { input: 3, output: 15 },
  },
  'anthropic::claude-haiku-4-5-20251001': {
    contextWindow: 200_000,
    maxOutput: 32_000,
    capabilities: { vision: true, tools: true, reasoning: true, json: true },
    pricing: { input: 1, output: 5 },
  },
  'anthropic::claude-opus-4-1-20250805': {
    contextWindow: 200_000,
    maxOutput: 32_000,
    capabilities: { vision: true, tools: true, reasoning: true, json: true },
    pricing: { input: 15, output: 75 },
  },

  // —— Gemini ——
  'gemini::gemini-2.5-pro': {
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    capabilities: { vision: true, tools: true, reasoning: true, json: true },
    pricing: { input: 1.25, output: 10 },
  },
  'gemini::gemini-2.5-flash': {
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    capabilities: { vision: true, tools: true, reasoning: true, json: true },
    pricing: { input: 0.3, output: 2.5 },
  },
  'gemini::gemini-2.0-flash': {
    contextWindow: 1_048_576,
    maxOutput: 8192,
    capabilities: { vision: true, tools: true, reasoning: false, json: true },
    pricing: { input: 0.1, output: 0.4 },
  },

  // —— Kimi / Moonshot ——
  'kimi::moonshot-v1-8k': { contextWindow: 8192, maxOutput: 4096, capabilities: { vision: false, tools: true } },
  'kimi::moonshot-v1-32k': { contextWindow: 32_768, maxOutput: 8192, capabilities: { vision: false, tools: true } },
  'kimi::moonshot-v1-128k': { contextWindow: 131_072, maxOutput: 8192, capabilities: { vision: false, tools: true } },

  // —— 智谱 GLM ——
  'glm::glm-4-plus': { contextWindow: 131_072, maxOutput: 4096, capabilities: { vision: false, tools: true } },
  'glm::glm-4-flash': { contextWindow: 131_072, maxOutput: 4096, capabilities: { vision: false, tools: true }, pricing: { input: 0, output: 0 } },
  'glm::glm-4v-flash': { contextWindow: 131_072, maxOutput: 4096, capabilities: { vision: true, tools: true }, pricing: { input: 0, output: 0 } },
  'glm::glm-4-long': { contextWindow: 1_000_000, maxOutput: 4096, capabilities: { vision: false, tools: true } },

  // —— 本地 Ollama：成本为 0 ——
  'ollama::llama3.1': {
    contextWindow: 131_072,
    maxOutput: 8192,
    capabilities: { vision: false, tools: true },
    pricing: { input: 0, output: 0 },
  },
  'ollama::qwen2.5': {
    contextWindow: 32_768,
    maxOutput: 8192,
    capabilities: { vision: false, tools: true },
    pricing: { input: 0, output: 0 },
  },
  'ollama::deepseek-r1': {
    contextWindow: 65_536,
    maxOutput: 32_768,
    capabilities: { vision: false, tools: false, reasoning: true },
    pricing: { input: 0, output: 0 },
  },
}

const DEFAULT_INFO = {
  contextWindow: 32_768,
  maxOutput: 4096,
  capabilities: { vision: false, tools: false, reasoning: false, json: false },
  pricing: { input: 0, output: 0 },
}

/** 模型名 → 内置信息（跨服务商按名字查找，先到先得） */
const BY_MODEL = new Map()
for (const [key, info] of Object.entries(BUILTIN)) {
  const model = key.split('::')[1]
  if (model && !BY_MODEL.has(model)) BY_MODEL.set(model, info)
}

/** 名字里带这些词，基本可以确定模型能力 */
const NAME_HINTS = {
  reasoning: /(^|[-_/])(r1|reasoner|thinking|o1|o3|o4|qwq)([-_/]|$)/i,
  vision: /(vision|vl|4o|omni|multimodal|llava|pixtral)/i,
  noTools: /(embed|rerank|tts|whisper|dall|image)/i,
}

/** 从模型名里的 "32k" / "128k" / "1m" 之类的标记推断上下文窗口 */
function inferContextWindow(model) {
  const m = /(\d+(?:\.\d+)?)\s*([km])\b/i.exec(model)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value)) return null
  return Math.round(value * (m[2].toLowerCase() === 'm' ? M : 1000))
}

/** 用户覆盖目录：server/data/model-catalog.json */
let overrideCache = { mtime: 0, data: {} }

function loadOverrides() {
  const file = path.join(config.storage.dataDir, 'model-catalog.json')
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    return {}
  }
  if (mtime === overrideCache.mtime) return overrideCache.data
  const data = readJsonSafe(file, {})
  overrideCache = { mtime, data: data && typeof data === 'object' ? data : {} }
  return overrideCache.data
}

function pick(base, patch) {
  if (!patch) return base
  return {
    ...base,
    ...patch,
    capabilities: { ...base.capabilities, ...(patch.capabilities || {}) },
    pricing: { ...base.pricing, ...(patch.pricing || {}) },
  }
}

/**
 * 查一个模型的完整信息。未知模型用启发式推断，标记 known=false，
 * 让前端可以提示「该模型未收录，参数为估算值」。
 *
 * 匹配顺序：provider::model 精确 → 全局同名模型 → 去掉 vendor 前缀后同名 → 启发式推断。
 * 第二、三条很重要：用户把 gpt-4o 接到自建网关上时，上下文窗口依然是 128k。
 */
export function getModelInfo(providerId, modelId) {
  const model = String(modelId || '')
  const key = `${providerId}::${model}`
  const overrides = loadOverrides()

  const finish = (base, known) => ({
    provider: providerId,
    model,
    label: model,
    known,
    ...pick(base, overrides[key]),
  })

  if (BUILTIN[key]) return finish({ ...DEFAULT_INFO, ...BUILTIN[key] }, true)

  // 全局同名（跨服务商）
  const byName = BY_MODEL.get(model)
  if (byName) return finish({ ...DEFAULT_INFO, ...byName }, true)

  // 聚合网关的 vendor/model 形式：先按完整后缀查，再按最后一段查
  if (model.includes('/')) {
    const parts = model.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const candidate = parts.slice(i).join('/')
      const hit = BY_MODEL.get(candidate)
      if (hit) return finish({ ...DEFAULT_INFO, ...hit }, true)
    }
  }

  const inferred = { ...DEFAULT_INFO, capabilities: { ...DEFAULT_INFO.capabilities } }
  inferred.contextWindow = inferContextWindow(model) || DEFAULT_INFO.contextWindow
  inferred.maxOutput = Math.min(8192, Math.max(1024, Math.floor(inferred.contextWindow / 8)))
  if (NAME_HINTS.reasoning.test(model)) inferred.capabilities.reasoning = true
  if (NAME_HINTS.vision.test(model)) inferred.capabilities.vision = true
  inferred.capabilities.tools = !NAME_HINTS.noTools.test(model)

  return finish(inferred, false)
}

/** 供 /api/models 使用：把某几个服务商的模型全量展开 */
export function listCatalog(providers) {
  const out = []
  for (const p of providers || []) {
    for (const model of p.models || []) {
      out.push({ provider: p.id, providerName: p.name, ...getModelInfo(p.id, model) })
    }
  }
  return out
}

/** 按 token 用量估算花费（美元），保留 6 位小数 */
export function estimateCost(info, usage) {
  const price = info?.pricing || { input: 0, output: 0 }
  const prompt = Number(usage?.prompt) || 0
  const completion = Number(usage?.completion) || 0
  const cost = (prompt * (price.input || 0) + completion * (price.output || 0)) / M
  return Math.round(cost * 1e6) / 1e6
}

/** 测试用：清掉覆盖缓存 */
export function resetCatalogCache() {
  overrideCache = { mtime: 0, data: {} }
}
