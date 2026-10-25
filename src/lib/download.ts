/** 触发浏览器下载 */
export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  downloadBlob(filename, new Blob([content], { type: mime }))
}

export function downloadJson(filename: string, data: unknown) {
  downloadText(filename, JSON.stringify(data, null, 2), 'application/json;charset=utf-8')
}

/** 安全文件名：去掉路径分隔符等非法字符 */
export function safeFileName(name: string): string {
  return (name || 'untitled').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
}
