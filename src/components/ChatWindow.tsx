import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, PanelLeftOpen, Settings } from 'lucide-react'
import { useChatStore, uid } from '../store/chat'
import { useSettingsOpen } from './settingsOpen'
import { fetchProviders, streamChat } from '../api/client'
import MessageItem from './MessageItem'
import ChatInput from './ChatInput'
import type { Message, ProviderInfo } from '../types'

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

  const [streaming, setStreaming] = useState(false)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true) // 用户是否停留在底部附近（智能滚动）

  const active = conversations.find((c) => c.id === activeId) ?? null
  const setShowSettings = useSettingsOpen((s) => s.setOpen)

  // 获取可用提供商（用于输入门控与自动选择模型）
  useEffect(() => {
    fetchProviders()
      .then((list) => {
        setProviders(list)
        if (list.length === 0) return
        const state = useChatStore.getState()
        const current = list.find((p) => p.id === state.settings.provider)
        const patch: Partial<typeof state.settings> = {}
        if (!current) {
          // 当前选择的提供商不在可用列表 → 切到第一个
          patch.provider = list[0].id
          patch.model = list[0].models[0] ?? ''
        } else if (!state.settings.model && current.models.length > 0) {
          patch.model = current.models[0]
        }
        if (Object.keys(patch).length) state.updateSettings(patch)
      })
      .catch(() => setProviders([]))
  }, [])

  // 智能滚动：流式输出或切换会话时，仅在用户停留在底部附近时自动滚动
  useEffect(() => {
    if (!pinnedRef.current) return
    bottomRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' })
  }, [active?.messages, activeId, streaming])

  // 用户上翻超过 100px 时暂停自动滚动，回到底部后恢复
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
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
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === 'AbortError')
        if (!aborted) {
          const current = useChatStore
            .getState()
            .conversations.find((c) => c.id === conversationId)
            ?.messages.find((m) => m.id === assistantId)
          const partial = current?.content ?? ''
          const message = err instanceof Error ? err.message : String(err)
          updateMessage(conversationId, assistantId, {
            content: partial
              ? partial + '\n\n---\n⚠️ 生成中断：' + message
              : '请求失败：' + message,
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

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleRegenerate = useCallback(() => {
    if (!active || streaming) return
    const msgs = active.messages
    // 从后往前找最后一条 assistant 消息的位置
    const reversedIdx = [...msgs].reverse().findIndex((m) => m.role === 'assistant')
    if (reversedIdx < 0) return
    const assistantIdx = msgs.length - 1 - reversedIdx
    // 重新生成前，删除它及其之后的全部内容，保留之前的纯历史
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
    <div className="flex h-full min-w-0 flex-1 flex-col bg-white dark:bg-zinc-950">
      {/* 顶栏 */}
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          {!sidebarOpen && (
            <button
              onClick={toggleSidebar}
              className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              aria-label="展开侧边栏"
            >
              <PanelLeftOpen size={17} />
            </button>
          )}
          <h1 className="max-w-[50vw] truncate text-sm font-medium text-zinc-700 dark:text-zinc-200">
            {active?.title ?? 'FlyChat'}
          </h1>
        </div>
        {active && active.messages.length > 0 && (
          <button
            onClick={exportMarkdown}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <Download size={14} />
            导出 Markdown
          </button>
        )}
      </header>

      {/* 消息区 */}
      <main ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/20">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
                <path d="M13 2 3 14h7l-1 8 12-14h-8l0-6z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-zinc-800 dark:text-zinc-100">
              欢迎使用 FlyChat
            </h2>
            <p className="max-w-md text-center text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              {ready
                ? '一站式 AI 聊天平台。输入消息开始对话，支持流式输出、Markdown 渲染与多会话管理。'
                : '一站式 AI 聊天平台。请先在右下角「设置」中选择服务端已配置的提供商和模型，即可开始对话。'}
            </p>
            {!ready && (
              <button
                onClick={() => setShowSettings(true)}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-500"
              >
                <Settings size={15} />
                去设置
              </button>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
            {active.messages.map((m, i) => {
              const isLastAssistant =
                m.role === 'assistant' && !active.messages.slice(i + 1).some((x) => x.role === 'assistant')
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
            <div ref={bottomRef} />
          </div>
        )}
      </main>

      {/* 输入区 */}
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
