// deslop-ignore-file 04 21 — 全站仅一个强调色（蓝）；外框 16px 内件 8px 符合嵌套规则
import { useEffect, useRef } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { useComposer } from '../store/composer'

interface Props {
  onSend: (text: string) => void
  onStop: () => void
  streaming: boolean
  disabled?: boolean
  disabledHint?: string
}

export default function ChatInput({ onSend, onStop, streaming, disabled, disabledHint }: Props) {
  const text = useComposer((s) => s.text)
  const setText = useComposer((s) => s.setText)
  const clear = useComposer((s) => s.clear)
  const focusToken = useComposer((s) => s.focusToken)
  const ref = useRef<HTMLTextAreaElement>(null)

  // 高度跟随内容
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 208) + 'px'
  }, [text])

  // 外部填充（示例提示词）或快捷键聚焦
  useEffect(() => {
    if (focusToken > 0) ref.current?.focus()
  }, [focusToken])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        ref.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const submit = () => {
    const value = text.trim()
    if (!value || streaming || disabled) return
    onSend(value)
    clear()
  }

  const canSend = !!text.trim() && !streaming && !disabled

  return (
    <div className="border-t border-rule bg-canvas px-4 pb-4 pt-3">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={`r-lg flex items-end gap-2 border bg-raised p-2 transition-colors ${
            disabled
              ? 'border-rule'
              : 'border-rule focus-within:border-accent'
          }`}
        >
          <textarea
            ref={ref}
            value={text}
            rows={1}
            placeholder={
              disabled ? disabledHint ?? '暂不可用' : '输入消息，Enter 发送，Shift + Enter 换行'
            }
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            className="max-h-52 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-6 text-ink-1 outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
          />
          {streaming ? (
            <button
              onClick={onStop}
              className="r-sm flex h-9 items-center gap-1.5 border border-rule px-3 text-sm font-medium text-ink-2 transition-colors hover-bg-hover"
            >
              <Square size={13} fill="currentColor" />
              停止
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              className="r-sm flex h-9 w-9 items-center justify-center bg-accent text-on-accent transition-opacity disabled:opacity-25"
              aria-label="发送"
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between px-1 text-xs text-ink-3">
          <span>内容由 AI 生成，请自行甄别</span>
          <span className="hidden sm:block">
            <kbd className="rounded border border-rule px-1.5 py-0.5 font-sans">⌘K</kbd> 聚焦输入
          </span>
        </div>
      </div>
    </div>
  )
}
