/** 轻量唯一 id 生成 */
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
