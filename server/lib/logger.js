import { config } from '../config.js'

/**
 * 结构化日志。
 * - json：一行一个 JSON，便于容器/日志系统采集
 * - pretty：本机开发可读
 * 任何字段名命中敏感词的值都会被脱敏，避免 API Key 落盘到日志。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }
const SENSITIVE = /(api[-_]?key|authorization|token|secret|password|cookie)/i

function redact(value, depth = 0) {
  if (depth > 4 || value == null) return value
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…` : value
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1)
    }
    return out
  }
  return value
}

function timestamp() {
  return new Date().toISOString()
}

function emit(level, message, fields) {
  if (LEVELS[level] < (LEVELS[config.log.level] ?? LEVELS.info)) return
  const payload = { ts: timestamp(), level, msg: message, ...redact(fields || {}) }

  if (config.log.format === 'json') {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }

  const { ts, level: _l, msg, ...rest } = payload
  const time = ts.slice(11, 23)
  const tag = level.toUpperCase().padEnd(5)
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''
  const line = `${time} ${tag} ${msg}${extra}\n`
  if (level === 'error') process.stderr.write(line)
  else process.stdout.write(line)
}

/** 创建带固定上下文的子 logger（例如每个请求一个 requestId） */
export function createLogger(base = {}) {
  return {
    debug: (msg, fields) => emit('debug', msg, { ...base, ...fields }),
    info: (msg, fields) => emit('info', msg, { ...base, ...fields }),
    warn: (msg, fields) => emit('warn', msg, { ...base, ...fields }),
    error: (msg, fields) => emit('error', msg, { ...base, ...fields }),
    child: (fields) => createLogger({ ...base, ...fields }),
  }
}

export const logger = createLogger()
