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
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-blue-600 px-4 py-2.5 text-[15px] leading-7 text-white shadow-sm">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
          <User size={16} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <div
        className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white ${
          message.error ? 'bg-red-500' : 'bg-gradient-to-br from-blue-500 to-indigo-600'
        }`}
      >
        {message.error ? <AlertCircle size={16} /> : <Zap size={16} fill="currentColor" />}
      </div>
      <div className="min-w-0 max-w-[85%] flex-1">
        {message.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-600 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400">
            {message.content}
          </div>
        ) : (
          <>
            <MarkdownRenderer content={message.content} />
            {streaming && (
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
