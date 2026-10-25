import { Router } from 'express'
import { AppError, asyncHandler, badRequest, notFound } from '../lib/errors.js'
import { createLogger } from '../lib/logger.js'
import { inc } from '../lib/metrics.js'
import {
  allProviders,
  asciiProblem,
  configuredProviders,
  effectiveModels,
  resolveProvider,
  sanitizeForApi,
} from '../providers/registry.js'
import { findCustom, removeCustom, setModelOverride, upsertCustom } from '../providers/store.js'
import { isSearchConfigured, availableSearchProviders } from '../search/index.js'
import { requireAdmin } from '../lib/auth.js'

const router = Router()
const log = createLogger({ route: 'providers' })

/** 提供商列表：绝不返回 API Key，只返回 hasKey 供界面显示状态 */
router.get('/providers', (_req, res) => {
  res.json({
    providers: configuredProviders(),
    webSearch: isSearchConfigured(),
    searchProviders: availableSearchProviders(),
  })
})

/** 全部服务商（含未配置的），供「模型服务」面板展示可配置项 */
router.get('/providers/all', (_req, res) => {
  res.json({
    providers: allProviders().map((p) => ({
      ...sanitizeForApi(p),
      configured: p.source === 'custom' ? true : !!process.env[p.apiKeyEnv] || (p.optionalKey && !!process.env[p.baseUrlEnv]),
      optionalKey: !!p.optionalKey,
      apiKeyEnv: p.apiKeyEnv,
      baseUrlEnv: p.baseUrlEnv || null,
      defaultBaseUrl: p.defaultBaseUrl || null,
    })),
  })
})

/**
 * 新建 / 修改自定义提供商（网页配置模型的核心接口）。
 * 多用户模式下 admin only：自定义服务商是全实例共享的资源，
 * 且 base URL 可以指向内网——不能让普通用户随意加。
 */
router.post(
  '/providers/custom',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const saved = await upsertCustom(req.body || {})
    log.info('保存自定义服务商', { id: saved.id, name: saved.name, type: saved.type })
    inc('provider_saved_total')
    res.json({ ok: true, id: saved.id })
  })
)

router.delete('/providers/custom/:id', requireAdmin, (req, res, next) => {
  try {
    removeCustom(req.params.id)
    inc('provider_deleted_total')
    res.json({ ok: true })
  } catch (err) {
    next(badRequest(err?.message || '删除失败', 'delete_failed'))
  }
})

/** 覆盖任意提供商（含内置）的模型列表，免去改 .env 重启（多用户模式 admin only） */
router.put('/providers/:id/models', requireAdmin, (req, res, next) => {
  const id = req.params.id
  const known = allProviders().some((p) => p.id === id)
  if (!known) return next(notFound(`服务商 ${id} 不存在`))
  try {
    const models = setModelOverride(id, req.body?.models)
    res.json({ ok: true, models })
  } catch (err) {
    next(badRequest(err?.message || '保存失败', 'save_models_failed'))
  }
})

/** 连通性自检：避免配错了地址/密钥却要到发消息时才发现 */
router.post(
  '/providers/:id/test',
  asyncHandler(async (req, res) => {
    const provider = resolveProvider(req.params.id)
    if (!provider) throw notFound('服务商不存在或未配置')
    const ascii = asciiProblem(provider)
    if (ascii) throw badRequest(ascii, 'non_ascii_config')

    const startedAt = Date.now()
    const headers = { 'Content-Type': 'application/json' }
    if (provider.type === 'openai-compat') headers.Authorization = `Bearer ${provider.apiKey}`
    else if (provider.type === 'anthropic') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
    }
    // Gemini 的模型列表接口把 Key 放在 query 上
    const url =
      provider.type === 'gemini'
        ? `${provider.baseUrl}/models?key=${encodeURIComponent(provider.apiKey)}`
        : `${provider.baseUrl}/models`

    try {
      const r = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(12_000) })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        return res.json({
          ok: false,
          message: `上游返回 ${r.status}${text ? `：${text.slice(0, 200)}` : ''}`,
          latencyMs: Date.now() - startedAt,
        })
      }
      // 能拿到模型列表就顺手回报数量，方便核对
      let models = []
      try {
        const json = await r.json()
        const raw = json?.data || json?.models || []
        models = raw.map((m) => m?.id || m?.name).filter(Boolean)
      } catch {
        /* 列表格式不确定，忽略 */
      }
      return res.json({
        ok: true,
        message: models.length ? `连接成功，上游返回 ${models.length} 个模型` : '连接成功',
        latencyMs: Date.now() - startedAt,
        models: models.slice(0, 300),
      })
    } catch (err) {
      return res.json({
        ok: false,
        message: `无法连接：${err?.message || err}`,
        latencyMs: Date.now() - startedAt,
      })
    }
  })
)

/** 拉取上游模型清单，让用户勾选而不是手打模型名 */
router.get(
  '/providers/:id/remote-models',
  asyncHandler(async (req, res) => {
    const provider = resolveProvider(req.params.id)
    if (!provider) throw notFound('服务商不存在或未配置')

    const headers = { 'Content-Type': 'application/json' }
    if (provider.type === 'openai-compat') headers.Authorization = `Bearer ${provider.apiKey}`
    else if (provider.type === 'anthropic') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
    }
    const url =
      provider.type === 'gemini'
        ? `${provider.baseUrl}/models?key=${encodeURIComponent(provider.apiKey)}`
        : `${provider.baseUrl}/models`

    const r = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) })
    if (!r.ok) throw new AppError(`上游返回 ${r.status}`, { status: 502, code: 'upstream_error' })
    const json = await r.json().catch(() => ({}))
    const raw = json?.data || json?.models || []
    const models = [...new Set(raw.map((m) => m?.id || m?.name).filter(Boolean))].sort()
    res.json({ models, current: effectiveModels({ id: req.params.id }) })
  })
)

/** 单个自定义服务商的详情（供编辑表单回填，不含密钥） */
router.get('/providers/custom/:id', (req, res, next) => {
  const p = findCustom(req.params.id)
  if (!p) return next(notFound('自定义服务商不存在'))
  res.json({
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    models: p.models,
    hasKey: !!p.apiKey,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  })
})

export default router
