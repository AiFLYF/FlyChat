import { config } from '../config.js'

/**
 * 服务端 → 前端的 SSE 通道。
 *
 * 心跳（注释行 `: ping`）不是可有可无的：模型思考十几秒不出字时，
 * nginx / Cloudflare / 手机网络都会把「看起来没动静」的连接掐掉。
 * 每 15 秒发一个注释行，连接就能活到第一个 token 到达。
 */
export function createSseStream(res, { heartbeatMs = config.chat.heartbeatMs } = {}) {
  let closed = false
  let ended = false

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 关掉 nginx 的响应缓冲，否则流式会变成「一次性吐出」
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  const timer = setInterval(() => {
    if (closed) return
    try {
      res.write(': ping\n\n')
    } catch {
      closed = true
    }
  }, heartbeatMs)
  timer.unref?.()

  const send = (obj) => {
    if (closed || ended) return false
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
      return true
    } catch {
      closed = true
      return false
    }
  }

  const close = () => {
    clearInterval(timer)
    if (ended) return
    ended = true
    try {
      res.end()
    } catch {
      /* 客户端可能已经断开 */
    }
  }

  res.on('close', () => {
    clearInterval(timer)
    if (!res.writableEnded) closed = true
  })

  return {
    send,
    close,
    get closed() {
      return closed || ended
    },
  }
}
