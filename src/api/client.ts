import type {
  Attachment,
  AuthConfig,
  AuthMeResponse,
  AuthUser,
  Citation,
  Conversation,
  CustomProviderInput,
  DocumentItem,
  KnowledgeSource,
  KnowledgeStatus,
  McpServer,
  McpTool,
  Message,
  Preset,
  ProviderInfo,
  Role,
  ServerModelInfo,
  ServerUsageSummary,
  Settings,
  ShareResponse,
  TokenUsage,
  ToolCall,
  ToolResult,
  UserRole,
  WorkspaceItem,
} from '../types'

export interface ChatMessagePayload {
  role: Role
  content: string
  attachments?: Attachment[]
}

export interface StreamParams {
  settings: Pick<
    Settings,
    'provider' | 'model' | 'temperature' | 'topP' | 'maxTokens' | 'systemPrompt'
  >
  /** 覆盖模型（多模型对比时使用） */
  model?: string
  messages: ChatMessagePayload[]
  webSearch?: boolean
  /** 深度思考：引导模型先推理再作答 */
  thinking?: boolean
  /** Agent 工具调用开关 */
  agent?: boolean
  /** 工具白名单，true = 全部内置与 MCP，或指定数组 */
  tools?: boolean | string[]
  /** 预设 ID */
  presetId?: string
  /** 绑定的知识库 Workspace ID */
  workspaceId?: string
  /** 消息树父节点 ID */
  parentId?: string
  /** 会话 ID */
  conversationId?: string
  onDelta: (text: string) => void
  onReasoning?: (text: string) => void
  onCitations?: (citations: Citation[]) => void
  onSources?: (sources: KnowledgeSource[]) => void
  onToolCall?: (call: ToolCall) => void
  onToolResult?: (result: ToolResult) => void
  onModelSwitch?: (switchInfo: { from: string; to: string; reason?: string }) => void
  onUsage?: (usage: TokenUsage) => void
  onNotice?: (message: string) => void
  onMeta?: (meta: NonNullable<import('../types').Message['meta']>) => void
}

/** 调用后端流式聊天代理，通过回调逐段返回文本 */
export async function streamChat(params: StreamParams, signal?: AbortSignal): Promise<void> {
  const {
    settings,
    messages,
    onDelta,
    onReasoning,
    onCitations,
    onSources,
    onToolCall,
    onToolResult,
    onModelSwitch,
    onUsage,
    onNotice,
    webSearch,
    thinking,
    agent,
    tools,
    presetId,
    workspaceId,
    parentId,
    conversationId,
  } = params

  const res = await fetch('/api/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: presetId ? undefined : settings.provider,
      model: params.model || (presetId ? undefined : settings.model),
      messages,
      system: presetId ? undefined : settings.systemPrompt || undefined,
      temperature: settings.temperature,
      topP: settings.topP,
      maxTokens: settings.maxTokens,
      webSearch: !!webSearch,
      think: !!thinking,
      agent: !!agent,
      tools: tools !== undefined ? tools : agent ? true : undefined,
      presetId: presetId || undefined,
      workspaceId: workspaceId || undefined,
      parentId: parentId || undefined,
      conversationId: conversationId || undefined,
    }),
    signal,
  })

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const json = await res.json()
      if (res.status === 401 && json?.code === 'login_required') {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('flychat:login_required'))
        }
      }
      detail = json?.error || detail
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  if (!res.body) throw new Error('浏览器不支持流式响应')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let streamError: string | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trimEnd()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        const evt = JSON.parse(payload)
        if (evt.type === 'delta' && evt.content) onDelta(evt.content)
        else if (evt.type === 'reasoning' && evt.content) onReasoning?.(evt.content)
        else if (evt.type === 'citations' && Array.isArray(evt.citations)) onCitations?.(evt.citations)
        else if (evt.type === 'sources' && Array.isArray(evt.sources)) onSources?.(evt.sources)
        else if (evt.type === 'tool_call') onToolCall?.(evt)
        else if (evt.type === 'tool_result') onToolResult?.(evt)
        else if (evt.type === 'model_switch') onModelSwitch?.(evt)
        else if (evt.type === 'usage' && evt.usage) onUsage?.(evt.usage)
        else if (evt.type === 'notice' && evt.message) onNotice?.(evt.message)
        else if (evt.type === 'meta') {
          params.onMeta?.({
            model: evt.model,
            contextTokens: evt.contextTokens ?? evt.context?.estimatedInputTokens,
            compressed: evt.compressed ?? evt.context?.trimmed,
            latencyMs: evt.latencyMs,
            contextWindow: evt.contextWindow,
            preset: evt.preset,
          })
        } else if (evt.type === 'error') {
          streamError = evt.message
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (streamError) throw new Error(streamError)
}

