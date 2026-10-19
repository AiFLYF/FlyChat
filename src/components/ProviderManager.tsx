import { useEffect, useState } from 'react'
import { Activity, Check, Pencil, Plus, Server, Trash2, X } from 'lucide-react'
import {
  deleteCustomProvider,
  saveCustomProvider,
  saveProviderModels,
  testProvider,
} from '../api/client'
import { FIELD, BUTTON_GHOST, BUTTON_PRIMARY, ICON_BTN } from '../lib/ui'
import Spinner from './ui/Spinner'
import type { ProviderInfo } from '../types'

const TYPE_OPTIONS = [
  { value: 'openai-compat', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'gemini', label: 'Google Gemini' },
]

export const PROTOCOL_DEFAULTS: Record<
  string,
  { defaultUrl: string; placeholderUrl: string; modelsPlaceholder: string; defaultModels: string }
> = {
  'openai-compat': {
    defaultUrl: '',
    placeholderUrl: 'https://api.openai.com/v1 或国内中转站地址',
    modelsPlaceholder: 'gpt-4o\ngpt-4o-mini\ndeepseek-chat',
    defaultModels: 'gpt-4o-mini\ndeepseek-chat',
  },
  anthropic: {
    defaultUrl: 'https://api.anthropic.com',
    placeholderUrl: 'https://api.anthropic.com 或 Claude 中转代理地址',
    modelsPlaceholder: 'claude-3-5-sonnet-20241022\nclaude-3-5-haiku-20241022\nclaude-3-opus-20240229',
    defaultModels: 'claude-3-5-sonnet-20241022\nclaude-3-5-haiku-20241022',
  },
  gemini: {
    defaultUrl: 'https://generativelanguage.googleapis.com',
    placeholderUrl: 'https://generativelanguage.googleapis.com 或代理地址',
    modelsPlaceholder: 'gemini-1.5-pro\ngemini-1.5-flash\ngemini-2.0-flash-exp',
    defaultModels: 'gemini-1.5-pro\ngemini-1.5-flash',
  },
}

interface FormState {
  id?: string
  name: string
  type: string
  baseUrl: string
  apiKey: string
  models: string
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'openai-compat',
  baseUrl: '',
  apiKey: '',
  models: '',
}

