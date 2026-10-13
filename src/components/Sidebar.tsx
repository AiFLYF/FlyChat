// deslop-ignore-file 04 19 — 全站仅一个强调色；2px 激活指示条用圆头属常规控件细节
import { useState } from 'react'
import { Check, MessageSquare, Pencil, Plus, Settings, Trash2, X, Zap } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useSettingsOpen } from './settingsOpen'
import type { Conversation } from '../types'

/** 把会话按时间分组：今天 / 昨天 / 更早 */
function groupConversations(list: Conversation[]) {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const todayStart = startOfToday.getTime()
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000

  const groups: { label: string; items: Conversation[] }[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '更早', items: [] },
  ]
  for (const c of [...list].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (c.updatedAt >= todayStart) groups[0].items.push(c)
    else if (c.updatedAt >= yesterdayStart) groups[1].items.push(c)
    else groups[2].items.push(c)
  }
  return groups.filter((g) => g.items.length > 0)
}

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
      <div className="r-sm flex items-center gap-1 bg-hover px-2.5 py-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commitRename}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-1 outline-none"
        />
        <button onClick={commitRename} className="text-ink-2 hover:text-ink-1" aria-label="确认">
          <Check size={15} />
        </button>
        <button onClick={() => setEditing(false)} className="text-ink-3 hover:text-ink-2" aria-label="取消">
          <X size={15} />
        </button>
      </div>
    )
  }

  return (
    <div
      className={`group relative flex cursor-pointer items-center gap-2 rounded-lg py-2 pl-3 pr-2 text-[13px] transition-colors ${
        active ? 'bg-hover font-medium text-ink-1' : 'text-ink-2 hover-bg-hover hover:text-ink-1'
      }`}
      onClick={() => setActive(conv.id)}
    >
      {active && <span className="absolute left-0 top-1.5 h-[calc(100%-12px)] w-[2px] rounded-full bg-accent" />}
      <MessageSquare size={14} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate">{conv.title}</span>
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button
          onClick={(e) => {
            e.stopPropagation()
            setDraft(conv.title)
            setEditing(true)
          }}
          className="r-sm p-1 text-ink-3 transition-colors hover-bg-hover hover:text-ink-1"
          aria-label="重命名"
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (confirm(`确定删除「${conv.title}」吗？`)) deleteConversation(conv.id)
          }}
          className="r-sm p-1 text-ink-3 transition-colors hover:text-danger"
          aria-label="删除"
        >
          <Trash2 size={12} />
        </button>
      </span>
    </div>
  )
}

export default function Sidebar({ open }: { open: boolean }) {
  const conversations = useChatStore((s) => s.conversations)
  const createConversation = useChatStore((s) => s.createConversation)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const setShowSettings = useSettingsOpen((s) => s.setOpen)

  const groups = groupConversations(conversations)

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-rule bg-panel transition-transform duration-200 ease-out md:relative md:z-auto md:w-64 ${
        open ? 'translate-x-0' : '-translate-x-full md:hidden'
      }`}
    >
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="flex items-center gap-2 px-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-on-accent">
            <Zap size={14} fill="currentColor" />
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-ink-1">FlyChat</span>
        </div>
        <button
          onClick={toggleSidebar}
          className="r-sm flex h-7 w-7 items-center justify-center text-ink-3 transition-colors hover-bg-hover hover:text-ink-1"
          aria-label="收起侧边栏"
        >
          <X size={15} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={() => createConversation()}
          className="r-sm flex w-full items-center justify-center gap-1.5 bg-accent px-3 py-2 text-[13px] font-medium text-on-accent transition-opacity hover:opacity-90"
        >
          <Plus size={15} />
          新对话
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {groups.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs leading-5 text-ink-3">
            还没有对话
            <br />
            点击「新对话」开始
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-3">
              <p className="px-3 pb-1 pt-2 text-[11px] font-medium tracking-wide text-ink-3">
                {g.label}
              </p>
              <div className="space-y-0.5">
                {g.items.map((conv) => (
                  <ConversationItem key={conv.id} conv={conv} />
                ))}
              </div>
            </div>
          ))
        )}
      </nav>

      <div className="border-t border-rule p-2">
        <button
          onClick={() => setShowSettings(true)}
          className="r-sm flex w-full items-center gap-2 px-3 py-2 text-[13px] text-ink-2 transition-colors hover-bg-hover hover:text-ink-1"
        >
          <Settings size={14} />
          设置
        </button>
      </div>
    </aside>
  )
}
