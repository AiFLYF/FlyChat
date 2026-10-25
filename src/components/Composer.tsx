import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Brain, Globe, Mic, MicOff, Paperclip, Square, Wrench, X } from 'lucide-react'
import { useComposer } from '../store/composer'
import { useChatStore } from '../store/chat'
import { fileToAttachment } from '../lib/files'
import { ComposerAttachments } from './Attachments'
import PromptPicker from './PromptPicker'
import Spinner from './ui/Spinner'
import { AudioWaveform } from './ui/BrandGraphic'
import { isSpeechRecognitionSupported, startSpeechRecognition } from '../lib/speech'
import type { Attachment } from '../types'

interface PillProps {
  onClick: () => void
  label: string
  active?: boolean
  disabled?: boolean
  children: React.ReactNode
}

/** 输入框内的功能胶囊（附件 / 提示词 / 联网 / 深度思考） */
function Pill({ onClick, label, active, disabled, children }: PillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={label}
      aria-label={label}
      // disabled-x：统一不透明度 + not-allowed 光标（原先只有 opacity-40，无光标反馈）
      // 触控目标 ≥40px：指针设备保持 h-8 视觉高度，粗指针（手机/平板）扩到 h-10
      className={`press flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-ui disabled-x [@media(pointer:coarse)]:h-10 ${
        active
          ? 'border-transparent bg-accent-soft font-medium text-accent'
          : 'border-rule text-ink-2 hover:bg-hover hover:text-ink-1'
      }`}
    >
      {children}
    </button>
  )
}

export interface ComposerProps {
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
  streaming: boolean
  disabled?: boolean
  disabledHint?: string
  webSearchAvailable: boolean
  /** hero = 空态居中大输入框；inline = 对话态底部输入框 */
  variant?: 'hero' | 'inline'
  /** 输入框下方的附加行（如模型选择） */
  footer?: React.ReactNode
}

/**
 * 统一输入框。
 * 设计参考 DeepSeek / ChatGPT / Claude：大圆角卡面、留白输入区、
 * 底部一行功能胶囊 + 右下角圆形发送按钮。
 */
