import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/**
 * 把 Tab / Shift+Tab 的焦点限制在容器内。
 *
 * 自绘浮层（登录框、知识库、命令面板）之前只标了 role="dialog"，
 * 焦点仍然能 Tab 到遮罩后面的页面上——键盘用户一旦跑出去就回不来，
 * 而这些浮层又没有明显的鼠标出口。
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const root = ref.current
      if (!root) return
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null
      )
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (current === first || !root.contains(current)) {
          e.preventDefault()
          last.focus()
        }
      } else if (current === last || !root.contains(current)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ref, active])
}
