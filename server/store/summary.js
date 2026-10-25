import { getDb } from './db.js'

/**
 * 上下文摘要缓存。
 *
 * 为什么必须缓存：每一轮对话都要压缩的话，等于每次请求都额外调一次模型，
 * 长对话里成本翻倍、延迟也翻倍。实际上被丢弃的那段历史在两次请求之间不会变，
 * 所以按「被丢弃消息的 id 集合」做 key，命中就直接用上一轮的摘要。
 */

const TABLE = `
CREATE TABLE IF NOT EXISTS context_summaries (
  prefix_key    TEXT PRIMARY KEY,
  summary       TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  tokens        INTEGER NOT NULL DEFAULT 0,
  model         TEXT,
  created_at    INTEGER NOT NULL
);
`

export function ensureSummaryTable() {
  getDb().exec(TABLE)
}

export function getSummary(prefixKey) {
  const row = getDb().prepare('SELECT * FROM context_summaries WHERE prefix_key = ?').get(String(prefixKey))
  return row ? { summary: row.summary, messageCount: row.message_count, tokens: row.tokens } : null
}

export function saveSummary({ prefixKey, summary, messageCount, tokens, model }) {
  getDb()
    .prepare(
      `INSERT INTO context_summaries (prefix_key, summary, message_count, tokens, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(prefix_key) DO UPDATE SET summary = excluded.summary, message_count = excluded.message_count,
         tokens = excluded.tokens, model = excluded.model, created_at = excluded.created_at`
    )
    .run(String(prefixKey), String(summary), messageCount, tokens, model || null, Date.now())
}

/** 定期清理：摘要表只保留最近 500 条 */
export function pruneSummaries(keep = 500) {
  getDb()
    .prepare(
      `DELETE FROM context_summaries WHERE prefix_key NOT IN (
         SELECT prefix_key FROM context_summaries ORDER BY created_at DESC LIMIT ?
       )`
    )
    .run(Math.max(10, keep))
}
