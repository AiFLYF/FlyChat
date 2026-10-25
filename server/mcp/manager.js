import { McpClient } from './client.js'
import { toToolDefinition } from './protocol.js'
import { enabledServers, recordProbe, resolvedServer } from './registry.js'
import { logger } from '../lib/logger.js'

/**
 * MCP 运行时管理：连接池 + 工具装载 + 执行。
 *
 * 连接池按 server id 缓存，TTL 5 分钟；配置一改（updatedAt 变化）立即失效——
 * 免得用户改了 command/env 之后连过去的还是旧进程。
 */

const POOL_TTL_MS = 5 * 60 * 1000
const pool = new Map()

function poolKey(id) {
  return id
}

function isFresh(entry, server) {
  return entry && entry.expiresAt > Date.now() && entry.updatedAt === server.updatedAt
}

async function acquire(server) {
  const cached = pool.get(poolKey(server.id))
  if (isFresh(cached, server) && cached.client.ready) return cached.client
  if (cached?.client) await cached.client.close().catch(() => {})

  const client = new McpClient(server)
  await client.connect()
  pool.set(poolKey(server.id), { client, expiresAt: Date.now() + POOL_TTL_MS, updatedAt: server.updatedAt })
  return client
}

export async function closeAll() {
  for (const [, entry] of pool) await entry.client.close().catch(() => {})
  pool.clear()
}

/**
 * 探测一个 server：连上、拿工具列表、写回状态。
 * @returns {Promise<{ok: boolean, tools?: any[], error?: string}>}
 */
export async function probeServer(id) {
  const server = resolvedServer(id)
  if (!server) return { ok: false, error: 'MCP server 不存在' }
  try {
    const client = new McpClient(server)
    await client.connect()
    const tools = await client.listTools()
    await client.close()
    recordProbe(id, { ok: true, toolCount: tools.length })
    // 探测成功也顺手刷新连接池
    pool.delete(poolKey(server.id))
    return { ok: true, tools }
  } catch (err) {
    const message = err?.message || String(err)
    recordProbe(id, { ok: false, error: message })
    logger.warn('MCP 探测失败', { id, message })
    return { ok: false, error: message }
  }
}

/** 工具是否「危险」：MCP 用 annotations 标注，没有标注就保守视为可写 */
function isDestructive(tool) {
  const hints = tool?.annotations || {}
  if (hints.destructiveHint === true) return true
  if (hints.readOnlyHint === true) return false
  return true // 未标注：保守
}

/**
 * 装载已启用 server 的工具。
 *
 * @param {{only?: string[]}} [options]
 *   `only` 限定只装这几个 server 的工具（预设绑定 MCP 组合时用）。
 *   传空数组表示「一个都不要」——这与不传是两种语义，不能混。
 * @returns {Promise<{definitions: object[], index: Map<string, {serverId, toolName, serverName, trusted}>}>}
 */
export async function loadMcpTools(options = {}) {
  const definitions = []
  const index = new Map()
  const only = Array.isArray(options.only) ? new Set(options.only) : null

  for (const id of enabledServers()) {
    if (only && !only.has(id)) continue
    const server = resolvedServer(id)
    if (!server) continue
    const disabled = new Set(server.disabledTools || [])

    let tools = []
    try {
      const client = await acquire(server)
      tools = await client.listTools()
    } catch (err) {
      logger.warn('MCP server 连接失败，跳过其工具', { id, name: server.name, message: err?.message })
      continue
    }

    for (const tool of tools) {
      if (disabled.has(tool.name)) continue
      const definition = toToolDefinition(server, tool)
      definitions.push(definition)
      index.set(definition.name, {
        serverId: server.id,
        serverName: server.name,
        toolName: tool.name,
        trusted: server.trusted,
        destructive: isDestructive(tool),
      })
    }
  }

  return { definitions, index }
}

/**
 * 执行一个 MCP 工具。
 * 安全模型：**未信任的 server 只能调只读工具**，写操作必须先开「信任」开关。
 */
export async function callMcpTool(serverId, toolName, args, ctx = {}) {
  const server = resolvedServer(serverId)
  if (!server) return { ok: false, error: 'MCP server 不存在' }

  const meta = { destructive: true }
  try {
    const client = await acquire(server)
    const tools = await client.listTools()
    const tool = tools.find((t) => t.name === toolName)
    if (!tool) return { ok: false, error: `MCP server 上没有工具 ${toolName}` }
    meta.destructive = isDestructive(tool)
    if (meta.destructive && !server.trusted) {
      return {
        ok: false,
        error: `工具 ${toolName} 属于可写操作，需要先在「设置 → MCP」里信任「${server.name}」后才能执行。`,
      }
    }
    return await client.callTool(toolName, args || {})
  } catch (err) {
    logger.warn('MCP 工具调用失败', { serverId, toolName, message: err?.message })
    return { ok: false, error: err?.message || String(err) }
  }
}

/** 测试用 */
export function resetMcpPool() {
  pool.clear()
}
