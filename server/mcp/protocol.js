/**
 * MCP 协议基础（JSON-RPC 2.0 子集）。
 *
 * 为什么自己写而不引 `@modelcontextprotocol/sdk`：
 * 那个包装了一堆传递依赖（zod、eventsource、express、pkce…），
 * 而我们对 MCP 的需求只是一个 JSON-RPC 客户端：initialize / tools/list / tools/call。
 * 自己实现约 200 行，换来「继续零依赖、Docker 镜像不涨」。
 *
 * 协议参考：https://modelcontextprotocol.io/specification
 */

export const PROTOCOL_VERSION = '2024-11-05'

export const CLIENT_INFO = {
  name: 'flychat',
  version: '1.0.0',
}

let nextId = 1
export function nextRequestId() {
  return nextId++
}

/** 构造一个请求 */
export function makeRequest(method, params) {
  return { jsonrpc: '2.0', id: nextRequestId(), method, ...(params === undefined ? {} : { params }) }
}

/** 构造一个通知（无 id，不需要响应） */
export function makeNotification(method, params) {
  return { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }
}

export function isResponse(msg) {
  return msg && typeof msg === 'object' && (msg.id !== undefined || msg.method === undefined) && 'result' in msg
    ? true
    : !!msg && typeof msg === 'object' && msg.id !== undefined && ('result' in msg || 'error' in msg)
}

export function isNotification(msg) {
  return !!msg && typeof msg === 'object' && typeof msg.method === 'string' && msg.id === undefined
}

/** 把 MCP 的 content 数组转成纯文本 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      if (!item) return ''
      if (item.type === 'text') return String(item.text ?? '')
      if (item.type === 'resource') {
        const resource = item.resource || {}
        return `[resource ${resource.uri || ''}] ${String(resource.text ?? '')}`
      }
      // image / audio 等二进制内容：返回占位说明，避免把 base64 灌进上下文
      return `[${item.type || 'unknown'} content]`
    })
    .filter(Boolean)
    .join('\n\n')
}

/** MCP 的 inputSchema → OpenAI function 的 parameters（两者都是 JSON Schema，可直接用） */
export function toToolDefinition(server, tool) {
  return {
    name: mcpToolName(server.id || server.name, server.name, tool.name),
    description: `【MCP: ${server.name}】${tool.description || tool.title || tool.name}`,
    parameters:
      tool.inputSchema && typeof tool.inputSchema === 'object' && tool.inputSchema.type
        ? tool.inputSchema
        : { type: 'object', properties: {} },
  }
}

/** 工具名加命名空间，避免多个 MCP server 的同名工具撞车（LibreChat / Cherry 都这么做） */
/**
 * 工具名加命名空间，避免多个 MCP server 的同名工具撞车（LibreChat / Cherry 都这么做）。
 *
 * OpenAI / Anthropic 都要求工具名只含 `[a-zA-Z0-9_-]`，所以中文 server 名必须转写。
 * 但只转写会撞车（「我的 Server」和「另一个 Server」都变成 server），
 * 因此再拼一段 server id 的短哈希保证唯一。
 */
export function mcpToolName(serverId, serverName, toolName) {
  const slug =
    String(serverName || 'mcp')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'mcp'
  const idHash =
    String(serverId || '')
      .replace(/[^a-z0-9]/gi, '')
      .slice(-4) || '0000'
  const tool = String(toolName || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `mcp__${slug}-${idHash}__${tool}`
}

/** 从加了命名空间的工具名反解出原始工具名 */
export function parseToolName(namespacedName) {
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(String(namespacedName || ''))
  return m ? m[1] : String(namespacedName || '')
}
