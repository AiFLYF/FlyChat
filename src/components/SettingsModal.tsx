// deslop-ignore-file 04 05 12 21 — 单一强调色；选中态为强调色描边 + 中性底；破坏性操作用红；弹窗单框圆角
import { useEffect, useState } from 'react'
import { Loader2, Moon, Monitor, Sun, X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useSettingsOpen } from './settingsOpen'
import { fetchProviders } from '../api/client'
import type { ProviderInfo, ThemeMode } from '../types'

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: '浅色', icon: <Sun size={13} /> },
  { value: 'dark', label: '深色', icon: <Moon size={13} /> },
  { value: 'system', label: '跟随系统', icon: <Monitor size={13} /> },
]

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <label className="text-[13px] font-medium text-ink-1">{label}</label>
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

export default function SettingsModal() {
  const open = useSettingsOpen((s) => s.open)
  const setOpen = useSettingsOpen((s) => s.setOpen)
  const settings = useChatStore((s) => s.settings)
  const updateSettings = useChatStore((s) => s.updateSettings)
  const clearAll = useChatStore((s) => s.clearAll)

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [customModel, setCustomModel] = useState('')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')
    fetchProviders()
      .then((list) => {
        setProviders(list)
        if (list.length > 0 && !list.some((p) => p.id === settings.provider)) {
          updateSettings({ provider: list[0].id, model: list[0].models[0] ?? '' })
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => setCustomModel(''), [settings.provider])

  if (!open) return null

  const currentProvider = providers.find((p) => p.id === settings.provider)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="r-lg max-h-[86vh] w-full max-w-lg overflow-y-auto border border-rule bg-raised p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-ink-1">设置</h2>
          <button
            onClick={() => setOpen(false)}
            className="r-sm -mr-1 flex h-8 w-8 items-center justify-center text-ink-3 transition-colors hover-bg-hover hover:text-ink-1"
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-2">
            <Loader2 size={16} className="animate-spin" />
            正在获取可用模型…
          </div>
        ) : error ? (
          <div className="r-md border border-rule bg-panel px-4 py-3 text-sm leading-6 text-ink-2">
            <b className="text-danger">错误</b>
            <span> — {error}（请确认后端服务已启动）</span>
          </div>
        ) : providers.length === 0 ? (
          <div className="r-md border border-rule bg-panel px-4 py-3 text-sm leading-6 text-ink-2">
            <b className="text-ink-1">未配置</b>
            <span>
              {' '}
              — 服务端还没有 API Key。把 <code className="text-ink-1">server/.env.example</code>{' '}
              复制为 <code className="text-ink-1">server/.env</code>，填入至少一个提供商的 Key
              后重启后端。
            </span>
          </div>
        ) : (
          <div className="space-y-6">
            <Field label="模型提供商">
              <div className="grid grid-cols-2 gap-2">
                {providers.map((p) => {
                  const on = settings.provider === p.id
                  return (
                    <button
                      key={p.id}
                      onClick={() => updateSettings({ provider: p.id, model: p.models[0] ?? '' })}
                      className={`r-sm border px-3 py-2 text-[13px] transition-colors ${
                        on
                          ? 'border-accent bg-accent-soft font-medium text-accent'
                          : 'border-rule text-ink-2 hover-bg-hover hover:text-ink-1'
                      }`}
                    >
                      {p.name}
                    </button>
                  )
                })}
              </div>
            </Field>

            {currentProvider && (
              <Field label="模型" hint={settings.model ? '当前：' + settings.model : undefined}>
                <div className="flex flex-wrap gap-1.5">
                  {currentProvider.models.map((m) => {
                    const on = settings.model === m
                    return (
                      <button
                        key={m}
                        onClick={() => updateSettings({ model: m })}
                        className={`r-sm border px-2.5 py-1.5 text-xs transition-colors ${
                          on
                            ? 'border-accent bg-accent-soft font-medium text-accent'
                            : 'border-rule text-ink-2 hover-bg-hover hover:text-ink-1'
                        }`}
                      >
                        {m}
                      </button>
                    )
                  })}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && customModel.trim()) {
                        updateSettings({ model: customModel.trim() })
                        setCustomModel('')
                      }
                    }}
                    placeholder="自定义模型名称"
                    className="r-sm min-w-0 flex-1 border border-rule bg-canvas px-3 py-1.5 text-[13px] text-ink-1 outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
                  />
                  {customModel.trim() && (
                    <button
                      onClick={() => {
                        updateSettings({ model: customModel.trim() })
                        setCustomModel('')
                      }}
                      className="r-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent"
                    >
                      使用
                    </button>
                  )}
                </div>
              </Field>
            )}

            <Field label="随机性" hint={String(settings.temperature)}>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={settings.temperature}
                onChange={(e) => updateSettings({ temperature: Number(e.target.value) })}
                className="w-full accent-[var(--accent)]"
              />
            </Field>

            <Field label="系统提示词" hint="可选">
              <textarea
                value={settings.systemPrompt}
                onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
                rows={3}
                placeholder="例如：你是一个乐于助人的中文 AI 助手。"
                className="r-sm w-full resize-y border border-rule bg-canvas px-3 py-2 text-[13px] leading-6 text-ink-1 outline-none transition-colors placeholder:text-ink-3 focus:border-accent"
              />
            </Field>
          </div>
        )}

        <div className="mt-6 border-t border-rule pt-5">
          <Field label="界面主题">
            <div className="inline-flex rounded-lg border border-rule p-0.5">
              {THEME_OPTIONS.map((opt) => {
                const on = settings.theme === opt.value
                return (
                  <button
                    key={opt.value}
                    onClick={() => updateSettings({ theme: opt.value })}
                    className={`r-sm flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors ${
                      on ? 'bg-accent text-on-accent' : 'text-ink-2 hover-bg-hover hover:text-ink-1'
                    }`}
                  >
                    {opt.icon}
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </Field>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-rule pt-5">
          <p className="text-xs leading-5 text-ink-3">
            对话记录保存在浏览器本地
            <br />
            清空后不可恢复
          </p>
          <button
            onClick={() => {
              if (confirm('确定清空所有对话记录吗？此操作不可恢复。')) {
                clearAll()
                setOpen(false)
              }
            }}
            className="r-sm shrink-0 border border-rule px-3 py-1.5 text-[13px] text-danger transition-colors hover-bg-hover"
          >
            清空所有对话
          </button>
        </div>
      </div>
    </div>
  )
}
