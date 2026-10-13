import { useRef, useState } from 'react'
import { Send, StopCircle } from 'lucide-react'

interface Props {
  onSend: (text: string) => void
  onStop: () => void
  streaming: boolean
  disabled?: boolean
  disabledHint?: string
}

export default function ChatInput({ onSend, onStop, streaming, disabled, disabledHint }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const value = text.trim()
    if (!value || streaming || disabled) return
    onSend(value)
    setText('')
    if (ref.current) ref.current.style.height = 'auto'
  }

  return (
    <div className="border-t border-zinc-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/80">
      <div className="mx-auto max-w-3xl">
        <div
          className={`flex items-end gap-2 rounded-2xl border bg-white p-2 shadow-sm transition-colors dark:bg-zinc-800 ${
            disabled
              ? 'border-zinc-200 dark:border-zinc-700/60'
              : 'border-zinc-200 focus-within:border-blue-400 dark:border-zinc-700 dark:focus-within:border-blue-500'
          }`}
        >
          <textarea
            ref={ref}
            value={text}
            rows={1}
            placeholder={disabled ? disabledHint ?? '暂不可用' : '输入消息，Enter 发送，Shift + Enter 换行'}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value)
              // 自动增高
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            className="max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-6 text-zinc-800 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
          {streaming ? (
            <button
              onClick={onStop}
              className="flex h-9 items-center gap-1.5 rounded-xl bg-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-600"
            >
              <StopCircle size={16} />
              停止
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!text.trim() || disabled}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="发送"
            >
              <Send size={16} />
            </button>
          )}
        </div>
        <p className="mt-2 text-center text-xs text-zinc-400 dark:text-zinc-500">
          内容由 AI 生成，请注意甄别准确性
        </p>
      </div>
    </div>
  )
}
