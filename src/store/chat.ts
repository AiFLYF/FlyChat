import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { clearConversationsFromServer } from '../api/client'
import { flushPersist, idbStorage, setPersistenceEnabled } from '../lib/db'
import {
  queueConversationDelete,
  resetServerSyncQueue,
  restoreConversationSync,
  setServerSyncScope,
} from '../lib/serverSync'
import { uid } from '../lib/id'
import type {
  Assistant,
  Conversation,
  ConversationFolder,
  Message,
  PromptItem,
  Settings,
  ThemeMode,
} from '../types'

interface ChatState {
  conversations: Conversation[]
  folders: ConversationFolder[]
  activeId: string | null
  settings: Settings
  sidebarOpen: boolean
  prompts: PromptItem[]
  assistants: Assistant[]
  /** IndexedDB 恢复完成标记 */
  hydrated: boolean

  createConversation: (assistantId?: string) => string
  deleteConversation: (id: string) => void
  restoreConversation: (conv: Conversation) => void
  renameConversation: (id: string, title: string) => void
  setActive: (id: string | null) => void
  togglePin: (id: string) => void
  toggleConversationStar: (id: string) => void
  setUsingContext: (id: string, value: boolean) => void
  setConversationAssistant: (id: string, assistantId: string | undefined) => void
  setConversationTags: (id: string, tags: string[]) => void
  setConversationDocumentIds: (id: string, documentIds: string[] | undefined) => void
  setConversationSummary: (id: string, summary: string) => void
  setConversationSystemPrompt: (id: string, systemPrompt: string) => void
  reorderConversations: (orderedIds: string[]) => void

  setFolders: (folders: ConversationFolder[]) => void
  /** 文件夹迁移后把会话上的临时 folderId 换成服务端 id */
  applyFolderIdMap: (idMap: Map<string, string>) => void
  createFolder: (name: string, emoji?: string, color?: string) => string
  updateFolder: (id: string, patch: Partial<ConversationFolder>) => void
  deleteFolder: (id: string) => void
  moveConversationToFolder: (conversationId: string, folderId: string | null) => void

  addMessage: (conversationId: string, message: Message) => void
  appendToMessage: (conversationId: string, messageId: string, text: string) => void
  appendReasoning: (conversationId: string, messageId: string, text: string) => void
  appendGeneratedImages: (
    conversationId: string,
    messageId: string,
    images: { url?: string; dataUrl?: string; revisedPrompt?: string }[]
  ) => void
  setMessageSuggestions: (conversationId: string, messageId: string, suggestions: string[]) => void
  updateMessage: (conversationId: string, messageId: string, patch: Partial<Message>) => void
  toggleMessageStar: (conversationId: string, messageId: string) => void
  switchMessageVariant: (conversationId: string, messageId: string, variantIndex: number) => void
  removeMessage: (conversationId: string, messageId: string) => void
  removeMessagesAfter: (conversationId: string, messageId: string) => void
  clearMessages: (conversationId: string) => void
  clearAll: () => void

  updateSettings: (patch: Partial<Settings>) => void
  toggleSidebar: () => void

  addPrompt: (prompt: PromptItem) => void
  updatePrompt: (id: string, patch: Partial<PromptItem>) => void
  removePrompt: (id: string) => void

  addAssistant: (assistant: Assistant) => void
  updateAssistant: (id: string, patch: Partial<Assistant>) => void
  removeAssistant: (id: string) => void

  importConversations: (conversations: Conversation[]) => void
  setHydrated: (v: boolean) => void
}

