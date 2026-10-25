/** 当天 00:00 的时间戳 */
function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 会话列表的时间分组：今天 / 昨天 / 更早。
 * 抽出来的原因：这段日期边界计算原本内联在 Sidebar 里，
 * 与 MessageItem 的时间格式化各写一套 `new Date()` 逻辑，容易不一致。
 */
export function dayBucket(ts: number): 'today' | 'yesterday' | 'earlier' {
  const today = startOfToday()
  if (ts >= today) return 'today'
  if (ts >= today - 24 * 60 * 60 * 1000) return 'yesterday'
  return 'earlier'
}

/** 消息时间：同一天显示 HH:mm，跨天显示 M/D HH:mm */
export function formatMessageTime(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