export interface ProvidersResult {
  providers: ProviderInfo[]
  /** 服务端是否配置了联网搜索 */
  webSearch: boolean
}

export async function fetchProviders(): Promise<ProvidersResult> {
  const res = await fetch('/api/providers', { credentials: 'include' })
  if (!res.ok) throw new Error('无法获取可用模型提供商')
  const json = await res.json()
  return { providers: json.providers ?? [], webSearch: !!json.webSearch }
}

/** 统一的写操作封装：后端错误统一在 json.error 里 */
async function postJson<T = Record<string, unknown>>(
  url: string,
  body?: unknown,
  method = 'POST'
): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = {}
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = { error: text }
    }
  }
  if (!res.ok) {
    if (res.status === 401 && json?.code === 'login_required') {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('flychat:login_required'))
      }
    }
    const err = new Error(json?.error || `请求失败 (${res.status})`)
    ;(err as any).code = json?.code
    ;(err as any).status = res.status
    throw err
  }
  return json as T
}

/** 统一的 GET 请求封装 */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  const text = await res.text()
  let json: any = {}
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = { error: text }
    }
  }
  if (!res.ok) {
    if (res.status === 401 && json?.code === 'login_required') {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('flychat:login_required'))
      }
    }
    const err = new Error(json?.error || `请求失败 (${res.status})`)
    ;(err as any).code = json?.code
    ;(err as any).status = res.status
    throw err
  }
  return json as T
}

/* =========================================================================
   自定义服务商与模型配置
   ========================================================================= */

export async function saveCustomProvider(input: CustomProviderInput): Promise<void> {
  await postJson('/api/providers/custom', input)
}

export async function deleteCustomProvider(id: string): Promise<void> {
  await postJson(`/api/providers/custom/${encodeURIComponent(id)}`, undefined, 'DELETE')
}

export async function saveProviderModels(id: string, models: string[]): Promise<void> {
  await postJson(`/api/providers/${encodeURIComponent(id)}/models`, { models }, 'PUT')
}

