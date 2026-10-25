import { getDb } from './db.js'

/**
 * 用量记账。
 * 每次流式请求结束后落一条记录：谁、哪个模型、多少 token、估算多少钱、耗时多少。
 * 这是「商业化」的基础：没有账，就没法谈配额、成本、计费。
 */

export function recordUsage({
  conversationId = null,
  provider = null,
  model = null,
  prompt = 0,
  completion = 0,
  total = 0,
  costUsd = 0,
  latencyMs = null,
  status = 'ok',
} = {}) {
  try {
    getDb()
      .prepare(
        `INSERT INTO usage_events
         (conversation_id, provider, model, prompt, completion, total, cost_usd, latency_ms, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        conversationId ? String(conversationId) : null,
        provider,
        model,
        Math.max(0, Math.round(Number(prompt) || 0)),
        Math.max(0, Math.round(Number(completion) || 0)),
        Math.max(0, Math.round(Number(total) || 0)),
        Number(costUsd) || 0,
        latencyMs == null ? null : Math.round(Number(latencyMs) || 0),
        status,
        Date.now()
      )
  } catch {
    // 记账失败不能影响聊天：静默忽略（例如存储不可用）
  }
}

/** 按天、按模型聚合。days=0 表示全部时间 */
export function usageSummary({ days = 30 } = {}) {
  const db = getDb()
  const since = days > 0 ? Date.now() - days * 86_400_000 : 0

  const totals =
    db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(prompt), 0) AS prompt,
                COALESCE(SUM(completion), 0) AS completion,
                COALESCE(SUM(total), 0) AS total,
                COALESCE(SUM(cost_usd), 0) AS cost,
                COALESCE(AVG(latency_ms), 0) AS avgLatency
         FROM usage_events WHERE created_at >= ?`
      )
      .get(since) || {}

  const byDay = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS requests,
              COALESCE(SUM(total), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost
       FROM usage_events WHERE created_at >= ?
       GROUP BY day ORDER BY day ASC`
    )
    .all(since)

  const byModel = db
    .prepare(
      `SELECT provider, model, COUNT(*) AS requests,
              COALESCE(SUM(prompt), 0) AS prompt,
              COALESCE(SUM(completion), 0) AS completion,
              COALESCE(SUM(total), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost
       FROM usage_events WHERE created_at >= ?
       GROUP BY provider, model ORDER BY tokens DESC`
    )
    .all(since)

  return {
    range: { days, since },
    totals: {
      requests: totals.requests ?? 0,
      promptTokens: totals.prompt ?? 0,
      completionTokens: totals.completion ?? 0,
      totalTokens: totals.total ?? 0,
      costUsd: Math.round((totals.cost ?? 0) * 1e6) / 1e6,
      avgLatencyMs: Math.round(totals.avgLatency ?? 0),
    },
    byDay,
    byModel,
  }
}

export function recentUsage({ limit = 50 } = {}) {
  const db = getDb()
  return db
    .prepare(
      `SELECT id, conversation_id AS conversationId, provider, model, prompt, completion, total,
              cost_usd AS costUsd, latency_ms AS latencyMs, status, created_at AS createdAt
       FROM usage_events ORDER BY id DESC LIMIT ?`
    )
    .all(Math.min(500, Math.max(1, Number(limit) || 50)))
}
