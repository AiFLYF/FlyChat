import { resolveProvider, configuredProviders } from '../providers/registry.js'

/**
 * 向量化（embeddings）。
 *
 * 不自带模型：调用用户已经配置好的 OpenAI 兼容 `/embeddings` 接口
 * （OpenAI、硅基流动、通义、Ollama 都支持）。这样零额外依赖，
 * 也不强迫用户再装一套 Python 运行时——这正是我们要比 AnythingLLM 轻的地方。
 */

const BATCH_SIZE = 16
const MAX_INPUT_CHARS = 8000

/** 常用 embedding 模型维度，用于校验上游返回是否异常 */
export const KNOWN_DIMENSIONS = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'bge-m3': 1024,
  'bge-large-zh-v1.5': 1024,
  'nomic-embed-text': 768,
  'Qwen/Qwen3-Embedding-8B': 4096,
}

/**
 * 选一个能用的 embedding 服务商。
 * 优先级：显式指定 > 环境变量 > 第一个已配置的 OpenAI 兼容服务商。
 */
export function resolveEmbeddingProvider(explicitId) {
  const wantId = explicitId || process.env.EMBEDDING_PROVIDER || ''
  if (wantId) {
    const p = resolveProvider(wantId)
    if (!p) return null
    if (p.type !== 'openai-compat') return null
    return p
  }
  // 没显式指定：挑第一个「OpenAI 兼容」的已配置服务商
  for (const candidate of configuredProviders()) {
    const resolved = resolveProvider(candidate.id)
    if (resolved?.type === 'openai-compat') return resolved
  }
  return null
}

export function defaultEmbeddingModel(provider) {
  if (process.env.EMBEDDING_MODEL) return process.env.EMBEDDING_MODEL
  // Ollama 默认模型和云端不一样
  if (provider?.id === 'ollama') return 'nomic-embed-text'
  return 'text-embedding-3-small'
}

/** 单批请求 */
async function embedBatch(provider, model, inputs, signal) {
  const res = await fetch(`${provider.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({ model, input: inputs }),
    signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const hint =
      res.status === 404
        ? '（该服务商可能不支持 /embeddings，请换一个支持向量化的服务商，或在 .env 里设置 EMBEDDING_PROVIDER）'
        : ''
    throw new Error(`向量化失败 (${res.status})${hint}${detail ? `：${detail.slice(0, 200)}` : ''}`)
  }

  const json = await res.json()
  const data = Array.isArray(json?.data) ? json.data : []
  if (data.length !== inputs.length) {
    throw new Error(`向量化返回数量不匹配（期望 ${inputs.length}，实际 ${data.length}）`)
  }
  const vectors = data
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((item) => Float32Array.from(item.embedding || []))

  // 维度与已知值不符 = 配错了模型或上游行为异常。必须在这里拦住：
  // 错维度的向量一旦入库，cosine 对不上会静默返回 0，整库语义检索悄悄失效，
  // 用户只会觉得「搜不出来」，根本想不到是 embedding 配置的问题。
  const expected = KNOWN_DIMENSIONS[model]
  if (expected && vectors[0] && vectors[0].length !== expected) {
    throw new Error(
      `向量化返回维度异常：模型 ${model} 应返回 ${expected} 维，实际 ${vectors[0].length} 维。请检查 EMBEDDING_MODEL 配置或上游服务`
    )
  }
  return vectors
}

/**
 * 批量向量化。文本过长会先截断（embedding 模型通常只吃 8k token）。
 * @returns {Promise<{vectors: Float32Array[], dim: number, model: string, provider: string}>}
 */
export async function embedTexts(texts, { providerId, model, signal } = {}) {
  const list = (texts || []).map((t) => String(t || '').slice(0, MAX_INPUT_CHARS))
  if (list.length === 0) return { vectors: [], dim: 0, model: '', provider: '' }

  const provider = resolveEmbeddingProvider(providerId)
  if (!provider) {
    throw new Error(
      '没有可用于向量化的服务商：请在 server/.env 设置 EMBEDDING_PROVIDER（需为 OpenAI 兼容且支持 /embeddings）'
    )
  }
  const usedModel = model || defaultEmbeddingModel(provider)

  const vectors = []
  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const batch = list.slice(i, i + BATCH_SIZE)
    const result = await embedBatch(provider, usedModel, batch, signal)
    vectors.push(...result)
  }

  return {
    vectors,
    dim: vectors[0]?.length || 0,
    model: usedModel,
    provider: provider.id,
  }
}

/** 余弦相似度（向量已归一化时等价于点积） */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Float32Array ↔ BLOB */
export function vectorToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function bufferToVector(buf) {
  if (!buf) return null
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(arrayBuffer)
}
