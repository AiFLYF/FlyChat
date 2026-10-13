import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

// 始终加载 server/ 目录下的 .env，与启动时的工作目录无关
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

import { streamChat } from './providers/index.js'

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

const PORT = process.env.PORT || 3001

/**
 * 提供商注册表
 * type: 'openai-compat' | 'anthropic' | 'gemini'
 * 在此添加新的 OpenAI 兼容服务商只需增加一条记录并在 .env 中配置对应 Key
 */
const PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai-compat',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai-compat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    type: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    models: [
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-1-20250805',
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
]

function resolveProvider(id) {
  const p = PROVIDERS.find((p) => p.id === id)
  if (!p) return null
  const apiKey = process.env[p.apiKeyEnv]
  if (!apiKey) return null
  const baseUrl = p.baseUrlEnv ? process.env[p.baseUrlEnv] || p.defaultBaseUrl : p.defaultBaseUrl
  return { ...p, apiKey, baseUrl }
}

// 返回当前已配置密钥的提供商列表（不暴露任何密钥）
// 模型列表可通过环境变量覆盖，如 ANTHROPIC_MODELS=space-bunny-free,another-model
app.get('/api/providers', (_req, res) => {
  const available = PROVIDERS.filter((p) => !!process.env[p.apiKeyEnv]).map(({ id, name, models }) => ({
    id,
    name,
    models:
      process.env[`${id.toUpperCase()}_MODELS`]?.split(',').map((s) => s.trim()).filter(Boolean) ||
      models,
  }))
  res.json({ providers: available })
})

app.get('/api/health', (_req, res) => res.json({ ok: true }))

// 统一流式聊天代理：上游三家协议差异在此抹平，
// 向前端输出统一 SSE：{"type":"delta","content":"..."} / {"type":"error"} / {"type":"done"}
app.post('/api/chat', async (req, res) => {
  const { provider: providerId, model, messages, temperature, maxTokens, system } = req.body || {}

  const provider = resolveProvider(providerId)
  if (!provider) {
    return res.status(400).json({ error: `提供商 "${providerId}" 未配置或不可用，请检查服务端 .env` })
  }
  if (!model || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '参数不完整：需要 model 与 messages' })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

  const abort = new AbortController()
  req.on('close', () => abort.abort())

  try {
    await streamChat(provider, {
      model,
      messages,
      system,
      temperature,
      maxTokens,
      abortSignal: abort.signal,
      onDelta: (text) => send({ type: 'delta', content: text }),
    })
    send({ type: 'done' })
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error('[chat error]', err?.message || err)
      send({ type: 'error', message: err?.message || '上游请求失败' })
    }
  } finally {
    res.end()
  }
})

app.listen(PORT, () => {
  console.log(`FlyChat server listening on http://localhost:${PORT}`)
})
