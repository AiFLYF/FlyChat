import { webSearch } from '../search/index.js'
import { assertSafeBaseUrl } from '../lib/ssrf.js'
import { htmlToText } from '../lib/html.js'
import { generateImage } from '../images/index.js'

/**
 * 内置工具（function calling）。
 *
 * 为什么由**服务端**执行工具，而不是把工具调用丢给前端：
 * 1. 用户说「帮我查一下今天的新闻」，模型自己决定要不要搜、搜什么——不用先开开关；
 * 2. 工具在服务端跑，前端零改动就能受益（进度通过 notice 事件展示）；
 * 3. API Key、内网访问、内容抓取这些敏感动作都在服务端做，不暴露给浏览器。
 *
 * 工具定义用 OpenAI 的 JSON Schema 风格，适配器负责转成各家格式。
 */

const MAX_TOOL_RESULT_CHARS = 8000
const FETCH_TIMEOUT_MS = 15_000
const MAX_FETCH_BYTES = 2 * 1024 * 1024

function clampText(text, max = MAX_TOOL_RESULT_CHARS) {
  const str = String(text || '')
  return str.length > max ? `${str.slice(0, max)}\n…（内容过长，已截断）` : str
}

/**
 * 工具注册表。
 * `parameters` 是 JSON Schema；`run(args, ctx)` 返回可 JSON 序列化的结果。
 */
