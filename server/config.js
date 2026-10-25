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
  },

  /**
   * 可选访问令牌：设置后，除 /api/health 外的所有接口都要求
   * `Authorization: Bearer <token>`（或 `X-FlyChat-Token`）。
   * 单机自用不设即可；把服务暴露到公网时必须设置。
   */
  auth: {
    token: (process.env.FLYCHAT_ACCESS_TOKEN || '').trim(),
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
    /** 为空表示不限制来源（本机开发）；生产建议显式列出 */
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
    warnings.push('生产环境未设置 CORS_ORIGINS：任意站点都能调用本服务')
  }
  return warnings
}
