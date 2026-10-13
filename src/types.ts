export type Role = 'user' | 'assistant'

export interface Message {
  id: string
  role: Role
  content: string
  createdAt: number
  /** 该消息使用的模型（assistant 消息） */
  model?: string
  error?: boolean
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}

export type ThemeMode = 'light' | 'dark' | 'system'

export interface Settings {
  provider: string
  model: string
  temperature: number
  systemPrompt: string
  theme: ThemeMode
}

export interface ProviderInfo {
  id: string
  name: string
  models: string[]
}
