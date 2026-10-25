import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 假 MCP server，用于测试。
 * 提供两种传输：stdio（子进程）与 Streamable HTTP。
 * 只实现测试需要的几个方法：initialize / tools/list / tools/call。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TOOLS = [
  {
    name: 'get_weather',
    description: '查询城市天气',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'write_file',
    description: '把内容写入服务器上的文件',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
]

const SERVER_SCRIPT = `
process.stdin.setEncoding('utf8')
let buffer = ''
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined) continue
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } })
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: ${JSON.stringify(TOOLS)} } })
    } else if (msg.method === 'tools/call') {
      const args = (msg.params && msg.params.arguments) || {}
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '北京 晴 26℃（' + (args.city || '未知城市') + '）' }], isError: false } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
    }
  }
})
`

let scriptFile = null

/** 把假 MCP server 脚本写到临时文件，返回路径（stdio 传输用） */
export function writeMcpServerScript() {
  if (scriptFile && fs.existsSync(scriptFile)) return scriptFile
  const file = path.join(os.tmpdir(), `flychat-mcp-${Date.now()}.cjs`)
  fs.writeFileSync(file, SERVER_SCRIPT, 'utf8')
  scriptFile = file
  return file
}

/** Streamable HTTP 传输的假 MCP server */
export async function startMockMcpHttp() {
  const state = { hits: 0, lastBody: null }
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      state.hits += 1
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'bad json' }))
        return
      }
      state.lastBody = msg
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
      if (msg.method === 'initialize') {
        reply({ protocolVersion: msg.params?.protocolVersion, capabilities: {}, serverInfo: { name: 'fake-mcp-http', version: '1.0.0' } })
      } else if (msg.method === 'tools/list') {
        reply({ tools: TOOLS })
      } else if (msg.method === 'tools/call') {
        const args = (msg.params && msg.params.arguments) || {}
        reply({ content: [{ type: 'text', text: `HTTP 已写入 ${args.path || '未知路径'}` }], isError: false })
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not allowed method' } }))
      }
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/mcp`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
