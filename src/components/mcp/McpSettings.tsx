import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Server,
  Shield,
  ShieldAlert,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import {
  deleteMcpServer,
  fetchMcpServers,
  probeMcpServer,
  saveMcpServer,
  setMcpServerEnabled,
  setMcpServerTrusted,
  setMcpToolDisabled,
} from '../../api/client'
import { BUTTON_PRIMARY, FIELD, ICON_BTN_SM } from '../../lib/ui'
import type { McpServer, McpTransport } from '../../types'

export default function McpSettings() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 新增/编辑表单态
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [argsStr, setArgsStr] = useState('')
  const [envStr, setEnvStr] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [headersStr, setHeadersStr] = useState('')
  const [saving, setSaving] = useState(false)

  // 展开查看工具的 server ID
  const [expandedServerIds, setExpandedServerIds] = useState<Record<string, boolean>>({})
  // 探测中状态
  const [probingIds, setProbingIds] = useState<Record<string, boolean>>({})

  const loadList = async () => {
    try {
      setLoading(true)
      const res = await fetchMcpServers()
      setServers(res.items || [])
    } catch (err: any) {
      setError(err.message || '获取 MCP 服务列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadList()
  }, [])

  const handleOpenAddForm = (server?: McpServer) => {
    setError(null)
    if (server) {
      setEditingId(server.id)
      setName(server.name)
      setTransport(server.transport)
      setCommand(server.command || '')
      setArgsStr(server.args ? server.args.join(' ') : '')
      setEnvStr(server.env ? JSON.stringify(server.env, null, 2) : '')
      setBaseUrl(server.baseUrl || '')
      setHeadersStr(server.headers ? JSON.stringify(server.headers, null, 2) : '')
    } else {
      setEditingId(null)
      setName('')
      setTransport('stdio')
      setCommand('npx')
      setArgsStr('-y @modelcontextprotocol/server-filesystem C:/')
      setEnvStr('')
      setBaseUrl('')
      setHeadersStr('')
    }
    setShowForm(true)
  }

  const handleSaveServer = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!name.trim()) {
      setError('请输入服务名称')
      return
    }

    let parsedEnv: Record<string, string> | undefined
    if (envStr.trim()) {
      try {
        parsedEnv = JSON.parse(envStr)
      } catch {
        setError('环境变量必须是合法的 JSON 键值对格式')
        return
      }
    }

    let parsedHeaders: Record<string, string> | undefined
    if (headersStr.trim()) {
      try {
        parsedHeaders = JSON.parse(headersStr)
      } catch {
        setError('Headers 必须是合法的 JSON 格式')
        return
      }
    }

    setSaving(true)
    try {
      const server = await saveMcpServer({
        id: editingId || undefined,
        name: name.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() || undefined : undefined,
        args: transport === 'stdio' ? (argsStr.trim() ? argsStr.trim().split(/\s+/) : []) : undefined,
        env: parsedEnv,
        baseUrl: transport === 'http' ? baseUrl.trim() || undefined : undefined,
        headers: parsedHeaders,
      })

      setShowForm(false)
      await loadList()

      // 保存后自动触发一次探活拉取工具列表
      handleProbe(server.id)
    } catch (err: any) {
      setError(err.message || '保存 MCP 服务失败')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleEnable = async (s: McpServer) => {
    try {
      await setMcpServerEnabled(s.id, !s.enabled)
      setServers((prev) =>
        prev.map((item) => (item.id === s.id ? { ...item, enabled: !item.enabled } : item))
      )
    } catch (err: any) {
      alert(err.message || '切换状态失败')
    }
  }

  const handleToggleTrust = async (s: McpServer) => {
    const nextTrust = !s.trusted
    if (nextTrust) {
      if (!confirm(`【安全确认】开启信任后，该 MCP 服务将可以读取或执行您本地机器的工具命令。\n\n确定要信任「${s.name}」吗？`)) {
        return
      }
    }
    try {
      await setMcpServerTrusted(s.id, nextTrust)
      setServers((prev) =>
        prev.map((item) => (item.id === s.id ? { ...item, trusted: nextTrust } : item))
      )
    } catch (err: any) {
      alert(err.message || '切换信任失败')
    }
  }

  const handleProbe = async (id: string) => {
    setProbingIds((p) => ({ ...p, [id]: true }))
    try {
      const res = await probeMcpServer(id)
      setServers((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, tools: res.tools, toolCount: res.tools?.length || 0, lastError: res.error }
            : item
        )
      )
    } catch (err: any) {
      alert(err.message || '探活失败')
    } finally {
      setProbingIds((p) => ({ ...p, [id]: false }))
    }
  }

  const handleDelete = async (s: McpServer) => {
    if (!confirm(`确定删除 MCP 服务「${s.name}」吗？`)) return
    try {
      await deleteMcpServer(s.id)
      setServers((prev) => prev.filter((item) => item.id !== s.id))
    } catch (err: any) {
      alert(err.message || '删除失败')
    }
  }

  const handleToggleTool = async (serverId: string, toolName: string, currentDisabled: boolean) => {
    try {
      await setMcpToolDisabled(serverId, toolName, !currentDisabled)
      setServers((prev) =>
        prev.map((s) => {
          if (s.id !== serverId || !s.tools) return s
          return {
            ...s,
            tools: s.tools.map((t) =>
              t.name === toolName ? { ...t, disabled: !currentDisabled } : t
            ),
          }
        })
      )
    } catch (err: any) {
      alert(err.message || '切换工具状态失败')
    }
  }

  return (
    <div className="space-y-4">
      {/* 头部说明 */}
      <div className="flex items-center justify-between border-b border-rule pb-3">
        <div>
          <div className="flex items-center gap-1.5">
            <Server size={16} className="text-accent" />
            <h3 className="text-sm font-semibold text-ink-1">MCP (Model Context Protocol) 扩展</h3>
          </div>
          <p className="mt-0.5 text-xs text-ink-3">
            原生对接 MCP 协议，支持 stdio（命令行子进程）与 http 远程工具连接
          </p>
        </div>
        <button
          onClick={() => handleOpenAddForm()}
          className={`${BUTTON_PRIMARY} py-1.5 text-xs`}
        >
          <Plus size={14} />
          <span>添加服务</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {/* 新增/编辑抽屉表单 */}
      {showForm && (
        <form
          onSubmit={handleSaveServer}
          className="rounded-xl border border-accent/40 bg-hover-soft p-4 space-y-3 anim-fade-down"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-ink-1">
              {editingId ? '编辑 MCP 服务' : '添加 MCP 服务'}
            </span>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-ink-4 hover:text-ink-1"
            >
              <X size={14} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-medium text-ink-2">服务名称 *</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 filesystem / github / postgres"
                className={FIELD}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-2">传输类型</label>
              <select
                value={transport}
                onChange={(e) => setTransport(e.target.value as McpTransport)}
                className={FIELD}
              >
                <option value="stdio">stdio (本地命令)</option>
                <option value="http">http (远程服务)</option>
              </select>
            </div>
          </div>

          {transport === 'stdio' ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-2">可执行命令 *</label>
                  <input
                    required
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="npx / uvx / node"
                    className={FIELD}
                  />
                </div>
                <div className="col-span-2">
                  <label className="mb-1 block text-xs font-medium text-ink-2">参数 (空格切分)</label>
                  <input
                    value={argsStr}
                    onChange={(e) => setArgsStr(e.target.value)}
                    placeholder="-y @modelcontextprotocol/server-filesystem C:/"
                    className={FIELD}
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-2">环境变量 (JSON 格式，可选)</label>
                <textarea
                  rows={2}
                  value={envStr}
                  onChange={(e) => setEnvStr(e.target.value)}
                  placeholder={'{\n  "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx"\n}'}
                  className={`${FIELD} resize-none font-mono text-xs`}
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-2">服务 Base URL *</label>
                <input
                  required
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://my-mcp-server.example.com/sse"
                  className={FIELD}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-2">自定义 Headers (JSON 格式，可选)</label>
                <textarea
                  rows={2}
                  value={headersStr}
                  onChange={(e) => setHeadersStr(e.target.value)}
                  placeholder={'{\n  "Authorization": "Bearer token"\n}'}
                  className={`${FIELD} resize-none font-mono text-xs`}
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg px-3 py-1.5 text-xs text-ink-2 hover:bg-hover"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={saving}
              className={`${BUTTON_PRIMARY} py-1.5 text-xs`}
            >
              {saving ? '保存中...' : '保存并探测'}
            </button>
          </div>
        </form>
      )}

      {/* 列表 */}
      {loading ? (
        <div className="py-8 text-center text-xs text-ink-3">正在加载 MCP 服务配置...</div>
      ) : servers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-rule p-8 text-center">
          <Server size={24} className="mx-auto mb-2 text-ink-4" />
          <p className="text-xs font-medium text-ink-2">暂无已配置的 MCP 服务</p>
          <p className="mt-1 text-[11px] text-ink-4">
            点击上方「添加服务」，连接本地或云端工具，让大模型自主调用
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {servers.map((s) => {
            const isExpanded = expandedServerIds[s.id]
            const isProbing = probingIds[s.id]

            return (
              <div
                key={s.id}
                className="rounded-xl border border-rule bg-panel transition-colors hover:border-rule-strong"
              >
                {/* 主行 */}
                <div className="flex items-center justify-between p-3.5">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <button
                      onClick={() =>
                        setExpandedServerIds((prev) => ({ ...prev, [s.id]: !prev[s.id] }))
                      }
                      className="text-ink-3 hover:text-ink-1"
                    >
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs text-ink-1 truncate">{s.name}</span>
                        <span className="rounded bg-hover px-1.5 py-0.2 text-[10px] font-mono text-ink-3">
                          {s.transport}
                        </span>
                        {s.trusted ? (
                          <span
                            className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.2 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                            title="已信任：允许执行读写工具"
                          >
                            <ShieldAlert size={10} />
                            已信任
                          </span>
                        ) : (
                          <span
                            className="flex items-center gap-1 rounded bg-hover px-1.5 py-0.2 text-[10px] text-ink-4"
                            title="只读沙箱模式"
                          >
                            <Shield size={10} />
                            只读
                          </span>
                        )}
                        <span className="rounded bg-accent/10 px-1.5 py-0.2 text-[10px] font-medium text-accent">
                          {s.toolCount ?? s.tools?.length ?? 0} 个工具
                        </span>
                      </div>
                      {s.lastError ? (
                        <p className="mt-1 text-[11px] text-danger truncate">{s.lastError}</p>
                      ) : (
                        <p className="mt-1 font-mono text-[11px] text-ink-4 truncate">
                          {s.transport === 'stdio'
                            ? `${s.command} ${(s.args || []).join(' ')}`
                            : s.baseUrl}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* 右侧开关与动作 */}
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <button
                      onClick={() => handleProbe(s.id)}
                      disabled={isProbing}
                      className={ICON_BTN_SM}
                      title="探活并拉取工具列表"
                    >
                      <RefreshCw size={12} className={isProbing ? 'animate-spin text-accent' : ''} />
                    </button>

                    <button
                      onClick={() => handleToggleTrust(s)}
                      className={`${ICON_BTN_SM} ${s.trusted ? 'text-amber-500' : 'text-ink-4'}`}
                      title={s.trusted ? '取消信任（变更为只读）' : '开启信任（允许执行本地读写）'}
                    >
                      <Shield size={13} />
                    </button>

                    {/* 启用开关 */}
                    <button
                      onClick={() => handleToggleEnable(s)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                        s.enabled ? 'bg-accent' : 'bg-hover'
                      }`}
                      role="switch"
                      aria-checked={s.enabled}
                    >
                      <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          s.enabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>

                    <button
                      onClick={() => handleOpenAddForm(s)}
                      className={ICON_BTN_SM}
                      title="编辑配置"
                    >
                      <Wrench size={12} />
                    </button>

                    <button
                      onClick={() => handleDelete(s)}
                      className={`${ICON_BTN_SM} hover:text-danger`}
                      title="删除服务"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {/* 展开的工具列表 */}
                {isExpanded && (
                  <div className="border-t border-rule/60 bg-hover-soft p-3 rounded-b-xl space-y-1.5 anim-fade-in">
                    <p className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider mb-2">
                      可用工具清单 ({s.tools?.length || 0})
                    </p>
                    {(!s.tools || s.tools.length === 0) ? (
                      <p className="text-xs text-ink-4 py-2">
                        尚未探测到工具。请点击右侧刷新按钮探活。
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {s.tools.map((tool) => (
                          <div
                            key={tool.name}
                            className={`flex items-start justify-between rounded-lg border p-2 text-xs transition-colors ${
                              tool.disabled
                                ? 'border-rule bg-panel/50 opacity-50'
                                : 'border-rule bg-panel'
                            }`}
                          >
                            <div className="min-w-0 flex-1 pr-2">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono font-medium text-ink-1 truncate">
                                  {tool.name}
                                </span>
                                {tool.readOnly && (
                                  <span className="rounded bg-hover px-1 text-[9px] text-ink-4">
                                    只读
                                  </span>
                                )}
                              </div>
                              {tool.description && (
                                <p className="mt-0.5 line-clamp-2 text-[10px] text-ink-3">
                                  {tool.description}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={() => handleToggleTool(s.id, tool.name, !!tool.disabled)}
                              className={`shrink-0 text-[10px] font-medium rounded px-1.5 py-0.5 ${
                                tool.disabled
                                  ? 'bg-hover text-ink-4 hover:bg-hover-soft'
                                  : 'bg-accent/10 text-accent hover:bg-accent/20'
                              }`}
                            >
                              {tool.disabled ? '已禁用' : '启用'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
