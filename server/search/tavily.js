/**
 * Tavily 联网搜索（专为 LLM 设计，直接返回摘要与来源链接）
 * 需在 server/.env 配置 TAVILY_API_KEY
 *
 * 可选环境变量：
 *   TAVILY_MAX_RESULTS   返回条数，1-10，默认 5
 *   TAVILY_SEARCH_DEPTH  basic | advanced，默认 basic（advanced 更准但更慢更贵）
 *   TAVILY_BASE_URL      覆盖接口地址（自建代理 / 本地测试）
 */

/** 每条结果的摘要上限，避免把上下文撑爆 */
const CONTENT_LIMIT = 1200

function readIntEnv(name, fallback, min, max) {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, raw))
}

function readDepthEnv() {
  return process.env.TAVILY_SEARCH_DEPTH === 'advanced' ? 'advanced' : 'basic'
}

/** 去掉 URL 上的 hash、末尾斜杠与 www 前缀，便于去重 */
function normalizeUrl(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    u.hostname = u.hostname.replace(/^www\./, '')
    return u.toString().replace(/\/$/, '')
  } catch {
    return url
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** 把上游错误翻译成可操作的提示 */
function describeError(status, body) {
  if (status === 401 || status === 403) return 'TAVILY_API_KEY 无效或无权访问，请检查 server/.env'
  if (status === 429) return 'Tavily 请求过于频繁（429），请稍后重试'
  if (status === 432 || status === 433) return 'Tavily 配额已用尽，请检查账户额度'
  const detail = (body || '').replace(/\s+/g, ' ').slice(0, 200)
  return `Tavily 返回 ${status}${detail ? `：${detail}` : ''}`
}

export async function searchTavily(query, { maxResults, signal } = {}) {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) throw new Error('未配置 TAVILY_API_KEY，无法联网搜索')

  const base = (process.env.TAVILY_BASE_URL || 'https://api.tavily.com').replace(/\/$/, '')
  const limit = maxResults ?? readIntEnv('TAVILY_MAX_RESULTS', 5, 1, 10)

  const res = await fetch(`${base}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: limit,
      search_depth: readDepthEnv(),
      include_answer: false,
      include_raw_content: false,
    }),
    signal,
  })

  if (!res.ok) {
    let body = ''
    try {
      body = await res.text()
    } catch {
      /* ignore */
    }
    throw new Error(describeError(res.status, body))
  }

  const json = await res.json()
  const results = Array.isArray(json?.results) ? json.results : []

  // 按 URL 去重后重新编号，保证引用序号与列表一致
  const seen = new Set()
  const citations = []
  for (const r of results) {
    const url = (r?.url || '').trim()
    if (!url) continue
    const key = normalizeUrl(url)
    if (seen.has(key)) continue
    seen.add(key)
    citations.push({
      index: citations.length + 1,
      title: (r.title || '').trim() || domainOf(url),
      url,
      content: (r.content || '').replace(/\s+/g, ' ').trim().slice(0, CONTENT_LIMIT),
    })
    if (citations.length >= limit) break
  }
  return citations
}
