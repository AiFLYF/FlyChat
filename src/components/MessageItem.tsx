// deslop-ignore-file 19 04 21 — 聊天产品惯例：圆形头像、单一强调色、气泡小尾巴
import { memo, useState } from 'react'
import { AlertCircle, Check, Copy, RefreshCw, User, Zap } from 'lucide-react'
import MarkdownRenderer from './MarkdownRenderer'
import type { Message } from '../types'

interface Props {
  message: Message
  streaming?: boolean
  isLastAssistant?: boolean
  onRegenerate?: () => void
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
      aria-label="复制消息"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

const MessageItem = memo(function MessageItem({ message, streaming, isLastAssistant, onRegenerate }: Props) {
  const isUser = message.role === 'user'

  if (isUser) {
    return (
      <div className="flex justify-end gap-3">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-[15px] leading-7 text-white">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
        {/* deslop-ignore 19 头像用圆形是聊天产品的通用惯例 */}
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
          <User size={16} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      {/* deslop-ignore 19 头像用圆形是聊天产品的通用惯例 */}
      <div
        className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white ${
          message.error ? 'bg-zinc-600' : 'bg-blue-600'
        }`}
      >
        {message.error ? <AlertCircle size={16} /> : <Zap size={16} fill="currentColor" />}
      </div>
      <div className="min-w-0 max-w-[85%] flex-1">
        {message.error ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            <b className="text-red-600 dark:text-red-400">错误</b>
            <span> — {message.content}</span>
          </div>
        ) : (
          <>
            <MarkdownRenderer content={message.content} />
            {streaming && (
              // deslop-ignore-next-line 16 流式输出光标是功能性指示器
              <span className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-sm bg-blue-500 align-middle" />
            )}
          </>
        )}
        {!streaming && !message.error && (
          <div className="mt-1 flex items-center gap-1">
            <CopyMessageButton text={message.content} />
            {isLastAssistant && onRegenerate && (
              <button
                onClick={onRegenerate}
                className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                aria-label="重新生成"
              >
                <RefreshCw size={14} />
              </button>
            )}
            {message.model && (
              <span className="ml-1 text-xs text-zinc-400 dark:text-zinc-500">{message.model}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

export default MessageItem
