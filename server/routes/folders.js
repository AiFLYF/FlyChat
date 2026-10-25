import { Router } from 'express'
import { asyncHandler, badRequest, notFound, unavailable } from '../lib/errors.js'
import { storageStatus } from '../store/db.js'
import { currentUserId } from '../lib/auth.js'
import {
  createFolder,
  deleteFolder,
  getFolder,
  listFolders,
  listTags,
  moveConversations,
  updateFolder,
} from '../store/folders.js'
import { inc } from '../lib/metrics.js'

const router = Router()

const requireStorage = (_req, _res, next) => {
  if (!storageStatus().available) {
    return next(unavailable('服务端持久化不可用，文件夹功能不可用', 'storage_unavailable'))
  }
  next()
}

/** 文件夹列表（带每个文件夹里的会话数） */
router.get('/folders', requireStorage, (req, res) => {
  res.json({ items: listFolders({ userId: currentUserId(req) }) })
})

router.get('/folders/:id', requireStorage, (req, res, next) => {
  const folder = getFolder(req.params.id, { userId: currentUserId(req) })
  if (!folder) return next(notFound('文件夹不存在'))
  res.json(folder)
})

router.post('/folders', requireStorage, (req, res, next) => {
  try {
    const folder = createFolder(req.body || {}, { userId: currentUserId(req) })
    inc('folder_created_total')
    res.status(201).json(folder)
  } catch (err) {
    next(err?.status ? err : badRequest(err?.message || '创建失败', 'folder_create_failed'))
  }
})

router.patch('/folders/:id', requireStorage, (req, res, next) => {
  try {
    res.json(updateFolder(req.params.id, req.body || {}, { userId: currentUserId(req) }))
  } catch (err) {
    next(err?.status ? err : badRequest(err?.message || '更新失败', 'folder_update_failed'))
  }
})

/**
 * 删除文件夹：里面的会话**不会被删**，只是回到「未分类」。
 * 返回 moved 让前端能提示「12 个会话已移到未分类」。
 */
router.delete('/folders/:id', requireStorage, (req, res) => {
  const result = deleteFolder(req.params.id, { userId: currentUserId(req) })
  res.json(result)
})

/** 批量把会话移进 / 移出文件夹（`folderId: null` 表示移出） */
router.post(
  '/folders/:id/move',
  requireStorage,
  asyncHandler(async (req, res) => {
    const folderId = req.params.id === 'none' ? null : req.params.id
    const result = moveConversations(req.body?.conversationIds, folderId, { userId: currentUserId(req) })
    res.json(result)
  })
)

/** 把所有出现过的标签连同数量返回（侧栏标签云） */
router.get('/tags', requireStorage, (req, res) => {
  res.json({ items: listTags({ userId: currentUserId(req) }) })
})

export default router
