import { config } from './config.js'
import { createApp } from './app.js'
import { initStorage, closeStorage } from './store/db.js'
import { logger } from './lib/logger.js'
import { configuredProviders } from './providers/registry.js'
import { availableSearchProviders } from './search/index.js'
import { resetStaleJobs } from './rag/jobs.js'
import { cleanupSessions, countUsers } from './store/users.js'

/**
 * 进程入口：只负责「装配 + 监听 + 优雅退出」。
 * 业务逻辑在 app.js 与 routes/ 里，测试可以直接 createApp() 拿到同一个应用。
 */

initStorage()

// 上次进程中断可能留下「processing」状态的行，复位成可重试的 failed
await resetStaleJobs()

// 清掉过期登录态；多用户模式下顺便提示「还没建管理员」和「有没有无主会话」
cleanupSessions()
if (config.auth.multiUser) {
  const users = countUsers()
  if (users === 0) {
    logger.warn('已开启多用户模式但还没有任何账号：打开网页会进入「创建管理员」页')
  } else {
    const { getDb } = await import('./store/db.js')
    const orphans = getDb().prepare('SELECT COUNT(*) AS n FROM conversations WHERE user_id IS NULL').get()?.n || 0
    if (orphans > 0) {
      logger.warn('存在无归属的历史会话，管理员可调用 POST /api/conversations/claim-orphans 认领', { orphans })
    }
  }
}

const app = createApp()
const server = app.listen(config.server.port, config.server.host, () => {
  const providers = configuredProviders()
  logger.info(`FlyChat 服务已启动 http://${config.server.host}:${config.server.port}`, {
    version: config.version,
    env: config.env,
    providers: providers.length ? providers.map((p) => p.id).join(',') : '（无，请在设置里配置）',
    search: availableSearchProviders().join(',') || '（未配置）',
    auth: config.auth.token ? '已开启访问令牌' : '未开启',
  })
  if (providers.length === 0) {
    logger.warn('还没有可用的模型服务商：打开前端「设置 → 模型服务」添加，或在 server/.env 填入 API Key')
  }
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`, {
      hint: '可能是上一次启动的进程还没退出；换端口用 PORT=3002 启动',
    })
  } else {
    logger.error('服务启动失败', { message: err?.message })
  }
  process.exit(1)
})

// 优雅退出：先停止接新连接，再关数据库，避免 WAL 未落盘
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`收到 ${signal}，正在退出…`)
  const force = setTimeout(() => {
    logger.warn('优雅退出超时，强制结束')
    process.exit(1)
  }, 5000)
  force.unref()

  server.close(() => {
    closeStorage()
    logger.info('已退出')
    process.exit(0)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal))
}

// 进程级兜底：漏网的异常只记录，不直接把服务打挂
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', { message: reason?.stack || reason?.message || String(reason) })
})
process.on('uncaughtException', (err) => {
  logger.error('未捕获异常', { message: err?.stack || err?.message || String(err) })
})
