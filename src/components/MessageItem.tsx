import { memo, useEffect, useRef, useState } from 'react'
import { useDismiss } from '../lib/useDismiss'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Pencil,
  RefreshCw,
  Share2,
  Sparkles,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react'
import { generateTaskRewrite, fetchTasksInfo } from '../api/client'
import { showToast } from './ui/Toast'
import MarkdownRenderer from './MarkdownRenderer'
import ReasoningBlock from './ReasoningBlock'
import Citations from './Citations'
import ToolCallsBlock from './ToolCallsBlock'
import KnowledgeSourcesBlock from './KnowledgeSourcesBlock'
import { MessageAttachments } from './Attachments'
import { BrandIcon } from './ui/BrandLogo'
import { AudioWaveform } from './ui/BrandGraphic'
import { formatMessageTime } from '../lib/date'
import { speakText, stopSpeaking } from '../lib/speech'
import { ICON_BTN, BUTTON_GHOST, BUTTON_PRIMARY } from '../lib/ui'
import type { Message } from '../types'

interface Props {
  message: Message
  streaming?: boolean
  isLastAssistant?: boolean
  /**
   * 是否播放入场动画。长会话一次性挂载数百条消息时，
   * 由 ChatWindow 只对视口附近的几条开启，避免上百个动画同时跑。
   */
  enter?: boolean
  onRegenerate?: () => void
  onEdit?: (messageId: string, newContent: string) => void
  onDelete?: (messageId: string) => void
  onShare?: (message: Message) => void
  onToggleStar?: (messageId: string) => void
  onSwitchVariant?: (messageId: string, index: number) => void
  onPickSuggestion?: (text: string) => void
}

function IconButton({
  onClick,
  label,
  danger,
  active,
  children,
}: {
  onClick: () => void
  label: string
  danger?: boolean
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`${ICON_BTN} h-7 gap-1 px-2 text-[11px] ${
        danger ? 'hover:text-danger' : ''
      } ${active ? 'bg-accent-soft text-accent font-medium' : ''}`}
    >
      {children}
    </button>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      label="复制消息"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          showToast('已复制内容到剪贴板', 'success')
          setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {copied ? <Check size={13} className="text-emerald-500 anim-bounce" /> : <Copy size={13} />}
      {/* 复制成功有文字反馈，读屏也能播报 */}
      <span aria-live="polite">{copied ? '已复制' : '复制'}</span>
    </IconButton>
  )
}

const TONE_LABELS: Record<string, string> = {
  concise: '更简洁',
  formal: '更正式',
  casual: '更口语',
  expand: '更详细',
  polish: '润色优化',
  translate: '译为英文',
  translate_zh: '译为中文',
}

const DEFAULT_TONES = [
  { key: 'concise', label: '更简洁', instruction: '删掉冗余修饰与重复表达，保留全部关键信息。' },
  { key: 'formal', label: '更正式', instruction: '更正式、更书面化，适合写在文档或邮件里。' },
  { key: 'casual', label: '更口语', instruction: '更口语、更自然，像面对面聊天。' },
  { key: 'expand', label: '更详细', instruction: '扩写得更详细，补充必要的解释与例子。' },
  { key: 'polish', label: '润色优化', instruction: '修正语病、让表达更通顺，意思不要变。' },
  { key: 'translate', label: '译为英文', instruction: '翻译成英文，保持原意与语气。' },
  { key: 'translate_zh', label: '译为中文', instruction: '翻译成简体中文，保持原意与语气。' },
]

let cachedTones: { key: string; label: string; instruction: string }[] | null = null

