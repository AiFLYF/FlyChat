import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

/**
 * 服务端配置的唯一入口。
 * 原则：所有 process.env 的读取都收敛在这里，其它模块只消费 config，
 * 这样测试可以注入环境变量后重新 import，排查配置问题也只需看一个文件。
 */

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.join(SERVER_DIR, '..')

// 始终加载 server/.env，与启动时的工作目录无关。
// 测试环境不加载：否则本机真实 Key 会混进测试，结果不可复现。
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.join(SERVER_DIR, '.env') })
}

const DATA_DIR = process.env.FLYCHAT_DATA_DIR
  ? path.resolve(process.env.FLYCHAT_DATA_DIR)
  : path.join(SERVER_DIR, 'data')

function readInt(name, fallback, min, max) {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, raw))
}

function readBool(name, fallback) {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  if (!raw) return fallback
  return !['0', 'false', 'off', 'no'].includes(raw)
}

function readFloat(name, fallback) {
  const raw = Number.parseFloat(process.env[name] ?? '')
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

function readList(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 解析 "provider:model,provider:model" 形式的降级链 */
function readFallbacks(name) {
  return readList(name)
    .map((entry) => {
      const idx = entry.indexOf(':')
      if (idx <= 0 || idx === entry.length - 1) return null
      return { provider: entry.slice(0, idx).trim(), model: entry.slice(idx + 1).trim() }
    })
    .filter(Boolean)
    .slice(0, 4)
}

/**
 * 降级链：主模型重试耗尽后按顺序尝试这些模型。
 * 例：FALLBACK_MODELS="deepseek:deepseek-chat,openai:gpt-4o-mini"
 * 每次请求现读环境变量，改了不用重启（也方便测试注入）。
 * 只在「一个字都还没发出去」时切换，不会出现两段拼接的回答。
 */
export function getFallbacks() {
  return readFallbacks('FALLBACK_MODELS')
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

const isTest = process.env.NODE_ENV === 'test'

/**
 * 每次请求现读的开关类配置。
 * 这些开关需要能在不改配置重启的前提下切换（部署时改环境变量要重启，
 * 但测试和热调优希望立即生效），所以不走上面的静态对象。
 */
export function getContextFlags() {
  return {
    budgetEnabled: readBool('CONTEXT_BUDGET', config.context.budgetEnabled),
    compaction: readBool('CONTEXT_COMPACT', config.context.compaction),
  }
}

export const config = {
  version: readPackageVersion(),
  env: process.env.NODE_ENV || 'development',
  isTest,

  server: {
    port: readInt('PORT', 3001, 0, 65535),
    host: process.env.HOST || '127.0.0.1',
    trustProxy: readBool('TRUST_PROXY', false),
    /**
     * 允许的 Host 头（域名部署必须配置，例如 chat.example.com）。
     * IP 字面量、localhost、CORS_ORIGINS 里的 host 始终放行。
     * 这是防 DNS 重绑定：攻击者让 evil.com 解析到 127.0.0.1 时，
     * 浏览器发的 Host 就是 evil.com，不在白名单里直接拒绝。
     */
    trustedHosts: readList('TRUSTED_HOSTS'),
    /**
     * keep-alive 空闲连接的保留时长。Node 默认只有 5s，比浏览器、反代和
     * undici 连接池的空闲容忍都短：服务端先静默关 socket，客户端下一拍
     * 复用这条半死连接就 ECONNRESET（测试里表现为间歇性 fetch failed）。
     * 提到 65s（高于常见代理 60s 的默认空闲超时）；headersTimeout 必须更大。
     */
    keepAliveTimeoutMs: readInt('KEEP_ALIVE_TIMEOUT_MS', 65_000, 1000, 600_000),
    headersTimeoutMs: readInt('HEADERS_TIMEOUT_MS', 66_000, 2000, 600_000),
  },

  /**
   * 可选访问令牌：设置后，除 /api/health 外的所有接口都要求
   * `Authorization: Bearer <token>`（或 `X-FlyChat-Token`）。
   * 单机自用不设即可；把服务暴露到公网时必须设置。
   */
  auth: {
    token: (process.env.FLYCHAT_ACCESS_TOKEN || '').trim(),
    /**
     * 登录 cookie 是否加 Secure。auto = 跟随实际请求协议（反代场景把 TRUST_PROXY 设为 1
     * 才会读 X-Forwarded-Proto）；Docker 里 NODE_ENV=production + HOST=0.0.0.0 但用户
     * 用 http://局域网IP 访问时，硬编码 Secure 会让 cookie 被浏览器丢弃、登录看起来永远失败。
     */
    cookieSecure: ['on', 'off'].includes(String(process.env.COOKIE_SECURE || '').toLowerCase())
      ? String(process.env.COOKIE_SECURE).toLowerCase()
      : 'auto',
    /**
     * 多用户模式。默认关闭 = 单用户（跟以前完全一样，不鉴权）。
     * 打开后所有 /api 与 /v1 都要求登录，会话按用户隔离。
     * 第一个管理员通过 `POST /api/auth/setup` 创建（仅在库里没有任何用户时可用）。
     */
    multiUser: readBool('MULTI_USER', false),
    /** 登录态有效期（天） */
    sessionDays: readInt('SESSION_DAYS', 30, 1, 365),
  },

  cors: {
    /** 额外允许的跨域来源；为空时只允许同源与本机来源，不再任意放行 */
    origins: readList('CORS_ORIGINS'),
  },

  limits: {
    /** 请求体上限：附件以 base64 内联，需要放宽 */
    bodyBytes: 32 * 1024 * 1024,
    /** 单次对话允许的最大消息条数 */
    messages: 200,
    /** 单条消息最大字符数 */
    messageChars: 200_000,
    /** 附件抽取上限 */
    extractChars: 200_000,
    /** 简单的内存限流：窗口内允许的写请求数 */
    writeRate: {
      windowMs: readInt('RATE_WINDOW_MS', 60_000, 1000, 3_600_000),
      max: readInt('RATE_MAX', 240, 1, 100_000),
    },
    /**
     * 重读接口（/api/export、/api/conversations/:id/export）单独限流：
     * 一次导出就把全部会话读进内存，普通浏览不该被牵连，反复导出则要拦住。
     */
    exportRate: {
      windowMs: readInt('EXPORT_WINDOW_MS', 60_000, 1000, 3_600_000),
      max: readInt('EXPORT_RATE_MAX', 20, 1, 10_000),
    },
  },

  chat: {
    /** 上游整体超时 */
    timeoutMs: readInt('UPSTREAM_TIMEOUT_MS', 10 * 60_000, 1000, 3_600_000),
    /** 上游 5xx/429/网络错误的自动重试次数（仅在还没吐出任何字节前重试） */
    retries: readInt('UPSTREAM_RETRIES', 2, 0, 5),
    retryBaseMs: readInt('UPSTREAM_RETRY_BASE_MS', 400, 50, 10_000),
    retryMaxMs: readInt('UPSTREAM_RETRY_MAX_MS', 8000, 100, 60_000),
    /** 单服务商并发流上限，超出排队 */
    concurrency: readInt('UPSTREAM_CONCURRENCY', 6, 1, 64),
    /** 熔断：连续失败多少次后短暂摘除该服务商 */
    breakerThreshold: readInt('BREAKER_THRESHOLD', 5, 1, 100),
    breakerCooldownMs: readInt('BREAKER_COOLDOWN_MS', 30_000, 1000, 600_000),
    /** SSE 心跳间隔，避免反代/网关掐断长连接 */
    heartbeatMs: readInt('SSE_HEARTBEAT_MS', 15_000, 1000, 120_000),
  },

  context: {
    /** 是否按模型上下文窗口自动裁剪历史 */
    budgetEnabled: readBool('CONTEXT_BUDGET', true),
    /** 裁剪时是否先用小模型把被丢弃的历史总结成摘要（关闭则退回直接丢弃） */
    compaction: readBool('CONTEXT_COMPACT', true),
    /** 给输出预留的比例（相对上下文窗口） */
    reserveRatio: 0.25,
    /** 至少保留最近几条消息，保证对话连贯 */
    minKeepMessages: readInt('CONTEXT_MIN_KEEP', 4, 1, 40),
    /** 单条超长消息做中段截断时，保留头部与尾部各占的比例 */
    middleOutKeep: 0.5,
  },

  storage: {
    /** auto | sqlite | off */
    driver: (process.env.FLYCHAT_STORAGE || 'auto').trim().toLowerCase(),
    dataDir: DATA_DIR,
    file: path.join(DATA_DIR, 'flychat.db'),
  },

  log: {
    level: (process.env.LOG_LEVEL || (isTest ? 'silent' : 'info')).toLowerCase(),
    format: process.env.LOG_FORMAT || (isTest ? 'json' : 'pretty'),
  },

  search: {
    /** tavily | brave | serper | searxng | auto */
    provider: (process.env.SEARCH_PROVIDER || 'auto').toLowerCase(),
    maxResults: readInt('TAVILY_MAX_RESULTS', 5, 1, 10),
    depth: process.env.TAVILY_SEARCH_DEPTH === 'advanced' ? 'advanced' : 'basic',
  },

  pricing: {
    /**
     * 非对话类调用的单次成本（美元），用于预算统计。
     * 图片/语音/搜索按次计费、没有 token 数，不配置就记 0——
     * 至少请求条数可见，配了价格后预算上限才对这几类入口生效。
     */
    imagePerCall: readFloat('IMAGE_COST_USD', 0),
    audioPerCall: readFloat('AUDIO_COST_USD', 0),
    searchPerCall: readFloat('SEARCH_COST_USD', 0),
  },

  rag: {
    /**
     * 网页入库是否拒绝内网/回环地址。
     * 单用户自托管默认**允许**（用户自己贴局域网文档服务地址是真实需求）；
     * 多用户模式默认**拒绝**——否则任何普通用户都能让服务端去读内网页面，
     * 再把内容当成自己知识库的文档读出来。
     * 确实需要放开时设 ALLOW_PRIVATE_INGEST=1。
     */
    rejectPrivateIngest: readBool('ALLOW_PRIVATE_INGEST', false) ? false : readBool('MULTI_USER', false),
    /** 单个工作区最多多少篇文档（含处理中/失败的） */
    maxDocuments: readInt('RAG_MAX_DOCS', 500, 1, 100_000),
    /** 单个工作区源文件总字节上限；0 = 不限制 */
    maxBytes: readInt('RAG_MAX_MB', 512, 0, 1_000_000) * 1024 * 1024,
  },
}

/** 启动时把「配置缺失但不致命」的问题收集起来，由 /api/health 与日志展示 */
export function configWarnings() {
  const warnings = []
  if (config.env === 'production' && !config.auth.token) {
    warnings.push('生产环境未设置 FLYCHAT_ACCESS_TOKEN：所有接口无需鉴权即可访问')
  }
  if (config.server.host === '0.0.0.0' && !config.auth.token) {
    warnings.push('监听 0.0.0.0 且未设置 FLYCHAT_ACCESS_TOKEN：局域网内任何人都能修改服务商配置')
  }
  if (config.cors.origins.length === 0 && config.env === 'production') {
    warnings.push('生产环境未设置 CORS_ORIGINS：仅允许同源与本机来源；跨域前端请显式配置白名单')
  }
  if (config.server.host === '0.0.0.0' && config.server.trustedHosts.length === 0) {
    warnings.push('监听 0.0.0.0 但未设置 TRUSTED_HOSTS：用域名访问时会被 403，请把域名加入 TRUSTED_HOSTS')
  }
  const loopbackHost = config.server.host === '127.0.0.1' || config.server.host === 'localhost' || config.server.host === '::1'
  if (config.auth.multiUser && !loopbackHost && !config.server.trustProxy) {
    warnings.push('多用户模式未设置 TRUST_PROXY：反向代理后所有用户共享代理 IP，限流与登录锁定会互相影响')
  }
  return warnings
}
