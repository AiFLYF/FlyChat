// deslop-ignore-file 19 04 21 — 聊天产品惯例：圆形头像、单一强调色、气泡小尾巴
import { memo, useState } from 'react'
import { AlertCircle, Check, Copy, RefreshCw, Zap } from 'lucide-react'
import MarkdownRenderer from './MarkdownRenderer'
import type { Message } from '../types'

interface Props {
  message: Message
  streaming?: boolean
  isLastAssistant?: boolean
  onRegenerate?: () => void
}

function timeLabel(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
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
      className="r-sm flex items-center gap-1 px-2 py-1 text-xs text-ink-3 transition-colors hover-bg-hover hover:text-ink-1"
      aria-label="复制消息"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}

const MessageItem = memo(function MessageItem({
  message,
  streaming,
  isLastAssistant,
  onRegenerate,
}: Props) {
  const isUser = message.role === 'user'

  if (isUser) {
    return (
      <div className="group flex flex-col items-end gap-1.5">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] leading-7 text-on-accent">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        </div>
        <div className="flex items-center gap-1 pr-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <span className="px-1 text-xs tabular-nums text-ink-3">{timeLabel(message.createdAt)}</span>
          <CopyMessageButton text={message.content} />
        </div>
      </div>
    )
  }

  return (
    <div className="group flex gap-3">
      <div
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
          message.error ? 'bg-panel text-ink-2' : 'bg-accent text-on-accent'
        }`}
      >
        {message.error ? <AlertCircle size={15} /> : <Zap size={14} fill="currentColor" />}
      </div>

      <div className="min-w-0 flex-1">
        {message.error ? (
          <div className="r-md border border-rule bg-panel px-4 py-3 text-sm leading-6 text-ink-2">
            <b className="text-danger">错误</b>
            <span> — {message.content}</span>
          </div>
        ) : (
          <>
            <MarkdownRenderer content={message.content} />
            {streaming && (
              // deslop-ignore-next-line 16 流式输出光标是功能性指示器
              <span className="ml-0.5 inline-block h-4 w-[7px] animate-pulse rounded-[2px] bg-accent align-middle" />
            )}
          </>
        )}

        {!streaming && !message.error && (
          <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <CopyMessageButton text={message.content} />
            {isLastAssistant && onRegenerate && (
              <button
                onClick={onRegenerate}
                className="r-sm flex items-center gap-1 px-2 py-1 text-xs text-ink-3 transition-colors hover-bg-hover hover:text-ink-1"
                aria-label="重新生成"
              >
                <RefreshCw size={13} />
                重新生成
              </button>
            )}
            <span className="px-1 text-xs tabular-nums text-ink-3">
              {message.model ? `${message.model} · ` : ''}
              {timeLabel(message.createdAt)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
})

export default MessageItem
