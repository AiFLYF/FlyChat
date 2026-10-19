import { create } from 'zustand'
import {
  createWorkspace as apiCreateWorkspace,
  deleteDocument as apiDeleteDocument,
  deleteWorkspace as apiDeleteWorkspace,
  fetchDocuments as apiFetchDocuments,
  fetchDocumentStatus as apiFetchDocumentStatus,
  fetchKnowledgeStatus as apiFetchKnowledgeStatus,
  fetchWorkspaces as apiFetchWorkspaces,
  retryDocument as apiRetryDocument,
  uploadDocument as apiUploadDocument,
} from '../api/client'
import type { DocumentItem, KnowledgeStatus, WorkspaceItem } from '../types'

interface KnowledgeState {
  workspaces: WorkspaceItem[]
  defaultWorkspaceId: string
  activeWorkspaceId: string
  status: KnowledgeStatus | null
  documents: DocumentItem[]
  loading: boolean
  modalOpen: boolean
  setModalOpen: (open: boolean) => void
  setActiveWorkspaceId: (id: string) => void
  loadAll: () => Promise<void>
  loadDocuments: (workspaceId?: string) => Promise<void>
  upload: (data: {
    workspaceId?: string
    name?: string
    mime?: string
    dataUrl?: string
    text?: string
    url?: string
    size?: number
  }) => Promise<DocumentItem>
  retry: (id: string) => Promise<void>
  removeDocument: (id: string) => Promise<void>
  createWorkspace: (name: string) => Promise<WorkspaceItem>
  removeWorkspace: (id: string) => Promise<void>
}

// 轮询中的任务 ID 记录
const activePolls = new Set<string>()

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  workspaces: [],
  defaultWorkspaceId: 'default',
  activeWorkspaceId: 'default',
  status: null,
  documents: [],
  loading: false,
  modalOpen: false,

  setModalOpen: (open) => set({ modalOpen: open }),

  setActiveWorkspaceId: (id) => {
    set({ activeWorkspaceId: id })
    get().loadDocuments(id)
  },

  loadAll: async () => {
    try {
      set({ loading: true })
      const [status, wsRes] = await Promise.all([
        apiFetchKnowledgeStatus().catch(() => null),
        apiFetchWorkspaces().catch(() => ({ items: [], defaultId: 'default' })),
      ])
      const activeId = get().activeWorkspaceId || wsRes.defaultId || 'default'
      set({
        status,
        workspaces: wsRes.items,
        defaultWorkspaceId: wsRes.defaultId,
        activeWorkspaceId: activeId,
      })
      await get().loadDocuments(activeId)
    } finally {
      set({ loading: false })
    }
  },

  loadDocuments: async (workspaceId) => {
    const wsId = workspaceId || get().activeWorkspaceId || 'default'
    try {
      const res = await apiFetchDocuments(wsId)
      set({ documents: res.items || [] })
      // 对其中仍处于 pending/processing 的文档发起自动轮询
      for (const doc of res.items || []) {
        if ((doc.status === 'pending' || doc.status === 'processing') && !activePolls.has(doc.id)) {
          pollDocStatus(doc.id, set)
        }
      }
    } catch {
      /* ignore */
    }
  },

  upload: async (data) => {
    const wsId = data.workspaceId || get().activeWorkspaceId || 'default'
    const res = await apiUploadDocument({ ...data, workspaceId: wsId })

    // 如果重复文档命中已存在的
    if (res.duplicate && res.documentId) {
      await get().loadDocuments(wsId)
      return res as DocumentItem
    }

    // 乐观插入到列表顶部
    const newDoc: DocumentItem = {
      id: res.id,
      workspaceId: wsId,
      name: res.name || data.name || data.url || '新文档',
      sourceUrl: res.sourceUrl || data.url,
      status: res.status || 'pending',
      stage: res.stage || (data.url ? '抓取网页' : '已入队'),
      progress: res.progress ?? (data.url ? 5 : 0),
      attempts: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    set((s) => ({
      documents: [newDoc, ...s.documents.filter((d) => d.id !== newDoc.id)],
    }))

    // 启动 800ms 轮询流水线
    pollDocStatus(newDoc.id, set)
    return newDoc
  },

  retry: async (id) => {
    await apiRetryDocument(id)
    set((s) => ({
      documents: s.documents.map((d) =>
        d.id === id ? { ...d, status: 'pending', stage: '已入队', progress: 5, error: undefined } : d
      ),
    }))
    pollDocStatus(id, set)
  },

  removeDocument: async (id) => {
    await apiDeleteDocument(id)
    set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }))
    apiFetchKnowledgeStatus()
      .then((status) => set({ status }))
      .catch(() => {})
  },

  createWorkspace: async (name) => {
    const ws = await apiCreateWorkspace(name)
    set((s) => ({ workspaces: [...s.workspaces, ws], activeWorkspaceId: ws.id }))
    get().loadDocuments(ws.id)
    return ws
  },

  removeWorkspace: async (id) => {
    await apiDeleteWorkspace(id)
    const nextWs = get().workspaces.filter((w) => w.id !== id)
    const nextId = nextWs[0]?.id || 'default'
    set({ workspaces: nextWs, activeWorkspaceId: nextId })
    get().loadDocuments(nextId)
  },
}))

/** 单条文档状态 800ms 轮询器 */
async function pollDocStatus(
  id: string,
  set: (fn: (s: KnowledgeState) => Partial<KnowledgeState>) => void
) {
  if (activePolls.has(id)) return
  activePolls.add(id)

  const pollInterval = 800
  const maxAttempts = 300 // 最长等待 4 分钟
  let attempts = 0

  const run = async () => {
    try {
      const doc = await apiFetchDocumentStatus(id)
      set((s) => ({
        documents: s.documents.map((d) => (d.id === id ? doc : d)),
      }))

      if (doc.status === 'ready' || doc.status === 'failed') {
        activePolls.delete(id)
        // 刷新一次全局 status 统计
        apiFetchKnowledgeStatus()
          .then((status) => set(() => ({ status })))
          .catch(() => {})
        return
      }
    } catch {
      // 网络波动继续尝试
    }

    attempts++
    if (attempts < maxAttempts && activePolls.has(id)) {
      setTimeout(run, pollInterval)
    } else {
      activePolls.delete(id)
    }
  }

  setTimeout(run, pollInterval)
}
