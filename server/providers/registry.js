import { customAsProviders, findCustom, getModelOverride } from './store.js'

/**
 * 服务商注册表。
 *
 * 内置服务商靠 server/.env 配置；网页「模型服务」里新增的自定义服务商存在
 * server/data/custom-providers.json。两者在这里合并成统一结构，上层不用关心来源。
 *
 * 新增一个 OpenAI 兼容服务商 = 加一条记录 + 在 .env 里填 {ID}_API_KEY。
 */

export const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai-compat',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsUsage: true,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini', 'o4-mini'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai-compat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    supportsUsage: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    type: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', 'claude-opus-4-1-20250805'],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    type: 'openai-compat',
    apiKeyEnv: 'KIMI_API_KEY',
    baseUrlEnv: 'KIMI_BASE_URL',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    supportsUsage: true,
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    type: 'openai-compat',
    apiKeyEnv: 'GLM_API_KEY',
    baseUrlEnv: 'GLM_BASE_URL',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    supportsUsage: true,
    // glm-4v-flash 是免费的视觉模型：配一个 GLM Key 即可获得零成本视界能力
    models: ['glm-4-plus', 'glm-4-flash', 'glm-4v-flash', 'glm-4-long'],
  },
  {
    id: 'qwen',
    name: '通义千问 (DashScope)',
    type: 'openai-compat',
    apiKeyEnv: 'QWEN_API_KEY',
    baseUrlEnv: 'QWEN_BASE_URL',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    supportsUsage: true,
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-vl-max'],
  },
  {
    id: 'doubao',
    name: '豆包 (火山方舟)',
    type: 'openai-compat',
    apiKeyEnv: 'DOUBAO_API_KEY',
    baseUrlEnv: 'DOUBAO_BASE_URL',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    supportsUsage: true,
    // 方舟用「推理接入点 ID」当模型名，请在 .env 的 DOUBAO_MODELS 或网页里覆盖
    models: ['doubao-pro-32k'],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    type: 'openai-compat',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    baseUrlEnv: 'SILICONFLOW_BASE_URL',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    supportsUsage: true,
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
  },
  {
    id: 'groq',
    name: 'Groq',
    type: 'openai-compat',
    apiKeyEnv: 'GROQ_API_KEY',
    baseUrlEnv: 'GROQ_BASE_URL',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    supportsUsage: true,
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai-compat',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    supportsUsage: true,
    models: ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'],
  },
  {
    id: 'ollama',
    name: 'Ollama (本地)',
    type: 'openai-compat',
    apiKeyEnv: 'OLLAMA_API_KEY',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    defaultBaseUrl: 'http://localhost:11434/v1',
    optionalKey: true,
    supportsUsage: true,
    models: ['llama3.1', 'qwen2.5', 'deepseek-r1'],
  },
]

/** 内置 + 网页配置的自定义服务商 */
export function allProviders() {
  return [...PROVIDERS.map((p) => ({ ...p, source: 'env' })), ...customAsProviders()]
}

/** 生效的模型列表：网页覆盖 > 环境变量覆盖 > 内置默认 */
export function effectiveModels(p) {
  const override = getModelOverride(p.id)
  if (override) return override
  const fromEnv = process.env[`${p.id.toUpperCase()}_MODELS`]
  if (fromEnv) {
    const list = fromEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (list.length) return list
  }
  return p.models || []
}

/** 是否已配置（决定要不要出现在前端的模型列表里） */
export function isConfigured(p) {
  if (p.source === 'custom') return true
  // 免密钥提供商（如 Ollama）只在显式配置了 BASE_URL 时出现，避免没部署也列出来
  if (p.optionalKey) return !!process.env[p.baseUrlEnv]
  return !!process.env[p.apiKeyEnv]
}

/**
 * 解析成「可以直接发请求」的 provider。
 * 返回 null 表示未配置或不存在。
 */
export function resolveProvider(id) {
  const p = allProviders().find((x) => x.id === id)
  if (!p) return null

  if (p.source === 'custom') {
    const stored = findCustom(p.id)
    if (!stored) return null
    return {
      id: stored.id,
      name: stored.name,
      type: stored.type,
      baseUrl: stored.baseUrl,
      source: 'custom',
      // 本地免密钥服务（如 Ollama 网关）留空时给一个占位值
      apiKey: stored.apiKey || 'no-key',
      supportsUsage: stored.type === 'openai-compat',
      /**
       * 必须带上 models：内置服务商是从 PROVIDERS 展开的、天然有 models，
       * 自定义服务商如果漏了这一个字段，调用方写 `provider.models.find(...)`
       * 就会在自定义服务商上静默拿到 undefined（图像生成第一版就是这么踩的）。
       */
      models: stored.models || [],
    }
  }

  const apiKey = process.env[p.apiKeyEnv]
  if (!apiKey && !p.optionalKey) return null
  const baseUrl = p.baseUrlEnv ? process.env[p.baseUrlEnv] || p.defaultBaseUrl : p.defaultBaseUrl
  return { ...p, apiKey: apiKey || 'ollama', baseUrl }
}

/**
 * 配置值必须是纯 ASCII，否则 Node fetch 会抛
 * "Cannot convert argument to a ByteString" 这种难以理解的错。
 * 常见原因：复制密钥时带进了全角标点或中文。
 */
export function asciiProblem(provider) {
  const bad = []
  if (provider.apiKey && /[^\x00-\x7F]/.test(provider.apiKey)) bad.push('API Key')
  if (provider.baseUrl && /[^\x00-\x7F]/.test(provider.baseUrl)) bad.push('Base URL')
  if (bad.length === 0) return ''
  const where = provider.source === 'custom' ? '设置 → 模型服务' : 'server/.env'
  return `${provider.name} 的配置包含非 ASCII 字符（${bad.join(' / ')}，常见于全角标点），请在${where}检查`
}

/** 供 /api/providers 输出：绝不包含 API Key */
export function sanitizeForApi(p) {
  const custom = p.source === 'custom'
  return {
    id: p.id,
    name: p.name,
    models: effectiveModels(p),
    source: p.source,
    hasKey: custom ? !!p.apiKey : p.optionalKey ? true : !!process.env[p.apiKeyEnv],
    modelsOverridden: !!getModelOverride(p.id),
    ...(custom ? { type: p.type, baseUrl: p.baseUrl } : {}),
  }
}

/** 已配置的服务商（含生效模型），供 /api/providers 与模型目录共用 */
export function configuredProviders() {
  return allProviders().filter(isConfigured).map(sanitizeForApi)
}
