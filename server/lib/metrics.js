/**
 * 进程内运行指标。
 * 不引 prometheus 客户端：自托管产品里一个 /api/metrics JSON 足够排查
 * 「是不是变慢了 / 是不是一直在报错」，需要对接监控时再换格式。
 */

const counters = new Map()
const timings = new Map()
const MAX_SAMPLES = 500

export function inc(name, labels = {}, value = 1) {
  const key = labelKey(name, labels)
  counters.set(key, (counters.get(key) || 0) + value)
}

export function observe(name, ms, labels = {}) {
  const key = labelKey(name, labels)
  const list = timings.get(key) || []
  list.push(Math.max(0, Number(ms) || 0))
  if (list.length > MAX_SAMPLES) list.shift()
  timings.set(key, list)
}

function labelKey(name, labels) {
  const entries = Object.entries(labels || {})
  if (entries.length === 0) return name
  return `${name}{${entries.map(([k, v]) => `${k}=${v}`).join(',')}}`
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[idx])
}

export function metricsSnapshot() {
  const latency = {}
  for (const [key, list] of timings.entries()) {
    const sorted = [...list].sort((a, b) => a - b)
    latency[key] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1] || 0,
    }
  }
  return {
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
    counters: Object.fromEntries(counters),
    latency,
  }
}

/** 测试用 */
export function resetMetrics() {
  counters.clear()
  timings.clear()
}
