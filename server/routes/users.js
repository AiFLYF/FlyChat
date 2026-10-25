import { Router } from 'express'
import { asyncHandler, badRequest, unavailable } from '../lib/errors.js'
import { storageStatus } from '../store/db.js'
import { createUser, deleteUser, listUsers, updateUser } from '../store/users.js'
import { requireAdmin } from '../lib/auth.js'
import { inc } from '../lib/metrics.js'

const router = Router()

const requireStorage = (_req, _res, next) => {
  if (!storageStatus().available) {
    return next(unavailable('服务端持久化不可用，用户管理不可用', 'storage_unavailable'))
  }
  next()
}

/** 用户管理只有管理员能碰 */
router.get('/users', requireAdmin, requireStorage, (_req, res) => {
  res.json({ items: listUsers() })
})

router.post(
  '/users',
  requireAdmin,
  requireStorage,
  asyncHandler(async (req, res) => {
    const user = createUser({
      username: req.body?.username,
      password: req.body?.password,
      role: req.body?.role === 'admin' ? 'admin' : 'user',
      displayName: req.body?.displayName,
    })
    inc('user_created_total')
    res.status(201).json(user)
  })
)

/** 改角色 / 禁用 / 重置密码 / 改显示名。字段传哪个改哪个 */
router.patch(
  '/users/:id',
  requireAdmin,
  requireStorage,
  asyncHandler(async (req, res) => {
    const patch = {}
    for (const key of ['role', 'disabled', 'password', 'displayName']) {
      if (req.body?.[key] !== undefined) patch[key] = req.body[key]
    }
    if (Object.keys(patch).length === 0) throw badRequest('没有要修改的字段', 'empty_patch')
    res.json(updateUser(req.params.id, patch))
  })
)

router.delete(
  '/users/:id',
  requireAdmin,
  requireStorage,
  asyncHandler(async (req, res) => {
    deleteUser(req.params.id)
    res.json({ ok: true })
  })
)

export default router