const MessageItem = memo(function MessageItem({
  message,
  streaming,
  isLastAssistant,
  enter = true,
  onRegenerate,
  onEdit,
  onDelete,
  onShare,
  onToggleStar,
  onSwitchVariant,
  onPickSuggestion,
}: Props) {
  const isUser = message.role === 'user'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [rewriteMenuOpen, setRewriteMenuOpen] = useState(false)
  const [rewriting, setRewriting] = useState(false)
  const [rewriteResult, setRewriteResult] = useState<string | null>(null)
  const [tones, setTones] = useState(() => cachedTones || DEFAULT_TONES)
  const rewriteRef = useRef<HTMLDivElement>(null)
  useDismiss(rewriteRef, () => setRewriteMenuOpen(false), rewriteMenuOpen)
  const enterCls = enter ? 'anim-fade-up ' : ''

  useEffect(() => {
    if (rewriteMenuOpen && !cachedTones) {
      fetchTasksInfo()
        .then((res) => {
          if (res?.tones && res.tones.length > 0) {
            const mapped = res.tones.map((t) => ({
              key: t.key,
              label: TONE_LABELS[t.key] || t.key,
              instruction: t.instruction,
            }))
            cachedTones = mapped
            setTones(mapped)
          }
        })
        .catch(() => {})
    }
  }, [rewriteMenuOpen])

  // ---------- 用户消息 ----------
  if (isUser) {
    if (editing) {
      return (
        <div className="flex flex-col items-end gap-2">
          <div className="anim-scale-in w-full max-w-[92%] rounded-2xl border-2 border-accent bg-panel p-1.5 shadow-2 sm:max-w-[86%]">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(12, draft.split('\n').length + 1)}
              aria-label="编辑消息"
              // 外框已用 border-2 border-accent 标出焦点，内部再画一圈就是双层描边
              className="no-focus-ring w-full resize-none bg-transparent px-3 py-2 text-[15px] leading-7 text-ink-1 outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setEditing(false)
                  setDraft(message.content)
                }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  onEdit?.(message.id, draft.trim())
                  setEditing(false)
                }
              }}
            />
            <div className="flex items-center justify-end gap-2 px-1 pb-0.5">
              <button
                onClick={() => {
                  setEditing(false)
                  setDraft(message.content)
                }}
                className={`${BUTTON_GHOST} py-1 text-xs`}
              >
                <X size={13} />
                取消
              </button>
              <button
                onClick={() => {
                  const next = draft.trim()
                  if (next) onEdit?.(message.id, next)
                  setEditing(false)
                }}
                className={`${BUTTON_PRIMARY} py-1 text-xs`}
              >
                <Check size={13} />
                保存并重新发送
              </button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className={`${enterCls}group flex flex-col items-end gap-1.5`}>
        {/* 窄屏放宽到 92%，避免短句被 86% 挤成两行 */}
        <div className="max-w-[92%] sm:max-w-[86%]">
          <MessageAttachments attachments={message.attachments} />
          {message.content && (
            <div className="rounded-[20px] rounded-br-[6px] bg-bubble-user px-4 py-2.5 text-[15px] leading-7 text-on-bubble-user transition-shadow duration-200 ease-out hover:shadow-1">
              <div className="whitespace-pre-wrap break-words">{message.content}</div>
            </div>
          )}
        </div>
        {/* 操作栏：淡入 + 轻微上移，比单纯 opacity 更有层次。
            hover:none（触屏）设备没有悬停概念，用媒体变体常显，否则移动端完全无法触发 */}
        <div className="flex translate-y-0.5 items-center gap-0.5 pr-0.5 opacity-0 transition-all duration-200 ease-out group-hover:translate-y-0 group-hover:opacity-100 focus-within:translate-y-0 focus-within:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100">
          <span className="tnum px-1 text-[11px] text-ink-3">
            {formatMessageTime(message.createdAt)}
          </span>
          {onEdit && (
            <IconButton
              label="编辑消息"
              onClick={() => {
                setDraft(message.content)
                setEditing(true)
              }}
            >
              <Pencil size={13} />
              编辑
            </IconButton>
          )}
          <CopyButton text={message.content} />
          {onDelete && (
            <IconButton label="删除消息" danger onClick={() => onDelete(message.id)}>
              <Trash2 size={13} />
            </IconButton>
          )}
        </div>
      </div>
    )
  }

  // ---------- 助手消息 ----------
  const [feedback, setFeedback] = useState<'like' | 'dislike' | null>(null)
  const [playingSpeech, setPlayingSpeech] = useState(false)

  // 消息卸载或切换时停止朗读
  useEffect(() => {
    return () => {
      if (playingSpeech) stopSpeaking()
    }
  }, [playingSpeech])

  const toggleSpeech = () => {
    if (playingSpeech) {
      stopSpeaking()
      setPlayingSpeech(false)
    } else {
      setPlayingSpeech(true)
      speakText(message.content, {
        onEnd: () => setPlayingSpeech(false),
        onError: () => setPlayingSpeech(false),
      })
    }
  }

  return (
    <div className={`${enterCls}group flex gap-3 sm:gap-3.5`}>
      <div
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-all duration-200 ease-out group-hover:scale-105 shadow-sm ${
          message.error ? 'bg-panel text-ink-2 ring-1 ring-rule' : 'bg-panel border border-rule/80'
        }`}
      >
        {message.error ? <AlertCircle size={16} /> : <BrandIcon size={20} glow />}
      </div>

      <div className="min-w-0 flex-1 pt-0.5">
        {message.modelSwitch && (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle size={13} className="shrink-0" />
            <span>模型故障自动降级切换：<b>{message.modelSwitch.from}</b> ➔ <b>{message.modelSwitch.to}</b></span>
            {message.modelSwitch.reason && <span className="opacity-75">({message.modelSwitch.reason})</span>}
          </div>
        )}

        {message.error ? (
          <div
            role="alert"
            className="rounded-xl border border-rule bg-panel px-4 py-3 text-sm leading-6 text-ink-2"
          >
            <b className="text-danger">错误</b>
            <span> — {message.content}</span>
            {isLastAssistant && onRegenerate && (
              <button
                onClick={onRegenerate}
                className={`${BUTTON_GHOST} mt-2.5 py-1 text-xs`}
              >
                <RefreshCw size={13} />
                重试
              </button>
            )}
          </div>
        ) : (
          <>
            {message.reasoning && (
              <ReasoningBlock
                text={message.reasoning}
                streaming={streaming}
                durationMs={message.reasoningTimeMs}
              />
            )}
            {message.toolCalls && message.toolCalls.length > 0 && (
              <ToolCallsBlock
                toolCalls={message.toolCalls}
                toolResults={message.toolResults}
              />
            )}
            <MarkdownRenderer content={message.content} />
            {streaming && (
              // deslop-ignore-next-line 16 流式输出光标是功能性指示器
              <span className="stream-caret ml-0.5 inline-block h-[18px] w-[7px] rounded-[2px] bg-accent align-middle" />
            )}
            {!streaming && <Citations citations={message.citations} />}
            <KnowledgeSourcesBlock sources={message.sources} />

            {/* 模型生成图片画廊 (Q-2026-10-19-10) */}
            {message.generatedImages && message.generatedImages.length > 0 && (
              <div className="my-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                {message.generatedImages.map((img, idx) => {
                  const src = img.url || img.dataUrl
                  if (!src) return null
                  return (
                    <div
                      key={idx}
                      className="group/img relative overflow-hidden rounded-xl border border-rule bg-canvas shadow-1 transition-all hover:shadow-2"
                    >
                      <img
                        src={src}
                        alt={img.revisedPrompt || 'AI 绘画生成'}
                        className="w-full h-auto object-cover max-h-80 cursor-zoom-in transition-transform duration-300 hover:scale-[1.02]"
                        onClick={() => window.open(src, '_blank')}
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-2.5 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-between text-white text-xs">
                        <span className="truncate max-w-[80%] text-[11px]" title={img.revisedPrompt}>
                          {img.revisedPrompt || 'AI 绘画'}
                        </span>
                        <a
                          href={src}
                          download={`ai-image-${Date.now()}.png`}
                          className="p-1 rounded bg-white/20 hover:bg-white/30 transition-colors"
                          title="下载原图"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Download size={13} />
                        </a>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {!streaming && !message.error && (
          <div className="mt-1.5 -ml-2 flex flex-wrap translate-y-0.5 items-center gap-0.5 opacity-0 transition-all duration-200 ease-out group-hover:translate-y-0 group-hover:opacity-100 focus-within:translate-y-0 focus-within:opacity-100 [@media(hover:none)]:translate-y-0 [@media(hover:none)]:opacity-100">
            {/* 多版本同胞回答切换器 ‹ 1/3 › */}
            {message.variants && message.variants.length > 1 && (
              <div className="flex items-center gap-0.5 rounded-lg border border-rule/70 bg-panel px-1.5 py-0.5 text-xs text-ink-2 shadow-sm mr-1">
                <button
                  type="button"
                  onClick={() => onSwitchVariant?.(message.id, (message.currentVariantIndex || 0) - 1)}
                  disabled={(message.currentVariantIndex || 0) <= 0}
                  className="press rounded p-0.5 text-ink-3 hover:text-ink-1 disabled:opacity-30 disabled:pointer-events-none"
                  title="查看上一回答版本"
                  aria-label="查看上一回答版本"
                >
                  <ChevronLeft size={12} />
                </button>
                <span className="font-mono text-[10px] px-1 font-semibold text-ink-2">
                  {(message.currentVariantIndex || 0) + 1} / {message.variants.length}
                </span>
                <button
                  type="button"
                  onClick={() => onSwitchVariant?.(message.id, (message.currentVariantIndex || 0) + 1)}
                  disabled={(message.currentVariantIndex || 0) >= message.variants.length - 1}
                  className="press rounded p-0.5 text-ink-3 hover:text-ink-1 disabled:opacity-30 disabled:pointer-events-none"
                  title="查看下一回答版本"
                  aria-label="查看下一回答版本"
                >
                  <ChevronRight size={12} />
                </button>
              </div>
            )}

            <CopyButton text={message.content} />

            {/* 改写润色菜单 (Q-2026-10-19-06) */}
            <div className="relative" ref={rewriteRef}>
              <IconButton
                label="改写与润色"
                onClick={() => setRewriteMenuOpen((v) => !v)}
              >
                {rewriting ? <Loader2 size={13} className="animate-spin text-accent" /> : <Wand2 size={13} />}
                <span className="hidden sm:inline">改写</span>
              </IconButton>
              {rewriteMenuOpen && (
                <div className="absolute bottom-full left-0 mb-1 w-36 rounded-xl border border-rule bg-panel p-1 shadow-3 z-30 text-xs anim-fade-up">
                  {tones.map((tone) => (
                    <button
                      key={tone.key}
                      type="button"
                      title={tone.instruction}
                      disabled={rewriting}
                      onClick={async () => {
                        setRewriteMenuOpen(false)
                        setRewriting(true)
                        try {
                          const res = await generateTaskRewrite({ text: message.content, tone: tone.key })
                          if (res.text) {
                            setRewriteResult(res.text)
                            showToast('改写完成', 'success')
                          }
                        } catch (err: any) {
                          showToast(`改写失败: ${err.message}`, 'error')
                        } finally {
                          setRewriting(false)
                        }
                      }}
                      className="press flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-ink-2 hover:bg-hover hover:text-ink-1 text-left transition-colors"
                    >
                      <span>{tone.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 收藏回答 */}
            <IconButton
              label={message.starred ? '取消收藏' : '收藏此回答'}
              active={message.starred}
              onClick={() => {
                onToggleStar?.(message.id)
                showToast(message.starred ? '已取消收藏' : '已收藏此回答', 'info')
              }}
            >
              <Star
                size={13}
                className={
                  message.starred
                    ? 'fill-amber-400 text-amber-500 anim-bounce'
                    : 'transition-transform hover:scale-110'
                }
              />
              <span className="hidden sm:inline">{message.starred ? '已收藏' : '收藏'}</span>
            </IconButton>

            {/* 语音朗读 */}
            <IconButton
              label={playingSpeech ? '停止朗读' : '朗读回答'}
              active={playingSpeech}
              onClick={toggleSpeech}
            >
              {playingSpeech ? (
                <>
                  <VolumeX size={13} className="text-accent" />
                  <AudioWaveform active className="scale-75" />
                </>
              ) : (
                <Volume2 size={13} />
              )}
            </IconButton>

            {/* 点赞反馈 */}
            <IconButton
              label="回答满意"
              active={feedback === 'like'}
              onClick={() => setFeedback(feedback === 'like' ? null : 'like')}
            >
              <ThumbsUp size={13} className={feedback === 'like' ? 'fill-current' : ''} />
            </IconButton>

            {/* 点踩反馈 */}
            <IconButton
              label="回答有待改进"
              active={feedback === 'dislike'}
              onClick={() => setFeedback(feedback === 'dislike' ? null : 'dislike')}
            >
              <ThumbsDown size={13} className={feedback === 'dislike' ? 'fill-current' : ''} />
            </IconButton>

            {/* 生成社交分享卡片 */}
            {onShare && (
              <IconButton label="生成分享卡片" onClick={() => onShare(message)}>
                <Share2 size={13} />
                分享
              </IconButton>
            )}

            {isLastAssistant && onRegenerate && (
              <IconButton label="重新生成" onClick={onRegenerate}>
                <RefreshCw size={13} />
                重新生成
              </IconButton>
            )}

            {onDelete && (
              <IconButton label="删除消息" danger onClick={() => onDelete(message.id)}>
                <Trash2 size={13} />
              </IconButton>
            )}

            <span className="tnum px-1.5 text-[11px] text-ink-3">
              {message.model ? `${message.model} · ` : ''}
              {formatMessageTime(message.createdAt)}
              {message.usage?.total ? ` · ${message.usage.total} tokens` : ''}
            </span>
          </div>
        )}

        {/* 改写结果卡片 */}
        {rewriteResult && (
          <div className="mt-2.5 rounded-xl border border-accent/30 bg-accent/5 p-3 text-xs text-ink-1 space-y-2 anim-fade-in">
            <div className="flex items-center justify-between text-[11px] font-semibold text-accent">
              <span className="flex items-center gap-1">
                <Wand2 size={12} />
                改写结果
              </span>
              <button
                type="button"
                onClick={() => setRewriteResult(null)}
                className="text-ink-4 hover:text-ink-2"
              >
                <X size={12} />
              </button>
            </div>
            <p className="leading-relaxed whitespace-pre-wrap">{rewriteResult}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(rewriteResult)
                  showToast('已复制改写结果', 'success')
                }}
                className="press rounded bg-panel px-2.5 py-1 text-[11px] border border-rule hover:bg-hover transition-colors"
              >
                复制
              </button>
              {onEdit && (
                <button
                  type="button"
                  onClick={() => {
                    onEdit(message.id, rewriteResult)
                    setRewriteResult(null)
                    showToast('已替换为改写内容', 'success')
                  }}
                  className="press rounded bg-accent px-2.5 py-1 text-[11px] text-white hover:opacity-90 transition-opacity"
                >
                  替换原文
                </button>
              )}
            </div>
          </div>
        )}

        {/* 智能追问建议 (Q-2026-10-19-06) */}
        {!streaming && isLastAssistant && message.suggestions && message.suggestions.length > 0 && (
          <div className="mt-3.5 space-y-1.5 anim-fade-in">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-3">
              <Sparkles size={12} className="text-accent" />
              <span>猜你想问</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {message.suggestions.map((suggestion, sIdx) => (
                <button
                  key={sIdx}
                  type="button"
                  onClick={() => onPickSuggestion?.(suggestion)}
                  className="hover-lift press flex items-center gap-1.5 rounded-full border border-rule/80 bg-panel px-3 py-1 text-xs text-ink-2 transition-all hover:border-accent hover:bg-hover hover:text-accent shadow-1 group"
                >
                  <span>{suggestion}</span>
                  <span className="text-[10px] text-accent opacity-60 transition-transform duration-200 group-hover:translate-x-0.5">↵</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

export default MessageItem
