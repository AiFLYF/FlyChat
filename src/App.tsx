import { useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import ChatWindow from './components/ChatWindow'
import SettingsModal from './components/SettingsModal'
import ShortcutsPanel from './components/ShortcutsPanel'
import UsageModal from './components/UsageModal'
import CommandPalette from './components/CommandPalette'
import SharedView from './components/SharedView'
import ArtifactWorkspace from './components/artifacts/ArtifactWorkspace'
import AssistantMarketModal from './components/AssistantMarketModal'
import { useChatStore } from './store/chat'
import { useComposer } from './store/composer'
import {
  useCommandPaletteOpen,
  useMarketOpen,
  useSettingsOpen,
  useShortcutsOpen,
  useUsageOpen,
} from './components/openPanels'
import { usePresence } from './lib/usePresence'

export default function App() {
  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const theme = useChatStore((s) => s.settings.theme)
  const hydrated = useChatStore((s) => s.hydrated)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const createConversation = useChatStore((s) => s.createConversation)

  // 检查 URL 是否包含分享链接（?share= 或 /s/:id / /share/:id）
  const [shareId, setShareId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const params = new URLSearchParams(window.location.search)
    const q = params.get('share')
    if (q) return q
    const m = window.location.pathname.match(/^\/(?:s|share)\/([^/]+)/)
    return m ? m[1] : null
  })

  const closeSharedView = () => {
    setShareId(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('share')
    const cleanPath = url.pathname.replace(/^\/(?:s|share)\/[^/]+/, '/') || '/'
    window.history.pushState({}, '', cleanPath + (url.search ? url.search : ''))
  }

  // 弹窗可见性
  const setSettingsOpen = useSettingsOpen((s) => s.setOpen)
  const setShortcutsOpen = useShortcutsOpen((s) => s.setOpen)
  const usageOpen = useUsageOpen((s) => s.open)
  const setUsageOpen = useUsageOpen((s) => s.setOpen)
  const commandOpen = useCommandPaletteOpen((s) => s.open)
  const setCommandOpen = useCommandPaletteOpen((s) => s.setOpen)
  const marketOpen = useMarketOpen((s) => s.open)
  const setMarketOpen = useMarketOpen((s) => s.setOpen)

  const settingsOpen = useSettingsOpen((s) => s.open)
  const shortcutsOpen = useShortcutsOpen((s) => s.open)
  const bumpComposerFocus = useComposer((s) => s.bumpFocus)
  const overlay = usePresence(sidebarOpen, 160)
  // 弹窗打开时把主内容区设为 inert，避免键盘/读屏越过焦点陷阱触达背景
  const bgRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bgRef.current?.toggleAttribute('inert', settingsOpen || shortcutsOpen || usageOpen || commandOpen || marketOpen)
  }, [settingsOpen, shortcutsOpen, usageOpen, commandOpen, marketOpen])

  // 应用主题（浅色 / 深色 / 跟随系统）
  const prevDark = useRef<boolean | null>(null)
  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    let timer: number | null = null

    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      // 真正发生明暗翻转时，短暂开启全局颜色过渡（见 index.css 的 .theme-anim），
      // 让整站是「渐变」而不是「闪一下」。首次应用不加，否则首屏会看到一次褪色。
      if (prevDark.current !== null && prevDark.current !== dark) {
        root.classList.add('theme-anim')
        if (timer) window.clearTimeout(timer)
        timer = window.setTimeout(() => root.classList.remove('theme-anim'), 260)
      }
      prevDark.current = dark
      root.classList.toggle('dark', dark)
      localStorage.setItem('flychat-theme', theme)
    }

    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  // 全局快捷键：
  //   ?            快捷键说明
  //   /            聚焦输入框（与快捷键面板的说明一致）
  //   Esc          关闭弹窗
  //   Ctrl+Shift+O 新对话
  //   Ctrl+B       切换侧边栏
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false)
        setShortcutsOpen(false)
        setUsageOpen(false)
        setCommandOpen(false)
        return
      }

      // "?" 需要在输入框/文本域聚焦时不触发，否则打不出问号
      const el = e.target as HTMLElement | null
      const typing =
        el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
        return
      }

      const mod = e.ctrlKey || e.metaKey

      // ⌘K / Ctrl+K 呼出快捷指令面板
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommandOpen((v) => !v)
        return
      }

      // "/" 聚焦输入框。弹窗打开时跳过：焦点应留在弹窗内，
      // 否则会把焦点偷遣到被遮罩盖住的输入框上（键盘用户会迷失）。
      if (
        e.key === '/' &&
        !typing &&
        !e.ctrlKey &&
        !e.metaKey &&
        !settingsOpen &&
        !shortcutsOpen &&
        !usageOpen &&
        !commandOpen
      ) {
        e.preventDefault()
        bumpComposerFocus()
        return
      }

      if (!mod) return
      if (e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        createConversation()
      } else if (!e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    createConversation,
    toggleSidebar,
    setSettingsOpen,
    setShortcutsOpen,
    setUsageOpen,
    setCommandOpen,
    settingsOpen,
    shortcutsOpen,
    usageOpen,
    commandOpen,
    bumpComposerFocus,
  ])

  // 骨架屏覆盖在真实界面之上，数据恢复完成后淡出——
  // 原先 `if (!hydrated) return <BootSkeleton />` 是硬切换，会「啪」地跳一下
  const boot = usePresence(!hydrated, 280)

  if (shareId) {
    return <SharedView shareId={shareId} onClose={closeSharedView} />
  }

  return (
    <div className="relative flex h-dvh overflow-hidden bg-canvas text-ink-1">
      {/* 小屏：侧边栏作为抽屉时的遮罩。同样需要退场动画，否则收起时遮罩是「啪」地消失 */}
      {overlay.mounted && (
        <div
          className={`fixed inset-0 z-30 bg-black/30 md:hidden ${
            overlay.closing ? 'anim-fade-out pointer-events-none' : 'anim-fade-in'
          }`}
          onClick={toggleSidebar}
          aria-hidden
        />
      )}
      {/* 主内容区：弹窗打开时整体 inert（见上方 effect），隔离背景交互 */}
      <div ref={bgRef} className="contents">
        <Sidebar open={sidebarOpen} />
        <ChatWindow />
        <ArtifactWorkspace />
      </div>
      {/* 常驻渲染：由组件内部的 usePresence 决定挂载与退场动画，
          若在这里做 `settingsOpen && ...`，关闭时会被父级直接卸载，退场动画无从播放 */}
      <SettingsModal />
      <ShortcutsPanel />
      <UsageModal open={usageOpen} onClose={() => setUsageOpen(false)} />
      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onOpenUsage={() => setUsageOpen(true)}
      />
      <AssistantMarketModal open={marketOpen} onClose={() => setMarketOpen(false)} />
      {boot.mounted && (
        <div
          className={`absolute inset-0 z-50 ${
            boot.closing ? 'anim-fade-out pointer-events-none' : ''
          }`}
        >
          <BootSkeleton />
        </div>
      )}
    </div>
  )
}

/** 首屏骨架：与真实布局同构，带微光扫过动画 */
function BootSkeleton() {
  return (
    <div className="flex h-dvh overflow-hidden bg-canvas" aria-busy aria-label="正在加载">
      <div className="hidden w-[272px] shrink-0 flex-col gap-3 bg-sidebar p-3 md:flex">
        <div className="skeleton r-sm h-7 w-24" />
        <div className="skeleton r-md h-9 w-full" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skeleton r-sm h-8 w-full opacity-70" />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 与真实顶栏一致：不画分隔线，避免交叉淡入淡出时凭空出现一条线 */}
        <div className="flex h-14 shrink-0 items-center px-4">
          <div className="skeleton r-sm h-4 w-32" />
        </div>
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="w-full max-w-2xl">
            <div className="skeleton mx-auto h-12 w-12 r-lg" />
            <div className="skeleton mx-auto mt-5 h-6 w-64" />
            <div className="skeleton mx-auto mt-3 h-4 w-80 opacity-70" />
            <div className="skeleton mt-7 h-24 w-full r-2xl" />
          </div>
        </div>
      </div>
    </div>
  )
}