/** 模型列表文本 ⇄ 数组：支持换行、逗号、顿号分隔 */
function parseModels(text: string): string[] {
  return text
    .split(/[\n,，、]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'accent' }) {
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-px text-[10px] leading-4 ${
        tone === 'accent' ? 'bg-accent-soft text-accent' : 'bg-hover text-ink-3'
      }`}
    >
      {children}
    </span>
  )
}

/**
 * 「模型服务」管理面板。
 *
 * 改动原因：此前新增/调整模型只能改 server/.env 再重启后端（例如把网关地址
 * 换成 127.0.0.1:8084、把模型换成 space-bunny-free），门槛高且容易配错。
 * 这里把服务商与模型列表搬到网页上：
 *   - 自定义服务商：完整增删改（名称 / 协议 / Base URL / API Key / 模型列表）
 *   - 任意服务商（含内置）：在线覆盖模型列表，无需重启
 *   - 连通性自检：先验证地址与密钥，再拿去发消息
 * 密钥只在提交时上行、后端只回传 hasKey 布尔值，界面上永远不显示明文。
 */
export default function ProviderManager({
  providers,
  onRefresh,
}: {
  providers: ProviderInfo[]
  /** 变更后重新拉取列表（父级会顺带修正当前选中的服务商/模型） */
  onRefresh: () => Promise<void> | void
}) {
  const [modelsFor, setModelsFor] = useState<string | null>(null)
  const [modelsDraft, setModelsDraft] = useState('')
  const [form, setForm] = useState<FormState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** 每个服务商的自检结果 */
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string } | 'loading'>>({})

  // 切换服务商时收起展开区，避免误操作
  useEffect(() => {
    setModelsFor(null)
    setForm(null)
  }, [providers.length])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSaveForm = () =>
    run(async () => {
      if (!form) return
      await saveCustomProvider({
        id: form.id,
        name: form.name,
        type: form.type,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey || undefined,
        models: parseModels(form.models),
      })
      setForm(null)
      await onRefresh()
    })

  const handleSaveModels = (id: string) =>
    run(async () => {
      await saveProviderModels(id, parseModels(modelsDraft))
      setModelsFor(null)
      await onRefresh()
    })

  const handleDelete = (p: ProviderInfo) =>
    run(async () => {
      if (!confirm(`确定删除服务商「${p.name}」吗？其 API Key 会一并从服务端移除。`)) return
      await deleteCustomProvider(p.id)
      await onRefresh()
    })

  const handleTest = async (p: ProviderInfo) => {
    setTests((t) => ({ ...t, [p.id]: 'loading' }))
    try {
      const result = await testProvider(p.id)
      setTests((t) => ({ ...t, [p.id]: result }))
    } catch (e) {
      setTests((t) => ({
        ...t,
        [p.id]: { ok: false, message: e instanceof Error ? e.message : String(e) },
      }))
    }
  }

  const openEdit = (p: ProviderInfo) => {
    setModelsFor(null)
    setError('')
    setForm({
      id: p.id,
      name: p.name,
      type: p.type ?? 'openai-compat',
      baseUrl: p.baseUrl ?? '',
      apiKey: '',
      models: p.models.join('\n'),
    })
  }

  return (
    <div className="space-y-2">
      {error && (
        <div role="alert" className="anim-fade-down rounded-lg bg-panel px-3 py-2 text-xs leading-5 text-danger ring-1 ring-rule">
          {error}
        </div>
      )}

      {providers.map((p) => {
        const custom = p.source === 'custom'
        const test = tests[p.id]
        return (
          <div
            key={p.id}
            className="r-md overflow-hidden bg-panel transition-shadow duration-200 ease-out ring-1 ring-rule hover:shadow-1"
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-ink-1">{p.name}</span>
                  <Badge tone={custom ? 'accent' : 'neutral'}>
                    {custom ? '网页配置' : '服务端'}
                  </Badge>
                  {!p.hasKey && <Badge>无密钥</Badge>}
                  {p.modelsOverridden && <Badge>模型已覆盖</Badge>}
                </div>
                <p className="mt-0.5 truncate text-[11px] text-ink-3" title={p.baseUrl}>
                  {p.baseUrl || `${p.models.length} 个模型`}
                  {p.baseUrl ? ` · ${p.models.length} 个模型` : ''}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  onClick={() => void handleTest(p)}
                  disabled={test === 'loading'}
                  className={`${ICON_BTN} h-7 gap-1 px-2 text-[11px]`}
                  aria-label={`测试 ${p.name} 连通性`}
                  title="连通性自检"
                >
                  {test === 'loading' ? <Spinner size={13} /> : <Activity size={13} />}
                </button>
                <button
                  onClick={() => {
                    setForm(null)
                    setError('')
                    setModelsFor(modelsFor === p.id ? null : p.id)
                    setModelsDraft(p.models.join('\n'))
                  }}
                  className={`${ICON_BTN} h-7 gap-1 px-2 text-[11px]`}
                  aria-label={`编辑 ${p.name} 的模型列表`}
                  title="编辑模型列表"
                >
                  <Server size={13} />
                </button>
                {custom && (
                  <>
                    <button
                      onClick={() => openEdit(p)}
                      className={`${ICON_BTN} h-7 gap-1 px-2 text-[11px]`}
                      aria-label={`编辑 ${p.name}`}
                      title="编辑服务商"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => void handleDelete(p)}
                      className={`${ICON_BTN} h-7 gap-1 px-2 text-[11px] hover:text-danger`}
                      aria-label={`删除 ${p.name}`}
                      title="删除服务商"
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 自检结果 */}
            {test && test !== 'loading' && (
              <p
                className={`anim-fade-down border-t border-rule px-3 py-2 text-[11px] leading-4 ${
                  test.ok ? 'text-success' : 'text-danger'
                }`}
              >
                {test.message}
              </p>
            )}

            {/* 模型列表编辑 */}
            {modelsFor === p.id && (
              <div className="anim-fade-down border-t border-rule p-2.5">
                <textarea
                  autoFocus
                  value={modelsDraft}
                  onChange={(e) => setModelsDraft(e.target.value)}
                  rows={Math.min(8, Math.max(3, modelsDraft.split('\n').length))}
                  aria-label={`${p.name} 的模型列表`}
                  className={`${FIELD} resize-y font-mono leading-5`}
                />
                <p className="mt-1.5 text-[11px] leading-4 text-ink-3">
                  每行一个模型名，也可用逗号分隔。留空则恢复服务端默认。
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void handleSaveModels(p.id)}
                    disabled={busy}
                    className={`${BUTTON_PRIMARY} py-1 text-xs`}
                  >
                    <Check size={13} />
                    保存模型
                  </button>
                  <button onClick={() => setModelsFor(null)} className={`${BUTTON_GHOST} py-1 text-xs`}>
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* 服务商编辑表单 */}
            {form?.id === p.id && (
              <ProviderForm
                form={form}
                setForm={setForm}
                busy={busy}
                onSave={handleSaveForm}
                onCancel={() => setForm(null)}
                isNew={false}
              />
            )}
          </div>
        )
      })}

      {/* 新增 */}
      {form && !form.id ? (
        <div className="r-md bg-panel ring-1 ring-accent">
          <ProviderForm
            form={form}
            setForm={setForm}
            busy={busy}
            onSave={handleSaveForm}
            onCancel={() => setForm(null)}
            isNew
          />
        </div>
      ) : (
        <button
          onClick={() => {
            setModelsFor(null)
            setError('')
            setForm({ ...EMPTY_FORM })
          }}
          className={`${BUTTON_GHOST} w-full justify-center py-2`}
        >
          <Plus size={14} />
          添加自定义服务商
        </button>
      )}
    </div>
  )
}

/** 服务商表单：新增与编辑共用 */
function ProviderForm({
  form,
  setForm,
  busy,
  onSave,
  onCancel,
  isNew,
}: {
  form: FormState
  setForm: (f: FormState) => void
  busy: boolean
  onSave: () => void
  onCancel: () => void
  isNew: boolean
}) {
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch })
  const valid = form.name.trim() && form.baseUrl.trim() && parseModels(form.models).length > 0

  return (
    <div className="anim-fade-down space-y-3 border-t border-rule p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[11px] font-medium text-ink-2">名称</label>
          <input
            autoFocus={isNew}
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="例如：我的中转站"
            // label 是视觉标签未与控件关联，读屏拿不到名称，这里显式补上
            aria-label="服务商名称"
            className={FIELD}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-medium text-ink-2">协议类型</label>
          <select
            value={form.type}
            onChange={(e) => {
              const nextType = e.target.value
              const defaults = PROTOCOL_DEFAULTS[nextType]
              const isOldDefaultUrl = !form.baseUrl || Object.values(PROTOCOL_DEFAULTS).some((d) => d.defaultUrl === form.baseUrl)
              const isOldDefaultModels = !form.models || Object.values(PROTOCOL_DEFAULTS).some((d) => d.defaultModels === form.models)
              set({
                type: nextType,
                baseUrl: isOldDefaultUrl && isNew ? (defaults?.defaultUrl || '') : form.baseUrl,
                models: isOldDefaultModels && isNew ? (defaults?.defaultModels || '') : form.models,
              })
            }}
            aria-label="协议类型"
            className={FIELD}
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[11px] font-medium text-ink-2">Base URL</label>
        <input
          value={form.baseUrl}
          onChange={(e) => set({ baseUrl: e.target.value })}
          placeholder={PROTOCOL_DEFAULTS[form.type]?.placeholderUrl || 'https://api.example.com/v1'}
          aria-label="Base URL"
          className={FIELD}
        />
      </div>

      <div>
        <label className="mb-1.5 block text-[11px] font-medium text-ink-2">
          API Key
          {!isNew && <span className="ml-1.5 font-normal text-ink-3">留空则保留原密钥</span>}
        </label>
        <input
          type="password"
          value={form.apiKey}
          onChange={(e) => set({ apiKey: e.target.value })}
          placeholder={isNew ? '本地免密钥服务可留空' : '••••••••'}
          autoComplete="off"
          aria-label="API Key"
          className={FIELD}
        />
      </div>

      <div>
        <label className="mb-1.5 block text-[11px] font-medium text-ink-2">
          模型列表<span className="ml-1.5 font-normal text-ink-3">每行一个</span>
        </label>
        <textarea
          value={form.models}
          onChange={(e) => set({ models: e.target.value })}
          rows={3}
          placeholder={PROTOCOL_DEFAULTS[form.type]?.modelsPlaceholder || 'gpt-4o-mini\ndeepseek-chat'}
          aria-label="模型列表"
          className={`${FIELD} resize-y font-mono leading-5`}
        />
      </div>

      <div className="flex gap-2">
        <button onClick={onSave} disabled={!valid || busy} className={`${BUTTON_PRIMARY} py-1 text-xs`}>
          {busy ? <Spinner size={13} /> : <Check size={13} />}
          {isNew ? '添加' : '保存'}
        </button>
        <button onClick={onCancel} className={`${BUTTON_GHOST} py-1 text-xs`}>
          <X size={13} />
          取消
        </button>
      </div>
    </div>
  )
}
