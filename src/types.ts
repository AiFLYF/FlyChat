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
  sources?: KnowledgeSource[]
  toolCalls?: ToolCall[]
  toolResults?: ToolResult[]
  modelSwitch?: { from: string; to: string; reason?: string }
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
  /** 评价反馈（点赞或点踩） */
  feedback?: 'like' | 'dislike' | null
  /** 用户消息携带的附件 */
  attachments?: Attachment[]
  /** 联网搜索引用 */
  citations?: Citation[]
  /** 知识库 RAG 引用来源 */
  sources?: KnowledgeSource[]
  /** 工具调用 */
  toolCalls?: ToolCall[]
  /** 工具调用结果 */
  toolResults?: ToolResult[]
  /** 模型故障自动降级切换记录 */
  modelSwitch?: { from: string; to: string; reason?: string }
  /** 树形结构父节点 ID */
  parentId?: string
  /** 同一轮多模型对比分组标识 */
  groupId?: string
  /** 模型生成的图片（Q-2026-10-19-10） */
  generatedImages?: { url?: string; dataUrl?: string; revisedPrompt?: string }[]
  /** 任务模型生成的追问建议 chips（Q-2026-10-19-06） */
  suggestions?: string[]
  /** token 用量 */
  usage?: TokenUsage
  /** 服务端返回的流式元数据（上下文与压缩指标） */
  meta?: {
    model?: string
    contextTokens?: number
    compressed?: boolean
    latencyMs?: number
    contextWindow?: number
    preset?: { id: string; name: string; icon?: string }
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
  /** 限定知识库文档提问 (Q-2026-10-19-07) */
  documentIds?: string[]
  /** 会话总结摘要 (Q-2026-10-19-06) */
  summary?: string
  /** 该会话专属的系统提示词（会话间彻底隔离，避免专家提示词污染普通新对话） */
  systemPrompt?: string
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
  /** 智能体工具调用 (Agent / MCP) */
  tools?: boolean
  /** 是否开启图像生成能力 (Q-2026-10-19-10) */
  imageGeneration?: boolean
  /** 关联知识库工作区 ID */
  workspaceId?: string
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

/* =========================================================================
   多用户与认证系统 (Multi-User & Auth)
   ========================================================================= */

export type UserRole = 'admin' | 'user'

export interface AuthUser {
  id: string
  username: string
  displayName?: string
  role: UserRole
  disabled?: boolean
  hasApiToken?: boolean
  authVia?: 'cookie' | 'token' | null
  lastLoginAt?: number
  createdAt?: number
}

export interface AuthConfig {
  authMode: 'single' | 'multi'
  needsSetup: boolean
  authRequired: boolean
  features?: {
    tools?: boolean
    knowledge?: boolean
    mcp?: boolean
    presets?: boolean
    image?: boolean
    [key: string]: boolean | undefined
  }
}

export interface AuthMeResponse {
  multiUser: boolean
  needsSetup: boolean
  user: AuthUser | null
}

/* =========================================================================
   预设中心 (Presets)
   ========================================================================= */

export interface PresetParams {
  temperature?: number
  topP?: number
  maxTokens?: number
  think?: boolean
  webSearch?: boolean
  agent?: boolean
  tools?: boolean | string[]
  topK?: number
  imageGeneration?: boolean
  /** 图像理解与视觉识别 (Vision) */
  vision?: boolean
  mcpMode?: 'all' | 'selected'
}

export interface Preset {
  id: string
  name: string
  description?: string
  icon?: string
  provider?: string
  model?: string
  systemPrompt?: string
  params?: PresetParams
  workspaceId?: string
  mcpServers?: string[]
  sortIndex?: number
  createdAt?: number
  updatedAt?: number
}

/* =========================================================================
   MCP 协议客户端 (Model Context Protocol)
   ========================================================================= */

export type McpTransport = 'stdio' | 'http'

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
  readOnly?: boolean
  disabled?: boolean
}

export interface McpServer {
  id: string
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  baseUrl?: string
  headers?: Record<string, string>
  enabled: boolean
  trusted: boolean
  toolCount?: number
  tools?: McpTool[]
  lastError?: string
  createdAt?: number
  updatedAt?: number
}

/* =========================================================================
   知识库 RAG 与异步文档上传
   ========================================================================= */

export interface KnowledgeStatus {
  documents: number
  chunks: number
  processing: number
  failed: number
  pending: number
  workspaces: number
  enabled: boolean
  embedding?: { provider: string; name: string; model: string }
}

export interface WorkspaceItem {
  id: string
  name: string
  docCount: number
  chunkCount: number
}

export type DocumentStage =
  | '已入队'
  | '抓取网页'
  | '解析文件'
  | '切块'
  | '向量化'
  | '写入数据库'
  | '已完成'
  | '失败'
  | '中断'
  | string

export interface DocumentItem {
  id: string
  workspaceId: string
  name: string
  sourceUrl?: string
  mime?: string
  size?: number
  chars?: number
  chunkCount?: number
  status: 'pending' | 'processing' | 'ready' | 'failed'
  stage: DocumentStage
  progress: number
  attempts: number
  error?: string
  createdAt?: number
  updatedAt?: number
}

export interface KnowledgeSource {
  index?: number
  title?: string
  documentId?: string
  documentName?: string
  heading?: string
  snippet?: string
  content?: string
  score?: number
  similarity?: number
  chunkIndex?: number
}

/* =========================================================================
   Agent 工具调用 (Tool Calling)
   ========================================================================= */

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown> | string
  status?: 'running' | 'done' | 'error'
}

export interface ToolResult {
  id: string
  name?: string
  ok?: boolean
  preview?: string
  result?: unknown
  error?: string
}

/* =========================================================================
   服务端会话文件夹与标签 (Q-2026-10-19-05)
   ========================================================================= */

export interface ServerFolderItem {
  id: string
  name: string
  icon?: string
  count?: number
  sortIndex?: number
}

export interface ServerTagItem {
  name: string
  count: number
}

/* =========================================================================
   小任务接口与改写风格 (Q-2026-10-19-06)
   ========================================================================= */

export interface TaskToneItem {
  key: string
  instruction: string
}

/* =========================================================================
   知识库多维打分诊断视图 (Q-2026-10-19-07)
   ========================================================================= */

export interface RetrieveDebugCandidate {
  id: string
  documentName: string
  seq: number
  heading?: string
  preview?: string
  score: number
  vectorScore: number
  keywordScore: number
  phraseScore: number
  headingScore: number
  picked: boolean
  belowThreshold: boolean
}

export interface RetrieveDebugResult {
  totalChunks: number
  passedThreshold: number
  vectorUsed: boolean
  candidates: RetrieveDebugCandidate[]
}

/* =========================================================================
   图像生成服务能力 (Q-2026-10-19-10)
   ========================================================================= */

export interface ImageStatus {
  available: boolean
  provider?: string
  providerName?: string
  model?: string
  reason?: string
}


