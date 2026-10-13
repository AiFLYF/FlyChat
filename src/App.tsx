import { useEffect } from 'react'
import Sidebar from './components/Sidebar'
import ChatWindow from './components/ChatWindow'
import SettingsModal from './components/SettingsModal'
import { useChatStore } from './store/chat'

export default function App() {
  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const theme = useChatStore((s) => s.settings.theme)

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

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
      {sidebarOpen && <Sidebar />}
      <ChatWindow />
      <SettingsModal />
    </div>
  )
}
