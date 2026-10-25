import { toPng } from 'html-to-image'
import { downloadBlob } from './download'

/** 把 DOM 节点导出为 PNG 图片 */
export async function exportNodeAsImage(node: HTMLElement, filename: string) {
  const styles = getComputedStyle(document.body)
  const dataUrl = await toPng(node, {
    pixelRatio: 2,
    cacheBust: true,
    backgroundColor: styles.backgroundColor || '#ffffff',
  })
  const res = await fetch(dataUrl)
  downloadBlob(filename, await res.blob())
}
