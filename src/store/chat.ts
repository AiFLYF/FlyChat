import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { idbStorage } from '../lib/db'
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
  reorderConversations: (orderedIds: string[]) => void

  createFolder: (name: string, emoji?: string, color?: string) => string
  updateFolder: (id: string, patch: Partial<ConversationFolder>) => void
  deleteFolder: (id: string) => void
  moveConversationToFolder: (conversationId: string, folderId: string | null) => void

  addMessage: (conversationId: string, message: Message) => void
  appendToMessage: (conversationId: string, messageId: string, text: string) => void
  appendReasoning: (conversationId: string, messageId: string, text: string) => void
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
        const conv: Conversation = {
          id: uid(),
          title: '新对话',
          messages: [],
          createdAt: now,
          updatedAt: now,
          usingContext: true,
          assistantId,
          sortIndex: minIndex - 1,
        }
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeId: conv.id,
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

      deleteConversation: (id) =>
        set((s) => {
          const conversations = s.conversations.filter((c) => c.id !== id)
          return {
            conversations,
            activeId: s.activeId === id ? conversations[0]?.id ?? null : s.activeId,
          }
        }),

      restoreConversation: (conv) =>
        set((s) => ({
          conversations: s.conversations.some((c) => c.id === conv.id)
            ? s.conversations
            : [conv, ...s.conversations],
          activeId: conv.id,
        })),

      renameConversation: (id, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c
          ),
        })),

      setActive: (id) => set({ activeId: id }),

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

      clearAll: () => set({ conversations: [], activeId: null }),

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
      name: 'flychat-store',
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
        return {
          ...current,
          ...p,
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

export { uid }
