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

  // 全局快捷键：Ctrl/Cmd+Shift+O 新对话，Ctrl/Cmd+B 切换侧边栏
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
  }, [createConversation, toggleSidebar])

  // Esc 关闭设置弹窗
  const settingsOpen = useSettingsOpen((s) => s.open)
  const setSettingsOpen = useSettingsOpen((s) => s.setOpen)
  useEffect(() => {
    if (!settingsOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen, setSettingsOpen])

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
      {/* 小屏遮罩：侧边栏作为抽屉打开时 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={toggleSidebar}
          aria-hidden
        />
      )}
      {sidebarOpen && <Sidebar />}
      <ChatWindow />
      <SettingsModal />
    </div>
  )
}
