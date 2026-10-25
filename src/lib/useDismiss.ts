import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * 浮层关闭逻辑：点击外部 + Esc 键。
 *
 * 改动原因：Sidebar（助手下拉）、ModelSelector、PromptPicker 三处各自写了一份
 * 完全相同的 `document.addEventListener('mousedown', ...)`，且都只处理鼠标、
 * 不响应 Esc —— 键盘用户无法关闭浮层（可访问性缺陷）。
 * 提取后三处共用，且统一补上 Esc 与焦点归还。
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  active = true
) {
  useEffect(() => {
    if (!active) return

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 阻止冒泡：App 层的 Esc 只负责关设置弹窗，不应连带关闭其他浮层
        e.stopPropagation()
        onDismiss()
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [ref, onDismiss, active])
}
