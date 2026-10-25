import crypto from 'node:crypto'
import { getDb } from '../store/db.js'
import { badRequest, notFound } from '../lib/errors.js'

/**
 * MCP server 配置的持久化。
 * 密钥（env / headers）只存在这里，`toApi()` 永不外泄。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  transport     TEXT NOT NULL,
  command       TEXT,
  args          TEXT,
  env           TEXT,
  base_url      TEXT,
  headers       TEXT,
  enabled       INTEGER NOT NULL DEFAULT 0,
  trusted       INTEGER NOT NULL DEFAULT 0,
  disabled_tools TEXT,
  last_error    TEXT,
  tool_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
`

export function ensureMcpTables() {
  getDb().exec(SCHEMA)
}

const TRANSPORTS = ['stdio', 'http']

function toJson(value) {
  return value == null ? null : JSON.stringify(value)
}

function rowToApi(row) {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command || undefined,
    args: row.args ? JSON.parse(row.args) : undefined,
    env: row.env ? Object.keys(JSON.parse(row.env)) : undefined,
    baseUrl: row.base_url || undefined,
    headers: row.headers ? Object.keys(JSON.parse(row.headers)) : undefined,
    enabled: !!row.enabled,
    trusted: !!row.trusted,
    disabledTools: row.disabled_tools ? JSON.parse(row.disabled_tools) : [],
    lastError: row.last_error || undefined,
    toolCount: row.tool_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function listServers() {
  ensureMcpTables()
  return getDb()
    .prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC')
    .all()
    .map(rowToApi)
}

export function findServer(id) {
  ensureMcpTables()
  const row = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(String(id))
  return row ? { row, api: rowToApi(row) } : null
}

export function upsertServer(input = {}) {
  ensureMcpTables()
  const db = getDb()
  const now = Date.now()

  const name = String(input.name ?? '').trim()
  if (!name) throw badRequest('请填写 MCP server 名称', 'invalid_name')
  if (name.length > 60) throw badRequest('名称不能超过 60 个字符', 'invalid_name')

  const transport = String(input.transport ?? '')
  if (!TRANSPORTS.includes(transport)) throw badRequest(`传输方式必须是 ${TRANSPORTS.join(' / ')}`, 'invalid_transport')

  let command = null
  let args = null
  let env = null
  let baseUrl = null

  if (transport === 'stdio') {
    command = String(input.command ?? '').trim()
    if (!command) throw badRequest('stdio 传输需要 command（例如 node / npx / uvx）', 'invalid_command')
    args = Array.isArray(input.args) ? input.args.map((a) => String(a)) : []
    if (args.some((a) => !a.trim())) throw badRequest('args 不能有空项', 'invalid_args')
    env = input.env && typeof input.env === 'object' ? input.env : {}
  } else {
    baseUrl = String(input.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\/.+/i.test(baseUrl)) throw badRequest('Base URL 必须以 http:// 或 https:// 开头', 'invalid_base_url')
  }
  const headers = input.headers && typeof input.headers === 'object' ? input.headers : {}

  const id = input.id ? String(input.id) : ''
  const existing = id ? db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(id) : null
  if (id && !existing) throw notFound('要修改的 MCP server 不存在')

  const record = {
    name,
    transport,
    command,
    args: toJson(args),
    env: toJson(env),
    base_url: baseUrl,
    headers: toJson(headers),
  }

  if (existing) {
    db.prepare(
      `UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, env = ?, base_url = ?, headers = ?, updated_at = ?
       WHERE id = ?`
    ).run(record.name, record.transport, record.command, record.args, record.env, record.base_url, record.headers, now, id)
    return findServer(id).api
  }

  const newId = `mcp-${crypto.randomBytes(6).toString('hex')}`
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, command, args, env, base_url, headers, enabled, trusted, disabled_tools, last_error, tool_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '[]', NULL, 0, ?, ?)`
  ).run(newId, record.name, record.transport, record.command, record.args, record.env, record.base_url, record.headers, now, now)
  return findServer(newId).api
}

export function deleteServer(id) {
  ensureMcpTables()
  const result = getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(String(id))
  return (result?.changes ?? 0) > 0
}

export function setEnabled(id, enabled) {
  ensureMcpTables()
  getDb().prepare('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), String(id))
  return findServer(id)?.api ?? null
}

export function setTrusted(id, trusted) {
  ensureMcpTables()
  getDb().prepare('UPDATE mcp_servers SET trusted = ?, updated_at = ? WHERE id = ?').run(trusted ? 1 : 0, Date.now(), String(id))
  return findServer(id)?.api ?? null
}

/** 单工具级别的禁用（Cherry Studio 的 disabledTools 也是这个粒度） */
export function setToolDisabled(id, toolName, disabled) {
  ensureMcpTables()
  const found = findServer(id)
  if (!found) throw notFound('MCP server 不存在')
  const list = new Set(found.api.disabledTools || [])
  if (disabled) list.add(toolName)
  else list.delete(toolName)
  getDb()
    .prepare('UPDATE mcp_servers SET disabled_tools = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify([...list]), Date.now(), String(id))
  return findServer(id).api
}

/** 探测结果回写（连接成功/失败、工具数） */
export function recordProbe(id, { ok, toolCount = 0, error = null }) {
  ensureMcpTables()
  getDb()
    .prepare('UPDATE mcp_servers SET tool_count = ?, last_error = ?, updated_at = ? WHERE id = ?')
    .run(ok ? toolCount : 0, error, Date.now(), String(id))
}

/** 给运行时用的完整配置（含密钥），只在服务端内部流转 */
export function resolvedServer(id) {
  const found = findServer(id)
  if (!found) return null
  const row = found.row
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: row.args ? JSON.parse(row.args) : [],
    env: row.env ? JSON.parse(row.env) : {},
    baseUrl: row.base_url,
    headers: row.headers ? JSON.parse(row.headers) : {},
    enabled: !!row.enabled,
    trusted: !!row.trusted,
    disabledTools: row.disabled_tools ? JSON.parse(row.disabled_tools) : [],
    updatedAt: row.updated_at,
  }
}

export function enabledServers() {
  ensureMcpTables()
  return getDb()
    .prepare('SELECT id FROM mcp_servers WHERE enabled = 1')
    .all()
    .map((r) => r.id)
}
