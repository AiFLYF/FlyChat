/**
 * 浏览器原生语音交互支持模块 (STT 语音转文字 / TTS 文本朗读)
 * 无需外部大依赖，极速响应，支持中文与多语言
 */

// 类型垫片
declare global {
  interface Window {
    SpeechRecognition?: any
    webkitSpeechRecognition?: any
  }
}

export interface SpeechRecognitionHandlers {
  onResult: (text: string, isFinal: boolean) => void
  onError?: (err: string) => void
  onEnd?: () => void
}

/** 检查当前浏览器是否支持原生语音识别 */
export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
}

/** 创建并启动语音识别器 */
export function startSpeechRecognition(
  handlers: SpeechRecognitionHandlers,
  lang = 'zh-CN'
): { stop: () => void } {
  const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SpeechRecognitionClass) {
    handlers.onError?.('当前浏览器不支持语音输入，建议使用 Chrome 或 Edge')
    return { stop: () => {} }
  }

  const recognition = new SpeechRecognitionClass()
  recognition.lang = lang
  recognition.interimResults = true
  recognition.continuous = true

  let isManualStopped = false

  recognition.onresult = (event: any) => {
    let interim = ''
    let final = ''

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const part = event.results[i][0].transcript
      if (event.results[i].isFinal) {
        final += part
      } else {
        interim += part
      }
    }

    if (final) {
      handlers.onResult(final, true)
    } else if (interim) {
      handlers.onResult(interim, false)
    }
  }

  recognition.onerror = (event: any) => {
    if (event.error === 'no-speech') return
    handlers.onError?.(event.error || '语音识别遇到错误')
  }

  recognition.onend = () => {
    if (!isManualStopped) {
      handlers.onEnd?.()
    }
  }

  try {
    recognition.start()
  } catch (err: any) {
    handlers.onError?.(err?.message || '无法启动录音')
  }

  return {
    stop: () => {
      isManualStopped = true
      try {
        recognition.stop()
      } catch {
        /* ignore */
      }
      handlers.onEnd?.()
    },
  }
}

/** 检查当前浏览器是否支持原生文本朗读 */
export function isSpeechSynthesisSupported(): boolean {
  if (typeof window === 'undefined') return false
  return 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
}

let activeUtterance: SpeechSynthesisUtterance | null = null

/** 朗读文本 */
export function speakText(
  text: string,
  options?: {
    lang?: string
    rate?: number
    pitch?: number
    onEnd?: () => void
    onError?: (err: string) => void
  }
): void {
  if (!isSpeechSynthesisSupported()) {
    options?.onError?.('当前环境不支持语音朗读')
    return
  }

  stopSpeaking()

  // 过滤掉 markdown 中的代码块或复杂符号，朗读更自然
  const cleanText = text
    .replace(/```[\s\S]*?```/g, ' [代码块省略] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*~_>-]/g, '')
    .trim()

  if (!cleanText) return

  const utterance = new SpeechSynthesisUtterance(cleanText)
  utterance.lang = options?.lang || 'zh-CN'
  utterance.rate = options?.rate || 1.0
  utterance.pitch = options?.pitch || 1.0

  utterance.onend = () => {
    activeUtterance = null
    options?.onEnd?.()
  }

  utterance.onerror = (e) => {
    activeUtterance = null
    options?.onError?.(e.error || '朗读中断')
  }

  activeUtterance = utterance
  window.speechSynthesis.speak(utterance)
}

/** 停止当前朗读 */
export function stopSpeaking(): void {
  if (!isSpeechSynthesisSupported()) return
  activeUtterance = null
  window.speechSynthesis.cancel()
}

/** 判断当前是否正在朗读 */
export function isSpeaking(): boolean {
  if (!isSpeechSynthesisSupported()) return false
  return window.speechSynthesis.speaking || !!activeUtterance
}
