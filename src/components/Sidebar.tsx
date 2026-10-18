// deslop-ignore-file 04 19 — 全站仅一个强调色；2px 激活指示条用圆头属常规控件细节
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  Command,
  Folder,
  FolderPlus,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useCommandPaletteOpen, useMarketOpen, useSettingsOpen, useUsageOpen } from './openPanels'
import { BrandLogo } from './ui/BrandLogo'
import { staggerDelay } from '../lib/motion'
import { useDismiss } from '../lib/useDismiss'
import { usePresence } from '../lib/usePresence'
import { dayBucket } from '../lib/date'
import { SEARCH_FIELD, ICON_BTN_SM, GROUP_LABEL, EMPTY_HINT } from '../lib/ui'
import { MenuPanel, MenuItem } from './ui/Menu'
import type { Conversation, ConversationFolder } from '../types'

/** 组内排序：有人工拖拽序号时按序号，否则按更新时间 */
function sortGroup(items: Conversation[]) {
  const hasIndex = items.some((i) => typeof i.sortIndex === 'number')
  if (hasIndex) return [...items].sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 会话项组件 */
function ConversationItem({
  conv,
  groupIds,
  index,
  onDragStart,
  onDropOn,
  onDelete,
  folders,
}: {
  conv: Conversation
  groupIds: string[]
  index: number
  onDragStart: (id: string) => void
  onDropOn: (groupIds: string[], targetId: string) => void
  onDelete: (id: string) => void
  folders: ConversationFolder[]
}) {
  const activeId = useChatStore((s) => s.activeId)
  const setActive = useChatStore((s) => s.setActive)
  const renameConversation = useChatStore((s) => s.renameConversation)
  const togglePin = useChatStore((s) => s.togglePin)
  const toggleConversationStar = useChatStore((s) => s.toggleConversationStar)
  const moveConversationToFolder = useChatStore((s) => s.moveConversationToFolder)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.title)
  const [dragOver, setDragOver] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useDismiss(menuRef, () => setMenuOpen(false), menuOpen)

  const active = activeId === conv.id
  const enterDelay = { animationDelay: staggerDelay(index, 26) }

  const commitRename = () => {
    const title = draft.trim()
    if (title && title !== conv.title) renameConversation(conv.id, title)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-lg bg-hover px-2 py-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={commitRename}
          aria-label="会话名称"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-1 outline-none"
        />
        <button onClick={commitRename} className={ICON_BTN_SM} aria-label="确认">
          <Check size={14} />
        </button>
        <button onClick={() => setEditing(false)} className={ICON_BTN_SM} aria-label="取消">
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div
      draggable
      onDragStart={() => onDragStart(conv.id)}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        onDropOn(groupIds, conv.id)
      }}
      onClick={() => setActive(conv.id)}
      role="listitem"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={conv.title}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setActive(conv.id)
        }
      }}
      style={enterDelay}
      className={`group anim-fade-in relative flex cursor-pointer items-center gap-2 rounded-lg py-2 pl-2.5 pr-1.5 text-[13px] transition-ui ${
        dragOver
          ? 'bg-hover ring-1 ring-accent'
          : active
            ? 'bg-hover font-medium text-ink-1'
            : 'text-ink-2 hover:bg-hover hover:text-ink-1'
      }`}
    >
      {/* 激活指示条 */}
      <span
        aria-hidden
        className={`absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent transition-transform duration-200 ease-out ${
          active ? 'scale-y-100' : 'scale-y-0'
        }`}
      />
      <MessageSquare size={14} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate">{conv.title}</span>

      {/* 常驻指示徽标 */}
      {conv.pinned && (
        <Pin size={11} className="shrink-0 text-ink-3 rotate-45" />
      )}
      {conv.starred && (
        <Star size={11} className="shrink-0 fill-amber-400 text-amber-500" />
      )}

      {/* 操作区：hover 或 键盘聚焦时显现 */}
      <span className="hidden shrink-0 items-center gap-0.5 transition-opacity duration-150 group-hover:flex group-focus-within:flex">
        {/* 收藏开关 */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            toggleConversationStar(conv.id)
          }}
          className={`${ICON_BTN_SM} ${conv.starred ? 'text-amber-500' : 'hover:text-amber-500'}`}
          aria-label={conv.starred ? '取消收藏' : '收藏'}
          title={conv.starred ? '取消收藏' : '收藏'}
        >
          <Star size={12} className={conv.starred ? 'fill-amber-400' : ''} />
        </button>

        {/* 置顶开关 */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            togglePin(conv.id)
          }}
          className={ICON_BTN_SM}
          aria-label={conv.pinned ? '取消置顶' : '置顶'}
          title={conv.pinned ? '取消置顶' : '置顶'}
        >
          {conv.pinned ? <PinOff size={12} /> : <Pin size={12} />}
        </button>

        {/* 重命名 */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setDraft(conv.title)
            setEditing(true)
          }}
          className={ICON_BTN_SM}
          aria-label="重命名"
          title="重命名"
        >
          <Pencil size={12} />
        </button>

        {/* 移至文件夹（仅在已建文件夹时出现） */}
        {folders.length > 0 && (
          <div className="relative" ref={menuRef}>
            <button
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen((v) => !v)
              }}
              className={`${ICON_BTN_SM} ${conv.folderId ? 'text-accent' : ''}`}
              aria-label="移动到文件夹"
              title="移动到文件夹"
            >
              <Folder size={12} />
            </button>
            <MenuPanel
              open={menuOpen}
              position="absolute right-0 top-7 z-50 w-44"
              origin="top-right"
              label="选择文件夹"
            >
              <p className="px-2.5 py-1 text-[10px] font-semibold text-ink-3 uppercase tracking-wider">
                移动至文件夹
              </p>
              {conv.folderId && (
                <MenuItem
                  icon={<X size={12} />}
                  onClick={() => {
                    moveConversationToFolder(conv.id, null)
                    setMenuOpen(false)
                  }}
                >
                  <span>移出文件夹</span>
                </MenuItem>
              )}
              {folders.map((f) => (
                <MenuItem
                  key={f.id}
                  icon={<span>{f.emoji || '📁'}</span>}
                  className={conv.folderId === f.id ? 'font-semibold text-accent bg-accent/10' : ''}
                  onClick={() => {
                    moveConversationToFolder(conv.id, f.id)
                    setMenuOpen(false)
                  }}
                >
                  <span className="truncate">{f.name}</span>
                </MenuItem>
              ))}
            </MenuPanel>
          </div>
        )}

        {/* 一键直接删除：流畅撤销提示，不再弹窗遮挡列表 */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete(conv.id)
          }}
          className={`${ICON_BTN_SM} hover:text-danger`}
          aria-label="删除"
          title="删除"
        >
          <Trash2 size={12} />
        </button>
      </span>
    </div>
  )
}

