// deslop-ignore-file 04 05 12 21 — 单一强调色；选中态为强调色描边 + 中性底；破坏性操作用红；弹窗单框圆角
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Download, Moon, Monitor, Plus, RotateCcw, Sparkles, Sun, Trash2, Upload } from 'lucide-react'
import { useChatStore } from '../store/chat'
import { useSettingsOpen } from './openPanels'
import { fetchProviders, fetchImageStatus } from '../api/client'
import { downloadJson } from '../lib/download'
import { uid } from '../lib/id'
import { formatBytes } from '../lib/files'
import { FIELD, BUTTON_GHOST, BUTTON_PRIMARY } from '../lib/ui'
import Switch from './ui/Switch'
import Slider from './ui/Slider'
import Spinner from './ui/Spinner'
import Modal from './ui/Modal'
import ProviderManager from './ProviderManager'
import McpSettings from './mcp/McpSettings'
import ApiGatewaySettings from './ApiGatewaySettings'
import type { Assistant, Conversation, PromptItem, ProviderInfo, ThemeMode, ImageStatus } from '../types'

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: '浅色', icon: <Sun size={13} /> },
  { value: 'dark', label: '深色', icon: <Moon size={13} /> },
  { value: 'system', label: '跟随系统', icon: <Monitor size={13} /> },
]

/** 可直接载入的系统提示词起点；用户仍可在下方自由修改 */
const SYSTEM_PROMPT_PRESETS = [
  {
    id: 'general',
    label: '中文通用助手',
    content: '你是一位严谨、友好且乐于助人的中文 AI 助手。先直接回答问题，再补充必要的解释；信息不足时明确说明，不要编造事实。',
  },
  {
    id: 'coding',
    label: '编程搭档',
    content: '你是一位资深软件工程师。回答技术问题时先理解现有项目约定，再给出可执行、最小必要的修改；指出潜在风险，并在适当时补充测试方式。不要臆造不存在的文件或 API。',
  },
  {
    id: 'writing',
    label: '写作编辑',
    content: '你是一位专业中文编辑。先确认文本的目标读者与用途，保持原意，优先提升结构、准确性与可读性；避免空话套话，不确定的信息用明确标记指出。',
  },
  {
    id: 'translation',
    label: '翻译助手',
    content: '你是一位专业双语译者。忠实保留原文含义、语气、格式与专有名词；译文自然流畅，不增删事实。遇到歧义时简要说明可能的译法。',
  },
]

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <label className="text-[13px] font-medium text-ink-1">{label}</label>
        {hint && <span className="tnum truncate text-xs text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function Section({
  title,
  children,
  delay = 0,
  first,
}: {
  title: string
  children: React.ReactNode
  /** 入场错峰延迟（ms） */
  delay?: number
  /** 第一个分区紧跟在弹窗标题下，不需要顶部分隔线 */
  first?: boolean
}) {
  return (
    <section className="anim-fade-up pt-6" style={{ animationDelay: `${delay}ms` }}>
      {/* 两端淡出的渐变细线：分区依然清晰，但不再是一条贯穿的硬线 */}
      {!first && <div aria-hidden className="hairline mb-6" />}
      <h3 className="mb-3 text-[13px] font-medium text-ink-1">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className={`text-[13px] ${disabled ? 'text-ink-3' : 'text-ink-1'}`}>{label}</p>
        {hint && <p className="mt-0.5 text-[11px] leading-4 text-ink-3">{hint}</p>}
      </div>
      {/* 与顶栏共用一个 Switch，尺寸/弹性/无障碍属性只维护一份 */}
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  )
}

/**
 * 校验导入的备份 JSON，过滤掉结构不合法的条目。
 * 之前只判断顶层是不是数组就直接合并，坏备份会污染持久化状态并导致组件渲染异常。
 */
