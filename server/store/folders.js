import crypto from 'node:crypto'
import { getDb, transaction } from './db.js'
import { badRequest, notFound } from '../lib/errors.js'

/**
 * 会话文件夹。
 *
 * 为什么还要标签：文件夹是「一个会话只属于一个地方」，适合「项目/客户」这种硬分类；
 * 标签是「一个会话可以贴多个」，适合「待跟进 / 重要 / 参考」这种横切关注点。
 * 两件事都在真实使用里出现，所以都做了——但都很轻（一个列 + 一个 JSON 数组）。
 */

const MAX_NAME = 60
const MAX_ICON = 8
const MAX_TAGS = 12
const MAX_TAG_LEN = 24

function now() {
  return Date.now()
}

function rowToFolder(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    icon: row.icon || undefined,
    sortIndex: row.sort_index ?? undefined,
    userId: row.user_id || undefined,
    count: row.count ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function cleanName(name) {
  const s = String(name || '').trim()
  if (!s) throw badRequest('文件夹名称不能为空', 'missing_name')
  return s.slice(0, MAX_NAME)
}

/**
 * 标签清洗：去空白、去重、限长、限数量。
 * 允许中文与空格（「待跟进 客户」这种是合理的），但去掉会破坏展示的字符。
 */
export function cleanTags(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    const tag = String(raw ?? '')
      .replace(/[,\n\r\t]/g, ' ')
      .trim()
      .slice(0, MAX_TAG_LEN)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** 列表带会话数：前端侧栏要显示「工作 (12)」 */
export function listFolders({ userId = null } = {}) {
  const db = getDb()
  const rows = userId
    ? db
        .prepare(
          `SELECT f.*, (SELECT COUNT(*) FROM conversations c WHERE c.folder_id = f.id AND c.user_id = ?) AS count
           FROM folders f WHERE f.user_id = ? ORDER BY COALESCE(f.sort_index, 999999) ASC, f.created_at ASC`
        )
        .all(String(userId), String(userId))
    : db
        .prepare(
          `SELECT f.*, (SELECT COUNT(*) FROM conversations c WHERE c.folder_id = f.id) AS count
           FROM folders f ORDER BY COALESCE(f.sort_index, 999999) ASC, f.created_at ASC`
        )
        .all()
  return rows.map(rowToFolder)
}

export function getFolder(id, { userId = null } = {}) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(String(id))
  if (!row) return null
  if (userId && row.user_id !== String(userId)) return null
  return rowToFolder(row)
}

export function createFolder({ name, icon, sortIndex } = {}, { userId = null } = {}) {
  const db = getDb()
  const id = `folder-${crypto.randomBytes(6).toString('hex')}`
  const t = now()
  db.prepare(
    `INSERT INTO folders (id, name, icon, sort_index, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    cleanName(name),
    icon ? String(icon).slice(0, MAX_ICON) : null,
    Number.isFinite(sortIndex) ? Number(sortIndex) : null,
    userId ? String(userId) : null,
    t,
    t
  )
  return getFolder(id)
}

export function updateFolder(id, patch = {}, { userId = null } = {}) {
  const db = getDb()
  const existing = getFolder(id, { userId })
  if (!existing) throw notFound('文件夹不存在')

  const sets = []
  const params = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(cleanName(patch.name))
  }
  if (patch.icon !== undefined) {
    sets.push('icon = ?')
    params.push(patch.icon ? String(patch.icon).slice(0, MAX_ICON) : null)
  }
  if (patch.sortIndex !== undefined) {
    sets.push('sort_index = ?')
    params.push(Number.isFinite(patch.sortIndex) ? Number(patch.sortIndex) : null)
  }
  if (sets.length === 0) return existing
  sets.push('updated_at = ?')
  params.push(now())
  params.push(String(id))
  db.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getFolder(id, { userId })
}

/**
 * 删除文件夹：**里面的会话不删**，只是回到「未分类」。
 * 删文件夹顺手删掉几十个会话是最容易让人失去信任的操作。
 */
export function deleteFolder(id, { userId = null } = {}) {
  const db = getDb()
  const folder = getFolder(id, { userId })
  if (!folder) return { ok: false, moved: 0 }
  let moved = 0
  transaction((tx) => {
    moved = tx
      .prepare(
        userId
          ? 'UPDATE conversations SET folder_id = NULL WHERE folder_id = ? AND user_id = ?'
          : 'UPDATE conversations SET folder_id = NULL WHERE folder_id = ?'
      )
      .run(...(userId ? [String(id), String(userId)] : [String(id)])).changes
    tx.prepare('DELETE FROM folders WHERE id = ?').run(String(id))
  })
  return { ok: true, moved }
}

/**
 * 批量把会话移进/移出文件夹。`folderId` 传 null 表示移出。
 * 只动属于当前用户的会话——传一堆别人的 id 进来也只会静默跳过。
 */
export function moveConversations(conversationIds, folderId, { userId = null } = {}) {
  const ids = (Array.isArray(conversationIds) ? conversationIds : [])
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .slice(0, 500)
  if (ids.length === 0) throw badRequest('conversationIds 不能为空', 'missing_conversation_ids')

  if (folderId) {
    const folder = getFolder(folderId, { userId })
    if (!folder) throw notFound('文件夹不存在')
  }

  const sql = userId
    ? 'UPDATE conversations SET folder_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    : 'UPDATE conversations SET folder_id = ?, updated_at = ? WHERE id = ?'
  let moved = 0
  transaction((tx) => {
    const stmt = tx.prepare(sql)
    for (const id of ids) {
      const args = userId
        ? [folderId ? String(folderId) : null, now(), id, String(userId)]
        : [folderId ? String(folderId) : null, now(), id]
      moved += stmt.run(...args).changes
    }
  })
  return { ok: true, moved }
}

/** 所有出现过的标签 + 各自数量（侧栏标签云用） */
export function listTags({ userId = null } = {}) {
  const db = getDb()
  const rows = userId
    ? db.prepare('SELECT tags FROM conversations WHERE user_id = ? AND tags IS NOT NULL').all(String(userId))
    : db.prepare('SELECT tags FROM conversations WHERE tags IS NOT NULL').all()

  const counts = new Map()
  for (const row of rows) {
    let list = []
    try {
      list = JSON.parse(row.tags)
    } catch {
      list = []
    }
    if (!Array.isArray(list)) continue
    for (const tag of list) {
      const key = String(tag)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
}
