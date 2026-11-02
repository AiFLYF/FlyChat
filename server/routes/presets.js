import { Router } from 'express'
import { asyncHandler, badRequest, notFound, unavailable } from '../lib/errors.js'
import { storageStatus } from '../store/db.js'
import { inc } from '../lib/metrics.js'
import { currentUserId, isAdmin } from '../lib/auth.js'
import {
  createPreset,
  deletePreset,
  duplicatePreset,
  getPreset,
  listPresets,
  updatePreset,
} from '../store/presets.js'

const router = Router()

/** 多用户模式下预设按用户隔离；单用户返回空 userId 表示不隔离 */
const scopeOf = (req) => ({ userId: currentUserId(req), isAdmin: isAdmin(req) })

/** 只拦预设自己的路径，别误伤同挂载点下的其它路由 */
const requireStorage = (_req, _res, next) => {
  if (!storageStatus().available) {
    return next(unavailable('服务端持久化不可用，预设功能不可用', 'storage_unavailable'))
  }
  next()
}

router.get('/presets', requireStorage, (req, res) => {
  res.json({ items: listPresets(scopeOf(req)) })
})

router.get('/presets/:id', requireStorage, (req, res, next) => {
  const preset = getPreset(req.params.id, scopeOf(req))
  if (!preset) return next(notFound('预设不存在'))
  res.json(preset)
})

/** 新建；带 id 就是修改（前端「保存」按钮两种场景走同一个接口） */
router.post('/presets', requireStorage, (req, res, next) => {
  const body = req.body || {}
  try {
    const preset = body.id
      ? updatePreset(body.id, body, scopeOf(req))
      : createPreset(body, scopeOf(req))
    if (!body.id) inc('preset_created_total')
    res.status(body.id ? 200 : 201).json(preset)
  } catch (err) {
    next(err?.status ? err : badRequest(err?.message || '保存预设失败', 'preset_save_failed'))
  }
})

router.put('/presets/:id', requireStorage, (req, res, next) => {
  try {
    res.json(updatePreset(req.params.id, req.body || {}, scopeOf(req)))
  } catch (err) {
    next(err)
  }
})

router.delete('/presets/:id', requireStorage, (req, res) => {
  res.json({ ok: deletePreset(req.params.id, scopeOf(req)) })
})

/** 复制一份，方便在已有预设上微调 */
router.post(
  '/presets/:id/duplicate',
  requireStorage,
  asyncHandler(async (req, res) => {
    const copy = duplicatePreset(req.params.id, req.body?.name, scopeOf(req))
    inc('preset_created_total')
    res.status(201).json(copy)
  })
)

export default router