export default function Sidebar({ open }: { open: boolean }) {
  const conversations = useChatStore((s) => s.conversations)
  const folders = useChatStore((s) => s.folders || [])
  const createConversation = useChatStore((s) => s.createConversation)
  const createFolder = useChatStore((s) => s.createFolder)
  const updateFolder = useChatStore((s) => s.updateFolder)
  const deleteFolder = useChatStore((s) => s.deleteFolder)
  const moveConversationToFolder = useChatStore((s) => s.moveConversationToFolder)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const restoreConversation = useChatStore((s) => s.restoreConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const reorderConversations = useChatStore((s) => s.reorderConversations)
  const assistants = useChatStore((s) => s.assistants)
  
  const setShowSettings = useSettingsOpen((s) => s.setOpen)
  const setShowUsage = useUsageOpen((s) => s.setOpen)
  const setShowCommand = useCommandPaletteOpen((s) => s.setOpen)
  const setMarketOpen = useMarketOpen((s) => s.setOpen)

  const [query, setQuery] = useState('')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [deleted, setDeleted] = useState<Conversation | null>(null)
  const dragId = useRef<string | null>(null)
  const undoTimer = useRef<number | null>(null)
  const assistantRef = useRef<HTMLDivElement>(null)
  const asideRef = useRef<HTMLElement>(null)

  // 文件夹展开/折叠状态（默认记录展开的 folderId 集合）
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({})
  // 新建文件夹输入框
  const [isCreatingFolder, setIsCreatingFolder] = useState(false)
  const [folderDraftName, setFolderDraftName] = useState('')
  // 正在重命名的文件夹 ID
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingFolderName, setEditingFolderName] = useState('')

  useEffect(() => {
    asideRef.current?.toggleAttribute('inert', !open)
  }, [open])

  useDismiss(assistantRef, () => setAssistantOpen(false), assistantOpen)

  const undoPresence = usePresence(!!deleted, 160)
  const lastDeleted = useRef<Conversation | null>(null)
  useEffect(() => {
    if (deleted) lastDeleted.current = deleted
  }, [deleted])

  const handleDelete = (id: string) => {
    const conv = useChatStore.getState().conversations.find((c) => c.id === id)
    if (!conv) return
    deleteConversation(id)
    setDeleted(conv)
    if (undoTimer.current) window.clearTimeout(undoTimer.current)
    undoTimer.current = window.setTimeout(() => setDeleted(null), 5000)
  }

  const handleDropOn = (groupIds: string[], targetId: string) => {
    const from = dragId.current
    dragId.current = null
    if (!from || from === targetId) return
    const ids = [...groupIds]
    const fromIdx = ids.indexOf(from)
    const toIdx = ids.indexOf(targetId)
    if (fromIdx < 0 || toIdx < 0) return
    ids.splice(fromIdx, 1)
    ids.splice(toIdx, 0, from)
    reorderConversations(ids)
  }

  // 过滤后的会话
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return conversations
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => m.content.toLowerCase().includes(q))
    )
  }, [conversations, q])

  // 已收藏的会话
  const starredConversations = useMemo(() => {
    return sortGroup(filtered.filter((c) => c.starred))
  }, [filtered])

  // 按文件夹分组
  const folderMap = useMemo(() => {
    const map = new Map<string, Conversation[]>()
    for (const f of folders) map.set(f.id, [])
    for (const c of filtered) {
      if (c.folderId && map.has(c.folderId)) {
        map.get(c.folderId)!.push(c)
      }
    }
    // 排序
    for (const [id, items] of map.entries()) {
      map.set(id, sortGroup(items))
    }
    return map
  }, [folders, filtered])

  // 未放入文件夹的常规会话（按置顶 / 今天 / 昨天 / 更早 分组）
  const unfiledGroups = useMemo(() => {
    const unfiled = filtered.filter((c) => !c.folderId || !folders.some((f) => f.id === c.folderId))
    const pinned = sortGroup(unfiled.filter((c) => c.pinned))
    const rest = unfiled.filter((c) => !c.pinned)
    const groups: { key: string; label: string; items: Conversation[] }[] = []
    if (pinned.length) groups.push({ key: 'pinned', label: '置顶', items: pinned })

    const buckets: Record<'today' | 'yesterday' | 'earlier', Conversation[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    }
    for (const c of rest) buckets[dayBucket(c.updatedAt)].push(c)

    const labels = { today: '今天', yesterday: '昨天', earlier: '更早' } as const
    for (const key of ['today', 'yesterday', 'earlier'] as const) {
      if (buckets[key].length) {
        groups.push({ key, label: labels[key], items: sortGroup(buckets[key]) })
      }
    }
    return groups
  }, [filtered, folders])

  const toggleFolderExpanded = (id: string) => {
    setExpandedFolders((prev) => ({
      ...prev,
      // 默认展开，点击时取反
      [id]: prev[id] === undefined ? false : !prev[id],
    }))
  }

  const handleCommitNewFolder = () => {
    const name = folderDraftName.trim()
    if (name) {
      createFolder(name)
    }
    setFolderDraftName('')
    setIsCreatingFolder(false)
  }

  const handleCommitRenameFolder = (id: string) => {
    const name = editingFolderName.trim()
    if (name) {
      updateFolder(id, { name })
    }
    setEditingFolderId(null)
  }

  return (
    <aside
      ref={asideRef}
      aria-hidden={!open}
      className={`fixed inset-y-0 left-0 z-40 flex w-[86vw] max-w-[300px] shrink-0 flex-col bg-sidebar transition-transform duration-200 ease-out md:relative md:z-auto md:w-[272px] ${
        open ? 'translate-x-0 shadow-3 md:shadow-none' : '-translate-x-full md:hidden'
      }`}
    >
      {/* 品牌行 */}
      <div className="flex h-14 shrink-0 items-center justify-between px-3.5">
        <BrandLogo size="md" showBadge badgeText="SOTA" glow />
        <button
          onClick={toggleSidebar}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-ui press hover:bg-hover hover:text-ink-1"
          aria-label="收起侧边栏"
        >
          <X size={15} />
        </button>
      </div>

      <div className="space-y-2 px-3 pb-2">
        {/* 搜索 */}
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索对话"
            aria-label="搜索对话"
            className={`${SEARCH_FIELD} py-2`}
          />
        </div>

        {/* 新对话 + 助手选择 */}
        <div className="relative flex gap-1.5" ref={assistantRef}>
          <button
            onClick={() => createConversation()}
            className="press hover-lift flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-inverse px-3 text-[13px] font-medium text-on-inverse shadow-1 transition-ui hover:opacity-90 hover:shadow-2"
          >
            <Plus size={15} />
            新对话
          </button>
          {assistants.length > 0 && (
            <button
              onClick={() => setAssistantOpen((v) => !v)}
              className="press flex h-9 w-9 items-center justify-center rounded-lg border border-rule bg-panel text-ink-2 transition-ui hover:bg-hover hover:text-ink-1"
              aria-label="选择助手"
              aria-haspopup="menu"
              aria-expanded={assistantOpen}
            >
              <ChevronDown
                size={15}
                className={`transition-transform duration-150 ${assistantOpen ? 'rotate-180' : ''}`}
              />
            </button>
          )}
          <MenuPanel
            open={assistantOpen}
            position="absolute left-0 top-10 z-30 w-full"
            origin="top"
            label="选择助手"
          >
            {assistants.map((a, i) => (
              <MenuItem
                key={a.id}
                icon={<span className="text-base leading-none">{a.emoji}</span>}
                className="anim-fade-in"
                onClick={() => {
                  createConversation(a.id)
                  setAssistantOpen(false)
                }}
                style={{ animationDelay: staggerDelay(i, 20, 6) }}
              >
                <span className="truncate">{a.name}</span>
              </MenuItem>
            ))}
          </MenuPanel>
        </div>

        {/* 智能体市场入口 */}
        <button
          onClick={() => setMarketOpen(true)}
          className="group flex w-full items-center justify-between rounded-lg border border-rule/70 bg-gradient-to-r from-accent/8 via-hover to-panel px-2.5 py-1.5 text-[12px] font-medium text-ink-1 transition-ui hover:border-accent/40 hover:bg-hover hover:shadow-1"
        >
          <div className="flex items-center gap-1.5">
            <Sparkles size={13} className="text-accent transition-transform duration-200 group-hover:scale-110" />
            <span>智能体市场</span>
          </div>
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            20+ 专家
          </span>
        </button>
      </div>

      {/* 文件夹管理工具行 */}
      <div className="flex items-center justify-between px-3.5 py-1 text-xs text-ink-3">
        <span className="font-semibold text-[11px] tracking-wider uppercase text-ink-3">
          对话与收藏
        </span>
        <button
          onClick={() => setIsCreatingFolder(true)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-hover hover:text-ink-1 transition-ui"
          title="新建文件夹"
        >
          <FolderPlus size={13} />
          <span>文件夹</span>
        </button>
      </div>

      {/* 新建文件夹输入框 */}
      {isCreatingFolder && (
        <div className="mx-3 mb-2 flex items-center gap-1 rounded-lg border border-accent/40 bg-hover px-2 py-1.5">
          <Folder size={14} className="text-accent shrink-0" />
          <input
            autoFocus
            value={folderDraftName}
            onChange={(e) => setFolderDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCommitNewFolder()
              if (e.key === 'Escape') setIsCreatingFolder(false)
            }}
            placeholder="文件夹名称..."
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink-1 outline-none"
          />
          <button onClick={handleCommitNewFolder} className={ICON_BTN_SM}>
            <Check size={13} />
          </button>
          <button onClick={() => setIsCreatingFolder(false)} className={ICON_BTN_SM}>
            <X size={13} />
          </button>
        </div>
      )}

      {/* 会话与文件夹列表 */}
      <nav role="list" aria-label="对话列表" className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {/* 1. 已收藏分类 */}
        {starredConversations.length > 0 && (
          <div role="presentation" className="anim-fade-in">
            <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-semibold text-amber-500">
              <Star size={12} className="fill-amber-400" />
              <span>已收藏 ({starredConversations.length})</span>
            </div>
            <div role="presentation" className="space-y-0.5">
              {starredConversations.map((conv, ci) => (
                <ConversationItem
                  key={`star-${conv.id}`}
                  conv={conv}
                  groupIds={starredConversations.map((c) => c.id)}
                  index={ci}
                  onDragStart={(id) => {
                    dragId.current = id
                  }}
                  onDropOn={handleDropOn}
                  onDelete={handleDelete}
                  folders={folders}
                />
              ))}
            </div>
          </div>
        )}

        {/* 2. 文件夹列表 */}
        {folders.map((folder) => {
          const folderConvs = folderMap.get(folder.id) || []
          const isExpanded = expandedFolders[folder.id] !== false // 默认展开
          const isEditing = editingFolderId === folder.id

          return (
            <div
              key={folder.id}
              role="presentation"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId.current) {
                  moveConversationToFolder(dragId.current, folder.id)
                  dragId.current = null
                }
              }}
              className="rounded-lg transition-colors"
            >
              {/* 文件夹头 */}
              <div className="group flex items-center justify-between rounded-md px-1.5 py-1 text-ink-2 hover:bg-hover hover:text-ink-1">
                <button
                  onClick={() => toggleFolderExpanded(folder.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-medium"
                >
                  {isExpanded ? (
                    <ChevronDown size={13} className="shrink-0 text-ink-3" />
                  ) : (
                    <ChevronRight size={13} className="shrink-0 text-ink-3" />
                  )}
                  <span className="shrink-0 text-sm leading-none">{folder.emoji || '📁'}</span>
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingFolderName}
                      onChange={(e) => setEditingFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCommitRenameFolder(folder.id)
                        if (e.key === 'Escape') setEditingFolderId(null)
                      }}
                      onBlur={() => handleCommitRenameFolder(folder.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="min-w-0 flex-1 rounded bg-panel px-1 py-0.5 text-xs text-ink-1 outline-none ring-1 ring-accent"
                    />
                  ) : (
                    <span className="truncate">{folder.name}</span>
                  )}
                  <span className="rounded bg-hover px-1.5 py-0.2 text-[10px] text-ink-4">
                    {folderConvs.length}
                  </span>
                </button>

                <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <button
                    onClick={() => {
                      setEditingFolderId(folder.id)
                      setEditingFolderName(folder.name)
                    }}
                    className={ICON_BTN_SM}
                    title="重命名文件夹"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`确定删除文件夹「${folder.name}」吗？对话将移出文件夹。`)) {
                        deleteFolder(folder.id)
                      }
                    }}
                    className={`${ICON_BTN_SM} hover:text-danger`}
                    title="删除文件夹"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>

              {/* 文件夹内部会话 */}
              {isExpanded && (
                <div className="ml-2.5 border-l border-rule/50 pl-1.5 pt-0.5 space-y-0.5">
                  {folderConvs.length === 0 ? (
                    <div className="px-2 py-1.5 text-[11px] text-ink-4">空文件夹（可拖入会话）</div>
                  ) : (
                    folderConvs.map((conv, ci) => (
                      <ConversationItem
                        key={conv.id}
                        conv={conv}
                        groupIds={folderConvs.map((c) => c.id)}
                        index={ci}
                        onDragStart={(id) => {
                          dragId.current = id
                        }}
                        onDropOn={handleDropOn}
                        onDelete={handleDelete}
                        folders={folders}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          )
        })}

        {/* 3. 未放入文件夹的分组 */}
        {unfiledGroups.length === 0 && folders.length === 0 && starredConversations.length === 0 ? (
          <div className={EMPTY_HINT}>
            <MessageSquare size={18} className="mx-auto mb-1.5 text-ink-3" aria-hidden />
            {query ? '没有匹配的对话' : '还没有对话'}
            {!query && (
              <>
                <br />
                点击「新对话」开始
              </>
            )}
          </div>
        ) : (
          unfiledGroups.map((g, gi) => {
            const groupIds = g.items.map((c) => c.id)
            return (
              <div
                key={g.key}
                role="presentation"
                className="anim-fade-in"
                style={{ animationDelay: staggerDelay(gi, 50, 4) }}
              >
                <p className={GROUP_LABEL}>{g.label}</p>
                <div role="presentation" className="space-y-0.5">
                  {g.items.map((conv, ci) => (
                    <ConversationItem
                      key={conv.id}
                      conv={conv}
                      groupIds={groupIds}
                      index={ci}
                      onDragStart={(id) => {
                        dragId.current = id
                      }}
                      onDropOn={handleDropOn}
                      onDelete={handleDelete}
                      folders={folders}
                    />
                  ))}
                </div>
              </div>
            )
          })
        )}
      </nav>

      {/* 撤销删除 */}
      {undoPresence.mounted && (
        <div
          role="status"
          aria-live="polite"
          className={`mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-rule bg-panel px-3 py-2 text-xs text-ink-2 shadow-2 ${
            undoPresence.closing ? 'anim-fade-out' : 'anim-slide-up'
          }`}
        >
          <span className="min-w-0 flex-1 truncate">已删除「{lastDeleted.current?.title}」</span>
          <button
            onClick={() => {
              const conv = deleted ?? lastDeleted.current
              if (conv) restoreConversation(conv)
              setDeleted(null)
            }}
            className="press flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-accent transition-ui hover:bg-accent-soft"
          >
            <Undo2 size={12} />
            撤销
          </button>
        </div>
      )}

      {/* 底部功能栏 */}
      <div className="shrink-0 space-y-0.5 px-2 pb-2 pt-2">
        <div aria-hidden className="hairline mb-1.5" />
        <button
          onClick={() => setShowCommand(true)}
          className="group flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] text-ink-2 transition-ui hover:bg-hover hover:text-ink-1"
        >
          <div className="flex items-center gap-2">
            <Command size={15} className="text-ink-3 group-hover:text-ink-1" />
            <span>快捷指令</span>
          </div>
          <kbd className="rounded border border-rule px-1 py-0.5 text-[10px] font-mono text-ink-4">
            ⌘K
          </kbd>
        </button>
        <button
          onClick={() => setShowUsage(true)}
          className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-2 transition-ui hover:bg-hover hover:text-ink-1"
        >
          <Activity size={15} className="text-ink-3 group-hover:text-accent" />
          <span>用量分析</span>
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-ink-2 transition-ui hover:bg-hover hover:text-ink-1"
        >
          <Settings size={15} className="transition-transform duration-200 group-hover:rotate-90" />
          <span>设置</span>
        </button>
      </div>
    </aside>
  )
}
