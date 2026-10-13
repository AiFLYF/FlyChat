import { useState } from 'react'
import { Check, MessageSquare, Pencil, Plus, Settings, Trash2, X, Zap } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useSettingsOpen } from './settingsOpen'
import type { Conversation } from '../types'

function ConversationItem({ conv }: { conv: Conversation }) {
  const activeId = useChatStore((s) => s.activeId)
  const setActive = useChatStore((s) => s.setActive)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.title)
  const active = activeId === conv.id

  const commitRename = () => {
    const title = draft.trim()
    if (title && title !== conv.title) renameConversation(conv.id, title)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-lg bg-blue-50 px-2.5 py-2 dark:bg-blue-950/40">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commitRename}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-800 outline-none dark:text-zinc-100"
        />
        <button onClick={commitRename} className="text-emerald-600 hover:text-emerald-500 dark:text-emerald-400" aria-label="确认">
          <Check size={15} />
        </button>
        <button onClick={() => setEditing(false)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200" aria-label="取消">
          <X size={15} />
        </button>
      </div>
    )
  }

  return (
    <div
      className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
        active
          ? 'bg-blue-100/80 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
          : 'text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }`}
      onClick={() => setActive(conv.id)}
    >
      <MessageSquare size={15} className="shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{conv.title}</span>
      <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
        <button
          onClick={(e) => {
            e.stopPropagation()
            setDraft(conv.title)
            setEditing(true)
          }}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-300/60 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
          aria-label="重命名"
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (confirm(`确定删除「${conv.title}」吗？`)) deleteConversation(conv.id)
          }}
          className="rounded p-1 text-zinc-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/40 dark:hover:text-red-400"
          aria-label="删除"
        >
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  )
}

export default function Sidebar() {
  const conversations = useChatStore((s) => s.conversations)
  const createConversation = useChatStore((s) => s.createConversation)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const setShowSettings = useSettingsOpen((s) => s.setOpen)

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 shadow-xl transition-transform dark:border-zinc-800 dark:bg-zinc-900 md:relative md:z-auto md:w-64 md:shadow-none">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="flex items-center gap-2 px-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white">
            <Zap size={15} fill="currentColor" />
          </div>
          <span className="text-[15px] font-semibold tracking-wide text-zinc-800 dark:text-zinc-100">
            FlyChat
          </span>
        </div>
        <button
          onClick={toggleSidebar}
          className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          aria-label="收起侧边栏"
        >
          <X size={16} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={() => createConversation()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-500"
        >
          <Plus size={15} />
          新对话
        </button>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-400 dark:text-zinc-500">
            还没有对话，点击「新对话」开始
          </p>
        ) : (
          conversations.map((conv) => <ConversationItem key={conv.id} conv={conv} />)
        )}
      </nav>

      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <button
          onClick={() => setShowSettings(true)}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <Settings size={15} />
          设置
        </button>
      </div>
    </aside>
  )
}
