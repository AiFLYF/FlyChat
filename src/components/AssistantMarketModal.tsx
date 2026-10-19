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

import { showToast } from './ui/Toast'
import { FIELD, BUTTON_PRIMARY, BUTTON_GHOST } from '../lib/ui'

interface Props {
  open: boolean
  onClose: () => void
}

const CATEGORIES = [
  { id: 'all', label: '全部' },
  { id: 'my', label: '⭐ 我的创建' },
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
  const [isCreating, setIsCreating] = useState(false)
  const [createEmoji, setCreateEmoji] = useState('🤖')
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createSystemPrompt, setCreateSystemPrompt] = useState('')
  const [createTemp, setCreateTemp] = useState(0.7)

  const modalRef = useRef<HTMLDivElement>(null)

  useDismiss(modalRef, onClose, open)

  const createConversation = useChatStore((s) => s.createConversation)
  const addAssistant = useChatStore((s) => s.addAssistant)
  const assistants = useChatStore((s) => s.assistants)

  const filtered = useMemo(() => {
    // 包含市场助手与用户自定义创建的助手
    const myAssistants: MarketAssistant[] = assistants
      .filter((a) => !MARKET_ASSISTANTS.some((m) => m.id === a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        emoji: a.emoji,
        description: a.systemPrompt.slice(0, 60) + '...',
        category: 'code' as const,
        systemPrompt: a.systemPrompt,
        temperature: a.temperature,
        badge: '我的创建',
      }))

    let source = MARKET_ASSISTANTS
    if (activeCategory === 'my') {
      source = myAssistants
    } else if (activeCategory === 'all') {
      source = [...myAssistants, ...MARKET_ASSISTANTS]
    } else {
      source = MARKET_ASSISTANTS.filter((item) => item.category === activeCategory)
    }

    const q = query.trim().toLowerCase()
    return source.filter((item) => {
      return (
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q)
      )
    })
  }, [activeCategory, query, assistants])

  const handleCreateCustomAssistant = (e: React.FormEvent) => {
    e.preventDefault()
    if (!createName.trim() || !createSystemPrompt.trim()) {
      showToast('请填写智能体名称与系统提示词', 'error')
      return
    }
    const newId = 'assistant-' + Date.now()
    addAssistant({
      id: newId,
      name: createName.trim(),
      emoji: createEmoji || '🤖',
      systemPrompt: createSystemPrompt.trim(),
      temperature: createTemp,
    })
    showToast(`已成功创建智能体「${createName}」！`, 'success')
    setIsCreating(false)
    setCreateName('')
    setCreateDesc('')
    setCreateSystemPrompt('')
    // 直接切换至新智能体开启对话
    createConversation(newId)
    onClose()
  }

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

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsCreating((v) => !v)}
              className="press hover-lift flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-medium text-on-accent shadow-1 hover:bg-accent-hover transition-ui"
            >
              <Plus size={14} />
              <span>{isCreating ? '浏览智能体市场' : '创建我的智能体'}</span>
            </button>
            <button
              onClick={onClose}
              className="press rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-hover hover:text-ink-1"
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {isCreating ? (
          <form onSubmit={handleCreateCustomAssistant} className="anim-fade-in flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
            <div className="rounded-xl border border-accent/20 bg-accent/5 p-3 text-xs text-ink-2">
              <b className="text-accent">创建专属于您的 AI 智能体：</b> 自定义设定角色性格、专业领域知识与系统提示词。保存后将永久收纳在您的智能体库与侧栏中。
            </div>

            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-3 sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-ink-2">图标 Emoji</label>
                <input
                  type="text"
                  maxLength={4}
                  value={createEmoji}
                  onChange={(e) => setCreateEmoji(e.target.value)}
                  className={`${FIELD} text-center text-lg`}
                />
              </div>
              <div className="col-span-9 sm:col-span-10">
                <label className="mb-1 block text-xs font-medium text-ink-2">智能体名称 *</label>
                <input
                  required
                  type="text"
                  placeholder="例如：全栈架构专家 / 资深中英译者"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  className={FIELD}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-ink-4">推荐图标:</span>
              {['🤖', '💻', '🧠', '✍️', '🎨', '💼', '🚀', '🔬', '💡', '🛡️'].map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => setCreateEmoji(em)}
                  className="h-6 w-6 rounded hover:bg-hover transition-colors text-xs flex items-center justify-center"
                >
                  {em}
                </button>
              ))}
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-2">智能体简要描述</label>
              <input
                type="text"
                placeholder="例如：专注于微服务架构、DDD 领域驱动设计与系统高并发设计..."
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                className={FIELD}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-2">
                核心设定与系统提示词 (System Prompt) *
              </label>
              <textarea
                required
                rows={5}
                placeholder="你是一位世界级的资深软件架构师。请以严谨、高内聚低耦合的架构思维分析问题..."
                value={createSystemPrompt}
                onChange={(e) => setCreateSystemPrompt(e.target.value)}
                className={`${FIELD} font-mono text-xs leading-relaxed`}
              />
            </div>

            <div>
              <div className="flex justify-between text-xs text-ink-2 mb-1">
                <span>采样温度 (Temperature): {createTemp}</span>
                <span className="text-ink-4">
                  {createTemp <= 0.3 ? '严谨精准' : createTemp <= 0.8 ? '均衡适中' : '发散创意'}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={createTemp}
                onChange={(e) => setCreateTemp(parseFloat(e.target.value))}
                className="w-full accent-accent"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-rule">
              <button
                type="button"
                onClick={() => setIsCreating(false)}
                className={`${BUTTON_GHOST} text-xs`}
              >
                取消
              </button>
              <button
                type="submit"
                className={`${BUTTON_PRIMARY} press hover-lift text-xs px-4`}
              >
                创建并开启专属对话
              </button>
            </div>
          </form>
        ) : (
          <>
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
      </>
    )}
  </div>
</div>
  )
}
