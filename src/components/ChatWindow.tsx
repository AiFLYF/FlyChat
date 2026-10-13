import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Menu, PanelLeftOpen } from 'lucide-react'
import { useChatStore, uid } from '../store/chat'
import { streamChat } from '../api/client'
import MessageItem from './MessageItem'
import ChatInput from './ChatInput'
import type { Message } from '../types'

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

  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const active = conversations.find((c) => c.id === activeId) ?? null

  // 流式输出 / 切换会话时自动滚到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' })
  }, [active?.messages, streaming])

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
          updateMessage(conversationId, assistantId, {
            content: partial
              ? partial + '\n\n---\n⚠️ 生成中断：' + (err instanceof Error ? err.message : String(err))
              : '请求失败：' + (err instanceof Error ? err.message : String(err)),
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
      if (streaming) return
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
    [streaming, activeId, createConversation, addMessage, runCompletion]
  )

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const handleRegenerate = useCallback(() => {
    if (!active || streaming) return
    const msgs = active.messages
    const lastAssistantIdx = [...msgs].reverse().findIndex((m) => m.role === 'assistant')
    if (lastAssistantIdx < 0) return
    const idx = msgs.length - 1 - lastAssistantIdx
    const history = msgs
      .slice(0, idx)
      .filter((m) => !m.error)
      .map(({ role, content }) => ({ role, content }))
    removeMessagesAfter(active.id, msgs[idx - 1]?.id ?? '')
    void runCompletion(active.id, history)
  }, [active, streaming, removeMessagesAfter, runCompletion])

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
      <main className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-lg shadow-blue-500/20">
              <Menu size={0} className="hidden" />
              <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
                <path d="M13 2 3 14h7l-1 8 12-14h-8l0-6z" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-zinc-800 dark:text-zinc-100">
              欢迎使用 FlyChat
            </h2>
            <p className="max-w-md text-center text-sm leading-6 text-zinc-500 dark:text-zinc-400">
              一站式 AI 聊天平台。支持 OpenAI / DeepSeek / Claude / Gemini 等多家模型，
              在右上角「设置」中选择服务端已配置的提供商和模型后即可开始对话。
            </p>
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
        disabled={false}
      />
    </div>
  )
}