export default function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  disabledHint,
  webSearchAvailable,
  variant = 'inline',
  footer,
}: ComposerProps) {
  const text = useComposer((s) => s.text)
  const setText = useComposer((s) => s.setText)
  const clear = useComposer((s) => s.clear)
  const focusToken = useComposer((s) => s.focusToken)
  const attachments = useComposer((s) => s.attachments)
  const addAttachment = useComposer((s) => s.addAttachment)
  const removeAttachment = useComposer((s) => s.removeAttachment)

  const settings = useChatStore((s) => s.settings)
  const updateSettings = useChatStore((s) => s.updateSettings)

  const fileRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<{ stop: () => void } | null>(null)
  const hasSpeech = isSpeechRecognitionSupported()

  const toggleListening = () => {
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
    } else {
      setError('')
      const rec = startSpeechRecognition({
        onResult: (chunk) => {
          setText(chunk)
          taRef.current?.focus()
        },
        onError: (err) => {
          setError(err)
          setListening(false)
        },
        onEnd: () => setListening(false),
      })
      recognitionRef.current = rec
      setListening(true)
    }
  }

  // 组件卸载时停止录音
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop()
    }
  }, [])

  const ingestFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    setError('')
    setUploading(true)
    try {
      for (const file of list) {
        const att = await fileToAttachment(file)
        addAttachment(att)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  // 高度跟随内容
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }, [text])

  // 外部填充（示例提示词）聚焦
  useEffect(() => {
    if (focusToken > 0) taRef.current?.focus()
  }, [focusToken])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        taRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const submit = () => {
    const value = text.trim()
    if ((!value && attachments.length === 0) || streaming || disabled) return
    onSend(value, attachments)
    clear()
  }

  const canSend = (!!text.trim() || attachments.length > 0) && !streaming && !disabled
  const placeholder = disabled
    ? disabledHint ?? '暂不可用'
    : variant === 'hero'
      ? // 不再重复问候语里的「有什么可以帮你？」，改为带操作提示
        '输入你的问题，Enter 发送'
      : '给 FlyChat 发送消息'

  return (
    <div
      className="w-full"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files?.length) void ingestFiles(e.dataTransfer.files)
      }}
    >
      {error && (
        <div role="alert" className="anim-fade-down mb-2 flex items-start gap-2 rounded-xl border border-rule bg-panel px-3 py-2 text-xs leading-5 text-ink-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="text-ink-3 hover:text-ink-1" aria-label="关闭">
            <X size={13} />
          </button>
        </div>
      )}

      {/* 焦点指示由这张卡统一绘制（描边转强调色 + 抬升一层）。
          卡内的 textarea 用 no-focus-ring 关掉自带焦点环，否则会出现内外双层描边。 */}
      <div
        className={`r-2xl relative border bg-panel transition-ui ${
          dragOver
            ? 'border-accent ring-soft'
            : 'border-rule shadow-2 focus-within:border-accent focus-within:ring-soft'
        } ${variant === 'hero' ? 'p-2.5' : 'p-2'}`}
        aria-busy={uploading}
      >
        {dragOver && (
          <div className="anim-fade-in absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed border-accent bg-panel/95 backdrop-blur-sm pointer-events-none">
            <Paperclip size={22} className="text-accent anim-bounce" />
            <span className="text-xs font-semibold text-accent">释放鼠标即可附加文件或图片</span>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="px-1.5 pt-1.5">
            <ComposerAttachments attachments={attachments} onRemove={removeAttachment} />
          </div>
        )}

        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label={variant === 'hero' ? '输入你的问题' : '给 FlyChat 发送消息'}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files)
            if (files.some((f) => f.type.startsWith('image/'))) {
              e.preventDefault()
              void ingestFiles(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          className={`no-focus-ring w-full resize-none bg-transparent outline-none placeholder:text-ink-3 disabled:cursor-not-allowed ${
            variant === 'hero'
              ? 'max-h-52 min-h-[64px] px-3.5 py-3 text-[16px] leading-7'
              : 'max-h-52 min-h-10 px-2.5 py-2 text-[15px] leading-6'
          }`}
        />

        {/* flex-wrap：窄屏功能胶囊放不下时换行，而不是横向溢出被裁掉 */}
        <div
          className={`flex flex-wrap items-center gap-1.5 ${
            variant === 'hero' ? 'px-2 pb-1 pt-1' : 'px-1 pb-0.5'
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.pdf,.docx,.txt,.md,.csv,.json,.yaml,.yml,.xml,.log"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void ingestFiles(e.target.files)
              e.target.value = ''
            }}
          />

          <Pill
            label="上传图片识图或文档（支持截图直接 Ctrl+V 粘贴）"
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? <Spinner size={15} /> : <Paperclip size={15} />}
          </Pill>

          <PromptPicker
            pill
            onPick={(content) => {
              setText(text ? `${text}\n${content}` : content)
              taRef.current?.focus()
            }}
          />

          {webSearchAvailable && (
            <Pill
              label="联网搜索"
              active={settings.webSearch}
              onClick={() => updateSettings({ webSearch: !settings.webSearch })}
            >
              <Globe size={15} />
              {/* 窄屏只留图标，避免输入行挤压溢出 */}
              {settings.webSearch && <span className="hidden sm:inline">联网</span>}
            </Pill>
          )}

          <Pill
            label="深度思考"
            active={settings.thinking}
            onClick={() => updateSettings({ thinking: !settings.thinking })}
          >
            <Brain size={15} />
            {settings.thinking && <span className="hidden sm:inline">思考</span>}
          </Pill>

          <Pill
            label="智能体工具 (Agent / MCP)"
            active={settings.tools !== false}
            onClick={() => updateSettings({ tools: settings.tools === false ? true : false })}
          >
            <Wrench size={15} />
            {settings.tools !== false && <span className="hidden sm:inline">工具</span>}
          </Pill>

          {hasSpeech && (
            <Pill
              label={listening ? '停止录音' : '语音输入'}
              active={listening}
              disabled={disabled || streaming}
              onClick={toggleListening}
            >
              {listening ? <MicOff size={15} className="text-accent" /> : <Mic size={15} />}
              {listening && <AudioWaveform active className="scale-75" />}
              <span className="hidden sm:inline">{listening ? '聆听中' : '语音'}</span>
            </Pill>
          )}

          <div className="ml-auto" />

          {/* 当有输入内容时，提供快速清空草稿按钮与字数计数器 */}
          {text.trim().length > 0 && (
            <div className="anim-fade-in flex items-center gap-2 mr-1 text-[11px] text-ink-4">
              <span className="hidden sm:inline-block font-mono text-[10px] text-ink-4/80">
                ↵ 发送 · Shift+↵ 换行
              </span>
              <span className="font-mono text-[10px] tracking-tight text-ink-3">{text.length} 字</span>
              <button
                type="button"
                onClick={clear}
                title="清空输入"
                aria-label="清空输入"
                className="tap-bounce text-ink-4 hover:text-ink-2 p-1 rounded transition-colors hover:bg-hover"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {streaming ? (
            <button
              onClick={onStop}
              className="press tap-bounce relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rule text-ink-2 transition-all hover:bg-hover hover:text-ink-1"
              title="停止生成"
              aria-label="停止生成"
            >
              <span className="absolute inset-0 rounded-full border-2 border-accent/40 animate-ping opacity-40 pointer-events-none" />
              <Square size={12} fill="currentColor" className="text-accent" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              className={`press tap-bounce relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-all duration-200 disabled-x disabled:shadow-none ${
                canSend
                  ? 'shadow-1 hover:bg-accent-hover hover:scale-105 hover:shadow-2'
                  : 'opacity-40'
              }`}
              title="发送消息 (Enter)"
              aria-label="发送"
            >
              <ArrowUp size={17} className={`transition-transform duration-200 ${canSend ? 'scale-110' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {footer}

      {/* 上传状态：用只读 live region 让读屏用户感知进度，避免只看图标 Spinner */}
      {uploading && (
        <p className="sr-only" role="status">
          正在上传文件…
        </p>
      )}

      <p className="mt-2 text-center text-[11px] text-ink-3 transition-opacity duration-200 opacity-70 hover:opacity-100">
        内容由 AI 生成，请自行甄别
      </p>
    </div>
  )
}
