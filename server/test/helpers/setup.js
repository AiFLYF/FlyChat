import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 测试环境准备。
 *
 * 必须在 import 任何业务模块**之前**调用：config.js 在模块加载时就读环境变量，
 * 晚一步设置就会连到真实的 data 目录和真实的上游。
 */
export function prepareEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flychat-test-'))
  process.env.NODE_ENV = 'test'
  process.env.FLYCHAT_DATA_DIR = dir
  process.env.LOG_LEVEL = 'silent'
  process.env.LOG_FORMAT = 'json'
  // 重试退避压到毫秒级，否则测试要等好几秒
  process.env.UPSTREAM_RETRY_BASE_MS = '10'
  process.env.UPSTREAM_RETRY_MAX_MS = '40'
  process.env.UPSTREAM_TIMEOUT_MS = '8000'
  process.env.SSE_HEARTBEAT_MS = '60000'
  // 清掉可能影响断言的宿主环境变量
  delete process.env.FLYCHAT_ACCESS_TOKEN
  delete process.env.CORS_ORIGINS
  delete process.env.TAVILY_API_KEY
  delete process.env.BRAVE_API_KEY
  delete process.env.SERPER_API_KEY
  delete process.env.SEARXNG_URL
  delete process.env.STRICT_SSRF
  Object.assign(process.env, extra)
  return dir
}

/** 在随机端口启动 app，返回 { url, close } */
export async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 读取 SSE 响应，返回事件数组 */
export async function readSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trimEnd()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        events.push(JSON.parse(payload))
      } catch {
        /* 忽略坏行 */
      }
    }
  }
  return events
}

/**
 * 测试隔离断言（必须在使用 app 之前调用）。
 *
 * 为什么必须有：ESM 的静态 import 会被提升，任何「在 prepareEnv() 之前
 * 静态 import 了业务模块」的测试文件，都会让 config.js 用默认的 server/data
 * 把测试数据写进项目真实数据库——我们真的踩到过：一次跑测试往生产库里塞了
 * 45 个假服务商和 60 条假用量。
 *
 * 用法：
 *   const { createApp } = await loadApp()
 */
export async function loadApp() {
  const [{ createApp }, { config }] = await Promise.all([
    import('../../app.js'),
    import('../../config.js'),
  ])
  if (config.storage.dataDir !== process.env.FLYCHAT_DATA_DIR) {
    throw new Error(
      `测试隔离失效：config.storage.dataDir=${config.storage.dataDir}，` +
        `但 FLYCHAT_DATA_DIR=${process.env.FLYCHAT_DATA_DIR}。` +
        '说明本文件在 prepareEnv() 之前静态 import 了业务模块（ESM 会提升 import），改成动态 import。'
    )
  }
  return createApp
}
