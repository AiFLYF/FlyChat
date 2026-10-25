import { useEffect, useId, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { usePresence } from '../../lib/usePresence'

/**
 * 弹窗通用外壳。
 *
 * 改动原因：SettingsModal 与后续的快捷键面板需要完全一致的
 * 「遮罩淡入 + 面板升起、关闭时反向播放、焦点移入/归还、Tab 焦点陷阱」逻辑。
 * 抽出来之后新增弹窗只需写内容，不必再复制一整套无障碍与动画代码。
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
  className = '',
  headerExtra,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  className?: string
  /** 标题右侧的附加元素 */
  headerExtra?: ReactNode
}) {
  const { mounted, closing } = usePresence(open, 200)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // 焦点管理：打开时把焦点移入面板内第一个可聚焦控件，关闭后归还给触发它的元素
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const focusables = panel?.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    ;(focusables?.[0] ?? panel)?.focus()
    return () => previous?.focus?.()
  }, [open])

  /**
   * 焦点陷阱：Tab / Shift+Tab 在弹窗内循环。
   * 覆盖「焦点刚好落在面板容器本身」的情况——否则一按 Shift+Tab 就会漏到背景页面。
   */
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const nodes = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null || el === document.activeElement)
    if (!nodes.length) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
      e.preventDefault()
      first.focus()
    }
  }

  if (!mounted) return null

  return (
    // 遮罩负责整体淡入淡出，面板只做位移+缩放，两层分工避免叠加后显得发虚
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-4 ${
        closing ? 'anim-fade-out pointer-events-none' : 'anim-fade-in'
      }`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={trapTab}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`r-2xl max-h-[92vh] w-full overflow-y-auto border border-rule bg-raised p-5 shadow-3 outline-none sm:max-h-[86vh] sm:p-6 ${
          closing ? 'anim-modal-sink' : 'anim-modal-rise'
        } ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight text-ink-1">
            {title}
          </h2>
          <div className="flex shrink-0 items-center gap-2">
            {headerExtra}
            <button
              onClick={onClose}
              className="r-sm press -mr-1 flex h-8 w-8 items-center justify-center text-ink-3 transition-ui hover:bg-hover hover:text-ink-1"
              aria-label="关闭"
            >
              <X size={17} />
            </button>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

/** 弹窗底部的操作区：用渐变细线与内容分隔，长内容时不必滚到底就能操作 */
export function ModalFooter({ children }: { children: ReactNode }) {
  return <div className="hairline mt-6 flex items-center gap-2 pt-5">{children}</div>
}
