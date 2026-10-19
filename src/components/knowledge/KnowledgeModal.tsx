import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  Plus,
  RotateCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useKnowledgeStore } from '../../store/knowledge'
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

  useEffect(() => {
    if (modalOpen) {
      loadAll()
    }
  }, [modalOpen])

  if (!modalOpen) return null

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
      <div className="relative flex max-h-[88vh] w-full max-w-3xl flex-col rounded-2xl border border-rule bg-panel shadow-3 anim-modal-rise overflow-hidden">
        {/* 顶部标题栏 */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-rule px-5">
          <div className="flex items-center gap-2">
            <BookOpen className="text-accent" size={18} />
            <h2 className="text-base font-semibold text-ink-1">知识库与 RAG 检索中心</h2>
          </div>
          <button onClick={() => setModalOpen(false)} className={ICON_BTN_SM} aria-label="关闭">
            <X size={15} />
          </button>
        </div>

        {/* 统计指标条 */}
        <div className="grid grid-cols-4 divide-x divide-rule border-b border-rule bg-hover-soft px-2 py-2.5 text-center text-xs">
          <div>
            <p className="text-[11px] text-ink-4">已就绪文档</p>
            <p className="mt-0.5 font-semibold text-ink-1">{status?.documents ?? documents.filter(d => d.status === 'ready').length}</p>
          </div>
          <div>
            <p className="text-[11px] text-ink-4">向量分块 (Chunks)</p>
            <p className="mt-0.5 font-semibold text-accent">{status?.chunks ?? 0}</p>
          </div>
          <div>
            <p className="text-[11px] text-ink-4">流水线处理中</p>
            <p className="mt-0.5 font-semibold text-ink-2">{status?.processing ?? documents.filter(d => d.status === 'processing' || d.status === 'pending').length}</p>
          </div>
          <div>
            <p className="text-[11px] text-ink-4">向量化模型</p>
            <p className="mt-0.5 font-mono text-[10px] text-ink-3 truncate px-1">
              {status?.embedding?.model || '已就绪'}
            </p>
          </div>
        </div>

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
                <span className="text-[10px] font-normal text-ink-4">（自动抓取正文、去标签并切块向量化）</span>
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
              className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-5 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-accent bg-accent/5'
                  : 'border-rule hover:border-accent/50 hover:bg-hover-soft'
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
              <Upload size={22} className="text-accent mb-1.5" />
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
                <span className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">
                  当前工作区文档 ({documents.length})
                </span>
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

                    return (
                      <div
                        key={doc.id}
                        className="rounded-xl border border-rule bg-panel p-3 transition-colors hover:border-rule-strong"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2.5 min-w-0 flex-1">
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
      </div>
    </div>
  )
}
