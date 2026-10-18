import { useState, useMemo, useRef } from 'react'
import {
  Compass,
  Plus,
  Search,
  X,
  MessageSquare,
  Check,
} from 'lucide-react'
import { MARKET_ASSISTANTS } from '../data/marketAssistants'
import { useChatStore } from '../store/chat'
import { useDismiss } from '../lib/useDismiss'
import type { MarketAssistant } from '../types'

interface Props {
  open: boolean
  onClose: () => void
}

const CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'code', label: '🚀 研发技术' },
  { id: 'writing', label: '📝 写作翻译' },
  { id: 'business', label: '💼 商业金融' },
  { id: 'productivity', label: '💡 效率规划' },
  { id: 'creative', label: '🎨 创意美学' },
]

export default function AssistantMarketModal({ open, onClose }: Props) {
  const [activeCategory, setActiveCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [installedMap, setInstalledMap] = useState<Record<string, boolean>>({})
  const modalRef = useRef<HTMLDivElement>(null)

  useDismiss(modalRef, onClose, open)

  const createConversation = useChatStore((s) => s.createConversation)
  const addAssistant = useChatStore((s) => s.addAssistant)
  const assistants = useChatStore((s) => s.assistants)

  const filtered = useMemo(() => {
    return MARKET_ASSISTANTS.filter((item) => {
      const matchCat = activeCategory === 'all' || item.category === activeCategory
      const q = query.trim().toLowerCase()
      const matchQuery =
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q)
      return matchCat && matchQuery
    })
  }, [activeCategory, query])

  const handleStartChat = (item: MarketAssistant) => {
    // 检查是否已在本地助手列表，没有则自动静默添加
    let targetAssistantId = item.id
    const existing = assistants.find((a) => a.id === item.id)
    if (!existing) {
      addAssistant({
        id: item.id,
        name: item.name,
        emoji: item.emoji,
        systemPrompt: item.systemPrompt,
        temperature: item.temperature,
      })
    }
    const newConvId = createConversation(targetAssistantId)
    useChatStore.getState().renameConversation(newConvId, `${item.emoji} ${item.name}`)
    onClose()
  }

  const handleInstall = (item: MarketAssistant) => {
    addAssistant({
      id: item.id,
      name: item.name,
      emoji: item.emoji,
      systemPrompt: item.systemPrompt,
      temperature: item.temperature,
    })
    setInstalledMap((prev) => ({ ...prev, [item.id]: true }))
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="market-modal-title"
        className="flex flex-col h-[88vh] max-h-[820px] w-full max-w-4xl rounded-2xl border border-rule bg-panel shadow-3 overflow-hidden animate-scale-in"
      >
        {/* 顶栏 */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-rule bg-canvas/80 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Compass size={18} />
            </div>
            <div>
              <h2 id="market-modal-title" className="text-sm font-bold text-ink-1 sm:text-base">
                智能体角色市场 (Agent Marketplace)
              </h2>
              <p className="text-[11px] text-ink-3 hidden sm:block">
                按需加载顶级行业预设面具，赋予大模型垂直领域专业能力
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="press rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-hover hover:text-ink-1"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>

        {/* 筛选与搜索 */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-b border-rule bg-panel px-4 sm:px-6 py-3">
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1 sm:pb-0">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`press whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-all ${
                  activeCategory === cat.id
                    ? 'bg-accent text-on-accent shadow-sm'
                    : 'text-ink-3 hover:bg-hover hover:text-ink-1'
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64 shrink-0">
            <Search
              size={13}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索角色名或描述..."
              className="h-8 w-full rounded-xl border border-rule bg-canvas pl-8 pr-3 text-xs text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        {/* 智能体卡片网格 */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-canvas/40">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {filtered.map((item) => {
              const isInstalled =
                installedMap[item.id] || assistants.some((a) => a.id === item.id)

              return (
                <div
                  key={item.id}
                  className="group relative flex flex-col justify-between rounded-2xl border border-rule/80 bg-panel p-4 shadow-1 transition-all duration-200 hover:border-accent/40 hover:shadow-2"
                >
                  <div>
                    {/* 头部：头像 + 名称 + 徽章 */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-canvas border border-rule/60 text-2xl shadow-sm group-hover:scale-105 transition-transform">
                          {item.emoji}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <h3 className="text-xs sm:text-sm font-bold text-ink-1 group-hover:text-accent transition-colors">
                              {item.name}
                            </h3>
                          </div>
                          {item.badge && (
                            <span className="mt-0.5 inline-block rounded-md bg-accent/10 px-1.5 py-0.2 text-[9px] font-semibold text-accent">
                              {item.badge}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* 描述 */}
                    <p className="mt-3 text-xs leading-relaxed text-ink-2/90 line-clamp-2">
                      {item.description}
                    </p>

                    {/* 启动提示词引导 */}
                    {item.starterPrompts && item.starterPrompts.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1">
                        {item.starterPrompts.slice(0, 2).map((starter) => (
                          <span
                            key={starter}
                            className="rounded-md bg-canvas/90 px-1.5 py-0.5 text-[10px] text-ink-3 truncate max-w-[200px]"
                          >
                            “{starter}”
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 底部动作条 */}
                  <div className="mt-4 flex items-center justify-end gap-2 border-t border-rule/50 pt-3">
                    <button
                      onClick={() => handleInstall(item)}
                      disabled={isInstalled}
                      className="press flex h-7 items-center gap-1 rounded-lg border border-rule px-2.5 text-[11px] text-ink-2 transition-all hover:bg-hover hover:text-ink-1 disabled:opacity-40"
                    >
                      {isInstalled ? (
                        <>
                          <Check size={12} className="text-emerald-500" />
                          <span>已添加</span>
                        </>
                      ) : (
                        <>
                          <Plus size={12} />
                          <span>添加到智能体</span>
                        </>
                      )}
                    </button>

                    <button
                      onClick={() => handleStartChat(item)}
                      className="press flex h-7 items-center gap-1 rounded-lg bg-accent px-3 text-[11px] font-medium text-on-accent shadow-sm hover:brightness-110 transition-all"
                    >
                      <MessageSquare size={12} />
                      <span>立即对话</span>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
