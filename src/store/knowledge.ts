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
  reset: () => void
}

const activePolls = new Map<string, symbol>()
let documentRequest = 0
let sessionVersion = 0

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
    activePolls.clear()
    set({ activeWorkspaceId: id, documents: [] })
    void get().loadDocuments(id)
  },

  loadAll: async () => {
    const session = sessionVersion
    try {
      set({ loading: true })
      const [status, wsRes] = await Promise.all([
        apiFetchKnowledgeStatus().catch(() => null),
        apiFetchWorkspaces().catch(() => ({ items: [], defaultId: 'default' })),
      ])
      if (session !== sessionVersion) return
      const current = get().activeWorkspaceId
      const activeId = wsRes.items.some((w) => w.id === current)
        ? current
        : wsRes.defaultId || wsRes.items[0]?.id || 'default'
      set({
        status,
        workspaces: wsRes.items,
        defaultWorkspaceId: wsRes.defaultId,
        activeWorkspaceId: activeId,
      })
      await get().loadDocuments(activeId)
    } finally {
      if (session === sessionVersion) set({ loading: false })
    }
  },

  loadDocuments: async (workspaceId) => {
    const wsId = workspaceId || get().activeWorkspaceId || 'default'
    if (wsId !== get().activeWorkspaceId) return
    const request = ++documentRequest
    try {
      const res = await apiFetchDocuments(wsId)
      if (request !== documentRequest || wsId !== get().activeWorkspaceId) return
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
    const session = sessionVersion
    const wsId = data.workspaceId || get().activeWorkspaceId || 'default'
    const res = await apiUploadDocument({ ...data, workspaceId: wsId })
    if (session !== sessionVersion) return res as DocumentItem

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

    if (get().activeWorkspaceId === wsId) {
      set((s) => ({
        documents: [newDoc, ...s.documents.filter((d) => d.id !== newDoc.id)],
      }))
      pollDocStatus(newDoc.id, set)
    }
    return newDoc
  },

  retry: async (id) => {
    const session = sessionVersion
    await apiRetryDocument(id)
    if (session !== sessionVersion || !get().documents.some((doc) => doc.id === id)) return
    set((s) => ({
      documents: s.documents.map((d) =>
        d.id === id ? { ...d, status: 'pending', stage: '已入队', progress: 5, error: undefined } : d
      ),
    }))
    pollDocStatus(id, set)
  },

  removeDocument: async (id) => {
    const session = sessionVersion
    const workspaceId = get().documents.find((doc) => doc.id === id)?.workspaceId || get().activeWorkspaceId
    await apiDeleteDocument(id)
    if (session !== sessionVersion) return
    activePolls.delete(id)
    if (get().activeWorkspaceId === workspaceId) {
      documentRequest += 1
      set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }))
      void get().loadDocuments(workspaceId)
    }
    apiFetchKnowledgeStatus()
      .then((status) => { if (session === sessionVersion) set({ status }) })
      .catch(() => {})
  },

  createWorkspace: async (name) => {
    const session = sessionVersion
    const ws = await apiCreateWorkspace(name)
    if (session !== sessionVersion) return ws
    set((s) => ({ workspaces: [...s.workspaces, ws] }))
    get().setActiveWorkspaceId(ws.id)
    return ws
  },

  removeWorkspace: async (id) => {
    const session = sessionVersion
    await apiDeleteWorkspace(id)
    if (session !== sessionVersion) return
    const nextWs = get().workspaces.filter((w) => w.id !== id)
    set({ workspaces: nextWs })
    if (get().activeWorkspaceId === id) {
      get().setActiveWorkspaceId(nextWs[0]?.id || get().defaultWorkspaceId)
    }
  },

  reset: () => {
    sessionVersion += 1
    documentRequest += 1
    activePolls.clear()
    set(useKnowledgeStore.getInitialState())
  },
}))

/** 单条文档状态 800ms 轮询器 */
async function pollDocStatus(
  id: string,
  set: (fn: (s: KnowledgeState) => Partial<KnowledgeState>) => void
) {
  if (activePolls.has(id)) return
  const token = Symbol(id)
  const session = sessionVersion
  activePolls.set(id, token)

  const pollInterval = 800
  const maxAttempts = 300 // 最长等待 4 分钟
  let attempts = 0

  const run = async () => {
    if (activePolls.get(id) !== token) return
    try {
      const doc = await apiFetchDocumentStatus(id)
      if (activePolls.get(id) !== token) return
      set((s) => ({
        documents: s.documents.map((d) => (d.id === id ? doc : d)),
      }))

      if (doc.status === 'ready' || doc.status === 'failed') {
        activePolls.delete(id)
        // 刷新一次全局 status 统计
        apiFetchKnowledgeStatus()
          .then((status) => { if (session === sessionVersion) set(() => ({ status })) })
          .catch(() => {})
        return
      }
    } catch {
      // 网络波动继续尝试。
    }

    if (activePolls.get(id) !== token) return
    attempts++
    if (attempts < maxAttempts) {
      setTimeout(run, pollInterval)
    } else {
      activePolls.delete(id)
    }
  }

  setTimeout(run, pollInterval)
}
