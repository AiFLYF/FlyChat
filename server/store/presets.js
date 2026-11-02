import crypto from 'node:crypto'
import { getDb } from './db.js'
import { workspaceExists } from '../rag/store.js'
import { AppError, badRequest, notFound } from '../lib/errors.js'

/**
 * 预设（Preset）持久化。
 *
 * 一个预设 = 一组「可复用的对话起点」：
 *   模型 + 采样参数 + 系统提示 + 绑定知识库 + 绑定工具/MCP server 组合
 *
 * 为什么要有它：竞品的调研结论里，「把常用配置存成一条能一键切换的条目」是使用频率最高的功能之一
 * （Open WebUI 的模型预设、LibreChat 的 modelSpec、Cherry 的 assistant 都是这个）。
 * 而 LibreChat #7387 明确抱怨「modelSpec 没法固定一组 MCP server」——
 * 我们把 MCP 组合也一起绑进来，这是可以直接拉开差距的地方。
 */

const MAX_NAME = 60
const MAX_PROMPT = 20000
const MAX_DESC = 400
const MAX_MCP = 20

const PARAM_KEYS = new Set([
  'temperature',
  'topP',
  'maxTokens',
  'think',
  'webSearch',
  'agent',
  'tools',
  'topK',
  'mcpMode',
  'imageGeneration',
])

function now() {
  return Date.now()
}

