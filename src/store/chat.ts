import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Conversation, Message, Settings, ThemeMode } from '../types'

interface ChatState {
  conversations: Conversation[]
  activeId: string | null
  settings: Settings
  sidebarOpen: boolean

  createConversation: () => string
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  setActive: (id: string | null) => void
  addMessage: (conversationId: string, message: Message) => void
  appendToMessage: (conversationId: string, messageId: string, text: string) => void
  updateMessage: (conversationId: string, messageId: string, patch: Partial<Message>) => void
  removeMessagesAfter: (conversationId: string, messageId: string) => void
  clearAll: () => void
  updateSettings: (patch: Partial<Settings>) => void
  toggleSidebar: () => void
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      conversations: [],
      activeId: null,
      settings: {
        provider: '',
        model: '',
        temperature: 0.7,
        systemPrompt: '',
        theme: 'system' as ThemeMode,
      },
      sidebarOpen: true,

      createConversation: () => {
        const now = Date.now()
        const conv: Conversation = {
          id: uid(),
          title: '新对话',
          messages: [],
          createdAt: now,
          updatedAt: now,
        }
        set((s) => ({ conversations: [conv, ...s.conversations], activeId: conv.id }))
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

      renameConversation: (id, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
        })),

      setActive: (id) => set({ activeId: id }),

      addMessage: (conversationId, message) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id !== conversationId
              ? c
              : {
                  ...c,
                  messages: [...c.messages, message],
                  updatedAt: Date.now(),
                  // 第一条用户消息自动作为会话标题
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

      updateMessage: (conversationId, messageId, patch) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id !== conversationId
              ? c
              : {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, ...patch } : m
                  ),
                }
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

      clearAll: () => set({ conversations: [], activeId: null }),

      updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    }),
    {
      name: 'flychat-store',
      partialize: (s) => ({
        conversations: s.conversations,
        activeId: s.activeId,
        settings: s.settings,
        sidebarOpen: s.sidebarOpen,
      }),
    }
  )
)

export { uid }
