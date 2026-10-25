import { spawn } from 'node:child_process'
import {
  CLIENT_INFO,
  PROTOCOL_VERSION,
  contentToText,
  isNotification,
  isResponse,
  makeNotification,
  makeRequest,
} from './protocol.js'

/**
 * MCP 客户端（stdio 与 Streamable HTTP 两种传输）。
 *
 * 生命周期：connect() → initialize → notifications/initialized → listTools() →
 * callTool() → close()。同时收到多条通知（进度、日志）时直接忽略——
 * 对我们来说只有 tools/call 的返回有意义。
 */

const DEFAULT_TIMEOUT_MS = 20_000

export class McpClient {
  /**
   * @param {{id: string, name: string, transport: 'stdio'|'http', command?: string,
   *          args?: string[], env?: Record<string,string>, baseUrl?: string,
   *          headers?: Record<string,string>, timeoutMs?: number}} config
   */
  constructor(config) {
    this.config = config
    this.name = config.name || config.id
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS
    this.ready = false
    this.serverInfo = null
    this._stdio = null
    this._buffer = ''
    this._pending = new Map()
  }

  async connect() {
    if (this.config.transport === 'stdio') await this._connectStdio()
    else await this._connectHttp()

    const init = await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: CLIENT_INFO,
    })
    this.serverInfo = init?.serverInfo || null
    // 初始化完成后必须发这个通知，否则某些 server 会拒绝后续请求
    this._notify('notifications/initialized')
    this.ready = true
    return init
  }

  async listTools() {
    const result = await this._request('tools/list', {})
    return Array.isArray(result?.tools) ? result.tools : []
  }

  /**
   * 调用工具。
   * @returns {{ok: boolean, text?: string, error?: string}}
   */
  async callTool(toolName, args = {}) {
    const result = await this._request('tools/call', { name: toolName, arguments: args || {} })
    const text = contentToText(result?.content)
    if (result?.isError) return { ok: false, error: text || 'MCP 工具返回错误' }
    return { ok: true, text }
  }

  async close() {
    this.ready = false
    if (this._stdio) {
      try {
        this._stdio.kill()
      } catch {
        /* 已经退出 */
      }
      this._stdio = null
    }
    for (const [, pending] of this._pending) pending.reject(new Error('连接已关闭'))
    this._pending.clear()
  }

  // ---- 内部 ----

  _notify(method, params) {
    const msg = makeNotification(method, params)
    if (this._stdio) this._stdio.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  async _request(method, params) {
    if (this.config.transport === 'stdio') {
      if (!this._stdio) throw new Error('MCP stdio 连接未建立')
      return this._requestStdio(method, params)
    }
    return this._requestHttp(method, params)
  }

  _requestStdio(method, params) {
    const msg = makeRequest(method, params)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(msg.id)
        reject(new Error(`MCP ${this.name} 超时（${this.timeoutMs}ms）：${method}`))
      }, this.timeoutMs)

      this._pending.set(msg.id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      this._stdio.stdin.write(`${JSON.stringify(msg)}\n`)
    })
  }

  _connectStdio() {
    return new Promise((resolve, reject) => {
      const { command, args = [], env = {} } = this.config
      if (!command) return reject(new Error('stdio 传输需要 command'))

      // 安全起见不让 MCP server 继承我们自己的密钥
      const cleanEnv = { ...process.env, ...env }
      delete cleanEnv.FLYCHAT_ACCESS_TOKEN

      const child = spawn(command, args, { env: cleanEnv, stdio: ['pipe', 'pipe', 'pipe'] })
      this._stdio = child

      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk).slice(0, 500)
      })
      child.on('error', (err) => {
        for (const [, pending] of this._pending) pending.reject(err)
        this._pending.clear()
      })
      child.on('exit', (code) => {
        this.ready = false
        const err = new Error(`MCP server ${this.name} 已退出（code=${code}）${stderr ? `：${stderr}` : ''}`)
        for (const [, pending] of this._pending) pending.reject(err)
        this._pending.clear()
      })

      this._readStdio()
      resolve()
    })
  }

  _readStdio() {
    this._stdio.stdout.on('data', (chunk) => {
      this._buffer += String(chunk)
      let idx
      while ((idx = this._buffer.indexOf('\n')) >= 0) {
        const line = this._buffer.slice(0, idx).trim()
        this._buffer = this._buffer.slice(idx + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        this._handleMessage(msg)
      }
    })
  }

  _handleMessage(msg) {
    if (isNotification(msg)) return // 进度/日志通知，忽略
    if (!isResponse(msg)) return
    const pending = this._pending.get(msg.id)
    if (!pending) return
    this._pending.delete(msg.id)
    if (msg.error) pending.reject(new Error(msg.error.message || `MCP 错误 ${msg.error.code}`))
    else pending.resolve(msg.result)
  }

  // ---- HTTP（Streamable HTTP）----

  async _connectHttp() {
    if (!this.config.baseUrl) throw new Error('HTTP 传输需要 baseUrl')
    // Streamable HTTP 不需要预先握手，initialize 时会自动带上
  }

  async _requestHttp(method, params) {
    const msg = makeRequest(method, params)
    const headers = {
      'Content-Type': 'application/json',
      // 关键：同时接受 JSON 与 SSE 两种响应形式
      Accept: 'application/json, text/event-stream',
      ...(this.config.headers || {}),
    }
    if (this._sessionId) headers['mcp-session-id'] = this._sessionId

    const res = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    const sessionId = res.headers.get('mcp-session-id')
    if (sessionId) this._sessionId = sessionId

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`MCP ${this.name} HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`)
    }

    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('text/event-stream')) {
      const payload = await this._readSseOnce(res)
      return payload
    }
    const json = await res.json().catch(() => null)
    if (json?.error) throw new Error(json.error.message || 'MCP 错误')
    return json?.result ?? null
  }

  /** 从 SSE 流里取出对应 id 的那一帧（MCP 的响应通常只有一帧） */
  async _readSseOnce(response) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let deadline = Date.now() + this.timeoutMs

    try {
      for (;;) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error(`MCP ${this.name} SSE 响应超时`)
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('MCP SSE 读取超时')), remaining)),
        ])
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let idx
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trimEnd()
          buffer = buffer.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          let msg
          try {
            msg = JSON.parse(payload)
          } catch {
            continue
          }
          if (isResponse(msg)) {
            if (msg.error) throw new Error(msg.error.message || 'MCP 错误')
            return msg.result
          }
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
    }
    throw new Error(`MCP ${this.name} SSE 流里没有响应`)
  }
}