function rowToPreset(row) {
  if (!row) return null
  let params = {}
  try {
    params = row.params ? JSON.parse(row.params) : {}
  } catch {
    params = {}
  }
  let mcpServers = []
  try {
    mcpServers = row.mcp_servers ? JSON.parse(row.mcp_servers) : []
  } catch {
    mcpServers = []
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    icon: row.icon || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    systemPrompt: row.system_prompt || undefined,
    params,
    workspaceId: row.workspace_id || undefined,
    mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
    sortIndex: row.sort_index ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 只保留认识的参数键，并做范围约束——预设是长期存在的配置，不能存进脏值 */
function cleanParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (!PARAM_KEYS.has(key)) continue
    if (key === 'temperature') {
      const n = Number(value)
      if (Number.isFinite(n)) out[key] = Math.min(2, Math.max(0, n))
    } else if (key === 'topP') {
      const n = Number(value)
      if (Number.isFinite(n)) out[key] = Math.min(1, Math.max(0, n))
    } else if (key === 'maxTokens' || key === 'topK') {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) out[key] = Math.round(n)
    } else if (key === 'tools') {
      // 允许 `true`（用全部内置工具）或明确的工具名数组
      if (value === true) out.tools = true
      else if (Array.isArray(value)) {
        out.tools = value.map((v) => String(v)).filter(Boolean).slice(0, 20)
      }
    } else if (key === 'mcpMode') {
      // 'all' = 用全部已启用 server；'selected' = 只用 preset.mcpServers 里挑的
      if (value === 'all' || value === 'selected') out.mcpMode = value
    } else if (typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

function cleanName(name) {
  const s = String(name || '').trim()
  if (!s) throw badRequest('预设名称不能为空', 'missing_name')
  return s.slice(0, MAX_NAME)
}

/** 绑定的知识库必须是当前用户可见的；已删除或别人的库不存，打开预设时才不会突然 404 */
function cleanWorkspaceId(workspaceId, userId) {
  if (!workspaceId) return null
  return workspaceExists(workspaceId, { userId }) ? String(workspaceId) : null
}

/**
 * 老预设（`user_id` 为 NULL）是开启归属隔离之前的共享数据：
 * 所有人可见、可直接使用，但只有管理员能改/删，普通用户只能克隆成自己的。
 */
function scopeRow(row, { userId = null, isAdmin = false } = {}) {
  const preset = rowToPreset(row)
  if (preset && userId && row.user_id == null && !isAdmin) preset.readonly = true
  return preset
}

function ownedRow(id, { userId = null } = {}) {
  const row = getDb().prepare('SELECT * FROM presets WHERE id = ?').get(String(id))
  if (!row) return null
  // 别人的预设一律当作不存在：不暴露它是否还在
  if (userId && row.user_id && row.user_id !== String(userId)) return null
  return row
}

function assertWritable(row, { userId = null, isAdmin = false } = {}) {
  if (!userId) return
  if (row.user_id === String(userId)) return
  if (row.user_id == null && isAdmin) return
  if (row.user_id == null) {
    throw new AppError('共享预设只能由管理员修改，可先克隆一份再编辑', {
      status: 403,
      code: 'preset_readonly',
    })
  }
  throw notFound('预设不存在')
}

/** 传 userId 时返回「自己的 + 无主共享的」；单用户模式不隔离 */
export function listPresets({ userId = null, isAdmin = false } = {}) {
  const db = getDb()
  const rows = userId
    ? db
        .prepare(
          'SELECT * FROM presets WHERE user_id = ? OR user_id IS NULL ORDER BY COALESCE(sort_index, 999999) ASC, created_at ASC'
        )
        .all(String(userId))
    : db
        .prepare('SELECT * FROM presets ORDER BY COALESCE(sort_index, 999999) ASC, created_at ASC')
        .all()
  return rows.map((row) => scopeRow(row, { userId, isAdmin }))
}

export function getPreset(id, { userId = null, isAdmin = false } = {}) {
  const row = ownedRow(id, { userId })
  return row ? scopeRow(row, { userId, isAdmin }) : null
}

export function createPreset(input = {}, { userId = null } = {}) {
  const db = getDb()
  const id = `preset-${crypto.randomBytes(6).toString('hex')}`
  const t = now()
  db.prepare(
    `INSERT INTO presets
     (id, name, description, icon, provider, model, system_prompt, params, workspace_id, mcp_servers, sort_index, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    cleanName(input.name),
    input.description ? String(input.description).slice(0, MAX_DESC) : null,
    input.icon ? String(input.icon).slice(0, 8) : null,
    input.provider ? String(input.provider) : null,
    input.model ? String(input.model).slice(0, 200) : null,
    input.systemPrompt ? String(input.systemPrompt).slice(0, MAX_PROMPT) : null,
    JSON.stringify(cleanParams(input.params)),
    cleanWorkspaceId(input.workspaceId, userId),
    JSON.stringify(
      Array.isArray(input.mcpServers) ? input.mcpServers.map(String).slice(0, MAX_MCP) : []
    ),
    Number.isFinite(input.sortIndex) ? Number(input.sortIndex) : null,
    userId ? String(userId) : null,
    t,
    t
  )
  return getPreset(id, { userId })
}

/**
 * 更新预设。只改传进来的字段（`undefined` 视为「不动」），
 * 想清空某个字段就传 `null` 或空字符串。
 */
export function updatePreset(id, patch = {}, { userId = null, isAdmin = false } = {}) {
  const db = getDb()
  const existing = ownedRow(id, { userId })
  if (!existing) throw notFound('预设不存在')
  assertWritable(existing, { userId, isAdmin })

  const sets = []
  const params = []
  const setIf = (field, column, value) => {
    if (value === undefined) return
    sets.push(`${column} = ?`)
    params.push(value)
  }

  if (patch.name !== undefined) setIf('name', 'name', cleanName(patch.name))
  setIf('description', 'description', patch.description === undefined ? undefined : patch.description ? String(patch.description).slice(0, MAX_DESC) : null)
  setIf('icon', 'icon', patch.icon === undefined ? undefined : patch.icon ? String(patch.icon).slice(0, 8) : null)
  setIf('provider', 'provider', patch.provider === undefined ? undefined : patch.provider ? String(patch.provider) : null)
  setIf('model', 'model', patch.model === undefined ? undefined : patch.model ? String(patch.model).slice(0, 200) : null)
  setIf(
    'systemPrompt',
    'system_prompt',
    patch.systemPrompt === undefined ? undefined : patch.systemPrompt ? String(patch.systemPrompt).slice(0, MAX_PROMPT) : null
  )
  if (patch.params !== undefined) {
    sets.push('params = ?')
    params.push(JSON.stringify(cleanParams(patch.params)))
  }
  setIf('workspaceId', 'workspace_id', patch.workspaceId === undefined ? undefined : cleanWorkspaceId(patch.workspaceId, userId))
  if (patch.mcpServers !== undefined) {
    sets.push('mcp_servers = ?')
    params.push(
      JSON.stringify(Array.isArray(patch.mcpServers) ? patch.mcpServers.map(String).slice(0, MAX_MCP) : [])
    )
  }
  setIf('sortIndex', 'sort_index', patch.sortIndex === undefined ? undefined : Number.isFinite(patch.sortIndex) ? Number(patch.sortIndex) : null)

  if (sets.length === 0) return getPreset(id, { userId, isAdmin })
  sets.push('updated_at = ?')
  params.push(now())
  params.push(String(id))
  db.prepare(`UPDATE presets SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getPreset(id, { userId, isAdmin })
}

export function deletePreset(id, { userId = null, isAdmin = false } = {}) {
  const row = ownedRow(id, { userId })
  if (!row) return false
  if (userId && row.user_id == null && !isAdmin) return false
  return getDb().prepare('DELETE FROM presets WHERE id = ?').run(String(id)).changes > 0
}

/** 复制一份（用户在已有预设上微调时最常用）；副本归当前用户所有 */
export function duplicatePreset(id, name, { userId = null, isAdmin = false } = {}) {
  const source = getPreset(id, { userId, isAdmin })
  if (!source) throw notFound('预设不存在')
  const { readonly: _readonly, ...fields } = source
  return createPreset(
    {
      ...fields,
      name: name ? String(name) : `${source.name} 副本`,
      sortIndex: undefined,
    },
    { userId }
  )
}
