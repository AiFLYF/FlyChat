export type Role = 'user' | 'assistant'

export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error' | 'aborted'

/** 附件：图片以 data URL 传递，文档在后端抽取为纯文本 */
export interface Attachment {
  id: string
  type: 'image' | 'file'
  name: string
  mime: string
  size: number
  /** 图片：data URL */
  dataUrl?: string
  /** 图片：用于展示的缩略图（canvas 缩放，比原图小很多，随主 store 内联保存） */
  thumbnail?: string
  /** 文档：抽取出的文本 */
  text?: string
  /**
   * 该附件的 dataUrl 已外置到独立 IndexedDB（flychat-attachments），
   * 主 store 只保留此标记；读取时由存储层重新内联 dataUrl。
   */
  externalized?: boolean
}

/** 联网搜索引用来源 */
export interface Citation {
  index: number
  title: string
  url: string
  content?: string
}

export interface TokenUsage {
  prompt: number
  completion: number
  total: number
}

export interface MessageVariant {
  id: string
  content: string
  reasoning?: string
  reasoningTimeMs?: number
  createdAt: number
  model?: string
  citations?: Citation[]
  usage?: TokenUsage
}

export interface Message {
  id: string
  role: Role
  content: string
  createdAt: number
  /** 该消息使用的模型（assistant 消息） */
  model?: string
  error?: boolean
  status?: MessageStatus
  /** 思考过程（DeepSeek-R1 / reasoner 等） */
  reasoning?: string
  /** 思考耗时（毫秒） */
  reasoningTimeMs?: number
  /** 重新生成的多版本变体 */
  variants?: MessageVariant[]
  /** 当前展示的变体索引 */
  currentVariantIndex?: number
  /** 是否收藏/星标该消息 */
  starred?: boolean
  /** 用户消息携带的附件 */
  attachments?: Attachment[]
  /** 联网搜索引用 */
  citations?: Citation[]
  /** 同一轮多模型对比分组标识 */
  groupId?: string
  /** token 用量 */
  usage?: TokenUsage
  /** 服务端返回的流式元数据（上下文与压缩指标） */
  meta?: {
    model?: string
    contextTokens?: number
    compressed?: boolean
    latencyMs?: number
    contextWindow?: number
  }
}

export interface ServerModelInfo {
  provider: string
  providerName?: string
  model: string
  name: string
  label?: string
  known?: boolean
  contextWindow?: number
  maxOutput?: number
  maxTokens?: number
  capabilities?: {
    vision?: boolean
    tools?: boolean
    reasoning?: boolean
    json?: boolean
    webSearch?: boolean
  }
  pricing?: {
    input?: number
    output?: number
  }
}

export interface ServerUsageSummary {
  available: boolean
  range?: { days: number; since: number }
  totals?: {
    requests: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    costUsd: number
    avgLatencyMs: number
  }
  byDay?: { day: string; requests: number; tokens: number; cost: number }[]
  byModel?: { provider: string; model: string; requests: number; tokens: number; cost: number }[]
}

export interface ShareResponse {
  id: string
  title: string
  url: string
  expiresAt?: string | null
  hasPassword?: boolean
}

export interface ConversationFolder {
  id: string
  name: string
  emoji: string
  color?: string
  collapsed?: boolean
  createdAt: number
}

export type ArtifactType = 'html' | 'svg' | 'react' | 'mermaid' | 'code' | 'markdown'

export interface ArtifactItem {
  id: string
  messageId: string
  title: string
  type: ArtifactType
  content: string
  language?: string
  createdAt: number
  version?: number
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  /** 置顶 */
  pinned?: boolean
  /** 星标/收藏 */
  starred?: boolean
  /** 所属文件夹 */
  folderId?: string | null
  /** 标签 */
  tags?: string[]
  /** 手动拖拽排序的序号（越小越靠前） */
  sortIndex?: number
  /** 是否携带历史上下文 */
  usingContext?: boolean
  /** 绑定的助手 id */
  assistantId?: string
}

export interface MarketAssistant {
  id: string
  name: string
  description: string
  emoji: string
  category: 'code' | 'writing' | 'productivity' | 'business' | 'creative'
  systemPrompt: string
  defaultModel?: string
  temperature?: number
  starterPrompts?: string[]
  badge?: string
}

export type ThemeMode = 'light' | 'dark' | 'system'

/** 提示词库条目 */
export interface PromptItem {
  id: string
  title: string
  content: string
  createdAt: number
}

/** 助手 / 面具 */
export interface Assistant {
  id: string
  name: string
  emoji: string
  systemPrompt: string
  provider?: string
  model?: string
  temperature?: number
}

/** 多模型对比中的一个目标 */
export interface ModelRef {
  provider: string
  model: string
}

export interface Settings {
  provider: string
  model: string
  /** 多模型对比选中的模型（provider::model） */
  compareModels: string[]
  /** 是否开启多模型对比模式 */
  compareEnabled: boolean
  temperature: number
  topP: number
  maxTokens: number
  systemPrompt: string
  theme: ThemeMode
  /** 联网搜索 */
  webSearch: boolean
  /** 深度思考：引导模型先推理再作答 */
  thinking: boolean
  /** 默认是否携带上下文 */
  usingContext: boolean
}

export interface ProviderInfo {
  id: string
  name: string
  models: string[]
  /** env = server/.env 内置；custom = 网页「模型服务」里添加的 */
  source?: 'env' | 'custom'
  /** 是否已配置 API Key（后端只回传布尔值，永不回传密钥本身） */
  hasKey?: boolean
  /** 模型列表是否被网页覆盖过 */
  modelsOverridden?: boolean
  /** 仅自定义服务商返回，供编辑表单回填 */
  type?: string
  baseUrl?: string
}

/** 网页上提交的自定义服务商配置 */
export interface CustomProviderInput {
  /** 不传表示新增 */
  id?: string
  name: string
  type: string
  baseUrl: string
  /** 留空表示不修改已有密钥 */
  apiKey?: string
  models: string[]
}
