import { useState, useEffect } from 'react'
import {
  ArrowLeft,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  KeyRound,
  Lock,
  Sparkles,
  AlertCircle,
  Share2,
} from 'lucide-react'
import { BrandIcon, BrandLogo } from './ui/BrandLogo'
import MarkdownRenderer from './MarkdownRenderer'
import { fetchShareSnapshot, type SharedConversationData } from '../api/client'
import { useChatStore } from '../store/chat'

interface SharedViewProps {
  shareId: string
  onClose: () => void
}

export default function SharedView({ shareId, onClose }: SharedViewProps) {
  const [data, setData] = useState<SharedConversationData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [copiedLink, setCopiedLink] = useState(false)
  const [forked, setForked] = useState(false)

  const createConversation = useChatStore((s) => s.createConversation)
  const addMessage = useChatStore((s) => s.addMessage)
  const renameConversation = useChatStore((s) => s.renameConversation)

  const loadData = async (pwd?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchShareSnapshot(shareId, pwd)
      setData(result)
      setPasswordRequired(false)
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      if (code === 'share_password_required') {
        setPasswordRequired(true)
      } else {
        setError(err instanceof Error ? err.message : '获取分享快照失败')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId])

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 2000)
    } catch {
      // fallback
    }
  }

  const handleFork = () => {
    if (!data) return
    const newId = createConversation()
    renameConversation(newId, data.title || '导入的分享会话')
    for (const msg of data.messages) {
      addMessage(newId, {
        id: msg.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
        role: msg.role,
        content: msg.content,
        reasoning: msg.reasoning,
        attachments: msg.attachments,
        citations: msg.citations,
        createdAt: msg.createdAt || Date.now(),
      })
    }
    setForked(true)
    setTimeout(() => {
      onClose()
    }, 800)
  }

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink-1">
      {/* 顶栏 */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b border-rule bg-panel/90 px-4 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="press flex h-8 items-center gap-1.5 rounded-lg border border-rule px-2.5 text-xs text-ink-2 hover:bg-hover hover:text-ink-1"
            title="返回主界面"
          >
            <ArrowLeft size={14} />
            <span className="hidden sm:inline">返回工作台</span>
          </button>
          <div className="h-4 w-px bg-rule" />
          <BrandLogo size="sm" />
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-accent">
            只读分享快照
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyLink}
            className="press flex h-8 items-center gap-1.5 rounded-lg border border-rule px-2.5 text-xs text-ink-2 hover:bg-hover hover:text-ink-1"
          >
            {copiedLink ? (
              <>
                <Check size={13} className="text-emerald-500" />
                <span className="text-emerald-500">已复制链接</span>
              </>
            ) : (
              <>
                <Share2 size={13} />
                <span>复制链接</span>
              </>
            )}
          </button>

          <button
            onClick={handleFork}
            disabled={!data || forked}
            className="press flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-on-accent shadow-1 hover:brightness-110 disabled:opacity-50"
          >
            {forked ? (
              <>
                <Check size={13} />
                <span>已导入对话</span>
              </>
            ) : (
              <>
                <Sparkles size={13} />
                <span>导入此对话</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* 主视图内容 */}
      <main className="flex-1 overflow-y-auto px-4 py-8">
        <div className="mx-auto max-w-3xl">
          {/* 加载骨架 */}
          {loading && (
            <div className="space-y-6">
              <div className="skeleton r-md h-9 w-3/4" />
              <div className="flex gap-3">
                <div className="skeleton r-sm h-5 w-24" />
                <div className="skeleton r-sm h-5 w-24" />
              </div>
              <div className="mt-8 space-y-4">
                <div className="skeleton r-xl h-24 w-full" />
                <div className="skeleton r-xl h-36 w-full" />
              </div>
            </div>
          )}

          {/* 密码保护卡片 */}
          {!loading && passwordRequired && (
            <div className="mx-auto mt-16 max-w-md rounded-2xl border border-rule bg-panel p-6 text-center shadow-2">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                <Lock size={24} />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-ink-1">此分享内容受密码保护</h2>
              <p className="mt-1.5 text-xs text-ink-3">
                创建者为此会话设置了访问凭证，请输入访问密码以解锁完整对话
              </p>

              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (passwordInput.trim()) {
                    loadData(passwordInput.trim())
                  }
                }}
                className="mt-6 space-y-3"
              >
                <div className="relative">
                  <KeyRound
                    size={14}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
                  />
                  <input
                    type="password"
                    placeholder="输入分享密码"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    className="h-10 w-full rounded-xl border border-rule bg-canvas pl-9 pr-3 text-xs text-ink-1 placeholder:text-ink-3 focus:border-accent focus:outline-none"
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  className="press flex h-10 w-full items-center justify-center rounded-xl bg-accent text-xs font-medium text-on-accent hover:brightness-110"
                >
                  验证并查看
                </button>
              </form>
            </div>
          )}

          {/* 错误状态 */}
          {!loading && !passwordRequired && error && (
            <div className="mx-auto mt-16 max-w-md rounded-2xl border border-rule bg-panel p-6 text-center shadow-2">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500">
                <AlertCircle size={24} />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-ink-1">无法加载分享内容</h2>
              <p className="mt-1.5 text-xs text-ink-3">{error}</p>
              <button
                onClick={onClose}
                className="press mt-6 inline-flex h-9 items-center justify-center rounded-xl bg-accent px-4 text-xs font-medium text-on-accent"
              >
                返回主应用
              </button>
            </div>
          )}

          {/* 会话内容渲染 */}
          {!loading && data && (
            <div>
              {/* 会话元数据标题栏 */}
              <div className="mb-8 border-b border-rule pb-6">
                <h1 className="text-xl font-bold tracking-tight text-ink-1 sm:text-2xl">
                  {data.title || '分享的对话'}
                </h1>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-3">
                  {data.model && (
                    <span className="flex items-center gap-1 rounded-md bg-canvas px-2 py-0.5 font-mono text-[11px] text-ink-2">
                      <Sparkles size={11} className="text-accent" />
                      {data.model}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Clock size={12} />
                    {new Date(data.createdAt).toLocaleDateString()}
                  </span>
                  <span className="flex items-center gap-1">
                    <Eye size={12} />
                    {data.views} 次浏览
                  </span>
                  <span className="flex items-center gap-1">
                    <Copy size={12} />
                    共 {data.messageCount} 条消息
                  </span>
                </div>
              </div>

              {/* 消息流 */}
              <div className="space-y-6">
                {data.messages.map((m, index) => {
                  const isUser = m.role === 'user'
                  return (
                    <div
                      key={m.id || index}
                      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
                    >
                      {/* 头像 */}
                      <div className="shrink-0">
                        {isUser ? (
                          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-[11px] font-bold text-on-accent shadow-sm">
                            YOU
                          </div>
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-rule bg-panel shadow-sm">
                            <BrandIcon size={18} />
                          </div>
                        )}
                      </div>

                      {/* 气泡正文 */}
                      <div
                        className={`max-w-[85%] rounded-2xl px-4 py-3 text-xs sm:text-sm ${
                          isUser
                            ? 'bg-accent text-on-accent'
                            : 'border border-rule bg-panel text-ink-1 shadow-1'
                        }`}
                      >
                        {m.reasoning && (
                          <details className="mb-2.5 rounded-lg border border-rule/60 bg-canvas/40 p-2 text-xs text-ink-3">
                            <summary className="cursor-pointer select-none font-medium text-ink-2">
                              思考推理过程
                            </summary>
                            <div className="mt-1.5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                              {m.reasoning}
                            </div>
                          </details>
                        )}
                        <div className="prose-chat leading-relaxed">
                          <MarkdownRenderer content={m.content} />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* 底部商业级 Banner */}
              <div className="mt-12 rounded-2xl border border-rule bg-gradient-to-r from-panel via-canvas to-panel p-6 text-center shadow-1">
                <div className="mx-auto flex justify-center">
                  <BrandIcon size={28} />
                </div>
                <h3 className="mt-3 text-sm font-semibold text-ink-1">
                  喜欢这个对话？在 FlyChat 中开启你的下一次探索
                </h3>
                <p className="mt-1 text-xs text-ink-3">
                  极速多模型对比 · 本地隐私 IndexedDB · 航空级界面设计
                </p>
                <div className="mt-4 flex justify-center gap-3">
                  <button
                    onClick={onClose}
                    className="press flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-xs font-medium text-on-accent hover:brightness-110"
                  >
                    <span>进入完整 FlyChat 对话</span>
                    <ExternalLink size={12} />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
