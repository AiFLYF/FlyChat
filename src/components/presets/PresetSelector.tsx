import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Copy,
  Plus,
  Sliders,
  Trash2,
} from 'lucide-react'
import { usePresetStore } from '../../store/preset'
import { useDismiss } from '../../lib/useDismiss'
import { ICON_BTN_SM } from '../../lib/ui'
import { showToast } from '../ui/Toast'

interface PresetSelectorProps {
  placement?: 'top' | 'bottom'
}

export default function PresetSelector({ placement = 'top' }: PresetSelectorProps) {
  const presets = usePresetStore((s) => s.presets)
  const activePresetId = usePresetStore((s) => s.activePresetId)
  const setActivePresetId = usePresetStore((s) => s.setActivePresetId)
  const setModalOpen = usePresetStore((s) => s.setModalOpen)
  const fetchPresets = usePresetStore((s) => s.fetchPresets)
  const deletePreset = usePresetStore((s) => s.deletePreset)
  const duplicatePreset = usePresetStore((s) => s.duplicatePreset)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useDismiss(ref, () => setOpen(false), open)

  useEffect(() => {
    fetchPresets()
  }, [])

  const activePreset = presets.find((p) => p.id === activePresetId)

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="press hover-lift flex items-center gap-1.5 rounded-lg border border-rule/70 bg-panel px-2.5 py-1 text-xs text-ink-2 shadow-sm hover:border-accent/40 hover:bg-hover hover:text-ink-1 transition-all"
        aria-label="选择预设"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {activePreset ? (
          <>
            <span className="text-sm leading-none">{activePreset.icon || '🤖'}</span>
            <span className="font-medium text-ink-1 truncate max-w-[120px]">
              {activePreset.name}
            </span>
          </>
        ) : (
          <>
            <Sliders size={13} className="text-ink-3" />
            <span className="text-ink-3">预设</span>
          </>
        )}
        <ChevronDown
          size={12}
          className={`text-ink-4 transition-transform duration-200 ease-out ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="预设配置中心"
          className={`absolute left-0 z-40 w-64 rounded-xl border border-rule bg-panel p-1.5 shadow-3 anim-fade-up ${
            placement === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
          }`}
        >
          <div className="flex items-center justify-between px-2 py-1 border-b border-rule/60 mb-1">
            <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">
              预设配置中心
            </span>
            <button
              onClick={() => {
                setOpen(false)
                setModalOpen(true, null)
              }}
              className="press flex items-center gap-1 text-[11px] text-accent hover:underline"
            >
              <Plus size={12} />
              新建
            </button>
          </div>

          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {/* 默认普通对话选项 */}
            <div
              onClick={() => {
                setActivePresetId(null)
                showToast('已切换至默认对话模式', 'info')
                setOpen(false)
              }}
              className={`flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                !activePresetId ? 'bg-accent/10 font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:translate-x-0.5'
              }`}
            >
              <div className="flex items-center gap-2">
                <span>💬</span>
                <span>默认模式 (无预设)</span>
              </div>
            </div>

            {presets.map((preset) => {
              const isActive = preset.id === activePresetId
              return (
                <div
                  key={preset.id}
                  className={`group flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-all ${
                    isActive ? 'bg-accent/10 font-medium text-accent' : 'text-ink-2 hover:bg-hover hover:translate-x-0.5'
                  }`}
                  onClick={() => {
                    setActivePresetId(preset.id)
                    showToast(`已激活预设：${preset.name}`, 'info')
                    setOpen(false)
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-sm shrink-0">{preset.icon || '🤖'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate font-medium">{preset.name}</p>
                        {preset.params?.vision && (
                          <span className="rounded bg-emerald-500/15 px-1 py-0.2 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
                            识图
                          </span>
                        )}
                        {preset.params?.think && (
                          <span className="rounded bg-purple-500/15 px-1 py-0.2 text-[9px] font-medium text-purple-600 dark:text-purple-400">
                            思考
                          </span>
                        )}
                      </div>
                      {preset.description && (
                        <p className="text-[10px] text-ink-4 truncate">{preset.description}</p>
                      )}
                    </div>
                  </div>

                  <div className="hidden group-hover:flex items-center gap-1 shrink-0 ml-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        duplicatePreset(preset.id)
                        showToast('已克隆预设', 'success')
                      }}
                      className={ICON_BTN_SM}
                      title="克隆预设"
                    >
                      <Copy size={11} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpen(false)
                        setModalOpen(true, preset)
                      }}
                      className={ICON_BTN_SM}
                      title="编辑预设"
                    >
                      <Sliders size={11} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`确定删除预设「${preset.name}」吗？`)) {
                          deletePreset(preset.id)
                          showToast('已删除预设', 'info')
                        }
                      }}
                      className={`${ICON_BTN_SM} hover:text-danger`}
                      title="删除预设"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