export const DEFAULT_SETTINGS: Settings = {
  provider: '',
  model: '',
  compareModels: [],
  compareEnabled: false,
  temperature: 0.7,
  topP: 1,
  maxTokens: 4096,
  systemPrompt: '',
  theme: 'system' as ThemeMode,
  webSearch: false,
  thinking: false,
  tools: true,
  workspaceId: '',
  usingContext: true,
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      conversations: [],
      folders: [],
      activeId: null,
      settings: DEFAULT_SETTINGS,
      sidebarOpen: typeof window === 'undefined' ? true : window.innerWidth >= 768,
      prompts: [],
      assistants: [],
      hydrated: false,

      createConversation: (assistantId) => {
        const now = Date.now()
        const state = useChatStore.getState()
        const assistant = assistantId ? state.assistants.find((a) => a.id === assistantId) : undefined
        const minIndex = state.conversations.reduce(
          (min, c) => (typeof c.sortIndex === 'number' ? Math.min(min, c.sortIndex) : min),
          0
        )
        const convTitle = assistant ? `${assistant.emoji} ${assistant.name}` : '新对话'
        const conv: Conversation = {
          id: uid(),
          title: convTitle,
          messages: [],
          createdAt: now,
          updatedAt: now,
          usingContext: true,
          assistantId,
          systemPrompt: assistant?.systemPrompt ?? '',
          sortIndex: minIndex - 1,
        }
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeId: conv.id,
          // 全局系统提示词是「用户偏好」，不随会话切换增删；
          // 助手/会话级指令只写进 conv.systemPrompt，发送时优先级更高。
          settings: assistant
            ? {
                ...s.settings,
                provider: assistant.provider || s.settings.provider,
                model: assistant.model || s.settings.model,
                temperature: assistant.temperature ?? s.settings.temperature,
              }
            : s.settings,
        }))
        return conv.id
      },

      deleteConversation: (id) => {
        set((s) => {
          const conversations = s.conversations.filter((c) => c.id !== id)
          return {
            conversations,
            activeId: s.activeId === id ? conversations[0]?.id ?? null : s.activeId,
          }
        })
        // 本地立即删除；服务端删除失败（离线/未同步/单用户无存储）不阻塞 UI，交给队列重试
        queueConversationDelete(id)
      },

      restoreConversation: (conv) => {
        set((s) => ({
          conversations: s.conversations.some((c) => c.id === conv.id)
            ? s.conversations
            : [conv, ...s.conversations],
          activeId: conv.id,
        }))
        // 撤销删除时删除任务可能还在队列里：取消并重新同步，避免服务端副本被删掉
        void restoreConversationSync(conv)
      },

      renameConversation: (id, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
        })),

      setActive: (id) => {
        const state = useChatStore.getState()
        const conv = state.conversations.find((c) => c.id === id)
        if (conv) {
          const assistant = conv.assistantId
            ? state.assistants.find((a) => a.id === conv.assistantId)
            : undefined
          set({
            activeId: id,
            // 切回助手会话时恢复它绑定的模型。
            // 只恢复模型不恢复提示词：系统提示词按「会话 > 助手 > 全局默认」解析，
            // 切会话不能把用户在设置里写的全局默认指令抹掉。
            settings: assistant
              ? {
                  ...state.settings,
                  provider: assistant.provider || state.settings.provider,
                  model: assistant.model || state.settings.model,
                  temperature: assistant.temperature ?? state.settings.temperature,
                }
              : state.settings,
          })
        } else {
          set({ activeId: id })
        }
      },

      togglePin: (id) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, pinned: !c.pinned, updatedAt: Date.now() } : c
          ),
        })),

      toggleConversationStar: (id) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, starred: !c.starred, updatedAt: Date.now() } : c
          ),
        })),

      setFolders: (folders) => set({ folders }),

      applyFolderIdMap: (idMap) =>
        set((s) => ({
          folders: s.folders.map((f) => {
            const next = idMap.get(f.id)
            return next ? { ...f, id: next } : f
          }),
          conversations: s.conversations.map((c) => {
            const next = c.folderId ? idMap.get(c.folderId) : undefined
            return next ? { ...c, folderId: next } : c
          }),
        })),

      createFolder: (name, emoji = '📁', color = 'blue') => {
        const id = uid()
        set((s) => ({
          folders: [
            ...s.folders,
            { id, name, emoji, color, collapsed: false, createdAt: Date.now() },
          ],
        }))
        return id
      },

      updateFolder: (id, patch) =>
        set((s) => ({
          folders: s.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)),
        })),

      deleteFolder: (id) =>
        set((s) => ({
          folders: s.folders.filter((f) => f.id !== id),
          conversations: s.conversations.map((c) =>
            c.folderId === id ? { ...c, folderId: null } : c
          ),
        })),

      moveConversationToFolder: (conversationId, folderId) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, folderId, updatedAt: Date.now() } : c
          ),
        })),

      setUsingContext: (id, value) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, usingContext: value, updatedAt: Date.now() } : c
          ),
        })),

      setConversationAssistant: (id, assistantId) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, assistantId, updatedAt: Date.now() } : c
          ),
        })),

      setConversationTags: (id, tags) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, tags, updatedAt: Date.now() } : c
          ),
        })),

      setConversationDocumentIds: (id, documentIds) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, documentIds, updatedAt: Date.now() } : c
          ),
        })),

      setConversationSummary: (id, summary) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, summary, updatedAt: Date.now() } : c
          ),
        })),

      setConversationSystemPrompt: (id, systemPrompt) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, systemPrompt, updatedAt: Date.now() } : c
          ),
        })),

      reorderConversations: (orderedIds) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            const idx = orderedIds.indexOf(c.id)
            return idx >= 0 ? { ...c, sortIndex: idx } : c
          }),
        })),

      addMessage: (conversationId, message) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id !== conversationId
              ? c
              : {
                  ...c,
                  messages: [...c.messages, message],
                  updatedAt: Date.now(),
                  // 第一条用户消息自动作为会话标题（后续可由模型优化）
                  title:
                    c.title === '新对话' && message.role === 'user'
                      ? message.content.slice(0, 30) || c.title
                      : c.title,
                }
          ),
        })),

      appendToMessage: (conversationId, messageId, text) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id !== conversationId
              ? c
              : {
                  ...c,
                  updatedAt: Date.now(),
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, content: m.content + text } : m
                  ),
                }
          ),
        })),

      appendReasoning: (conversationId, messageId, text) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id !== conversationId
              ? c
              : {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, reasoning: (m.reasoning ?? '') + text } : m
                  ),
                }
          ),
        })),

      appendGeneratedImages: (conversationId, messageId, images) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id !== conversationId
              ? c
              : {
                  ...c,
                  updatedAt: Date.now(),
                  messages: c.messages.map((m) =>
                    m.id === messageId
                      ? {
                          ...m,
                          generatedImages: [...(m.generatedImages || []), ...images],
                        }
                      : m
                  ),
                }
          ),
        })),

      setMessageSuggestions: (conversationId, messageId, suggestions) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id !== conversationId
              ? c
              : {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, suggestions } : m
                  ),
                }
          ),
        })),

      updateMessage: (conversationId, messageId, patch) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id !== conversationId
              ? c
              : {
                  ...c,
                  messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
                }
          ),
        })),

      toggleMessageStar: (conversationId, messageId) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId) return c
            return {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, starred: !m.starred } : m
              ),
            }
          }),
        })),

      switchMessageVariant: (conversationId, messageId, variantIndex) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId) return c
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId || !m.variants || !m.variants[variantIndex]) return m
                const v = m.variants[variantIndex]
                return {
                  ...m,
                  content: v.content,
                  reasoning: v.reasoning,
                  reasoningTimeMs: v.reasoningTimeMs,
                  model: v.model || m.model,
                  citations: v.citations || m.citations,
                  currentVariantIndex: variantIndex,
                }
              }),
            }
          }),
        })),

      removeMessage: (conversationId, messageId) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id !== conversationId
              ? c
              : { ...c, messages: c.messages.filter((m) => m.id !== messageId), updatedAt: Date.now() }
          ),
        })),

      removeMessagesAfter: (conversationId, messageId) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const idx = c.messages.findIndex((m) => m.id === messageId)
            return idx >= 0 ? { ...c, messages: c.messages.slice(0, idx + 1) } : c
          }),
        })),

      clearMessages: (conversationId) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, messages: [], title: '新对话' } : c
          ),
        })),

      clearAll: () => {
        set({ conversations: [], activeId: null })
        // 先取消 outbox 里的待办并等在途同步落地，再清服务端：
        // 否则排队中的同步会在清空之后把会话重新写回去
        void resetServerSyncQueue()
          .then(() => clearConversationsFromServer())
          .catch(() => {})
      },

      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

      addPrompt: (prompt) => set((s) => ({ prompts: [prompt, ...s.prompts] })),
      updatePrompt: (id, patch) =>
        set((s) => ({ prompts: s.prompts.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
      removePrompt: (id) => set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) })),

      addAssistant: (assistant) => set((s) => ({ assistants: [assistant, ...s.assistants] })),
      updateAssistant: (id, patch) =>
        set((s) => ({
          assistants: s.assistants.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        })),
      removeAssistant: (id) =>
        set((s) => ({ assistants: s.assistants.filter((a) => a.id !== id) })),

      importConversations: (incoming) =>
        set((s) => {
          const existing = new Set(s.conversations.map((c) => c.id))
          const merged = [...incoming.filter((c) => !existing.has(c.id)), ...s.conversations]
          return { conversations: merged, activeId: merged[0]?.id ?? null }
        }),

      setHydrated: (v) => set({ hydrated: v }),
    }),
    {
      name: 'flychat-guest',
      skipHydration: true,
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => ({
        conversations: s.conversations,
        folders: s.folders,
        activeId: s.activeId,
        settings: s.settings,
        sidebarOpen: s.sidebarOpen,
        prompts: s.prompts,
        assistants: s.assistants,
      }),
      // 兼容旧版本：补齐新增设置字段
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ChatState>
        // 上次关闭时正好在流式输出中途，streaming 状态会落盘；
        // 恢复后已没有流在跑，归一为 aborted，否则输入框/重发会一直被当成生成中。
        const conversations = Array.isArray(p.conversations)
          ? p.conversations.map((c) => ({
              ...c,
              messages: Array.isArray(c.messages)
                ? c.messages.map((m) => (m?.status === 'streaming' ? { ...m, status: 'aborted' as const } : m))
                : c.messages,
            }))
          : current.conversations
        return {
          ...current,
          ...p,
          conversations,
          settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
        }
      },
      onRehydrateStorage: () => (_state, error) => {
        if (error) console.warn('[FlyChat] 本地数据恢复失败：', error)
        // 无论成功与否都要放行，避免界面卡在加载态
        useChatStore.getState().setHydrated(true)
      },
    }
  )
)

let activeStorage: string | null = null
let scopeQueue: Promise<void> = Promise.resolve()

export function activateChatStorage(name: string): Promise<void> {
  scopeQueue = scopeQueue.then(async () => {
    if (activeStorage === name) return
    setPersistenceEnabled(false)
    try {
      await flushPersist()
      // 身份切换：旧账号的待办留在它自己的作用域里，不能带着新 cookie 发出去
      setServerSyncScope(name)
      useChatStore.persist.setOptions({ name })
      useChatStore.setState({ ...useChatStore.getInitialState(), hydrated: false })
      await useChatStore.persist.rehydrate()
      activeStorage = name
    } finally {
      setPersistenceEnabled(true)
    }
  })
  return scopeQueue
}

export { uid }
