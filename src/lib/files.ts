import { extractFile } from '../api/client'
import { uid } from './id'
import type { Attachment } from '../types'

/** 单个文件体积上限 */
const MAX_FILE_BYTES = 20 * 1024 * 1024

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

/**
 * 生成图片展示用的缩略图：缩到最长边 maxSize 的 JPEG。原图可能好几 MB，
 * 若每条历史消息都直接渲染/保存原图，列表会明显卡顿、内存吃紧。
 * 缩略图仅用于展示，发送给模型仍用完整 dataUrl。任一步失败或原图已够小则原样返回。
 */
export function generateThumbnail(dataUrl: string, maxSize = 480): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
        // 原图已小于目标尺寸，无需重绘
        if (scale >= 1) return resolve(dataUrl)
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(dataUrl)
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.8))
      } catch {
        resolve(dataUrl)
      }
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

/**
 * 把用户选择的文件转换为附件：
 * - 图片：读成 data URL，交给支持视觉的模型
 * - 文档：交给后端抽取纯文本（只抽一次，之后随消息一起发送）
 */
export async function fileToAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`文件过大（上限 20MB）：${file.name}`)
  }
  const dataUrl = await readAsDataUrl(file)

  if (file.type.startsWith('image/')) {
    const thumbnail = await generateThumbnail(dataUrl)
    return {
      id: uid(),
      type: 'image',
      name: file.name,
      mime: file.type,
      size: file.size,
      dataUrl,
      thumbnail,
    }
  }

  const { text } = await extractFile({ name: file.name, mime: file.type || 'application/octet-stream', dataUrl })
  if (!text.trim()) throw new Error(`未能从「${file.name}」中提取到文本内容`)
  return {
    id: uid(),
    type: 'file',
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    text,
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}
