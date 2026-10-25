import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  Brain,
  Check,
  MessageSquare,
  Moon,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sun,
} from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useSettingsOpen } from './openPanels'
import { usePresence } from '../lib/usePresence'

import { showToast } from './ui/Toast'

/** 快捷键提示：统一描边胶囊样式（与搜索框右侧 ESC 一致） */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-rule bg-hover px-1.5 py-0.5 text-[10px] font-mono text-ink-3">
      {children}
    </kbd>
  )
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onOpenUsage: () => void
}

export default function CommandPalette({ open, onClose, onOpenUsage }: CommandPaletteProps) {
  const presence = usePresence(open, 180)
  const [query, setQuery] = useState('')
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const setActive = useChatStore((s) => s.setActive)
  const createConversation = useChatStore((s) => s.createConversation)
  const settings = useChatStore((s) => s.settings)
  const updateSettings = useChatStore((s) => s.updateSettings)
  const setSettingsOpen = useSettingsOpen((s) => s.setOpen)

  // 快捷指令列表与会话模糊过滤
  const filteredConversations = useMemo(() => {
    if (!query.trim()) return conversations.slice(0, 5)
    const q = query.toLowerCase()
    return conversations.filter((c) => c.title.toLowerCase().includes(q)).slice(0, 8)
  }, [conversations, query])

  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  if (!presence.mounted) return null

  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh] ${
        presence.closing ? 'anim-fade-out pointer-events-none' : 'anim-fade-in'
      }`}
    >
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* 命令面板卡片 */}
      <div
        className={`relative z-10 w-full max-w-xl rounded-2xl border border-rule bg-panel shadow-3 overflow-hidden ${
          presence.closing ? 'scale-95 opacity-0' : 'scale-100 opacity-100'
        } transition-all duration-200`}
      >
        {/* 搜索输入 */}
        <div className="flex items-center gap-3 border-b border-rule px-4 py-3">
          <Search size={18} className="text-ink-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话、快捷操作或设置..."
            className="w-full bg-transparent text-sm text-ink-1 placeholder:text-ink-3 outline-none"
          />
          <kbd className="rounded border border-rule bg-hover px-1.5 py-0.5 text-[10px] font-mono text-ink-3">
            ESC
          </kbd>
        </div>

        {/* 结果列表 */}
        <div className="max-h-[380px] overflow-auto p-2 flex flex-col gap-1 text-sm">
          {/* 常用操作 */}
          <div className="px-2 py-1 text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
            快捷操作
          </div>

          <button
            onClick={() => {
              createConversation()
              onClose()
            }}
            className="press flex items-center gap-2.5 rounded-xl px-3 py-2 text-ink-1 hover:bg-hover hover:translate-x-0.5 transition-all duration-150 text-left"
          >
            <Plus size={16} className="text-accent" />
            <span className="flex-1 font-medium">创建新对话</span>
            <Kbd>Ctrl+Shift+O</Kbd>
          </button>

          <button
            onClick={() => {
              const nextTheme = settings.theme === 'dark' ? 'light' : 'dark'
              updateSettings({ theme: nextTheme })
              showToast(`已切换至${nextTheme === 'dark' ? '深色' : '浅色'}主题`, 'info')
              onClose()
            }}
            className="press flex items-center gap-2.5 rounded-xl px-3 py-2 text-ink-1 hover:bg-hover hover:translate-x-0.5 transition-all duration-150 text-left"
          >
            {settings.theme === 'dark' ? <Sun size={16} className="text-ink-3" /> : <Moon size={16} className="text-ink-3" />}
            <span className="flex-1">切换到{settings.theme === 'dark' ? '浅色' : '深色'}主题</span>
          </button>

          <button
            onClick={() => {
              const nextThinking = !settings.thinking
              updateSettings({ thinking: nextThinking })
              showToast(nextThinking ? '已开启深度思考模式' : '已关闭深度思考模式', 'info')
              onClose()
            }}
            className="press flex items-center gap-2.5 rounded-xl px-3 py-2 text-ink-1 hover:bg-hover hover:translate-x-0.5 transition-all duration-150 text-left"
          >
            <Brain size={16} className="text-ink-3" />
            <span className="flex-1">切换深度思考模式</span>
            {settings.thinking && <Check size={14} className="text-accent" />}
          </button>

          <button
            onClick={() => {
              onClose()
              onOpenUsage()
            }}
            className="press flex items-center gap-2.5 rounded-xl px-3 py-2 text-ink-1 hover:bg-hover hover:translate-x-0.5 transition-all duration-150 text-left"
          >
            <BarChart3 size={16} className="text-ink-3" />
            <span className="flex-1">查看 Token 用量与费用分析</span>
          </button>

          <button
            onClick={() => {
              onClose()
              setSettingsOpen(true)
            }}
            className="press flex items-center gap-2.5 rounded-xl px-3 py-2 text-ink-1 hover:bg-hover hover:translate-x-0.5 transition-all duration-150 text-left"
          >
            <SettingsIcon size={16} className="text-ink-3" />
            <span className="flex-1">打开全局设置与模型配置</span>
          </button>

          {/* 会话匹配 */}
          {filteredConversations.length > 0 && (
            <>
              <div className="mt-2 px-2 py-1 text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                最近对话
              </div>
              {filteredConversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setActive(c.id)
                    onClose()
                  }}
                  className={`press flex items-center gap-2.5 rounded-xl px-3 py-2 transition-all duration-150 text-left hover:translate-x-0.5 ${
                    activeId === c.id ? 'bg-accent-soft text-accent font-medium shadow-xs' : 'text-ink-1 hover:bg-hover'
                  }`}
                >
                  <MessageSquare size={16} className="shrink-0 opacity-70" />
                  <span className="flex-1 truncate">{c.title || '新对话'}</span>
                  <span className="text-[11px] text-ink-4">
                    {c.messages[c.messages.length - 1]?.model || '对话'}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
