import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { PANEL, MENU_ITEM } from '../../lib/ui'
import { usePresence } from '../../lib/usePresence'

type Origin = 'top' | 'top-right' | 'top-left' | 'bottom' | 'bottom-left' | 'bottom-right'

const ORIGIN: Record<Origin, string> = {
  top: 'origin-top',
  'top-right': 'origin-top-right',
  'top-left': 'origin-top-left',
  bottom: 'origin-bottom',
  'bottom-left': 'origin-bottom-left',
  'bottom-right': 'origin-bottom-right',
}

/**
 * 浮层菜单容器。
 *
 * 改动原因：ModelSelector / PromptPicker / Sidebar 助手菜单 / ChatWindow 导出菜单
 * 四处重复了「absolute + overflow-hidden + rounded + border + shadow-3 + animate-pop」，
 * 且各自漏了 `role="menu"`。统一后定位类由调用方通过 position 传入，
 * 其余外观与动画集中在此，转场方向由 origin 控制（贴着触发按钮展开更自然）。
 */
export function MenuPanel({
  open,
  position,
  origin = 'top',
  label,
  children,
}: {
  /** 由调用方传入可见性：关闭时先播退场动画再卸载 */
  open: boolean
  /** 定位相关 class（absolute / right-0 / top-10 / 宽度 / z-index） */
  position: string
  origin?: Origin
  label?: string
  children: ReactNode
}) {
  // 始终渲染，靠 closing 切换退场动画，避免关闭时「啪」地消失
  const { mounted, closing } = usePresence(open, 140)
  const panelRef = useRef<HTMLDivElement>(null)
  /** 打开前的焦点持有者（触发按钮），关闭时归还 */
  const returnFocusRef = useRef<HTMLElement | null>(null)

  // 打开时把焦点移入面板、关闭时归还触发按钮——ARIA APG 的「菜单按钮」模式。
  // 没有这一步，role="menu" 只是摆设：键盘用户打开菜单后焦点还在触发按钮上，
  // 按方向键不会有任何反应。
  //
  // 依赖里必须带 mounted：usePresence 靠 effect 翻 phase，open 变 true 的这次渲染
  // 面板还没进 DOM（panelRef.current 为 null），要等 mounted 变 true 后再聚焦。
  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    if (!mounted) return
    // 带搜索框的菜单（ModelSelector / PromptPicker）优先聚焦输入框，其次第一项
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), [role="menuitem"]:not([disabled])'
    )
    first?.focus()
    return () => {
      // open 变 false 即执行（退场动画期间焦点已在触发按钮上，符合预期）
      returnFocusRef.current?.focus?.()
    }
  }, [open, mounted])

  if (!mounted) return null

  /** 方向键在菜单项间移动焦点，Home/End 跳首尾；输入框内不拦截（要移动文本光标） */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const el = e.target as HTMLElement
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return
    const panel = panelRef.current
    if (!panel) return
    const items = Array.from(
      panel.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')
    )
    if (!items.length) return
    e.preventDefault()
    const idx = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Home') items[0].focus()
    else if (e.key === 'End') items[items.length - 1].focus()
    else if (e.key === 'ArrowDown') items[(idx + 1 + items.length) % items.length]?.focus()
    else items[(idx - 1 + items.length) % items.length]?.focus()
  }

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`overflow-hidden rounded-xl ${PANEL} ${ORIGIN[origin]} ${position} ${
        closing ? 'anim-menu-out' : 'animate-pop'
      }`}
    >
      {children}
    </div>
  )
}

/** 浮层菜单项 */
export function MenuItem({
  icon,
  children,
  onClick,
  disabled,
  className = '',
  style,
}: {
  icon?: ReactNode
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
  style?: CSSProperties
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`${MENU_ITEM} ${className}`}
      style={style}
    >
      {icon}
      {children}
    </button>
  )
}

/** 菜单分组小标题 */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium tracking-wide text-ink-3">{children}</p>
}