export const TOOLS = {
  web_search: {
    definition: {
      name: 'web_search',
      description:
        '在互联网上搜索最新信息。当问题涉及实时新闻、当前价格、天气、赛事、新发布的软件版本，或你不确定的事实核查时使用。返回若干条带标题、链接和摘要的结果。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，用自然语言描述你要找什么' },
          max_results: { type: 'integer', description: '返回条数，1-8，默认 5', minimum: 1, maximum: 8 },
        },
        required: ['query'],
      },
    },
    async run(args, ctx) {
      const query = String(args?.query || '').trim()
      if (!query) throw new Error('query 不能为空')
      const { citations, provider } = await webSearch(query, {
        maxResults: Math.min(8, Math.max(1, Number(args?.max_results) || 5)),
        signal: ctx.signal,
      })
      // 把来源回传给前端，用户能点开核对
      ctx.emitCitations?.(citations)
      return {
        query,
        provider,
        results: citations.map((c) => ({
          index: c.index,
          title: c.title,
          url: c.url,
          snippet: clampText(c.content, 700),
        })),
      }
    },
  },

  fetch_url: {
    definition: {
      name: 'fetch_url',
      description:
        '读取指定网页的正文内容。当用户给出一个链接，或搜索结果摘要不足以回答、需要看原文细节时使用。只能读取公网 http/https 页面。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要读取的完整 URL，必须以 http:// 或 https:// 开头' },
        },
        required: ['url'],
      },
    },
    async run(args, ctx) {
      const startUrl = String(args?.url || '').trim()

      /**
       * 手动跟随重定向，每一跳都按最严口径校验（含 DNS 解析结果）。
       * 不能用 `redirect: 'follow'`：那样只校验初始 URL，
       * 公网页面 302 到 127.0.0.1 / 169.254.169.254 就把内网内容读进来了。
       * 与 extract.js 的差别：这里连回环/内网一起拒绝（rejectPrivate）——
       * 抓取对象来自模型输出，页面内容可能诱导模型（提示注入），按最坏情况设防。
       */
      const fetchSafely = async (start) => {
        let current = start
        for (let hop = 0; hop <= 3; hop += 1) {
          await assertSafeBaseUrl(current, { rejectPrivate: true, timeoutMs: 5000 })
          const res = await fetch(current, {
            headers: {
              // 不少站点会拒绝没有 UA 的请求
              'User-Agent': 'Mozilla/5.0 (compatible; FlyChatBot/1.0; +https://github.com/)',
              Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
            },
            redirect: 'manual',
            signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(ctx.signal ? [ctx.signal] : [])]),
          })
          if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location')
            if (!location) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`)
            current = new URL(location, current).toString()
            continue
          }
          return res
        }
        throw new Error('重定向次数过多')
      }

      const res = await fetchSafely(startUrl)
      if (!res.ok) throw new Error(`目标页面返回 ${res.status}`)

      const contentType = res.headers.get('content-type') || ''
      // 边读边计数，超限立刻中断：先 arrayBuffer 再判长度会把整个响应读进内存
      const reader = res.body?.getReader()
      const chunks = []
      let total = 0
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (total > MAX_FETCH_BYTES) {
            try {
              await reader.cancel()
            } catch {
              /* ignore */
            }
            throw new Error('页面过大（超过 2MB）')
          }
          chunks.push(Buffer.from(value))
        }
      }
      const body = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks))

      const text = contentType.includes('html') ? htmlToText(body) : body.trim()
      return {
        url: res.url || startUrl,
        contentType,
        title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() || null,
        text: clampText(text),
      }
    },
  },

  current_time: {
    definition: {
      name: 'current_time',
      description: '获取当前日期与时间。当问题涉及「今天」「现在」「最近几天」等相对时间时使用。',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA 时区名，例如 Asia/Shanghai，默认使用服务器本地时区' },
        },
      },
    },
    async run(args) {
      const timezone = args?.timezone ? String(args.timezone) : undefined
      const now = new Date()
      let local = now.toString()
      try {
        local = now.toLocaleString('zh-CN', timezone ? { timeZone: timezone } : undefined)
      } catch {
        /* 时区名非法时退回本地时间 */
      }
      return { iso: now.toISOString(), local, timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone }
    },
  },

  /**
   * 图像生成。
   *
   * 关键设计：**图片不进模型上下文**。
   * 上游可能返回 base64，一张图就是几百 KB——塞进 prompt 既烧钱又没用。
   * 所以图片走 `ctx.emitImages` 直接推给前端，模型只拿到「生成了几张、用什么模型」。
   */
  generate_image: {
    definition: {
      name: 'generate_image',
      description:
        '根据文字描述生成一张图片。当用户明确要求画图、生成图片、做封面/海报/插画/图标时使用。' +
        'prompt 要写具体：主体、风格、构图、色调、光线。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '图片描述。建议包含：主体 + 风格（写实/扁平插画/水彩/3D）+ 构图 + 色调',
          },
          size: {
            type: 'string',
            description: '尺寸，如 1024x1024（方图）、1792x1024（横图）、1024x1792（竖图）。不填由上游决定',
          },
        },
        required: ['prompt'],
      },
    },
    async run(args, ctx) {
      const prompt = String(args?.prompt || '').trim()
      if (!prompt) throw new Error('prompt 不能为空')

      const result = await generateImage({
        prompt,
        size: args?.size ? String(args.size) : undefined,
        // 优先用当前对话的服务商出图，避免「在 A 上聊天、图片来自 B」
        preferProvider: ctx?.providerId,
        signal: ctx?.signal,
      })

      // 前端直接渲染：优先 url，没有 url 就把 base64 拼成 dataUrl
      const images = result.data.map((d) => ({
        url: d.url,
        dataUrl: d.b64_json ? `data:image/png;base64,${d.b64_json}` : undefined,
        revisedPrompt: d.revisedPrompt,
      }))
      ctx?.emitImages?.(images, { prompt, model: result.model, provider: result.provider })

      // 返回给**模型**的只有元信息——绝不能带图片本体
      return {
        ok: true,
        count: images.length,
        model: result.model,
        provider: result.provider,
        tookMs: result.tookMs,
        note: '图片已经直接展示给用户了。不要复述链接或 base64，也不要用 Markdown 图片语法再插一次。',
      }
    },
  },
}

/** 默认开启的工具：只放「不需要额外配置就能用」的 */
export const DEFAULT_TOOL_NAMES = ['web_search', 'fetch_url', 'current_time']

/** 把工具名数组转成适配器需要的定义数组；未知名字直接忽略 */
export function resolveTools(names) {
  const list = Array.isArray(names) && names.length ? names : DEFAULT_TOOL_NAMES
  return list
    .map((name) => TOOLS[name])
    .filter(Boolean)
    .map((t) => ({ ...t.definition, __run: t.run }))
}

/** 执行一次工具调用；错误转成结构化结果，让模型自己决定怎么补救 */
export async function executeTool(toolName, args, ctx = {}) {
  const tool = TOOLS[toolName]
  if (!tool) return { ok: false, error: `未知工具：${toolName}` }
  try {
    const result = await tool.run(args || {}, ctx)
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: err?.message || String(err) }
  }
}
