import { useEffect, useState } from 'react'
import { Check, AlertCircle, Info, AlertTriangle, X } from 'lucide-react'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

export interface ToastMessage {
  id: string
  text: string
  type?: ToastType
  duration?: number
}

// 事件派发器，支持全局任何地方无 context 唤起
export function showToast(text: string, type: ToastType = 'info', duration = 2400) {
  if (typeof window === 'undefined') return
  const event = new CustomEvent('flychat:toast', {
    detail: { id: Math.random().toString(36).slice(2), text, type, duration },
  })
  window.dispatchEvent(event)
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<ToastMessage>
      if (!customEvent.detail) return
      const toast = customEvent.detail
      setToasts((prev) => [...prev.slice(-4), toast])

      const timer = window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id))
      }, toast.duration || 2400)

      return () => window.clearTimeout(timer)
    }

    window.addEventListener('flychat:toast', handler)
    return () => window.removeEventListener('flychat:toast', handler)
  }, [])

  if (toasts.length === 0) return null

  return (
    <aside
      aria-label="操作反馈通知"
      className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2"
    >
      {toasts.map((toast) => {
        const isSuccess = toast.type === 'success'
        const isError = toast.type === 'error'
        const isWarn = toast.type === 'warning'

        return (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto anim-fade-up flex max-w-sm items-center gap-2.5 rounded-xl border border-rule/80 bg-panel/95 px-3.5 py-2.5 text-xs text-ink-1 shadow-3 backdrop-blur-md transition-all hover:scale-[1.02]"
          >
            <div className="shrink-0">
              {isSuccess && <Check size={14} className="text-emerald-500" />}
              {isError && <AlertCircle size={14} className="text-danger" />}
              {isWarn && <AlertTriangle size={14} className="text-amber-500" />}
              {!isSuccess && !isError && !isWarn && <Info size={14} className="text-accent" />}
            </div>

            <span className="font-medium leading-relaxed">{toast.text}</span>

            <button
              type="button"
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
              className="press ml-1 rounded p-0.5 text-ink-4 hover:bg-hover hover:text-ink-2"
              aria-label="关闭提示"
            >
              <X size={12} />
            </button>
          </div>
        )
      })}
    </aside>
  )
}
