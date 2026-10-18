import { useEffect, useRef, useState } from 'react'
import { Brain, Check, ChevronRight, Copy, Sparkles } from 'lucide-react'
import MarkdownRenderer from './MarkdownRenderer'

/**
 * SOTA 级思考过程折叠块（DeepSeek-R1 / OpenAI o1/o3 / Claude Thinking）
 * 包含：实时秒级秒表计时器、思考字符统计、复制思考过程、自动折叠与微光扫过效果。
 */
export default function ReasoningBlock({
  text,
  streaming,
  durationMs,
}: {
  text: string
  streaming?: boolean
  durationMs?: number
}) {
  const [open, setOpen] = useState(!!streaming)
  const wasStreaming = useRef(!!streaming)
  const [elapsedSec, setElapsedSec] = useState<number>(0)
  const startTimeRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)

  // 计时器：流式时实时递增
  useEffect(() => {
    if (streaming) {
      if (!startTimeRef.current) {
        startTimeRef.current = Date.now()
      }
      const timer = window.setInterval(() => {
        if (startTimeRef.current) {
          setElapsedSec((Date.now() - startTimeRef.current) / 1000)
        }
      }, 100)
      return () => window.clearInterval(timer)
    } else {
      if (startTimeRef.current && !durationMs) {
        setElapsedSec((Date.now() - startTimeRef.current) / 1000)
      }
      startTimeRef.current = null
    }
  }, [streaming, durationMs])

  // 流式结束自动收起（如果用户没手动干预）
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      setOpen(false)
    }
    if (!wasStreaming.current && streaming) {
      setOpen(true)
    }
    wasStreaming.current = !!streaming
  }, [streaming])

  if (!text) return null

  const displayTime = durationMs
    ? (durationMs / 1000).toFixed(1)
    : elapsedSec > 0
    ? elapsedSec.toFixed(1)
    : null

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="anim-fade-in mb-3 overflow-hidden rounded-xl border border-rule/70 bg-panel/75 shadow-1 backdrop-blur-sm">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-2 transition-all hover:bg-hover"
      >
        <div className="relative flex items-center justify-center">
          <Brain
            size={14}
            className={`shrink-0 transition-colors ${
              streaming ? 'text-accent animate-pulse' : 'text-purple-500/80 dark:text-purple-400'
            }`}
          />
          {streaming && (
            <span className="absolute -right-0.5 -top-0.5 flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
          )}
        </div>

        <span className="font-medium text-ink-1">
          {streaming ? '深度推理思考中…' : '已完成深度思考'}
        </span>

        {displayTime && (
          <span className="rounded-md bg-hover px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
            {displayTime}s
          </span>
        )}

        <span className="hidden text-[10px] text-ink-3 sm:inline">
          · {text.length} 字符
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            className="press rounded p-1 text-ink-3 transition-colors hover:bg-panel hover:text-ink-1"
            title="复制思考过程"
            aria-label="复制思考过程"
          >
            {copied ? (
              <Check size={12} className="text-emerald-500" />
            ) : (
              <Copy size={12} />
            )}
          </button>

          <ChevronRight
            size={13}
            className={`shrink-0 text-ink-3 transition-transform duration-200 ease-out ${
              open ? 'rotate-90' : ''
            }`}
          />
        </div>
      </button>

      {/* 平滑网格折叠容器 */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-rule/50 bg-hover-soft/60 px-3.5 py-3">
            <div className="prose-chat border-l-2 border-purple-500/30 pl-3 text-xs leading-relaxed text-ink-2/90">
              <MarkdownRenderer content={text} />
            </div>
            {streaming && (
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-accent">
                <Sparkles size={11} className="animate-spin" />
                <span>思维链持续展开中...</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
