import { Router } from 'express'
import { getModelInfo, listCatalog } from '../catalog/models.js'
import { allProviders, configuredProviders, effectiveModels } from '../providers/registry.js'
import { isSearchConfigured } from '../search/index.js'

const router = Router()

/**
 * 模型目录：前端据此显示上下文窗口、能力图标、价格，并决定要不要发图片。
 * 带上 providerName 与 known 标记，未知模型前端可以提示「参数为估算值」。
 */
router.get('/models', (req, res) => {
  const includeUnconfigured = req.query.all === '1' || req.query.all === 'true'
  const base = includeUnconfigured
    ? allProviders().map((p) => ({ id: p.id, name: p.name, models: effectiveModels(p) }))
    : configuredProviders()

  const webSearch = isSearchConfigured()
  const models = listCatalog(base).map((m) => ({
    ...m,
    // 前端约定的扁平别名
    name: m.label,
    maxTokens: m.maxOutput,
    capabilities: { ...m.capabilities, webSearch },
  }))

  res.json({
    models,
    providers: base.map((p) => ({ id: p.id, name: p.name, models: p.models })),
    // 前端可以用这个值做「没有可用模型」的引导
    count: models.length,
  })
})

/** 单个模型的详细信息；模型名里可能有斜杠（openrouter），所以用通配 */
router.get('/models/:provider/*', (req, res) => {
  const model = req.params[0]
  const info = getModelInfo(req.params.provider, model)
  res.json({
    ...info,
    name: info.label,
    maxTokens: info.maxOutput,
    capabilities: { ...info.capabilities, webSearch: isSearchConfigured() },
  })
})

export default router
