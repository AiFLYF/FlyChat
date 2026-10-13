// deslop-ignore-file 04 05 12 21 — 单一强调色、选中态为强调色描边+中性底、破坏性操作用红、弹窗单框圆角
import { useEffect, useState } from 'react'
import { Loader2, Moon, Monitor, Sun, X } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useSettingsOpen } from './settingsOpen'
import { fetchProviders } from '../api/client'
import type { ProviderInfo, ThemeMode } from '../types'

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: '浅色', icon: <Sun size={14} /> },
  { value: 'dark', label: '深色', icon: <Moon size={14} /> },
  { value: 'system', label: '跟随系统', icon: <Monitor size={14} /> },
]

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
        // 当前选择的提供商不可用时自动切到第一个可用提供商
        if (list.length > 0 && !list.some((p) => p.id === settings.provider)) {
          updateSettings({ provider: list[0].id, model: list[0].models[0] ?? '' })
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    setCustomModel('')
  }, [settings.provider])

  if (!open) return null

  const currentProvider = providers.find((p) => p.id === settings.provider)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-800 dark:text-zinc-100">设置</h2>
          <button
            onClick={() => setOpen(false)}
            className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500 dark:text-zinc-400">
            <Loader2 size={16} className="animate-spin" />
            正在获取可用模型…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            <b className="text-red-600 dark:text-red-400">错误</b>
            <span> — {error}（请确认后端服务已启动）</span>
          </div>
        ) : providers.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            <b>未配置</b>
            <span>
              {' '}
              — 服务端尚未配置任何 API Key。请复制 <code>server/.env.example</code> 为{' '}
              <code>server/.env</code>，填入至少一个提供商的 Key 后重启后端。
            </span>
          </div>
        ) : (
          <div className="space-y-5">
            {/* 模型提供商 */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                模型提供商
              </label>
              <div className="grid grid-cols-2 gap-2">
                {providers.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => updateSettings({ provider: p.id, model: p.models[0] ?? '' })}
                    className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                      settings.provider === p.id
                        ? 'border-blue-600 bg-zinc-100 font-medium text-blue-700 dark:bg-zinc-800 dark:text-blue-400'
                        : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 模型 */}
            {currentProvider && (
              <div>
                <label className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  模型
                </label>
                <div className="flex flex-wrap gap-2">
                  {currentProvider.models.map((m) => (
                    <button
                      key={m}
                      onClick={() => updateSettings({ model: m })}
                      className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                        settings.model === m
                          ? 'border-blue-600 bg-zinc-100 font-medium text-blue-700 dark:bg-zinc-800 dark:text-blue-400'
                          : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder="自定义模型名称（可选）"
                    className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-sm text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-700 dark:text-zinc-100 dark:focus:border-blue-500"
                  />
                  {customModel.trim() && (
                    <button
                      onClick={() => updateSettings({ model: customModel.trim() })}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
                    >
                      使用
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* 温度 */}
            <div>
              <label className="mb-1.5 flex items-center justify-between text-sm font-medium text-zinc-700 dark:text-zinc-300">
                <span>随机性（temperature）</span>
                <span className="text-xs tabular-nums text-zinc-500">{settings.temperature}</span>
              </label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={settings.temperature}
                onChange={(e) => updateSettings({ temperature: Number(e.target.value) })}
                className="w-full accent-blue-600"
              />
            </div>

            {/* 系统提示词 */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                系统提示词（System Prompt）
              </label>
              <textarea
                value={settings.systemPrompt}
                onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
                rows={3}
                placeholder="例如：你是一个乐于助人的中文 AI 助手。"
                className="w-full resize-y rounded-lg border border-zinc-200 bg-transparent px-3 py-2 text-sm text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-700 dark:text-zinc-100 dark:focus:border-blue-500"
              />
            </div>
          </div>
        )}

        {/* 主题 */}
        <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <label className="mb-1.5 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            界面主题
          </label>
          <div className="inline-flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => updateSettings({ theme: opt.value })}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                  settings.theme === opt.value
                    ? 'bg-blue-600 text-white'
                    : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
                }`}
              >
                {opt.icon}
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 危险操作 */}
        <div className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <button
            onClick={() => {
              if (confirm('确定清空所有对话记录吗？此操作不可恢复。')) {
                clearAll()
                setOpen(false)
              }
            }}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            清空所有对话
          </button>
        </div>
      </div>
    </div>
  )
}