function validateBackup(data: unknown): {
  conversations: Conversation[]
  prompts: PromptItem[]
  assistants: Assistant[]
  skipped: number
} {
  const result = {
    conversations: [] as Conversation[],
    prompts: [] as PromptItem[],
    assistants: [] as Assistant[],
    skipped: 0,
  }
  if (!data || typeof data !== 'object') return result
  const raw = data as Record<string, unknown>

  // 兼容「单条对话」格式：{ id, messages:[...] }
  let convInput: unknown = raw.conversations
  if (!Array.isArray(convInput) && raw.id && Array.isArray(raw.messages)) convInput = [raw]

  if (Array.isArray(convInput)) {
    for (const item of convInput) {
      if (!item || typeof item !== 'object') {
        result.skipped++
        continue
      }
      const c = item as Record<string, unknown>
      const messages = Array.isArray(c.messages) ? c.messages.filter(isValidMessage) : []
      const id = typeof c.id === 'string' ? c.id : ''
      if (!id) {
        result.skipped++
        continue
      }
      result.conversations.push({
        id,
        title: typeof c.title === 'string' && c.title ? c.title : '导入的对话',
        messages,
        createdAt: numOr(c.createdAt, Date.now()),
        updatedAt: numOr(c.updatedAt, Date.now()),
        usingContext: typeof c.usingContext === 'boolean' ? c.usingContext : true,
        pinned: !!c.pinned,
        assistantId: typeof c.assistantId === 'string' ? c.assistantId : undefined,
        sortIndex: typeof c.sortIndex === 'number' ? c.sortIndex : undefined,
      })
    }
  }

  if (Array.isArray(raw.prompts)) {
    for (const p of raw.prompts) {
      if (!p || typeof p !== 'object') {
        result.skipped++
        continue
      }
      const x = p as Record<string, unknown>
      if (typeof x.id === 'string' && typeof x.title === 'string' && typeof x.content === 'string') {
        result.prompts.push({
          id: x.id,
          title: x.title,
          content: x.content,
          createdAt: numOr(x.createdAt, Date.now()),
        })
      } else {
        result.skipped++
      }
    }
  }

  if (Array.isArray(raw.assistants)) {
    for (const a of raw.assistants) {
      if (!a || typeof a !== 'object') {
        result.skipped++
        continue
      }
      const x = a as Record<string, unknown>
      if (typeof x.id === 'string' && typeof x.name === 'string') {
        result.assistants.push({
          id: x.id,
          name: x.name,
          emoji: typeof x.emoji === 'string' ? x.emoji : '🤖',
          systemPrompt: typeof x.systemPrompt === 'string' ? x.systemPrompt : '',
          provider: typeof x.provider === 'string' ? x.provider : '',
          model: typeof x.model === 'string' ? x.model : '',
          temperature: typeof x.temperature === 'number' ? x.temperature : undefined,
        })
      } else {
        result.skipped++
      }
    }
  }

  return result
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function isValidMessage(m: unknown): m is Conversation['messages'][number] {
  if (!m || typeof m !== 'object') return false
  const x = m as Record<string, unknown>
  return (
    (x.role === 'user' || x.role === 'assistant' || x.role === 'system') &&
    typeof x.content === 'string'
  )
}

export default function SettingsModal() {
  const open = useSettingsOpen((s) => s.open)
  const setOpen = useSettingsOpen((s) => s.setOpen)
  const settings = useChatStore((s) => s.settings)
  const updateSettings = useChatStore((s) => s.updateSettings)
  const clearAll = useChatStore((s) => s.clearAll)
  const prompts = useChatStore((s) => s.prompts)
  const addPrompt = useChatStore((s) => s.addPrompt)
  const updatePrompt = useChatStore((s) => s.updatePrompt)
  const removePrompt = useChatStore((s) => s.removePrompt)
  const assistants = useChatStore((s) => s.assistants)
  const addAssistant = useChatStore((s) => s.addAssistant)
  const updateAssistant = useChatStore((s) => s.updateAssistant)
  const removeAssistant = useChatStore((s) => s.removeAssistant)
  const importConversations = useChatStore((s) => s.importConversations)

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [webSearchAvailable, setWebSearchAvailable] = useState(false)
  const [imageStatus, setImageStatus] = useState<ImageStatus | null>(null)
  const [customModel, setCustomModel] = useState('')
  const [promptPreset, setPromptPreset] = useState('')
  const [newPromptTitle, setNewPromptTitle] = useState('')
  const [newPromptContent, setNewPromptContent] = useState('')
  const [notice, setNotice] = useState('')
  const importRef = useRef<HTMLInputElement>(null)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [tab, setTab] = useState<'general' | 'providers' | 'mcp' | 'api' | 'prompts' | 'data'>('general')

  /**
   * 拉取服务商列表与图像模型状态。抽成独立函数是因为「模型服务」面板增删改之后要重新拉取，
   * 并且必须处理「当前选中的服务商被删掉」的情况——否则聊天会一直报未配置。
   */
  const loadProviders = useCallback(async () => {
    const { providers: list, webSearch } = await fetchProviders()
    setProviders(list)
    setWebSearchAvailable(webSearch)
    void fetchImageStatus().then(setImageStatus).catch(() => {})
    if (list.length === 0) return
    const current = useChatStore.getState().settings
    if (!list.some((p) => p.id === current.provider)) {
      useChatStore
        .getState()
        .updateSettings({ provider: list[0].id, model: list[0].models[0] ?? '' })
    }
  }, [])

  /** 重试拉取服务商列表（服务端不可达时供「模型服务」面板单独重试，不阻塞其它本地设置） */
  const reload = useCallback(() => {
    setLoading(true)
    setError('')
    loadProviders()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [loadProviders])

  useEffect(() => {
    if (!open) return
    reload()
  }, [open, reload])

  useEffect(() => setCustomModel(''), [settings.provider])

  // 存储占用提示：让用户知道本地数据体量，接近上限时给出清理建议
  useEffect(() => {
    if (!open || !navigator.storage?.estimate) return
    navigator.storage
      .estimate()
      .then((e) => {
        if (typeof e.usage === 'number' && typeof e.quota === 'number') {
          setStorage({ usage: e.usage, quota: e.quota })
        }
      })
      .catch(() => {})
  }, [open])

  const currentProvider = providers.find((p) => p.id === settings.provider)
  const themeIndex = Math.max(0, THEME_OPTIONS.findIndex((o) => o.value === settings.theme))

  const handleExport = () => {
    const state = useChatStore.getState()
    downloadJson(`flychat-backup-${new Date().toISOString().slice(0, 10)}.json`, {
      app: 'FlyChat',
      version: 1,
      exportedAt: Date.now(),
      conversations: state.conversations,
      prompts: state.prompts,
      assistants: state.assistants,
      settings: state.settings,
    })
  }

  const handleImport = async (file: File) => {
    setNotice('')
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const { conversations, prompts, assistants, skipped } = validateBackup(data)
      if (!conversations.length && !prompts.length && !assistants.length) {
        setNotice('导入失败：文件不是有效的 FlyChat 备份')
        return
      }
      if (conversations.length) importConversations(conversations)
      prompts.forEach((p) => addPrompt(p))
      assistants.forEach((a) => addAssistant(a))
      setNotice(
        skipped > 0
          ? `导入完成：有 ${skipped} 项因格式不正确被跳过`
          : '导入成功'
      )
    } catch (e) {
      setNotice(`导入失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const addAssistantDraft = () =>
    addAssistant({
      id: uid(),
      name: '新助手',
      emoji: '🤖',
      systemPrompt: '',
      provider: settings.provider,
      model: settings.model,
    })

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="设置" className="max-w-2xl">
      <div className="flex border-b border-rule/70 -mt-2 mb-4 overflow-x-auto text-xs font-medium gap-1 scrollbar-none">
        {[
          { id: 'general', label: '常规与模型' },
          { id: 'providers', label: '模型服务' },
          { id: 'mcp', label: 'MCP 扩展' },
          { id: 'api', label: 'API 网关' },
          { id: 'prompts', label: '提示词与助手' },
          { id: 'data', label: '数据与备份' },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id as any)}
            className={`press px-3.5 py-2 border-b-2 text-xs sm:text-[13px] font-medium transition-all duration-150 whitespace-nowrap rounded-t-md ${
              tab === t.id
                ? 'border-accent text-accent bg-accent-soft/40 font-semibold'
                : 'border-transparent text-ink-3 hover:text-ink-1 hover:bg-hover/50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div key={tab} className="anim-fade-in space-y-5">
        {tab === 'general' && (
          <>
            {/* 本地生成参数始终可用；模型提供商/模型选择依赖后端，下方独立处理加载与错误，不再阻塞其它本地设置 */}
            <Section title="模型与参数" first delay={80}>
            {/* 模型提供商：依赖后端，独立处理加载/错误/未配置，并提供重试入口 */}
            <Field label="模型提供商">
              {loading ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-ink-2" role="status">
                  <Spinner size={16} />
                  正在获取可用模型…
                </div>
              ) : error ? (
                <div role="alert" className="r-md border border-rule bg-panel px-4 py-3 text-sm leading-6 text-ink-2">
                  <b className="text-danger">无法加载模型服务</b>
                  <span> — {error}</span>
                  <button onClick={reload} className={`${BUTTON_GHOST} mt-2 py-1`}>重试</button>
                </div>
              ) : providers.length === 0 ? (
                <div className="r-md border border-rule bg-panel px-4 py-3 text-sm leading-6 text-ink-2">
                  <b className="text-ink-1">未配置</b>
                  <span>
                    {' '}
                    — 还没有可用的服务商。可以到下方「模型服务」里添加一个自定义服务商，
                    也可以把 <code className="text-ink-1">server/.env.example</code>{' '}
                    复制为 <code className="text-ink-1">server/.env</code> 填入 Key 后重启后端。
                  </span>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {providers.map((p) => {
                    const on = settings.provider === p.id
                    return (
                      <button
                        key={p.id}
                        onClick={() => updateSettings({ provider: p.id, model: p.models[0] ?? '' })}
                        className={`r-sm border px-3 py-2 text-left text-[13px] transition-ui press hover-lift ${
                          on
                            ? 'border-accent bg-accent-soft font-medium text-accent'
                            : 'border-rule text-ink-2 hover:bg-hover hover:text-ink-1'
                        }`}
                      >
                        {p.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </Field>

              {currentProvider && (
                // hint 不再重复「当前：模型名」（下方选中态已经表达），改为模型数量
                <Field label="模型" hint={`${currentProvider.models.length} 个模型`}>
                  <div className="flex flex-wrap gap-1.5">
                    {currentProvider.models.map((m) => {
                      const on = settings.model === m
                      return (
                        <button
                          key={m}
                          onClick={() => updateSettings({ model: m })}
                          className={`r-sm max-w-full truncate border px-2.5 py-1.5 text-xs transition-ui press ${
                            on
                              ? 'border-accent bg-accent-soft font-medium text-accent'
                              : 'border-rule text-ink-2 hover:bg-hover hover:text-ink-1'
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
                      aria-label="自定义模型名称"
                      className={FIELD}
                    />
                    {customModel.trim() && (
                      <button
                        onClick={() => {
                          updateSettings({ model: customModel.trim() })
                          setCustomModel('')
                        }}
                        className={BUTTON_PRIMARY}
                      >
                        使用
                      </button>
                    )}
                  </div>
                </Field>
              )}

              <Field label="随机性 (temperature)" hint={String(settings.temperature)}>
                <Slider
                  label="随机性"
                  min={0}
                  max={2}
                  step={0.1}
                  value={settings.temperature}
                  onChange={(v) => updateSettings({ temperature: v })}
                />
              </Field>

              {/* 窄屏单列：两个滑块 + 数字框并排会互相挤压 */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="top_p" hint={String(settings.topP)}>
                  <Slider
                    label="top_p"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.topP}
                    onChange={(v) => updateSettings({ topP: v })}
                  />
                </Field>
                <Field label="最大输出 tokens">
                  <input
                    type="number"
                    min={256}
                    max={128000}
                    step={256}
                    value={settings.maxTokens}
                    aria-label="最大输出 tokens"
                    onChange={(e) => updateSettings({ maxTokens: Number(e.target.value) || 4096 })}
                    className={FIELD}
                  />
                </Field>
              </div>
            </Section>

            <Section title="快捷开关" delay={120}>
              <div className="space-y-2">
                <ToggleRow
                  label="智能体工具调用 (Agent / MCP)"
                  hint="允许模型自主调用已启用的 MCP 扩展工具与外部能力"
                  checked={settings.tools !== false}
                  onChange={(v) => updateSettings({ tools: v })}
                />
                <ToggleRow
                  label="深度思考"
                  hint="让模型先推理再作答"
                  checked={settings.thinking}
                  onChange={(v) => updateSettings({ thinking: v })}
                />
                <ToggleRow
                  label="联网搜索"
                  hint={webSearchAvailable ? '回答附带引用来源' : '需在服务端配置 TAVILY_API_KEY'}
                  checked={settings.webSearch}
                  disabled={!webSearchAvailable}
                  onChange={(v) => updateSettings({ webSearch: v })}
                />
                <ToggleRow
                  label="默认携带上下文"
                  hint="新会话默认携带历史消息"
                  checked={settings.usingContext}
                  onChange={(v) => updateSettings({ usingContext: v })}
                />
                <ToggleRow
                  label="AI 图像生成"
                  hint={
                    imageStatus?.available
                      ? `已就绪 (${imageStatus.providerName || imageStatus.provider || '图像服务'}${imageStatus.model ? ' · ' + imageStatus.model : ''})`
                      : imageStatus?.reason || '尚未配置可用图像模型（请在模型服务中配置或检查服务端）'
                  }
                  checked={imageStatus?.available ? !!settings.imageGeneration : false}
                  disabled={!imageStatus?.available}
                  onChange={(v) => updateSettings({ imageGeneration: v })}
                />
              </div>
            </Section>

            <Section title="界面主题" delay={160}>
              <div className="relative inline-grid grid-cols-3 rounded-lg border border-rule p-0.5">
                <span
                  aria-hidden
                  className="absolute inset-y-0.5 left-0.5 w-[calc((100%-0.25rem)/3)] rounded-md bg-accent shadow-1 transition-transform duration-200 ease-[var(--ease-spring)]"
                  style={{ transform: `translateX(${themeIndex * 100}%)` }}
                />
                {THEME_OPTIONS.map((opt) => {
                  const on = settings.theme === opt.value
                  return (
                    <button
                      key={opt.value}
                      onClick={() => updateSettings({ theme: opt.value })}
                      aria-pressed={on}
                      className={`relative z-10 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors duration-200 ease-out ${
                        on ? 'text-on-accent' : 'text-ink-2 hover:text-ink-1'
                      }`}
                    >
                      {opt.icon}
                      {opt.label}
                    </button>
                  )
                })}
              </div>
            </Section>
          </>
        )}

        {tab === 'providers' && (
          <Section title="模型服务" first delay={80}>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-ink-2" role="status">
                <Spinner size={16} />
                正在获取可用模型…
              </div>
            ) : error ? (
              <div role="alert" className="r-md border border-rule bg-panel px-4 py-3 text-sm leading-6 text-ink-2">
                <b className="text-danger">无法加载模型服务</b>
                <span> — {error}</span>
                <button onClick={reload} className={`${BUTTON_GHOST} mt-2 py-1`}>重试</button>
              </div>
            ) : (
              <ProviderManager providers={providers} onRefresh={loadProviders} />
            )}
          </Section>
        )}

        {tab === 'mcp' && (
          <div className="anim-fade-up">
            <McpSettings />
          </div>
        )}

        {tab === 'api' && (
          <div className="anim-fade-up">
            <ApiGatewaySettings />
          </div>
        )}

        {tab === 'prompts' && (
          <>
            {/* 系统提示词独立成区 */}
            <Section title="系统提示词" first delay={80}>
              <div className="r-lg bg-panel p-3 shadow-1 ring-1 ring-rule">
                <div className="mb-3 flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Sparkles size={15} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[13px] font-medium text-ink-1">全局默认指令</p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] ${
                          settings.systemPrompt.trim()
                            ? 'bg-accent-soft text-accent'
                            : 'bg-hover text-ink-3'
                        }`}
                      >
                        {settings.systemPrompt.trim() ? '已启用' : '未设置'}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-ink-3">
                      每次请求都会作为 system 指令发送；留空则使用模型默认行为。助手专属指令优先于此设置。
                    </p>
                  </div>
                </div>

                <label htmlFor="global-system-prompt" className="sr-only">
                  全局系统提示词
                </label>
                <textarea
                  id="global-system-prompt"
                  value={settings.systemPrompt}
                  onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
                  rows={7}
                  placeholder={'例如：你是一个严谨、友好的中文助手。\n先直接回答问题；信息不足时明确说明，不要编造事实。'}
                  aria-label="全局系统提示词"
                  aria-describedby="system-prompt-help system-prompt-count"
                  className={`${FIELD} min-h-36 resize-y leading-6`}
                />

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p id="system-prompt-help" className="text-[11px] leading-4 text-ink-3">
                    自动保存到当前浏览器的本地数据
                  </p>
                  <div className="flex items-center gap-2">
                    <span id="system-prompt-count" className="tnum text-[11px] text-ink-3">
                      {settings.systemPrompt.length.toLocaleString('zh-CN')} 字符
                    </span>
                    {settings.systemPrompt && (
                      <button
                        type="button"
                        onClick={() => updateSettings({ systemPrompt: '' })}
                        className="press inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink-3 transition-ui hover:bg-hover hover:text-ink-1"
                      >
                        <RotateCcw size={11} />
                        清空
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-2 border-t border-rule pt-3 sm:flex-row">
                  <select
                    value={promptPreset}
                    onChange={(e) => setPromptPreset(e.target.value)}
                    aria-label="选择系统提示词模板"
                    className={`${FIELD} min-w-0 flex-1`}
                  >
                    <option value="">选择一个起步模板…</option>
                    {SYSTEM_PROMPT_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!promptPreset}
                    onClick={() => {
                      const preset = SYSTEM_PROMPT_PRESETS.find((item) => item.id === promptPreset)
                      if (!preset) return
                      if (
                        settings.systemPrompt.trim() &&
                        !confirm('载入模板会替换当前系统提示词，是否继续？')
                      ) {
                        return
                      }
                      updateSettings({ systemPrompt: preset.content })
                    }}
                    className={`${BUTTON_GHOST} justify-center whitespace-nowrap`}
                  >
                    <Sparkles size={13} />
                    载入模板
                  </button>
                </div>
              </div>
            </Section>

            <Section title="提示词库" delay={120}>
              <div className="space-y-2">
                {prompts.length === 0 && (
                  <p className="text-xs text-ink-3">还没有提示词，可在下方添加。</p>
                )}
                {prompts.map((p) => (
                  <div key={p.id} className="r-sm border border-rule bg-panel p-2.5">
                    <div className="flex items-center gap-2">
                      <input
                        value={p.title}
                        onChange={(e) => updatePrompt(p.id, { title: e.target.value })}
                        aria-label="提示词标题"
                        className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink-1 outline-none"
                      />
                      <button
                        onClick={() => removePrompt(p.id)}
                        className="r-sm p-1 text-ink-3 transition-ui press hover:text-danger"
                        aria-label="删除提示词"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <textarea
                      value={p.content}
                      onChange={(e) => updatePrompt(p.id, { content: e.target.value })}
                      rows={2}
                      aria-label="提示词内容"
                      className="mt-1 w-full resize-y bg-transparent text-xs leading-5 text-ink-2 outline-none"
                    />
                  </div>
                ))}
                <div className="r-sm border border-rule p-2.5">
                  <input
                    value={newPromptTitle}
                    onChange={(e) => setNewPromptTitle(e.target.value)}
                    placeholder="标题，例如：代码审查"
                    aria-label="新提示词标题"
                    className="w-full bg-transparent text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
                  />
                  <textarea
                    value={newPromptContent}
                    onChange={(e) => setNewPromptContent(e.target.value)}
                    rows={2}
                    placeholder="提示词内容…"
                    aria-label="新提示词内容"
                    className="mt-1 w-full resize-y bg-transparent text-xs leading-5 text-ink-2 outline-none placeholder:text-ink-3"
                  />
                  <button
                    onClick={() => {
                      if (!newPromptTitle.trim() || !newPromptContent.trim()) return
                      addPrompt({
                        id: uid(),
                        title: newPromptTitle.trim(),
                        content: newPromptContent.trim(),
                        createdAt: Date.now(),
                      })
                      setNewPromptTitle('')
                      setNewPromptContent('')
                    }}
                    className={`${BUTTON_PRIMARY} mt-1.5 py-1 text-xs`}
                    disabled={!newPromptTitle.trim() || !newPromptContent.trim()}
                  >
                    <Plus size={12} />
                    添加提示词
                  </button>
                </div>
              </div>
            </Section>

            <Section title="助手（预设提示词 + 模型）" delay={290}>
              <div className="space-y-2">
                {assistants.map((a) => (
                  <AssistantEditor
                    key={a.id}
                    assistant={a}
                    providers={providers}
                    onChange={(patch) => updateAssistant(a.id, patch)}
                    onRemove={() => removeAssistant(a.id)}
                  />
                ))}
                <button
                  onClick={addAssistantDraft}
                  className={`${BUTTON_GHOST} w-full justify-center py-2`}
                >
                  <Plus size={14} />
                  新建助手
                </button>
              </div>
            </Section>
          </>
        )}

        {tab === 'data' && (
          <Section title="数据与备份" first delay={80}>
            <div className="flex flex-wrap gap-2">
              <button onClick={handleExport} className={BUTTON_GHOST}>
                <Download size={14} />
                导出全部数据
              </button>
              <button onClick={() => importRef.current?.click()} className={BUTTON_GHOST}>
                <Upload size={14} />
                导入数据
              </button>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleImport(f)
                  e.target.value = ''
                }}
              />
            </div>
            {notice && (
              <p role="status" className="text-xs text-ink-2">{notice}</p>
            )}
            {storage && (
              <div className="r-sm border border-rule bg-panel px-3 py-2 text-xs text-ink-2">
                <div className="flex items-center justify-between">
                  <span>本地存储占用</span>
                  <span className="tnum">
                    {formatBytes(storage.usage)}
                    {storage.quota > 0 ? ` / ${formatBytes(storage.quota)}` : ''}
                  </span>
                </div>
                {storage.quota > 0 && (
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover">
                    <div
                      className={`h-full rounded-full ${storage.usage / storage.quota > 0.8 ? 'bg-danger' : 'bg-accent'}`}
                      style={{ width: `${Math.min(100, (storage.usage / storage.quota) * 100)}%` }}
                    />
                  </div>
                )}
                {storage.quota > 0 && storage.usage / storage.quota > 0.8 && (
                  <p className="mt-1.5 text-danger">存储空间接近上限，建议导出重要对话后再清理部分历史。</p>
                )}
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-5 text-ink-3">
                对话记录保存在浏览器本地（IndexedDB）
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
                className="r-sm shrink-0 border border-rule px-3 py-1.5 text-[13px] text-danger transition-ui press hover:bg-hover"
              >
                清空所有对话
              </button>
            </div>
          </Section>
        )}
      </div>
    </Modal>
  )
}

function AssistantEditor({
  assistant,
  providers,
  onChange,
  onRemove,
}: {
  assistant: Assistant
  providers: ProviderInfo[]
  onChange: (patch: Partial<Assistant>) => void
  onRemove: () => void
}) {
  const provider = providers.find((p) => p.id === assistant.provider)
  return (
    <div className="r-sm border border-rule bg-panel p-2.5">
      <div className="flex items-center gap-2">
        <input
          value={assistant.emoji}
          onChange={(e) => onChange({ emoji: e.target.value.slice(0, 2) })}
          className="w-8 shrink-0 bg-transparent text-center text-base outline-none"
          aria-label="助手图标"
        />
        <input
          value={assistant.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink-1 outline-none"
          aria-label="助手名称"
        />
        <Bot size={13} className="shrink-0 text-ink-3" aria-hidden />
        <button
          onClick={onRemove}
          className="r-sm p-1 text-ink-3 transition-ui press hover:text-danger"
          aria-label="删除助手"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <textarea
        value={assistant.systemPrompt}
        onChange={(e) => onChange({ systemPrompt: e.target.value })}
        rows={2}
        placeholder="系统提示词…"
        aria-label="助手系统提示词"
        className="mt-1.5 w-full resize-y bg-transparent text-xs leading-5 text-ink-2 outline-none placeholder:text-ink-3"
      />
      <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
        <select
          value={assistant.provider ?? ''}
          onChange={(e) => {
            const p = providers.find((x) => x.id === e.target.value)
            onChange({ provider: e.target.value, model: p?.models[0] })
          }}
          aria-label="助手提供商"
          className="r-sm min-w-0 flex-1 border border-rule bg-canvas px-2 py-1 text-xs text-ink-2 outline-none"
        >
          <option value="">默认提供商</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={assistant.model ?? ''}
          onChange={(e) => onChange({ model: e.target.value })}
          aria-label="助手模型"
          className="r-sm min-w-0 flex-1 border border-rule bg-canvas px-2 py-1 text-xs text-ink-2 outline-none"
          disabled={!provider}
        >
          <option value="">默认模型</option>
          {provider?.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
