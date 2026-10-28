import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
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
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  /** 内容区下方是否还有内容：决定底部渐隐要不要画 */
  const [moreBelow, setMoreBelow] = useState(false)

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
   * Esc 关闭。
   *
   * 由弹窗外壳统一负责，而不是指望每个调用方各自实现：原先「分享与导出」弹窗
   * 只挂了遮罩点击和关闭按钮，Esc 完全无效，与站内其它弹窗行为不一致
   * （实测按 Esc 后遮罩仍在，后续点击全部被拦截）。
   * 挂在 window 上而非面板上，是为了不依赖焦点落在面板内。
   */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  /**
   * 跟踪内容区是否还能继续往下滚。
   * 用 ResizeObserver 而不是只监听 scroll：切换标签页后内容高度变化（内容变长/变短），
   * 只监听 scroll 的话底部渐隐会停在错误的状态。
   * 只有取值真的变了才 setState，避免每帧滚动都触发重渲染。
   */
  useEffect(() => {
    if (!open || !mounted) return
    const el = bodyRef.current
    if (!el) return
    const update = () => {
      const next = el.scrollTop + el.clientHeight < el.scrollHeight - 8
      setMoreBelow((prev) => (prev === next ? prev : next))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [open, mounted])

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
        // 面板本身不滚动，改成「标题栏固定 + 内容区独立滚动」：
        // 原先整个面板 overflow-y-auto，小屏滚到中间时标题和关闭按钮会一起滚出视口，
        // 用户只剩 Esc 一条退路（实测 390×844 下关闭按钮 top=-290px）。
        className={`r-2xl relative flex max-h-[92vh] w-full flex-col overflow-hidden border border-rule bg-raised shadow-3 outline-none sm:max-h-[86vh] ${
          closing ? 'anim-modal-sink' : 'anim-modal-rise'
        } ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-rule/60 px-5 pb-3 pt-4 sm:px-6 sm:pb-3.5 sm:pt-5">
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
        {/* min-h-0 不能省：flex 子项默认 min-height:auto，内容会把容器撑破、overflow 永不生效 */}
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {children}
        </div>
        {/* 底部渐隐：告诉用户「下面还有」，滚到底自动消失。
            直接挂在面板上而不是再包一层 relative 容器——包一层会让内容区高度
            解析不到 flex 父级的实际高度（实测 h-full 退化成 auto，滚动直接失效）。 */}
        {moreBelow && (
          <div
            aria-hidden
            className="fade-out-bottom pointer-events-none absolute inset-x-0 bottom-0 h-9"
          />
        )}
      </div>
    </div>
  )
}

/** 弹窗底部的操作区：用渐变细线与内容分隔，长内容时不必滚到底就能操作 */
export function ModalFooter({ children }: { children: ReactNode }) {
  return <div className="hairline mt-6 flex items-center gap-2 pt-5">{children}</div>
}
