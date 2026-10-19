import { useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  BarChart3,
  BookOpen,
  Check,
  CheckCircle2,
  ExternalLink,
  FileText,
  Filter,
  Globe,
  Loader2,
  MessageSquare,
  Plus,
  RotateCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useKnowledgeStore } from '../../store/knowledge'
import { useChatStore } from '../../store/chat'
import { retrieveKnowledge } from '../../api/client'
import type { RetrieveDebugResult } from '../../types'
import { FIELD, ICON_BTN_SM } from '../../lib/ui'

export default function KnowledgeModal() {
  const modalOpen = useKnowledgeStore((s) => s.modalOpen)
  const setModalOpen = useKnowledgeStore((s) => s.setModalOpen)
  const workspaces = useKnowledgeStore((s) => s.workspaces)
  const activeWorkspaceId = useKnowledgeStore((s) => s.activeWorkspaceId)
  const setActiveWorkspaceId = useKnowledgeStore((s) => s.setActiveWorkspaceId)
  const status = useKnowledgeStore((s) => s.status)
  const documents = useKnowledgeStore((s) => s.documents)
  const loadAll = useKnowledgeStore((s) => s.loadAll)
  const upload = useKnowledgeStore((s) => s.upload)
  const retry = useKnowledgeStore((s) => s.retry)
  const removeDocument = useKnowledgeStore((s) => s.removeDocument)
  const createWorkspace = useKnowledgeStore((s) => s.createWorkspace)
  const removeWorkspace = useKnowledgeStore((s) => s.removeWorkspace)

  const [newWsName, setNewWsName] = useState('')
  const [showNewWs, setShowNewWs] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [addingUrl, setAddingUrl] = useState(false)
  const [urlError, setUrlError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 选项卡：文档管理 vs 检索诊断
  const [activeTab, setActiveTab] = useState<'documents' | 'diagnostics'>('documents')

  // 对话绑定与限定文档 (Q-2026-10-19-07)
  const activeId = useChatStore((s) => s.activeId)
  const conversations = useChatStore((s) => s.conversations)
  const setConversationDocumentIds = useChatStore((s) => s.setConversationDocumentIds)
  const createConversation = useChatStore((s) => s.createConversation)
  const setActive = useChatStore((s) => s.setActive)

  const activeConv = conversations.find((c) => c.id === activeId)
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(() => {
    return new Set(activeConv?.documentIds || [])
  })

  // 检索诊断状态
  const [debugQuery, setDebugQuery] = useState('')
  const [debugLoading, setDebugLoading] = useState(false)
  const [debugOnlySelected, setDebugOnlySelected] = useState(false)
  const [debugResult, setDebugResult] = useState<{
    chunks: any[]
    timings?: { embedMs: number; searchMs: number; totalMs: number }
    debug?: RetrieveDebugResult
  } | null>(null)

  useEffect(() => {
    if (modalOpen) {
      loadAll()
      if (activeConv?.documentIds?.length) {
        setSelectedDocIds(new Set(activeConv.documentIds))
      }
    }
  }, [modalOpen, activeConv?.id])

  if (!modalOpen) return null

  const handleToggleDoc = (docId: string) => {
    setSelectedDocIds((prev) => {
      const next = new Set(prev)
      if (next.has(docId)) {
        next.delete(docId)
      } else {
        next.add(docId)
      }
      return next
    })
  }

  const handleSelectAllReady = () => {
    const readyIds = documents.filter((d) => d.status === 'ready').map((d) => d.id)
    setSelectedDocIds(new Set(readyIds))
  }

  const handleClearSelection = () => {
    setSelectedDocIds(new Set())
    if (activeId && activeConv?.documentIds?.length) {
      setConversationDocumentIds(activeId, undefined)
    }
  }

  const handleApplyToCurrentChat = () => {
    const ids = Array.from(selectedDocIds)
    if (!activeId) {
      const newId = createConversation()
      setConversationDocumentIds(newId, ids.length ? ids : undefined)
      setActive(newId)
    } else {
      setConversationDocumentIds(activeId, ids.length ? ids : undefined)
    }
    setModalOpen(false)
  }

  const handleStartNewScopedChat = () => {
    const ids = Array.from(selectedDocIds)
    const newId = createConversation()
    setConversationDocumentIds(newId, ids.length ? ids : undefined)
    setActive(newId)
    setModalOpen(false)
  }

  const handleRunDebug = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!debugQuery.trim() || debugLoading) return
    setDebugLoading(true)
    try {
      const docIds =
        debugOnlySelected && selectedDocIds.size > 0 ? Array.from(selectedDocIds) : undefined
      const res = await retrieveKnowledge(debugQuery.trim(), {
        workspaceId: activeWorkspaceId,
        documentIds: docIds,
        debug: true,
        topK: 6,
      })
      setDebugResult(res)
    } catch (err: any) {
      alert(`检索诊断失败: ${err.message}`)
    } finally {
      setDebugLoading(false)
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return
    setUploading(true)
    for (const file of Array.from(files)) {
      try {
        const reader = new FileReader()
        await new Promise<void>((resolve, reject) => {
          reader.onload = async () => {
            try {
              const dataUrl = reader.result as string
              await upload({
                name: file.name,
                mime: file.type || 'text/plain',
                dataUrl,
                size: file.size,
              })
              resolve()
            } catch (e) {
              reject(e)
            }
          }
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
      } catch (err: any) {
        alert(`上传「${file.name}」失败: ${err.message}`)
      }
    }
    setUploading(false)
  }

  const handleCreateWs = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newWsName.trim()) return
    await createWorkspace(newWsName.trim())
    setNewWsName('')
    setShowNewWs(false)
  }

  const handleAddUrl = async (e: React.FormEvent) => {
    e.preventDefault()
    const targetUrl = urlInput.trim()
    if (!targetUrl) return
    setUrlError(null)
    setAddingUrl(true)
    try {
      await upload({ url: targetUrl })
      setUrlInput('')
    } catch (err: any) {
      setUrlError(err.message || '添加网页失败')
    } finally {
      setAddingUrl(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm anim-fade-in">
      <div className="relative flex max-h-[88vh] w-full max-w-4xl flex-col rounded-2xl border border-rule bg-panel shadow-3 anim-modal-rise overflow-hidden">
        {/* 顶部标题栏 + 标签页切换 */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-rule px-5">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <BookOpen className="text-accent" size={18} />
              <h2 className="text-base font-semibold text-ink-1">知识库与 RAG 检索中心</h2>
            </div>
            {/* 标签栏 */}
            <div className="flex rounded-lg bg-hover p-0.5 text-xs">
              <button
                onClick={() => setActiveTab('documents')}
                className={`press flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-all ${
                  activeTab === 'documents'
                    ? 'bg-panel text-ink-1 shadow-sm'
                    : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                <FileText size={13} />
                文档管理
              </button>
              <button
                onClick={() => setActiveTab('diagnostics')}
                className={`press flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-all ${
                  activeTab === 'diagnostics'
                    ? 'bg-panel text-accent shadow-sm'
                    : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                <Activity size={13} />
                检索诊断
              </button>
            </div>
          </div>
          <button onClick={() => setModalOpen(false)} className={ICON_BTN_SM} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        {/* 统计指标条 */}
        <div className="grid grid-cols-4 divide-x divide-rule border-b border-rule bg-hover-soft px-2 py-2.5 text-center text-xs">
          <div>
            <p className="text-[11px] text-ink-4">已就绪文档</p>
            <p className="mt-0.5 font-semibold text-ink-1">
              {status?.documents ?? documents.filter((d) => d.status === 'ready').length}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-ink-4">向量分块 (Chunks)</p>
            <p className="mt-0.5 font-semibold text-accent">{status?.chunks ?? 0}</p>
          </div>
          <div>
            <p className="text-[11px] text-ink-4">流水线处理中</p>
            <p className="mt-0.5 font-semibold text-ink-2">
              {status?.processing ??
                documents.filter((d) => d.status === 'processing' || d.status === 'pending').length}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-ink-4">向量化模型</p>
            <p className="mt-0.5 font-mono text-[10px] text-ink-3 truncate px-1">
              {status?.embedding?.model || '已就绪'}
            </p>
          </div>
        </div>

        {activeTab === 'documents' ? (
          <div className="flex flex-1 overflow-hidden">
            {/* 左侧：工作区列表 */}
            <div className="w-52 shrink-0 border-r border-rule bg-panel p-3 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">
                    工作区
                  </span>
                  <button
                    onClick={() => setShowNewWs((v) => !v)}
                    className="text-ink-3 hover:text-accent"
                    title="新建知识库工作区"
                  >
                    <Plus size={14} />
                  </button>
                </div>

                {showNewWs && (
                  <form onSubmit={handleCreateWs} className="mb-2 space-y-1">
                    <input
                      autoFocus
                      value={newWsName}
                      onChange={(e) => setNewWsName(e.target.value)}
                      placeholder="工作区名称..."
                      className={`${FIELD} py-1 text-xs`}
                    />
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setShowNewWs(false)}
                        className="px-2 py-0.5 text-[11px] text-ink-3"
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        className="rounded bg-accent px-2 py-0.5 text-[11px] text-white"
                      >
                        创建
                      </button>
                    </div>
                  </form>
                )}

                <div className="space-y-1">
                  {workspaces.map((ws) => {
                    const active = ws.id === activeWorkspaceId
                    return (
                      <div
                        key={ws.id}
                        onClick={() => setActiveWorkspaceId(ws.id)}
                        className={`group flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                          active
                            ? 'bg-accent/10 font-semibold text-accent'
                            : 'text-ink-2 hover:bg-hover'
                        }`}
                      >
                        <span className="truncate">{ws.name}</span>
                        <div className="flex items-center gap-1">
                          <span className="rounded bg-hover px-1 text-[9px] text-ink-4">
                            {ws.docCount}
                          </span>
                          {ws.id !== 'default' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                if (confirm(`确定删除工作区「${ws.name}」吗？`)) {
                                  removeWorkspace(ws.id)
                                }
                              }}
                              className="hidden group-hover:block text-ink-4 hover:text-danger"
                              title="删除工作区"
                            >
                              <Trash2 size={11} />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* 右侧：文档上传与异步流水线列表 */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col space-y-3">
              {/* 抓取网页链接入库 */}
              <div className="rounded-xl border border-rule bg-hover-soft p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-2 mb-2">
                  <Globe size={14} className="text-accent" />
                  <span>添加网页链接</span>
                  <span className="text-[10px] font-normal text-ink-4">
                    （自动抓取正文、去标签并切块向量化）
                  </span>
                </div>
                <form onSubmit={handleAddUrl} className="flex gap-2">
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => {
                      setUrlInput(e.target.value)
                      if (urlError) setUrlError(null)
                    }}
                    placeholder="https://example.com/article..."
                    className={`${FIELD} flex-1 py-1.5 text-xs`}
                    disabled={addingUrl}
                  />
                  <button
                    type="submit"
                    disabled={addingUrl || !urlInput.trim()}
                    className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 shrink-0"
                  >
                    {addingUrl ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    添加
                  </button>
                </form>
                {urlError && (
                  <p className="mt-1.5 flex items-center gap-1 text-[11px] text-danger">
                    <AlertCircle size={11} className="shrink-0" />
                    <span>{urlError}</span>
                  </p>
                )}
              </div>

              {/* 上传拖拽区 */}
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  handleFiles(e.dataTransfer.files)
                }}
                onClick={() => fileInputRef.current?.click()}
                className={`press hover-lift flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 text-center cursor-pointer transition-all duration-200 ${
                  dragOver
                    ? 'border-accent bg-accent/10 scale-[1.01] shadow-sm'
                    : 'border-rule hover:border-accent/60 hover:bg-hover-soft'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.markdown,.pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.html,.htm,.json,.csv"
                  className="hidden"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <Upload size={20} className="text-accent mb-1" />
                <p className="text-xs font-semibold text-ink-1">
                  点击上传或将文档拖拽至此
                </p>
                <p className="mt-0.5 text-[11px] text-ink-4">
                  支持 TXT, Markdown, PDF, Word, PPTX, Excel, HTML, JSON 等格式
                </p>
              </div>

              {/* 文档列表 */}
              <div className="flex-1">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">
                      当前工作区文档 ({documents.length})
                    </span>
                    {documents.some((d) => d.status === 'ready') && (
                      <button
                        onClick={handleSelectAllReady}
                        className="text-[11px] text-accent hover:underline"
                      >
                        全选就绪文档
                      </button>
                    )}
                  </div>
                  {uploading && (
                    <span className="flex items-center gap-1 text-[11px] text-accent">
                      <Loader2 size={12} className="animate-spin" />
                      正在上传入队...
                    </span>
                  )}
                </div>

                {documents.length === 0 ? (
                  <div className="py-12 text-center text-xs text-ink-4">
                    暂无文档。上传文件后将自动切块并建立向量检索索引。
                  </div>
                ) : (
                  <div className="space-y-2">
                    {documents.map((doc) => {
                      const isProcessing = doc.status === 'processing' || doc.status === 'pending'
                      const isReady = doc.status === 'ready'
                      const isFailed = doc.status === 'failed'
                      const isSelected = selectedDocIds.has(doc.id)

                      return (
                        <div
                          key={doc.id}
                          className={`rounded-xl border p-3 transition-colors ${
                            isSelected
                              ? 'border-accent bg-accent/5 shadow-sm'
                              : 'border-rule bg-panel hover:border-rule-strong'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-2.5 min-w-0 flex-1">
                              {/* 勾选框（就绪文档可选定范围） */}
                              {isReady ? (
                                <button
                                  type="button"
                                  onClick={() => handleToggleDoc(doc.id)}
                                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                                    isSelected
                                      ? 'border-accent bg-accent text-white'
                                      : 'border-rule bg-field hover:border-accent'
                                  }`}
                                  title={isSelected ? '取消勾选' : '勾选用于限定检索提问'}
                                >
                                  {isSelected && <Check size={11} strokeWidth={3} />}
                                </button>
                              ) : (
                                <div className="mt-0.5 h-4 w-4 shrink-0" />
                              )}

                              {doc.sourceUrl ? (
                                <Globe size={16} className="text-accent shrink-0 mt-0.5" />
                              ) : (
                                <FileText size={16} className="text-ink-3 shrink-0 mt-0.5" />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <p className="text-xs font-medium text-ink-1 truncate">{doc.name}</p>
                                  {doc.sourceUrl && (
                                    <a
                                      href={doc.sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-ink-4 hover:text-accent shrink-0 inline-flex items-center"
                                      title={`在新标签页打开原网页: ${doc.sourceUrl}`}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <ExternalLink size={12} />
                                    </a>
                                  )}
                                  {isSelected && (
                                    <span className="rounded bg-accent/15 px-1.5 py-0.2 text-[10px] font-medium text-accent">
                                      限定检索
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-4">
                                  {isReady && (
                                    <>
                                      <span className="flex items-center gap-1 text-success">
                                        <CheckCircle2 size={12} />
                                        已就绪
                                      </span>
                                      <span>·</span>
                                      <span>{doc.chunkCount ?? 0} 个分块</span>
                                      <span>·</span>
                                      <span>{doc.chars ?? 0} 字符</span>
                                    </>
                                  )}
                                  {isProcessing && (
                                    <span className="flex items-center gap-1 text-accent">
                                      <Loader2 size={12} className="animate-spin" />
                                      {doc.stage === '抓取网页' ? '正在抓取网页正文…' : (doc.stage || '正在处理')} ({doc.progress}%)
                                    </span>
                                  )}
                                  {isFailed && (
                                    <span className="flex items-center gap-1 text-danger font-medium">
                                      <AlertCircle size={12} />
                                      处理失败
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* 操作 */}
                            <div className="flex items-center gap-1 shrink-0">
                              {isFailed && (
                                <button
                                  onClick={() => retry(doc.id)}
                                  className="flex items-center gap-1 rounded bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20 transition-colors"
                                  title="重新入队处理"
                                >
                                  <RotateCw size={11} />
                                  重试
                                </button>
                              )}
                              <button
                                onClick={() => removeDocument(doc.id)}
                                className={`${ICON_BTN_SM} hover:text-danger`}
                                title="删除文档"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>

                          {/* 处理中进度条 */}
                          {isProcessing && (
                            <div className="mt-2.5 space-y-1">
                              <div className="h-1.5 w-full rounded-full bg-hover overflow-hidden">
                                <div
                                  className="h-full bg-accent transition-all duration-300"
                                  style={{ width: `${Math.max(doc.progress, 5)}%` }}
                                />
                              </div>
                            </div>
                          )}

                          {/* 失败详情展示 */}
                          {isFailed && doc.error && (
                            <p className="mt-2 rounded bg-danger/10 p-2 text-[11px] text-danger">
                              {doc.error}
                            </p>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* 检索诊断视图 (Q-2026-10-19-07) */
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div className="rounded-xl border border-rule bg-hover-soft p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-ink-1 mb-2">
                <BarChart3 size={15} className="text-accent" />
                <span>RAG 混合检索与打分诊断器</span>
                <span className="text-[11px] font-normal text-ink-3">
                  (测试向量相似度、关键词 BM25、短语命中与标题层级 4 路信号打分及 MMR 召回)
                </span>
              </div>
              <form onSubmit={handleRunDebug} className="flex flex-col gap-3">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search
                      size={14}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4"
                    />
                    <input
                      type="text"
                      value={debugQuery}
                      onChange={(e) => setDebugQuery(e.target.value)}
                      placeholder="输入测试问题或查询关键词，例如：系统架构设计、API 接口规范..."
                      className={`${FIELD} w-full pl-8 py-2 text-xs`}
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={debugLoading || !debugQuery.trim()}
                    className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 shrink-0"
                  >
                    {debugLoading ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Activity size={13} />
                    )}
                    运行检索诊断
                  </button>
                </div>

                <div className="flex items-center justify-between text-xs text-ink-3">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={debugOnlySelected}
                      onChange={(e) => setDebugOnlySelected(e.target.checked)}
                      disabled={selectedDocIds.size === 0}
                      className="rounded border-rule text-accent"
                    />
                    <span>
                      仅限定在选中的 {selectedDocIds.size} 份文档中检索
                      {selectedDocIds.size === 0 && ' (请先在文档管理页勾选)'}
                    </span>
                  </label>
                  <span>Top-K: 6 候选分块</span>
                </div>
              </form>
            </div>

            {/* 诊断输出卡片 */}
            {debugResult && (
              <div className="space-y-3">
                {/* 性能与统计指标 */}
                <div className="grid grid-cols-4 gap-2 rounded-xl border border-rule bg-panel p-3 text-center text-xs">
                  <div className="rounded-lg bg-hover-soft p-2">
                    <p className="text-[10px] text-ink-4">总耗时</p>
                    <p className="mt-0.5 font-bold text-accent">
                      {debugResult.timings?.totalMs ?? 0} ms
                    </p>
                    <p className="text-[9px] text-ink-4">
                      向量: {debugResult.timings?.embedMs ?? 0}ms · 搜索: {debugResult.timings?.searchMs ?? 0}ms
                    </p>
                  </div>
                  <div className="rounded-lg bg-hover-soft p-2">
                    <p className="text-[10px] text-ink-4">召回分块总数</p>
                    <p className="mt-0.5 font-bold text-ink-1">
                      {debugResult.debug?.totalChunks ?? 0}
                    </p>
                    <p className="text-[9px] text-ink-4">候选分块池容量</p>
                  </div>
                  <div className="rounded-lg bg-hover-soft p-2">
                    <p className="text-[10px] text-ink-4">过阈值数量</p>
                    <p className="mt-0.5 font-bold text-success">
                      {debugResult.debug?.passedThreshold ?? 0}
                    </p>
                    <p className="text-[9px] text-ink-4">相关度达标的分块</p>
                  </div>
                  <div className="rounded-lg bg-hover-soft p-2">
                    <p className="text-[10px] text-ink-4">向量引擎状态</p>
                    <p className="mt-0.5 font-bold text-ink-1">
                      {debugResult.debug?.vectorUsed ? '向量+关键词混合' : '纯文本关键词'}
                    </p>
                    <p className="text-[9px] text-ink-4">双路召回加权</p>
                  </div>
                </div>

                {/* 候选分块列表与打分细节 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-ink-2">
                    <span>召回候选分块详情 ({debugResult.debug?.candidates?.length ?? 0})</span>
                    <span className="text-[11px] font-normal text-ink-4">
                      绿色标签为经 MMR 去重最终送入上下文的分块
                    </span>
                  </div>

                  {(!debugResult.debug?.candidates || debugResult.debug.candidates.length === 0) ? (
                    <div className="rounded-xl border border-rule bg-panel py-8 text-center text-xs text-ink-4">
                      未检索到匹配分块，请尝试调整查询词或检查知识库文档。
                    </div>
                  ) : (
                    debugResult.debug.candidates.map((cand) => (
                      <div
                        key={cand.id}
                        className={`rounded-xl border p-3.5 text-xs transition-colors ${
                          cand.picked
                            ? 'border-emerald-500/30 bg-emerald-500/5'
                            : 'border-rule bg-panel opacity-80'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                cand.picked
                                  ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-hover text-ink-4'
                              }`}
                            >
                              {cand.picked ? '✓ MMR 选入上下文' : 'MMR 过滤 / 备选'}
                            </span>
                            <span className="font-semibold text-ink-1 truncate">
                              {cand.documentName}
                            </span>
                            {cand.heading && (
                              <span className="text-[11px] text-ink-3 truncate">
                                § {cand.heading}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[10px] text-ink-4">综合评分:</span>
                            <span className="font-mono font-bold text-accent">
                              {cand.score.toFixed(3)}
                            </span>
                          </div>
                        </div>

                        {/* 4 路打分柱状图 */}
                        <div className="grid grid-cols-4 gap-2 mb-2.5 rounded-lg bg-hover-soft p-2">
                          <div>
                            <div className="flex justify-between text-[10px] text-ink-3 mb-1">
                              <span>向量余弦</span>
                              <span className="font-mono">{(cand.vectorScore * 100).toFixed(0)}%</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-rule overflow-hidden">
                              <div
                                className="h-full bg-blue-500 rounded-full transition-all duration-500 ease-out"
                                style={{ width: `${Math.min(cand.vectorScore * 100, 100)}%` }}
                              />
                            </div>
                          </div>
                          <div>
                            <div className="flex justify-between text-[10px] text-ink-3 mb-1">
                              <span>关键词词频</span>
                              <span className="font-mono">{(cand.keywordScore * 100).toFixed(0)}%</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-rule overflow-hidden">
                              <div
                                className="h-full bg-emerald-500 rounded-full transition-all duration-500 ease-out"
                                style={{ width: `${Math.min(cand.keywordScore * 100, 100)}%` }}
                              />
                            </div>
                          </div>
                          <div>
                            <div className="flex justify-between text-[10px] text-ink-3 mb-1">
                              <span>短语匹配</span>
                              <span className="font-mono">{(cand.phraseScore * 100).toFixed(0)}%</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-rule overflow-hidden">
                              <div
                                className="h-full bg-amber-500 rounded-full transition-all duration-500 ease-out"
                                style={{ width: `${Math.min(cand.phraseScore * 100, 100)}%` }}
                              />
                            </div>
                          </div>
                          <div>
                            <div className="flex justify-between text-[10px] text-ink-3 mb-1">
                              <span>标题层级</span>
                              <span className="font-mono">{(cand.headingScore * 100).toFixed(0)}%</span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-rule overflow-hidden">
                              <div
                                className="h-full bg-purple-500 rounded-full transition-all duration-500 ease-out"
                                style={{ width: `${Math.min(cand.headingScore * 100, 100)}%` }}
                              />
                            </div>
                          </div>
                        </div>

                        {/* 分块内容预览 */}
                        <div className="rounded bg-hover p-2 text-[11px] text-ink-2 font-mono leading-relaxed max-h-24 overflow-y-auto">
                          {cand.preview || '无内容预览'}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 底部限定文档操作栏 (当勾选了文档时常驻) */}
        {selectedDocIds.size > 0 && (
          <div className="flex items-center justify-between border-t border-rule bg-accent/5 px-5 py-3 text-xs">
            <div className="flex items-center gap-2">
              <Filter size={14} className="text-accent" />
              <span className="font-medium text-ink-1">
                已选定 <span className="text-accent font-bold">{selectedDocIds.size}</span> 份文档作为专属 RAG 检索范围
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleClearSelection}
                className="px-2.5 py-1 text-ink-3 hover:text-ink-1"
              >
                清空选择
              </button>
              <button
                type="button"
                onClick={handleStartNewScopedChat}
                className="flex items-center gap-1 rounded-lg border border-rule bg-panel px-3 py-1 font-medium text-ink-1 hover:bg-hover"
              >
                <Plus size={12} />
                开启限定新会话
              </button>
              <button
                type="button"
                onClick={handleApplyToCurrentChat}
                className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1 font-medium text-white shadow-sm hover:opacity-90"
              >
                <MessageSquare size={12} />
                绑定到当前会话提问
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

