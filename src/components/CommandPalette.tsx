import { useEffect, useMemo, useState, useRef } from 'react'
import {
  BarChart3,
  BookOpen,
  Brain,
  Check,
  HelpCircle,
  MessageSquare,
  Moon,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  Sliders,
} from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useSettingsOpen, useMarketOpen, useShortcutsOpen } from './openPanels'
import { useKnowledgeStore } from '../store/knowledge'
import { usePresetStore } from '../store/preset'
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
  const [selectedIdx, setSelectedIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const setActive = useChatStore((s) => s.setActive)
  const createConversation = useChatStore((s) => s.createConversation)
  const settings = useChatStore((s) => s.settings)
  const updateSettings = useChatStore((s) => s.updateSettings)
  const setSettingsOpen = useSettingsOpen((s) => s.setOpen)
  const setKnowledgeModalOpen = useKnowledgeStore((s) => s.setModalOpen)
  const setPresetModalOpen = usePresetStore((s) => s.setModalOpen)
  const setMarketOpen = useMarketOpen((s) => s.setOpen)
  const setShortcutsOpen = useShortcutsOpen((s) => s.setOpen)

  // 所有系统快捷指令定义
  const allActions = useMemo(
    () => [
      {
        id: 'new',
        label: '创建新对话',
        keywords: 'new create 对话 新建',
        icon: Plus,
        iconCls: 'text-accent',
        kbd: 'Ctrl+Shift+O',
        run: () => {
          createConversation()
          onClose()
        },
      },
      {
        id: 'theme',
        label: `切换到${settings.theme === 'dark' ? '浅色' : '深色'}主题`,
        keywords: 'theme 主题 暗色 浅色 深色 模式',
        icon: settings.theme === 'dark' ? Sun : Moon,
        iconCls: 'text-ink-3',
        run: () => {
          const nextTheme = settings.theme === 'dark' ? 'light' : 'dark'
          updateSettings({ theme: nextTheme })
          showToast(`已切换至${nextTheme === 'dark' ? '深色' : '浅色'}主题`, 'info')
          onClose()
        },
      },
      {
        id: 'thinking',
        label: '切换深度思考模式',
        keywords: 'thinking 深度 思考 推理 reasoning',
        icon: Brain,
        iconCls: 'text-ink-3',
        active: settings.thinking,
        run: () => {
          const nextThinking = !settings.thinking
          updateSettings({ thinking: nextThinking })
          showToast(nextThinking ? '已开启深度思考模式' : '已关闭深度思考模式', 'info')
          onClose()
        },
      },
      {
        id: 'usage',
        label: '查看 Token 用量与费用分析',
        keywords: 'usage token 用量 费用 统计 分析 cost',
        icon: BarChart3,
        iconCls: 'text-ink-3',
        run: () => {
          onClose()
          onOpenUsage()
        },
      },
      {
        id: 'knowledge',
        label: '打开知识库 (RAG) 管理',
        keywords: 'knowledge 知识库 rag 向量 文档 document 检索',
        icon: BookOpen,
        iconCls: 'text-ink-3',
        run: () => {
          onClose()
          setKnowledgeModalOpen(true)
        },
      },
      {
        id: 'preset-create',
        label: '新建或自定义角色与配置预设 (Preset)',
        keywords: 'preset 预设 角色 assistant 助手 自定义 prompt 提示词',
        icon: Sliders,
        iconCls: 'text-accent',
        run: () => {
          onClose()
          setPresetModalOpen(true, null)
        },
      },
      {
        id: 'market',
        label: '浏览智能体市场与专家提示词',
        keywords: 'agent market 智能体 市场 助手 专家 提示词 prompt',
        icon: Sparkles,
        iconCls: 'text-ink-3',
        run: () => {
          onClose()
          setMarketOpen(true)
        },
      },
      {
        id: 'shortcuts',
        label: '查看键盘快捷键说明',
        keywords: 'shortcuts 快捷键 帮助 键位 help',
        icon: HelpCircle,
        iconCls: 'text-ink-3',
        kbd: '?',
        run: () => {
          onClose()
          setShortcutsOpen(true)
        },
      },
      {
        id: 'settings',
        label: '打开全局设置与模型配置',
        keywords: 'settings 设置 配置 模型 服务 provider mcp api',
        icon: SettingsIcon,
        iconCls: 'text-ink-3',
        kbd: 'Ctrl+,',
        run: () => {
          onClose()
          setSettingsOpen(true)
        },
      },
    ],
    [
      settings.theme,
      settings.thinking,
      createConversation,
      updateSettings,
      onClose,
      onOpenUsage,
      setKnowledgeModalOpen,
      setMarketOpen,
      setShortcutsOpen,
      setSettingsOpen,
    ]
  )

  // 根据 query 模糊匹配指令
  const filteredActions = useMemo(() => {
    if (!query.trim()) return allActions
    const q = query.toLowerCase().trim()
    return allActions.filter(
      (a) => a.label.toLowerCase().includes(q) || a.keywords.toLowerCase().includes(q)
    )
  }, [allActions, query])

  // 根据 query 过滤会话
  const filteredConversations = useMemo(() => {
    if (!query.trim()) return conversations.slice(0, 5)
    const q = query.toLowerCase().trim()
    return conversations.filter((c) => (c.title || '').toLowerCase().includes(q)).slice(0, 8)
  }, [conversations, query])

  // 键盘操作扁平映射
  const flatItems = useMemo(() => {
    const list: Array<{
      key: string
      type: 'action' | 'conversation'
      run: () => void
    }> = []
    filteredActions.forEach((a) => {
      list.push({ key: `act-${a.id}`, type: 'action', run: a.run })
    })
    filteredConversations.forEach((c) => {
      list.push({
        key: `conv-${c.id}`,
        type: 'conversation',
        run: () => {
          setActive(c.id)
          onClose()
        },
      })
    })
    return list
  }, [filteredActions, filteredConversations, setActive, onClose])

  // 重置选中状态
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIdx(0)
    }
  }, [open])

  useEffect(() => {
    setSelectedIdx(0)
  }, [query])

  // 键盘控制（上下键选择，Enter 执行，ESC 关闭）
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx((prev) => (flatItems.length ? (prev + 1) % flatItems.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx((prev) => (flatItems.length ? (prev - 1 + flatItems.length) % flatItems.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (flatItems[selectedIdx]) {
        flatItems[selectedIdx].run()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

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
        role="dialog"
        aria-modal="true"
        aria-label="快捷指令"
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
            onKeyDown={handleKeyDown}
            placeholder="搜索会话、快捷操作或设置..."
            className="w-full bg-transparent text-sm text-ink-1 placeholder:text-ink-3 outline-none"
          />
          <kbd className="rounded border border-rule bg-hover px-1.5 py-0.5 text-[10px] font-mono text-ink-3">
            ESC
          </kbd>
        </div>

        {/* 结果列表 */}
        <div ref={listRef} className="max-h-[380px] overflow-auto p-2 flex flex-col gap-1 text-sm">
          {/* 指令列表 */}
          {filteredActions.length > 0 && (
            <>
              <div className="px-2 py-1 text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                快捷指令
              </div>
              {filteredActions.map((action, idx) => {
                const isSelected = selectedIdx === idx
                const Icon = action.icon
                return (
                  <button
                    key={action.id}
                    onClick={action.run}
                    className={`press flex items-center gap-2.5 rounded-xl px-3 py-2 transition-all duration-150 text-left ${
                      isSelected
                        ? 'bg-hover text-ink-1 translate-x-1 shadow-xs ring-1 ring-accent/30'
                        : 'text-ink-1 hover:bg-hover'
                    }`}
                  >
                    <Icon size={16} className={action.iconCls} />
                    <span className="flex-1 font-medium">{action.label}</span>
                    {action.active && <Check size={14} className="text-accent mr-1" />}
                    {action.kbd && <Kbd>{action.kbd}</Kbd>}
                  </button>
                )
              })}
            </>
          )}

          {/* 会话匹配 */}
          {filteredConversations.length > 0 && (
            <>
              <div className="mt-2 px-2 py-1 text-[11px] font-semibold text-ink-4 uppercase tracking-wider">
                {query.trim() ? '匹配对话' : '最近对话'}
              </div>
              {filteredConversations.map((c, convIdx) => {
                const totalIdx = filteredActions.length + convIdx
                const isSelected = selectedIdx === totalIdx
                const isCurrent = activeId === c.id
                return (
                  <button
                    key={c.id}
                    onClick={() => {
                      setActive(c.id)
                      onClose()
                    }}
                    className={`press flex items-center gap-2.5 rounded-xl px-3 py-2 transition-all duration-150 text-left ${
                      isSelected
                        ? 'bg-hover text-ink-1 translate-x-1 shadow-xs ring-1 ring-accent/30'
                        : isCurrent
                        ? 'bg-accent-soft text-accent font-medium shadow-xs'
                        : 'text-ink-1 hover:bg-hover'
                    }`}
                  >
                    <MessageSquare size={16} className="shrink-0 opacity-70" />
                    <span className="flex-1 truncate">{c.title || '新对话'}</span>
                    <span className="text-[11px] text-ink-4">
                      {c.messages[c.messages.length - 1]?.model || '对话'}
                    </span>
                  </button>
                )
              })}
            </>
          )}

          {/* 空状态提示 */}
          {filteredActions.length === 0 && filteredConversations.length === 0 && (
            <div className="py-8 text-center text-xs text-ink-4">
              未找到与 &quot;{query}&quot; 相关的操作或会话
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