export async function testProvider(id: string): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`/api/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    credentials: 'include',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error || `自检失败 (${res.status})`)
  return { ok: !!json.ok, message: json.message || '' }
}

export async function extractFile(file: {
  name: string
  mime: string
  dataUrl: string
}): Promise<{ text: string; chars: number; truncated: boolean }> {
  const res = await fetch('/api/extract', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(file),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error || `解析失败 (${res.status})`)
  return json
}

export async function completeOnce(params: {
  settings: Pick<Settings, 'provider' | 'model' | 'temperature'>
  system?: string
  messages: ChatMessagePayload[]
  maxTokens?: number
}): Promise<string> {
  let text = ''
  await streamChat(
    {
      settings: {
        ...params.settings,
        temperature: 0.3,
        topP: 1,
        maxTokens: params.maxTokens ?? 64,
        systemPrompt: params.system ?? '',
      },
      messages: params.messages,
      onDelta: (t) => {
        text += t
      },
    },
    undefined
  )
  return text.trim()
}

export async function fetchModelsCatalog(): Promise<ServerModelInfo[]> {
  try {
    const res = await fetch('/api/models', { credentials: 'include' })
    if (!res.ok) return []
    const json = await res.json()
    return json.models ?? []
  } catch {
    return []
  }
}

export async function generateServerTitle(
  messages: { role: Role; content: string }[],
  provider?: string,
  model?: string
): Promise<string> {
  const res = await fetch('/api/title', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, provider, model }),
  })
  if (!res.ok) throw new Error('服务端标题生成失败')
  const json = await res.json()
  return json.title || '新对话'
}

export async function createShareLink(
  snapshot: Conversation,
  password?: string,
  expiresInDays?: number
): Promise<ShareResponse> {
  const res = await fetch('/api/share', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot, password, expiresInDays }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error || '创建分享链接失败')
  return json
}

export async function fetchServerUsage(): Promise<ServerUsageSummary | null> {
  try {
    const res = await fetch('/api/usage', { credentials: 'include' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function syncConversationToServer(conv: Conversation): Promise<boolean> {
  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(conv),
    })
    return res.ok
  } catch {
    return false
  }
}

export interface SharedConversationData {
  id: string
  title: string
  createdAt: number
  expiresAt: number | null
  views: number
  hasPassword: boolean
  model: string | null
  messages: Message[]
  messageCount: number
}

export async function fetchShareSnapshot(
  shareId: string,
  password?: string
): Promise<SharedConversationData> {
  const query = password ? `?password=${encodeURIComponent(password)}` : ''
  const headers: Record<string, string> = {}
  if (password) {
    headers['x-share-password'] = password
  }
  const res = await fetch(`/api/share/${encodeURIComponent(shareId)}${query}`, {
    credentials: 'include',
    headers,
  })
  if (res.status === 401) {
    const err = new Error('该分享受密码保护，请输入密码')
    ;(err as unknown as Record<string, unknown>).code = 'share_password_required'
    throw err
  }
  if (res.status === 410) {
    const err = new Error('该分享链接已过期')
    ;(err as unknown as Record<string, unknown>).code = 'share_expired'
    throw err
  }
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    throw new Error(json.error || '获取分享内容失败')
  }
  return await res.json()
}

/* =========================================================================
   多用户与认证系统 API (Q-2026-10-19-03)
   ========================================================================= */

export async function fetchAuthConfig(): Promise<AuthConfig> {
  return await getJson<AuthConfig>('/api/config')
}

export async function fetchAuthMe(): Promise<AuthMeResponse> {
  return await getJson<AuthMeResponse>('/api/auth/me')
}

export async function setupAdmin(data: {
  username: string
  password: string
  displayName?: string
}): Promise<{ ok: boolean; user: AuthUser }> {
  return await postJson('/api/auth/setup', data)
}

export async function loginUser(data: {
  username: string
  password: string
}): Promise<{ ok: boolean; user: AuthUser }> {
  return await postJson('/api/auth/login', data)
}

export async function logoutUser(): Promise<{ ok: boolean }> {
  return await postJson('/api/auth/logout', {})
}

export async function updatePassword(data: {
  oldPassword: string
  newPassword: string
}): Promise<{ ok: boolean }> {
  return await postJson('/api/auth/password', data)
}

export async function updateProfile(data: {
  displayName?: string
}): Promise<{ ok: boolean; user: AuthUser }> {
  return await postJson('/api/auth/profile', data, 'PATCH')
}

export async function fetchUsers(): Promise<{ items: AuthUser[] }> {
  return await getJson<{ items: AuthUser[] }>('/api/users')
}

export async function createUser(data: {
  username: string
  password: string
  role?: UserRole
  displayName?: string
}): Promise<{ ok: boolean; user: AuthUser }> {
  return await postJson('/api/users', data)
}

export async function updateUser(
  id: string,
  data: Partial<AuthUser> & { password?: string }
): Promise<{ ok: boolean; user: AuthUser }> {
  return await postJson(`/api/users/${encodeURIComponent(id)}`, data, 'PATCH')
}

export async function deleteUser(id: string): Promise<{ ok: boolean }> {
  return await postJson(`/api/users/${encodeURIComponent(id)}`, undefined, 'DELETE')
}

/* =========================================================================
   预设中心 API (Q-2026-10-19-02)
   ========================================================================= */

export async function fetchPresets(): Promise<{ items: Preset[] }> {
  return await getJson<{ items: Preset[] }>('/api/presets')
}

export async function fetchPreset(id: string): Promise<Preset> {
  return await getJson<Preset>(`/api/presets/${encodeURIComponent(id)}`)
}

export async function savePreset(preset: Partial<Preset>): Promise<Preset> {
  return await postJson<Preset>('/api/presets', preset)
}

export async function updatePreset(id: string, patch: Partial<Preset>): Promise<Preset> {
  return await postJson<Preset>(`/api/presets/${encodeURIComponent(id)}`, patch, 'PUT')
}

export async function deletePreset(id: string): Promise<{ ok: boolean }> {
  return await postJson(`/api/presets/${encodeURIComponent(id)}`, undefined, 'DELETE')
}

export async function duplicatePreset(id: string, name?: string): Promise<Preset> {
  return await postJson<Preset>(`/api/presets/${encodeURIComponent(id)}/duplicate`, { name })
}

/* =========================================================================
   MCP 协议管理 API (Q-2026-10-18-04)
   ========================================================================= */

export async function fetchMcpServers(): Promise<{ items: McpServer[] }> {
  return await getJson<{ items: McpServer[] }>('/api/mcp/servers')
}

export async function saveMcpServer(server: Partial<McpServer>): Promise<McpServer> {
  return await postJson<McpServer>('/api/mcp/servers', server)
}

export async function deleteMcpServer(id: string): Promise<{ ok: boolean }> {
  return await postJson(`/api/mcp/servers/${encodeURIComponent(id)}`, undefined, 'DELETE')
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }> {
  return await postJson(`/api/mcp/servers/${encodeURIComponent(id)}/enable`, { enabled })
}

export async function setMcpServerTrusted(id: string, trusted: boolean): Promise<{ ok: boolean }> {
  return await postJson(`/api/mcp/servers/${encodeURIComponent(id)}/trust`, { trusted })
}

export async function probeMcpServer(
  id: string
): Promise<{ ok: boolean; tools: McpTool[]; error?: string }> {
  return await postJson(`/api/mcp/servers/${encodeURIComponent(id)}/probe`, {})
}

export async function setMcpToolDisabled(
  id: string,
  toolName: string,
  disabled: boolean
): Promise<{ ok: boolean }> {
  return await postJson(
    `/api/mcp/servers/${encodeURIComponent(id)}/tools/${encodeURIComponent(toolName)}/disable`,
    { disabled }
  )
}

/* =========================================================================
   知识库 RAG 与异步文档上传 API (Q-2026-10-19-01, Q-2026-10-18-02)
   ========================================================================= */

export async function fetchKnowledgeStatus(): Promise<KnowledgeStatus> {
  return await getJson<KnowledgeStatus>('/api/knowledge/status')
}

export async function fetchWorkspaces(): Promise<{
  items: WorkspaceItem[]
  defaultId: string
}> {
  return await getJson<{ items: WorkspaceItem[]; defaultId: string }>('/api/workspaces')
}

export async function createWorkspace(name: string): Promise<WorkspaceItem> {
  return await postJson<WorkspaceItem>('/api/workspaces', { name })
}

export async function deleteWorkspace(id: string): Promise<{ ok: boolean }> {
  return await postJson(`/api/workspaces/${encodeURIComponent(id)}`, undefined, 'DELETE')
}

export async function fetchDocuments(workspaceId?: string): Promise<{ items: DocumentItem[] }> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''
  return await getJson<{ items: DocumentItem[] }>(`/api/documents${query}`)
}

export async function uploadDocument(data: {
  workspaceId?: string
  name?: string
  mime?: string
  dataUrl?: string
  text?: string
  url?: string
  size?: number
}): Promise<DocumentItem & { duplicate?: boolean; documentId?: string }> {
  return await postJson('/api/documents', data)
}

export async function fetchDocumentStatus(id: string): Promise<DocumentItem> {
  return await getJson<DocumentItem>(`/api/documents/${encodeURIComponent(id)}`)
}

export async function retryDocument(id: string): Promise<{ ok: boolean }> {
  return await postJson(`/api/documents/${encodeURIComponent(id)}/retry`, {})
}

export async function deleteDocument(id: string): Promise<{ ok: boolean }> {
  return await postJson(`/api/documents/${encodeURIComponent(id)}`, undefined, 'DELETE')
}
