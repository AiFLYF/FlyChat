import { Router } from 'express'
import { config, configWarnings } from '../config.js'
import { badRequest } from '../lib/errors.js'
import { metricsSnapshot } from '../lib/metrics.js'
import { breakerSnapshot } from '../lib/resilience.js'
import { storageStatus } from '../store/db.js'
import { conversationStats } from '../store/conversations.js'
import { recentUsage, usageSummary } from '../store/usage.js'
import { configuredProviders, allProviders } from '../providers/registry.js'
import { availableSearchProviders, isSearchConfigured, webSearch } from '../search/index.js'
import { resolveEmbeddingProvider, defaultEmbeddingModel } from '../rag/embeddings.js'
import { checkBudget, getBudget, setBudget } from '../store/budget.js'
import { countUsers } from '../store/users.js'
import { imageStatus } from '../images/index.js'
import { asyncHandler } from '../lib/errors.js'
import { requireAdmin } from '../lib/auth.js'

const router = Router()

/** 健康检查：给探针用，也给人看。存储/搜索/熔断状态一屏可见 */
router.get('/health', (_req, res) => {
  const storage = storageStatus()
  const providers = configuredProviders()
  const warnings = configWarnings()
  res.json({
    ok: true,
    version: config.version,
    env: config.env,
    uptimeSeconds: Math.round(process.uptime()),
    storage: { ...storage, ...(storage.available ? conversationStats() : {}) },
    providers: {
      configured: providers.length,
      total: allProviders().length,
      ids: providers.map((p) => p.id),
    },
    search: { enabled: isSearchConfigured(), providers: availableSearchProviders() },
    breakers: breakerSnapshot(),
    warnings,
  })
})

router.get('/metrics', (_req, res) => {
  res.json({ ...metricsSnapshot(), breakers: breakerSnapshot() })
})

/** 图像能力探测：没配置就返回 unavailable，不该让 /api/config 整个挂掉 */
function safeImageStatus() {
  try {
    return imageStatus()
  } catch (err) {
    return { available: false, reason: err?.message || '未配置' }
  }
}

/** 用户表可能还没建好（存储不可用），这里只用于 /api/config 的提示，不该因此报错 */
function safeCountUsers() {
  try {
    return countUsers()
  } catch {
    return 0
  }
}

/** 前端启动时拉一次：决定要不要显示「联网搜索」开关、上传上限等 */
router.get('/config', (_req, res) => {
  res.json({
    version: config.version,
    features: {
      webSearch: isSearchConfigured(),
      serverStorage: storageStatus().available,
      contextBudget: config.context.budgetEnabled,
      compare: true,
      // 工具调用（agent）与知识库都依赖具体能力，前端据此决定是否显示入口
      tools: true,
      knowledge: !!resolveEmbeddingProvider(),
      mcp: true,
      presets: storageStatus().available,
      // 有没有可用的图像模型：前端据此决定要不要显示「生成图片」开关
      image: safeImageStatus().available,
    },
    embedding: (() => {
      const p = resolveEmbeddingProvider()
      return p ? { provider: p.id, name: p.name, model: defaultEmbeddingModel(p) } : null
    })(),
    limits: {
      bodyBytes: config.limits.bodyBytes,
      messages: config.limits.messages,
      messageChars: config.limits.messageChars,
      extractChars: config.limits.extractChars,
    },
    authRequired: !!config.auth.token,
    /**
     * 前端据此决定进哪个界面：
     * - `single`：直接进主界面（跟以前一样）
     * - `multi` + `needsSetup`：显示「创建管理员」页
     * - `multi` 且已登录：主界面；未登录：登录页
     */
    authMode: config.auth.multiUser ? 'multi' : 'single',
    needsSetup: config.auth.multiUser && storageStatus().available ? safeCountUsers() === 0 : false,
  })
})

/** 当前预算与已花费（前端额度条用） */
router.get('/budget', (_req, res) => {
  if (!storageStatus().available) return res.json({ enabled: false, reason: 'storage_unavailable' })
  const result = checkBudget()
  const budget = getBudget()
  res.json({
    enabled: budget.enabled,
    dailyUsd: budget.dailyUsd,
    monthlyUsd: budget.monthlyUsd,
    spend: result.spend,
    percent: {
      daily: budget.dailyUsd > 0 ? Math.round((result.spend.daily / budget.dailyUsd) * 100) : 0,
      monthly: budget.monthlyUsd > 0 ? Math.round((result.spend.monthly / budget.monthlyUsd) * 100) : 0,
    },
  })
})

/** 设置预算上限；0 表示不限制（多用户模式 admin only——预算是全实例的） */
router.put('/budget', requireAdmin, (req, res, next) => {
  if (!storageStatus().available) {
    return next(unavailable('服务端持久化不可用', 'storage_unavailable'))
  }
  const { dailyUsd, monthlyUsd } = req.body || {}
  const daily = Number(dailyUsd)
  const monthly = Number(monthlyUsd)
  if (!Number.isFinite(daily) || daily < 0) return next(badRequest('dailyUsd 必须是非负数字', 'invalid_budget'))
  if (!Number.isFinite(monthly) || monthly < 0) return next(badRequest('monthlyUsd 必须是非负数字', 'invalid_budget'))
  res.json(setBudget({ dailyUsd: daily, monthlyUsd: monthly }))
})

/** 用量统计。`/usage/summary` 是 `/usage` 的别名，前端两种叫法都支持 */
function usageHandler(req, res) {
  if (!storageStatus().available) return res.json({ available: false, totals: null })
  const days = Math.min(3650, Math.max(0, Number(req.query.days) || 30))
  res.json({ available: true, ...usageSummary({ days }) })
}
router.get('/usage', usageHandler)
router.get('/usage/summary', usageHandler)

router.get('/usage/recent', (req, res) => {
  if (!storageStatus().available) return res.json({ available: false, items: [] })
  res.json({ available: true, items: recentUsage({ limit: req.query.limit }) })
})

/** 独立搜索接口：前端做「只搜不聊」或搜索建议时用 */
router.post(
  '/search',
  asyncHandler(async (req, res) => {
    const query = String(req.body?.query || '').trim()
    if (!query) throw badRequest('缺少 query', 'missing_query')
    if (!isSearchConfigured()) throw badRequest('未配置联网搜索服务', 'search_unavailable')
    const result = await webSearch(query, { maxResults: req.body?.maxResults })
    res.json(result)
  })
)

export default router
