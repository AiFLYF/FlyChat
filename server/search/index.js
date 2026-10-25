/**
 * 联网搜索的提供商抽象。
 *
 * 只绑 Tavily 一家的问题是：Key 用完了、服务挂了，整个「联网」功能就没了。
 * 这里按「显式配置 > 自动探测可用 Key」选一家，并把各家返回结构统一成
 * citations 数组（index/title/url/content），上层完全不用关心是谁搜的。
 */

import { config } from '../config.js'
import { searchTavily } from './tavily.js'

const CONTENT_LIMIT = 1200

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

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

/** 把任意来源的原始结果统一成 citations（去重 + 重新编号） */
export function toCitations(items, limit) {
  const seen = new Set()
  const out = []
  for (const item of items || []) {
    const url = String(item?.url || '').trim()
    if (!url) continue
    const key = normalizeUrl(url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      index: out.length + 1,
      title: String(item.title || '').trim() || domainOf(url),
      url,
      content: String(item.content || item.snippet || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, CONTENT_LIMIT),
    })
    if (out.length >= limit) break
  }
  return out
}

async function searchBrave(query, { limit, signal }) {
  const key = process.env.BRAVE_API_KEY
  if (!key) throw new Error('未配置 BRAVE_API_KEY')
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(limit))
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal,
  })
  if (!res.ok) throw new Error(`Brave 返回 ${res.status}`)
  const json = await res.json()
  return (json?.web?.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.description,
  }))
}

async function searchSerper(query, { limit, signal }) {
  const key = process.env.SERPER_API_KEY
  if (!key) throw new Error('未配置 SERPER_API_KEY')
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: limit }),
    signal,
  })
  if (!res.ok) throw new Error(`Serper 返回 ${res.status}`)
  const json = await res.json()
  return (json?.organic || []).map((r) => ({
    title: r.title,
    url: r.link,
    content: r.snippet,
  }))
}

/** 自建 SearXNG：完全离线可控，适合内网部署 */
async function searchSearxng(query, { limit, signal }) {
  const base = (process.env.SEARXNG_URL || '').replace(/\/$/, '')
  if (!base) throw new Error('未配置 SEARXNG_URL')
  const url = new URL(`${base}/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`SearXNG 返回 ${res.status}`)
  const json = await res.json()
  return (json?.results || []).slice(0, limit).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
  }))
}

const IMPL = {
  tavily: async (q, opts) => toCitations(await searchTavily(q, opts), opts.limit),
  brave: async (q, opts) => toCitations(await searchBrave(q, opts), opts.limit),
  serper: async (q, opts) => toCitations(await searchSerper(q, opts), opts.limit),
  searxng: async (q, opts) => toCitations(await searchSearxng(q, opts), opts.limit),
}

/** 当前可用的搜索后端（按优先级） */
export function availableSearchProviders() {
  const list = []
  if (process.env.TAVILY_API_KEY) list.push('tavily')
  if (process.env.BRAVE_API_KEY) list.push('brave')
  if (process.env.SERPER_API_KEY) list.push('serper')
  if (process.env.SEARXNG_URL) list.push('searxng')
  return list
}

export function isSearchConfigured() {
  return availableSearchProviders().length > 0
}

/**
 * 执行搜索。显式指定 provider 时只用它；auto 时按优先级尝试，
 * 前一家失败自动换下一家——联网搜索失败不该让整轮对话失败。
 */
export async function webSearch(query, { maxResults, signal, provider } = {}) {
  const limit = maxResults ?? config.search.maxResults
  const available = availableSearchProviders()
  if (available.length === 0) {
    throw new Error('未配置联网搜索：请在 server/.env 设置 TAVILY_API_KEY / BRAVE_API_KEY / SERPER_API_KEY / SEARXNG_URL')
  }

  const order =
    provider && provider !== 'auto'
      ? [provider]
      : config.search.provider !== 'auto' && IMPL[config.search.provider]
        ? [config.search.provider, ...available.filter((p) => p !== config.search.provider)]
        : available

  let lastError = null
  for (const name of order) {
    if (!IMPL[name]) continue
    try {
      const citations = await IMPL[name](String(query).slice(0, 400), { limit, signal })
      if (citations.length) return { provider: name, citations }
      lastError = new Error(`${name} 没有返回结果`)
    } catch (err) {
      if (signal?.aborted) throw err
      lastError = err
    }
  }
  throw lastError || new Error('联网搜索失败')
}

/** 把搜索结果拼成注入提示词的上下文块 */
export function buildSearchContext(citations) {
  if (!citations?.length) return ''
  const lines = citations.map((c) => `[${c.index}] ${c.title}\n${c.url}\n${c.content}`)
  return [
    '以下是从网络检索到的资料，请优先依据这些资料回答，并在引用处用 [序号] 标注来源：',
    '',
    ...lines,
  ].join('\n')
}
