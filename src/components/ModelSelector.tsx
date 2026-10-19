import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Columns3, Eye, Search, Sparkles, Wrench } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useDismiss } from '../lib/useDismiss'
import { SEARCH_FIELD, EMPTY_HINT } from '../lib/ui'
import Switch from './ui/Switch'
import { MenuPanel, MenuItem, MenuLabel } from './ui/Menu'
import { showToast } from './ui/Toast'
import { fetchModelsCatalog } from '../api/client'
import type { ProviderInfo, ServerModelInfo } from '../types'

export function modelKey(provider: string, model: string) {
  return `${provider}::${model}`
}

function formatContext(tokens?: number) {
  if (!tokens) return null
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return `${tokens}`
}

/** 顶栏的模型选择器：胶囊触发、可搜索、按提供商分组，支持多模型对比 */
export default function ModelSelector({
  providers,
  align = 'left',
}: {
  providers: ProviderInfo[]
  align?: 'left' | 'right'
}) {
  const settings = useChatStore((s) => s.settings)
  const updateSettings = useChatStore((s) => s.updateSettings)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<ServerModelInfo[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    fetchModelsCatalog().then((items) => {
      if (active && items.length > 0) {
        setCatalog(items)
      }
    })
    return () => {
      active = false
    }
  }, [])

  const catalogMap = useMemo(() => {
    const map = new Map<string, ServerModelInfo>()
    for (const item of catalog) {
      map.set(modelKey(item.provider, item.model), item)
      if (!map.has(item.model)) {
        map.set(item.model, item)
      }
    }
    return map
  }, [catalog])

  // 点击外部 / Esc 关闭（原先三处各写一份，且不支持键盘关闭）
  useDismiss(ref, () => setOpen(false), open)

  const currentProvider = providers.find((p) => p.id === settings.provider)
  const compareCount = settings.compareEnabled ? settings.compareModels.length : 0

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return providers
    return providers
      .map((p) => ({
        ...p,
        models: p.models.filter(
          (m) => m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
        ),
      }))
      .filter((p) => p.models.length > 0)
  }, [providers, query])

  const toggleCompareModel = (key: string) => {
    const list = settings.compareModels.includes(key)
      ? settings.compareModels.filter((k) => k !== key)
      : [...settings.compareModels, key]
    updateSettings({ compareModels: list })
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        // overflow-hidden + 窄屏最大 104px：顶栏还有标题/上下文/导出，给标题留空间。
        // 必须同时截断，否则内容会溢出按钮盒（原先后缀 span 是 shrink-0 且无 truncate，
        // 320px 下会把箭头挤出视口 15px）。
        className="press hover-lift flex h-8 max-w-[120px] sm:max-w-[200px] md:max-w-[240px] items-center gap-1.5 overflow-hidden rounded-full border border-rule/80 bg-panel px-2.5 text-xs text-ink-2 shadow-1 transition-all hover:bg-hover hover:text-ink-1 hover:border-accent/40"
      >
        {compareCount > 1 ? (
          <>
            <Columns3 size={13} className="shrink-0 text-accent" />
            <span className="truncate font-medium text-accent">对比 {compareCount} 个模型</span>
          </>
        ) : (
          <>
            <span className="truncate">{currentProvider?.name ?? '选择模型'}</span>
            {settings.model && (
              // 窄屏隐藏模型名后缀：提供商名已截断，再挤一个不可收缩的长串必然溢出
              <span className="hidden shrink-0 text-ink-3 sm:inline">· {settings.model}</span>
            )}
          </>
        )}
        <ChevronDown
          size={13}
          className={`shrink-0 text-ink-3 transition-transform duration-200 ease-out ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      <MenuPanel
        open={open}
        position={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-10 z-40 w-[min(24rem,calc(100vw-2rem))]`}
        origin={align === 'right' ? 'top-right' : 'top-left'}
        label="模型选择"
      >
        <div className="flex items-center gap-2 border-b border-rule p-2">
          <div className="relative flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型"
              aria-label="搜索模型"
              className={SEARCH_FIELD}
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-b border-rule px-3 py-2">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
            <Columns3 size={12} />
            多模型对比
          </span>
          <Switch
            size="sm"
            label="多模型对比"
            checked={settings.compareEnabled}
            onChange={(v) => updateSettings({ compareEnabled: v })}
          />
        </div>

        <div className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            // 空状态：补图标，与站内其它空态保持一致
            <div className={EMPTY_HINT}>
              <Search size={18} className="mx-auto mb-1.5 text-ink-3" aria-hidden />
              没有匹配的模型
            </div>
          ) : (
            filtered.map((p) => (
              <div key={p.id} className="mb-1">
                <MenuLabel>{p.name}</MenuLabel>
                {p.models.map((m) => {
                  const key = modelKey(p.id, m)
                  const meta = catalogMap.get(key) || catalogMap.get(m)
                  const ctx = formatContext(meta?.contextWindow)
                  const selected = settings.compareEnabled
                    ? settings.compareModels.includes(key)
                    : settings.provider === p.id && settings.model === m
                  return (
                    <MenuItem
                      key={m}
                      className="rounded-lg py-1.5 hover:translate-x-0.5 transition-transform"
                      icon={
                        <span
                          aria-hidden
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-ui ${
                            settings.compareEnabled ? 'border border-rule-strong' : ''
                          } ${selected ? 'bg-accent text-on-accent' : ''}`}
                        >
                          {selected && <Check size={11} />}
                        </span>
                      }
                      onClick={() => {
                        if (settings.compareEnabled) {
                          toggleCompareModel(key)
                        } else {
                          updateSettings({ provider: p.id, model: m })
                          showToast(`已选择模型：${m}`, 'info')
                          setOpen(false)
                        }
                      }}
                    >
                      <div className="flex min-w-0 flex-1 items-center justify-between gap-1.5">
                        <span className={`truncate ${selected ? 'font-medium text-ink-1' : ''}`}>{m}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          {meta?.capabilities?.reasoning && (
                            <span
                              className="flex items-center gap-0.5 rounded bg-purple-500/10 px-1 py-0.5 text-[9px] font-medium text-purple-600 dark:text-purple-400"
                              title="深度思考/推理"
                            >
                              <Sparkles size={9} />
                              <span className="hidden sm:inline">推理</span>
                            </span>
                          )}
                          {meta?.capabilities?.vision && (
                            <span
                              className="flex items-center gap-0.5 rounded bg-blue-500/10 px-1 py-0.5 text-[9px] font-medium text-blue-600 dark:text-blue-400"
                              title="多模态视觉理解"
                            >
                              <Eye size={9} />
                              <span className="hidden sm:inline">视觉</span>
                            </span>
                          )}
                          {meta?.capabilities?.tools && (
                            <span
                              className="flex items-center gap-0.5 rounded bg-amber-500/10 px-1 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400"
                              title="工具调用"
                            >
                              <Wrench size={9} />
                            </span>
                          )}
                          {ctx && (
                            <span className="rounded border border-rule/50 bg-canvas/80 px-1 py-0.5 font-mono text-[9px] text-ink-3">
                              {ctx}
                            </span>
                          )}
                        </div>
                      </div>
                    </MenuItem>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </MenuPanel>
    </div>
  )
}
