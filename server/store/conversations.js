import { getDb, transaction } from './db.js'
import { badRequest, notFound } from '../lib/errors.js'

/**
 * 会话与消息仓库。
 *
 * 存储层只做「存什么、取什么」，不做业务判断；
 * 前端 IndexedDB 里的数据结构原样对齐，这样将来接入服务端同步时不用改模型。
 */

const MAX_TITLE = 200
const MAX_CONTENT = 400_000

function toJson(value) {
  if (value == null) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function fromJson(text, fallback) {
  if (!text) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function rowToConversation(row) {
  return {
    id: row.id,
    title: row.title || '',
    pinned: !!row.pinned,
    sortIndex: row.sort_index ?? undefined,
    usingContext: !!row.using_context,
    assistantId: row.assistant_id || undefined,
    model: row.model || undefined,
    summary: row.summary || undefined,
    leafMessageId: row.leaf_message_id || undefined,
    folderId: row.folder_id || undefined,
    tags: fromJson(row.tags, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count ?? undefined,
  }
}

function rowToMessage(row) {
  const usage =
    row.usage_total == null
      ? undefined
      : {
          prompt: row.usage_prompt || 0,
          completion: row.usage_completion || 0,
          total: row.usage_total || 0,
        }
  return {
    id: row.id,
    role: row.role,
    content: row.content || '',
    createdAt: row.created_at,
    ...(row.model ? { model: row.model } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.error ? { error: true } : {}),
    ...(row.reasoning ? { reasoning: row.reasoning } : {}),
    ...(row.group_id ? { groupId: row.group_id } : {}),
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    ...(usage ? { usage } : {}),
    ...(row.citations ? { citations: fromJson(row.citations, []) } : {}),
    ...(row.attachments ? { attachments: fromJson(row.attachments, []) } : {}),
  }
}

function cleanTitle(title) {
  return String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
}

/**
 * 会话列表。
 * 传 `userId` 时只返回该用户的会话（多用户模式）；不传则不隔离（单用户模式）。
 */
export function listConversations({
  limit = 50,
  offset = 0,
  q = '',
  userId = null,
  folderId = undefined,
  tag = '',
  unfiled = false,
} = {}) {
  const db = getDb()
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50))
  const safeOffset = Math.max(0, Number(offset) || 0)
  const query = String(q || '').trim()
  const scoped = !!userId

  const base = `
    SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c`
  const order = `
    ORDER BY c.pinned DESC, c.sort_index IS NULL, c.sort_index ASC, c.updated_at DESC
    LIMIT ? OFFSET ?`

  // 条件用数组拼，避免「有搜索词 / 没搜索词 / 有用户 / 没用户」八种组合各写一遍
  const where = []
  const args = []
  if (scoped) {
    where.push('c.user_id = ?')
    args.push(String(userId))
  }
  if (unfiled) {
    where.push('c.folder_id IS NULL')
  } else if (folderId !== undefined) {
    // 传 null / '' 表示「未分类」，传 id 表示某个文件夹
    if (folderId) {
      where.push('c.folder_id = ?')
      args.push(String(folderId))
    } else {
      where.push('c.folder_id IS NULL')
    }
  }
  if (tag) {
    // tags 存成 JSON 数组字符串，这里用 LIKE 粗筛，再在内存里精确比对，
    // 避免「重要」匹配到「不重要」这种子串误伤。
    // ESCAPE 必须显式声明：SQLite 的 LIKE 默认没有转义符，
    // 转义了 % _ 却不写 ESCAPE 的话，反斜杠只是普通字符，转义等于没转。
    where.push(`c.tags LIKE ? ESCAPE '\\'`)
    args.push(`%${String(tag).replace(/[%_\\]/g, (m) => `\\${m}`)}%`)
  }
  if (query) {
    const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`
    where.push(`(c.title LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'))`)
    args.push(like, like)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  let rows = db.prepare(`${base} ${whereSql} ${order}`).all(...args, safeLimit, safeOffset)

  if (tag) {
    const wanted = String(tag).toLowerCase()
    rows = rows.filter((r) => {
      const list = fromJson(r.tags, [])
      return Array.isArray(list) && list.some((t) => String(t).toLowerCase() === wanted)
    })
  }

  // total 按同样的过滤条件算，否则分页会显示成「1/50」这种对不上的数
  const countWhere = []
  const countArgs = []
  if (scoped) {
    countWhere.push('user_id = ?')
    countArgs.push(String(userId))
  }
  if (unfiled || (folderId !== undefined && !folderId)) {
    countWhere.push('folder_id IS NULL')
  } else if (folderId) {
    countWhere.push('folder_id = ?')
    countArgs.push(String(folderId))
  }
  const total = tag
    ? rows.length
    : db
        .prepare(
          `SELECT COUNT(*) AS n FROM conversations${countWhere.length ? ` WHERE ${countWhere.join(' AND ')}` : ''}`
        )
        .get(...countArgs)?.n ?? 0

  return { items: rows.map(rowToConversation), total, limit: safeLimit, offset: safeOffset }
}

/**
 * 读一个会话。
 * 传 `userId` 时会校验归属：不是自己的会话一律返回 null——
 * 返回 404 而不是 403，避免被用来探测「这个 id 存在不存在」。
 */
export function getConversation(id, { userId = null } = {}) {
  const db = getDb()
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(String(id))
  if (!row) return null
  // 严格比对：`user_id` 为空的老数据也不能给到某个用户，否则等于越权读
  if (userId && row.user_id !== String(userId)) return null
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC').all(String(id))
  const tree = buildTree(rows.map(rowToMessage), row.leaf_message_id)
  return { ...rowToConversation(row), ...tree }
}

/**
 * 把扁平消息组成树，并按前序展开成展示顺序。
 *
 * 支持三种场景：
 * - 纯线性对话（没有 parentId）：parent 为空的都算根，按 seq 前序 = 原来的顺序，完全向后兼容；
 * - 分叉/编辑重生成：同一个 parentId 下的多条消息构成 variants（前端轮播切换）；
 * - parent 指向已删除消息：降级为根节点，不会把消息弄丢。
 */
function buildTree(messages, leafId) {
  const byId = new Map(messages.map((m) => [m.id, m]))
  const childrenOf = new Map()
  const roots = []

  for (const m of messages) {
    if (m.parentId && byId.has(m.parentId)) {
      if (!childrenOf.has(m.parentId)) childrenOf.set(m.parentId, [])
      childrenOf.get(m.parentId).push(m)
    } else {
      roots.push(m)
    }
  }

  // 只有挂在同一个 parent 下才算「兄弟节点」（前端轮播的多个版本）。
  // 没有 parentId 的老数据是纯线性对话，每条都只算 1 个版本，
  // 否则界面上会莫名其妙出现「1/4」这种轮播。
  const siblingsOf = (m) => (m.parentId && childrenOf.has(m.parentId) ? childrenOf.get(m.parentId) : [m])

  const ordered = []
  const seen = new Set()
  const visit = (m) => {
    if (seen.has(m.id)) return
    seen.add(m.id)
    const siblings = siblingsOf(m)
    ordered.push({
      ...m,
      variantCount: siblings.length,
      variantIndex: siblings.indexOf(m),
      hasChildren: childrenOf.has(m.id),
    })
    for (const child of childrenOf.get(m.id) || []) visit(child)
  }
  for (const root of roots) visit(root)
  // 兜底：任何没被访问到的消息（异常 parent 指向）按原顺序补到后面
  for (const m of messages) if (!seen.has(m.id)) ordered.push({ ...m, variantCount: 1, variantIndex: 0, hasChildren: false })

  // 当前激活路径：只有树形对话才需要回溯；纯线性对话整条都是激活状态
  const isTree = messages.some((m) => m.parentId)
  const leaf = byId.get(leafId) || ordered[ordered.length - 1] || null
  const activePath = []
  if (isTree) {
    let cursor = leaf
    while (cursor) {
      activePath.unshift(cursor.id)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null
    }
  } else {
    activePath.push(...ordered.map((m) => m.id))
  }

  return { messages: ordered, activePath, leafMessageId: leaf?.id ?? null, tree: isTree }
}

/**
 * 取「根 → 指定消息」这一条链，用作 /api/chat 的上下文。
 * 分叉后新请求只需要这条链上的消息，而不是整条扁平历史——这是消息树的核心价值。
 */
export function messageChain(conversationId, messageId, { userId = null } = {}) {
  const db = getDb()
  // 归属校验放在这里：/api/chat 用 parentId 取上下文时会走到这条路径，
  // 不校验的话别人猜一个 conversationId 就能把整段历史当上下文送进模型。
  if (userId) {
    const owner = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(String(conversationId))
    if (!owner || owner.user_id !== String(userId)) return []
  }
  const rows = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC').all(String(conversationId))
  if (rows.length === 0) return []
  const list = rows.map(rowToMessage)
  const byId = new Map(list.map((m) => [m.id, m]))
  const chain = []
  const seen = new Set()
  let cursor = byId.get(messageId) || list[list.length - 1]
  while (cursor) {
    // 客户端可以写入任意 parentId（含互相指向的坏数据），
    // 没有环检测的话这里会死循环，把请求挂死、内存耗光
    if (seen.has(cursor.id)) break
    seen.add(cursor.id)
    chain.unshift(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : null
  }
  return chain
}

export function upsertConversation(input = {}) {
  const id = String(input.id || '').trim()
  if (!id) throw badRequest('缺少会话 id', 'missing_conversation_id')
  const now = Date.now()
  const db = getDb()

  const existing = db.prepare('SELECT id, user_id FROM conversations WHERE id = ?').get(id)
  if (existing) {
    // 别人的会话不能被覆盖写
    if (input.userId && existing.user_id !== String(input.userId)) {
      throw notFound('会话不存在')
    }
    // 前端是「整条会话 POST 上来」的同步方式，所以更新时也要落消息，
    // 否则第二次同步开始消息就永远不更新了（这是真实踩过的坑）
    updateConversation(id, input)
    if (Array.isArray(input.messages) && input.messages.length) {
      saveMessages(id, input.messages, { replace: true })
    }
    return getConversation(id)
  }

  db.prepare(
    `INSERT INTO conversations (id, title, summary, pinned, sort_index, using_context, assistant_id, model, created_at, updated_at, leaf_message_id, user_id, folder_id, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    cleanTitle(input.title),
    input.summary ? String(input.summary).slice(0, 4000) : null,
    input.pinned ? 1 : 0,
    Number.isFinite(input.sortIndex) ? input.sortIndex : null,
    input.usingContext === false ? 0 : 1,
    input.assistantId ? String(input.assistantId) : null,
    input.model ? String(input.model) : null,
    Number(input.createdAt) || now,
    Number(input.updatedAt) || now,
    input.leafMessageId ? String(input.leafMessageId) : null,
    input.userId ? String(input.userId) : null,
    input.folderId ? String(input.folderId) : null,
    Array.isArray(input.tags) && input.tags.length ? JSON.stringify(input.tags) : null
  )

  if (Array.isArray(input.messages) && input.messages.length) {
    saveMessages(id, input.messages, { replace: true })
  }
  return getConversation(id)
}

/** 只更新传入的字段，其余保持不变 */
export function updateConversation(id, patch = {}, { userId = null } = {}) {
  const db = getDb()
  const exists = db.prepare('SELECT id, user_id FROM conversations WHERE id = ?').get(String(id))
  if (!exists) throw notFound('会话不存在')
  if (userId && exists.user_id !== String(userId)) throw notFound('会话不存在')

  const sets = []
  const params = []
  if (patch.title !== undefined) {
    sets.push('title = ?')
    params.push(cleanTitle(patch.title))
  }
  if (patch.pinned !== undefined) {
    sets.push('pinned = ?')
    params.push(patch.pinned ? 1 : 0)
  }
  if (patch.sortIndex !== undefined) {
    sets.push('sort_index = ?')
    params.push(Number.isFinite(patch.sortIndex) ? patch.sortIndex : null)
  }
  if (patch.usingContext !== undefined) {
    sets.push('using_context = ?')
    params.push(patch.usingContext ? 1 : 0)
  }
  if (patch.assistantId !== undefined) {
    sets.push('assistant_id = ?')
    params.push(patch.assistantId ? String(patch.assistantId) : null)
  }
  if (patch.model !== undefined) {
    sets.push('model = ?')
    params.push(patch.model ? String(patch.model) : null)
  }
  if (patch.summary !== undefined) {
    sets.push('summary = ?')
    params.push(patch.summary ? String(patch.summary).slice(0, 4000) : null)
  }
  if (patch.folderId !== undefined) {
    sets.push('folder_id = ?')
    params.push(patch.folderId ? String(patch.folderId) : null)
  }
  if (patch.tags !== undefined) {
    // 空数组存 null 而不是 "[]"，这样列表里的 `tags LIKE` 过滤不会误命中
    sets.push('tags = ?')
    params.push(Array.isArray(patch.tags) && patch.tags.length ? JSON.stringify(patch.tags) : null)
  }
  if (patch.leafMessageId !== undefined) {
    sets.push('leaf_message_id = ?')
    params.push(patch.leafMessageId ? String(patch.leafMessageId) : null)
  }
  // 只有显式传 updatedAt 才用调用方的值（前端本地排序需要），否则用当前时间
  sets.push('updated_at = ?')
  params.push(Number(patch.updatedAt) || Date.now())

  params.push(String(id))
  db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getConversation(id)
}

export function deleteConversation(id, { userId = null } = {}) {
  const db = getDb()
  if (userId) {
    const row = db.prepare('SELECT user_id FROM conversations WHERE id = ?').get(String(id))
    if (!row || row.user_id !== String(userId)) return false
  }
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(String(id))
  return (result?.changes ?? 0) > 0
}

/** 删除所有会话（危险操作，路由层要求显式确认） */
export function deleteAllConversations({ userId = null } = {}) {
  const db = getDb()
  if (userId) {
    // 多用户模式下「清空」只清自己的，绝不能把别人的会话一起删了
    const ids = db
      .prepare('SELECT id FROM conversations WHERE user_id = ?')
      .all(String(userId))
      .map((r) => r.id)
    if (ids.length === 0) return 0
    transaction((tx) => {
      for (const id of ids) {
        tx.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
        tx.prepare('DELETE FROM conversations WHERE id = ?').run(id)
      }
    })
    return ids.length
  }
  const n = db.prepare('SELECT COUNT(*) AS n FROM conversations').get()?.n ?? 0
  db.exec('DELETE FROM messages')
  db.exec('DELETE FROM conversations')
  return n
}

/**
 * 批量写入消息。
 * replace=true 时先清空该会话的消息（整体覆盖，适合前端全量同步）；
 * 否则按 id upsert（增量追加）。
 */
export function saveMessages(conversationId, messages, { replace = false } = {}) {
  if (!Array.isArray(messages)) throw badRequest('messages 必须是数组')
  const db = getDb()
  const id = String(conversationId)
  const conv = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id)
  if (!conv) throw notFound('会话不存在')

  return transaction((tx) => {
    if (replace) tx.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)

    const maxSeq =
      tx.prepare('SELECT COALESCE(MAX(seq), -1) AS s FROM messages WHERE conversation_id = ?').get(id)?.s ?? -1

    const insert = tx.prepare(
      `INSERT INTO messages
       (id, conversation_id, seq, role, content, reasoning, model, status, error,
        citations, attachments, group_id, parent_id, usage_prompt, usage_completion, usage_total, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         reasoning = excluded.reasoning,
         model = excluded.model,
         status = excluded.status,
         error = excluded.error,
         citations = excluded.citations,
         attachments = excluded.attachments,
         group_id = excluded.group_id,
         parent_id = excluded.parent_id,
         usage_prompt = excluded.usage_prompt,
         usage_completion = excluded.usage_completion,
         usage_total = excluded.usage_total`
    )

    let seq = maxSeq
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      const msgId = String(m.id || '').trim()
      if (!msgId) throw badRequest('消息缺少 id')
      const content = String(m.content ?? '')
      if (content.length > MAX_CONTENT) throw badRequest(`单条消息超过 ${MAX_CONTENT} 字符上限`)
      seq += 1
      insert.run(
        msgId,
        id,
        seq,
        String(m.role || 'user'),
        content,
        m.reasoning ? String(m.reasoning) : null,
        m.model ? String(m.model) : null,
        m.status ? String(m.status) : null,
        m.error ? 1 : 0,
        toJson(m.citations),
        toJson(m.attachments),
        m.groupId ? String(m.groupId) : null,
        m.parentId ? String(m.parentId) : null,
        m.usage?.prompt ?? null,
        m.usage?.completion ?? null,
        m.usage?.total ?? null,
        Number(m.createdAt) || Date.now()
      )
    }

    tx.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    return { saved: messages.length }
  })
}

export function conversationStats({ userId = null } = {}) {
  const db = getDb()
  if (userId) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n,
                (SELECT COUNT(*) FROM messages m JOIN conversations c2 ON c2.id = m.conversation_id WHERE c2.user_id = ?) AS messages,
                MIN(created_at) AS t
         FROM conversations WHERE user_id = ?`
      )
      .get(String(userId), String(userId))
    return { conversations: row?.n ?? 0, messages: row?.messages ?? 0, firstAt: row?.t ?? null }
  }
  return {
    conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations').get()?.n ?? 0,
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get()?.n ?? 0,
    firstAt: db.prepare('SELECT MIN(created_at) AS t FROM conversations').get()?.t ?? null,
  }
}

/** 导出为 Markdown：给用户一个「数据是我的」的出口 */
export function exportMarkdown(id, { userId = null } = {}) {
  const conv = getConversation(id, { userId })
  if (!conv) throw notFound('会话不存在')
  // 只导出当前激活分支，分叉出来的支线不混进来
  const active = conv.tree ? new Set(conv.activePath || []) : null
  const lines = [`# ${conv.title || '未命名会话'}`, '']
  for (const m of conv.messages || []) {
    if (active && !active.has(m.id)) continue
    const who = m.role === 'user' ? '我' : m.role === 'assistant' ? '助手' : m.role
    lines.push(`## ${who}${m.model ? ` · ${m.model}` : ''}`, '')
    if (m.reasoning) {
      lines.push('<details><summary>思考过程</summary>', '', m.reasoning, '', '</details>', '')
    }
    lines.push(m.content || '', '')
    if (m.citations?.length) {
      lines.push('参考来源：')
      for (const c of m.citations) lines.push(`- [${c.index}] [${c.title}](${c.url})`)
      lines.push('')
    }
  }
  return lines.join('\n')
}
