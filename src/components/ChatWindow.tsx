// deslop-ignore-file 04 12 21 — 单一强调色；紧凑应用栏的字号层级；空态标识底板
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, Download, PanelLeftOpen, Settings } from 'lucide-react'
import { useChatStore, uid } from '../store/chat'
import { useSettingsOpen } from './settingsOpen'
import { useComposer } from '../store/composer'
import { fetchProviders, streamChat } from '../api/client'
import MessageItem from './MessageItem'
import ChatInput from './ChatInput'
import type { Message, ProviderInfo } from '../types'

const EXAMPLES = [
  '用三句话解释什么是向量数据库',
  '帮我写一个正则，匹配中国大陆手机号',
  '这段 Python 代码为什么报 KeyError？',
  '把下面的会议记录整理成行动项清单',
]

export default function ChatWindow() {
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const settings = useChatStore((s) => s.settings)
  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const createConversation = useChatStore((s) => s.createConversation)
  const addMessage = useChatStore((s) => s.addMessage)
  const appendToMessage = useChatStore((s) => s.appendToMessage)
  const updateMessage = useChatStore((s) => s.updateMessage)
  const removeMessagesAfter = useChatStore((s) => s.removeMessagesAfter)
  const clearMessages = useChatStore((s) => s.clearMessages)

  const setShowSettings = useSettingsOpen((s) => s.setOpen)
  const fillComposer = useComposer((s) => s.fill)

  const [streaming, setStreaming] = useState(false)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [atBottom, setAtBottom] = useState(true)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  const active = conversations.find((c) => c.id === activeId) ?? null

  // 获取可用提供商（输入门控与自动选型）
  useEffect(() => {
    fetchProviders()
      .then((list) => {
        setProviders(list)
        if (list.length === 0) return
        const state = useChatStore.getState()
        const current = list.find((p) => p.id === state.settings.provider)
        const patch: Partial<typeof state.settings> = {}
        if (!current) {
          patch.provider = list[0].id
          patch.model = list[0].models[0] ?? ''
        } else if (!state.settings.model && current.models.length > 0) {
          patch.model = current.models[0]
        }
        if (Object.keys(patch).length) state.updateSettings(patch)
      })
      .catch(() => setProviders([]))
  }, [])

  // 智能滚动：仅在停留底部附近时跟随
  useEffect(() => {
    if (!pinnedRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' })
  }, [active?.messages, activeId, streaming])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 100
    pinnedRef.current = near
    setAtBottom(near)
  }, [])

  const scrollToBottom = useCallback(() => {
    pinnedRef.current = true
    setAtBottom(true)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const ready = providers.length > 0 && !!settings.provider && !!settings.model

  const runCompletion = useCallback(
    async (conversationId: string, history: { role: 'user' | 'assistant'; content: string }[]) => {
      const assistantId = uid()
      addMessage(conversationId, {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        model: settings.model,
      })
      setStreaming(true)
      const controller = new AbortController()
      abortRef.current = controller

      try {
        await streamChat(
          {
            settings,
            messages: history,
            onDelta: (text) => appendToMessage(conversationId, assistantId, text),
          },
          controller.signal
        )
      } catch (err) {
        const aborted =
          controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')
        if (!aborted) {
          const current = useChatStore
            .getState()
            .conversations.find((c) => c.id === conversationId)
            ?.messages.find((m) => m.id === assistantId)
          const partial = current?.content ?? ''
          const message = err instanceof Error ? err.message : String(err)
          updateMessage(conversationId, assistantId, {
            content: partial ? partial + '\n\n---\n生成中断：' + message : '请求失败：' + message,
            error: !partial,
          })
        }
      } finally {
        setStreaming(false)
        abortRef.current = null
      }
    },
    [settings, addMessage, appendToMessage, updateMessage]
  )

  const handleSend = useCallback(
    (text: string) => {
      if (streaming || !ready) return
      const convId = activeId ?? createConversation()
      const message: Message = { id: uid(), role: 'user', content: text, createdAt: Date.now() }
      addMessage(convId, message)
      const history = [
        ...(useChatStore.getState().conversations.find((c) => c.id === convId)?.messages ?? []),
        message,
      ]
        .filter((m) => !m.error)
        .map(({ role, content }) => ({ role, content }))
      void runCompletion(convId, history)
    },
    [streaming, ready, activeId, createConversation, addMessage, runCompletion]
  )

  const handleStop = useCallback(() => abortRef.current?.abort(), [])

  const handleRegenerate = useCallback(() => {
    if (!active || streaming) return
    const msgs = active.messages
    const reversedIdx = [...msgs].reverse().findIndex((m) => m.role === 'assistant')
    if (reversedIdx < 0) return
    const assistantIdx = msgs.length - 1 - reversedIdx
    if (assistantIdx > 0) removeMessagesAfter(active.id, msgs[assistantIdx - 1].id)
    else clearMessages(active.id)
    const history = msgs
      .slice(0, assistantIdx)
      .filter((m) => !m.error)
      .map(({ role, content }) => ({ role, content }))
    void runCompletion(active.id, history)
  }, [active, streaming, removeMessagesAfter, clearMessages, runCompletion])

  const exportMarkdown = useCallback(() => {
    if (!active) return
    const lines = [
      `# ${active.title}`,
      '',
      `> 导出自 FlyChat · ${new Date().toLocaleString('zh-CN')}`,
      '',
      ...active.messages.map(
        (m) => `**${m.role === 'user' ? '用户' : 'AI'}**：\n\n${m.content}\n\n---\n`
      ),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${active.title}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [active])

  const empty = !active || active.messages.length === 0

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col bg-canvas">
      {/* 顶栏 */}
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-rule px-4">
        <div className="flex min-w-0 items-center gap-2">
          {!sidebarOpen && (
            <button
              onClick={toggleSidebar}
              className="r-sm -ml-1 flex h-8 w-8 items-center justify-center text-ink-2 transition-colors hover-bg-hover"
              aria-label="展开侧边栏"
            >
              <PanelLeftOpen size={17} />
            </button>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-medium leading-5 text-ink-1">
              {active?.title ?? 'FlyChat'}
            </h1>
            {ready && (
              <p className="truncate text-xs leading-4 text-ink-3">
                {providers.find((p) => p.id === settings.provider)?.name} · {settings.model}
              </p>
            )}
          </div>
        </div>
        {active && active.messages.length > 0 && (
          <button
            onClick={exportMarkdown}
            className="r-sm flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-xs text-ink-2 transition-colors hover-bg-hover"
          >
            <Download size={14} />
            导出
          </button>
        )}
      </header>

      {/* 消息区 */}
      <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="mx-auto flex h-full w-full max-w-2xl flex-col justify-center px-6 py-10">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-on-accent">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M13 2 3 14h7l-1 8 12-14h-8l0-6z" />
              </svg>
            </div>
            <h2 className="mt-5 text-2xl font-semibold tracking-tight text-ink-1">
              {ready ? '开始一段对话' : '还没有可用的模型'}
            </h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-ink-2">
              {ready
                ? '支持流式输出、Markdown 与多会话管理。可以从下面的例子开始，也可以直接提问。'
                : '服务端还没有配置 API Key。把 server/.env.example 复制为 server/.env，填入至少一个提供商的 Key 后重启后端。'}
            </p>

            {ready ? (
              <div className="mt-7 grid gap-2 sm:grid-cols-2">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => fillComposer(ex)}
                    className="r-md border border-rule bg-panel px-3.5 py-3 text-left text-[13px] leading-5 text-ink-2 transition-colors hover-bg-hover hover:text-ink-1"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            ) : (
              <button
                onClick={() => setShowSettings(true)}
                className="r-sm mt-6 flex w-fit items-center gap-1.5 bg-accent px-4 py-2 text-sm font-medium text-on-accent"
              >
                <Settings size={15} />
                去设置
              </button>
            )}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-8">
            <div className="space-y-7">
              {active.messages.map((m, i) => {
                const isLastAssistant =
                  m.role === 'assistant' &&
                  !active.messages.slice(i + 1).some((x) => x.role === 'assistant')
                return (
                  <MessageItem
                    key={m.id}
                    message={m}
                    streaming={streaming && isLastAssistant && i === active.messages.length - 1}
                    isLastAssistant={isLastAssistant && !streaming}
                    onRegenerate={handleRegenerate}
                  />
                )
              })}
            </div>
            <div ref={bottomRef} className="h-1" />
          </div>
        )}
      </main>

      {/* 回到底部 */}
      {!empty && !atBottom && (
        <button
          onClick={scrollToBottom}
          className="r-sm absolute bottom-28 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center border border-rule bg-raised text-ink-2 shadow-sm transition-colors hover-bg-hover"
          aria-label="回到底部"
        >
          <ArrowDown size={16} />
        </button>
      )}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        streaming={streaming}
        disabled={!ready}
        disabledHint={
          providers.length === 0
            ? '请先在 server/.env 配置 API Key 并重启后端'
            : '请先在上方「设置」中选择模型'
        }
      />
    </div>
  )
}
