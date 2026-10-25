import { Router } from 'express'
import { asyncHandler, badRequest, notFound, unavailable } from '../lib/errors.js'
import { inc } from '../lib/metrics.js'
import { requireAdmin } from '../lib/auth.js'
import { storageStatus } from '../store/db.js'
import {
  deleteServer,
  findServer,
  listServers,
  setEnabled,
  setToolDisabled,
  setTrusted,
  upsertServer,
} from '../mcp/registry.js'
import { loadMcpTools, probeServer } from '../mcp/manager.js'

const router = Router()

/** 只拦 MCP 自己的路径（放在 router.use 顶层会误伤同挂载点的其它路由） */
const requireStorage = (req, _res, next) => {
  if (!storageStatus().available) {
    return next(unavailable('服务端持久化不可用，MCP 功能不可用', 'storage_unavailable'))
  }
  next()
}

router.get('/mcp/servers', requireStorage, (_req, res) => {
  res.json({ items: listServers() })
})

// —— 写操作一律 admin（多用户模式）：注册 stdio server 等于允许在服务器上执行
// 任意命令（RCE），普通用户绝不能碰。读取保持登录即可，工具定义本身不含敏感值。 ——
router.post('/mcp/servers', requireStorage, requireAdmin, (req, res, next) => {
  try {
    const server = upsertServer(req.body || {})
    inc('mcp_server_saved_total')
    res.status(201).json(server)
  } catch (err) {
    next(err.status ? err : badRequest(err?.message || '保存失败'))
  }
})

router.delete('/mcp/servers/:id', requireStorage, requireAdmin, (req, res, next) => {
  const ok = deleteServer(req.params.id)
  if (!ok) return next(notFound('MCP server 不存在'))
  res.json({ ok: true })
})

router.post('/mcp/servers/:id/enable', requireStorage, requireAdmin, (req, res, next) => {
  const server = setEnabled(req.params.id, req.body?.enabled !== false)
  if (!server) return next(notFound('MCP server 不存在'))
  res.json(server)
})

/** 信任开关：不开信任只能调只读工具 */
router.post('/mcp/servers/:id/trust', requireStorage, requireAdmin, (req, res, next) => {
  const server = setTrusted(req.params.id, req.body?.trusted === true)
  if (!server) return next(notFound('MCP server 不存在'))
  res.json(server)
})

router.post('/mcp/servers/:id/tools/:name/disable', requireStorage, requireAdmin, (req, res, next) => {
  try {
    const server = setToolDisabled(req.params.id, decodeURIComponent(req.params.name), req.body?.disabled !== false)
    res.json(server)
  } catch (err) {
    next(err.status ? err : badRequest(err?.message || '操作失败'))
  }
})

/** 连通性探测：真的连上去把工具列表拉回来（会触发对配置地址的真实连接，admin only） */
router.post(
  '/mcp/servers/:id/probe',
  requireStorage,
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!findServer(req.params.id)) throw notFound('MCP server 不存在')
    const result = await probeServer(req.params.id)
    res.json(result)
  })
)

/** 当前生效的工具定义（前端可用来展示「这个 server 提供了哪些工具」） */
router.get('/mcp/tools', requireStorage, async (_req, res) => {
  const { definitions } = await loadMcpTools()
  res.json({ tools: definitions, count: definitions.length })
})

export default router
