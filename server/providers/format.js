/**
 * 把内部消息格式转换为各家上游协议格式的公共助手。
 * 内部附件约定：
 *   - 图片：{ type:'image', mime, dataUrl }
 *   - 文档：{ type:'file', name, text }（文本已在前端由 /api/extract 抽取好）
 */

/** 文档文本与用户正文合并成一段可读的提示文本 */
export function buildTextContent(message) {
  const files = (message.attachments || []).filter((a) => a.type === 'file' && a.text)
  const blocks = files.map(
    (a) => `【附件：${a.name || '文档'}】\n${String(a.text).slice(0, 100000)}`
  )
  if (message.content) blocks.push(message.content)
  return blocks.join('\n\n')
}

/** 取出图片附件（只保留 data URL 形式） */
export function imageAttachments(message) {
  return (message.attachments || []).filter((a) => a.type === 'image' && a.dataUrl)
}

/** 解析 data URL：data:<mime>;base64,<data> */
export function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '')
  if (!match) return null
  const mime = match[1] || 'application/octet-stream'
  const isBase64 = !!match[2]
  const data = match[3] || ''
  return { mime, data, isBase64 }
}
