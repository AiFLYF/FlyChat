import { useEffect, useState } from 'react'
import { Check, Sliders, Sparkles, X, Globe, Cpu, Wrench } from 'lucide-react'
import { usePresetStore } from '../../store/preset'
import { useKnowledgeStore } from '../../store/knowledge'
import { useChatStore } from '../../store/chat'
import { BUTTON_PRIMARY, FIELD, ICON_BTN_SM } from '../../lib/ui'
import type { Preset } from '../../types'

export default function PresetModal() {
  const modalOpen = usePresetStore((s) => s.modalOpen)
  const setModalOpen = usePresetStore((s) => s.setModalOpen)
  const editingPreset = usePresetStore((s) => s.editingPreset)
  const savePreset = usePresetStore((s) => s.savePreset)

  const workspaces = useKnowledgeStore((s) => s.workspaces)
  const currentSettings = useChatStore((s) => s.settings)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('🤖')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(4096)
  const [webSearch, setWebSearch] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [agent, setAgent] = useState(true)
  const [workspaceId, setWorkspaceId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (editingPreset) {
      setName(editingPreset.name || '')
      setDescription(editingPreset.description || '')
      setIcon(editingPreset.icon || '🤖')
      setProvider(editingPreset.provider || '')
      setModel(editingPreset.model || '')
      setSystemPrompt(editingPreset.systemPrompt || '')
      setTemperature(editingPreset.params?.temperature ?? 0.7)
      setMaxTokens(editingPreset.params?.maxTokens ?? 4096)
      setWebSearch(!!editingPreset.params?.webSearch)
      setThinking(!!editingPreset.params?.think)
      setAgent(editingPreset.params?.agent !== false)
      setWorkspaceId(editingPreset.workspaceId || '')
    } else {
      // 默认基于当前设置填入
      setName('')
      setDescription('')
      setIcon('💡')
      setProvider(currentSettings.provider || '')
      setModel(currentSettings.model || '')
      setSystemPrompt(currentSettings.systemPrompt || '')
      setTemperature(currentSettings.temperature ?? 0.7)
      setMaxTokens(currentSettings.maxTokens ?? 4096)
      setWebSearch(currentSettings.webSearch)
      setThinking(currentSettings.thinking)
      setAgent(true)
      setWorkspaceId('')
    }
  }, [editingPreset, currentSettings, modalOpen])

  if (!modalOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError('请输入预设名称')
      return
    }

    setSubmitting(true)
    try {
      await savePreset({
        id: editingPreset?.id,
        name: name.trim(),
        description: description.trim() || undefined,
        icon: icon.trim() || '🤖',
        provider: provider.trim() || undefined,
        model: model.trim() || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        workspaceId: workspaceId || undefined,
        params: {
          temperature,
          maxTokens,
          webSearch,
          think: thinking,
          agent,
          tools: agent ? true : undefined,
        },
      })
    } catch (err: any) {
      setError(err.message || '保存预设失败')
    } finally {
      setSubmitting(false)
    }
  }

  const QUICK_ICONS = ['🤖', '⌨️', '✍️', '🎨', '💼', '🔬', '💡', '🔍', '📊', '🛡️']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm anim-fade-in">
      <div className="relative flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl border border-rule bg-panel shadow-3 anim-modal-rise overflow-hidden">
        {/* 标题 */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-rule px-5">
          <div className="flex items-center gap-2">
            <Sliders className="text-accent" size={18} />
            <h2 className="text-base font-semibold text-ink-1">
              {editingPreset ? '编辑预设 (Preset)' : '新建配置预设 (Preset)'}
            </h2>
          </div>
          <button onClick={() => setModalOpen(false)} className={ICON_BTN_SM} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}

          {/* 基础信息 */}
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-3">
              <label className="mb-1 block text-xs font-medium text-ink-2">图标 Emoji</label>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  maxLength={4}
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  className={`${FIELD} text-center text-lg`}
                />
              </div>
            </div>
            <div className="col-span-9">
              <label className="mb-1 block text-xs font-medium text-ink-2">预设名称 *</label>
              <input
                required
                type="text"
                placeholder="例如：全栈工程师 / 法律文档审查"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={FIELD}
              />
            </div>
          </div>

          {/* 快捷 Emoji */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-ink-4">推荐图标:</span>
            {QUICK_ICONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => setIcon(emoji)}
                className="h-6 w-6 rounded hover:bg-hover transition-colors text-xs flex items-center justify-center"
              >
                {emoji}
              </button>
            ))}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">简要描述</label>
            <input
              type="text"
              placeholder="专注编写健壮可读的现代代码..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={FIELD}
            />
          </div>

          {/* 系统提示词 */}
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-2">系统提示词 (System Prompt)</label>
            <textarea
              rows={4}
              placeholder="你是一个专业的 AI 助手，在回答时保持条理清晰..."
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className={`${FIELD} resize-none font-mono text-xs leading-relaxed`}
            />
          </div>

          {/* 模型与工作区绑定 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-2">指定模型 (可选)</label>
              <input
                type="text"
                placeholder="如 deepseek-chat 或 gpt-4o"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={FIELD}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-2">绑定知识库工作区</label>
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className={FIELD}
              >
                <option value="">不绑定特定知识库</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.docCount} 文档)
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 采样参数与开关 */}
          <div className="rounded-xl border border-rule bg-hover-soft p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-1">模型推理与能力开关</span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-rule bg-panel px-2.5 py-2 text-xs hover:border-accent transition-colors">
                <input
                  type="checkbox"
                  checked={agent}
                  onChange={(e) => setAgent(e.target.checked)}
                  className="rounded text-accent"
                />
                <Wrench size={13} className="text-accent" />
                <span>Agent 工具</span>
              </label>

              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-rule bg-panel px-2.5 py-2 text-xs hover:border-accent transition-colors">
                <input
                  type="checkbox"
                  checked={webSearch}
                  onChange={(e) => setWebSearch(e.target.checked)}
                  className="rounded text-accent"
                />
                <Globe size={13} className="text-sky-500" />
                <span>联网搜索</span>
              </label>

              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-rule bg-panel px-2.5 py-2 text-xs hover:border-accent transition-colors">
                <input
                  type="checkbox"
                  checked={thinking}
                  onChange={(e) => setThinking(e.target.checked)}
                  className="rounded text-accent"
                />
                <Cpu size={13} className="text-purple-500" />
                <span>深度思考</span>
              </label>
            </div>

            {/* 温度滑块 */}
            <div>
              <div className="flex justify-between text-xs text-ink-2 mb-1">
                <span>采样温度 (Temperature): {temperature}</span>
                <span className="text-ink-4">
                  {temperature <= 0.3 ? '严谨精准' : temperature <= 0.8 ? '均衡适中' : '发散创意'}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                className="w-full accent-accent"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="rounded-lg px-4 py-2 text-xs text-ink-2 hover:bg-hover"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={submitting}
              className={`${BUTTON_PRIMARY} px-5 py-2 text-xs`}
            >
              {submitting ? '保存中...' : '保存预设'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
