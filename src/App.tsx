// deslop-ignore-file 19 — 移动端抽屉遮罩为纯色半透明，非玻璃拟态
import { useEffect } from 'react'
import Sidebar from './components/Sidebar'
import ChatWindow from './components/ChatWindow'
import SettingsModal from './components/SettingsModal'
import { useChatStore } from './store/chat'
import { useSettingsOpen } from './components/settingsOpen'

export default function App() {
  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const theme = useChatStore((s) => s.settings.theme)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const createConversation = useChatStore((s) => s.createConversation)
  const settingsOpen = useSettingsOpen((s) => s.open)
  const setSettingsOpen = useSettingsOpen((s) => s.setOpen)

  // 应用主题（浅色 / 深色 / 跟随系统）
  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      root.classList.toggle('dark', dark)
      localStorage.setItem('flychat-theme', theme)
    }
    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  // 全局快捷键：Ctrl/Cmd+Shift+O 新对话，Ctrl/Cmd+B 切换侧边栏，Esc 关设置
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false)
        return
      }
      const mod = e.ctrlKey || e.metaKey
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
  }, [createConversation, toggleSidebar, setSettingsOpen])

  return (
    <div className="flex h-screen overflow-hidden bg-canvas text-ink-1">
      {/* 小屏：侧边栏作为抽屉时的遮罩 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 transition-opacity md:hidden"
          onClick={toggleSidebar}
          aria-hidden
        />
      )}
      <Sidebar open={sidebarOpen} />
      <ChatWindow />
      {settingsOpen && <SettingsModal />}
    </div>
  )
}
