import type {
  Attachment,
  AuthConfig,
  AuthMeResponse,
  AuthUser,
  Citation,
  Conversation,
  CustomProviderInput,
  DocumentItem,
  ImageStatus,
  KnowledgeSource,
  KnowledgeStatus,
  McpServer,
  McpTool,
  Message,
  Preset,
  ProviderInfo,
  RetrieveDebugResult,
  Role,
  ServerFolderItem,
  ServerModelInfo,
  ServerTagItem,
  ServerUsageSummary,
  Settings,
  ShareResponse,
  TaskToneItem,
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

/** 短 GET 的统一超时：服务端接受连接却迟迟不回时，界面不能无限转圈 */
const GET_TIMEOUT_MS = 30_000

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
  /** 限定检索文档 IDs (Q-2026-10-19-07) */
  documentIds?: string[]
  /** 消息树父节点 ID */
  parentId?: string
  /** 会话 ID */
  conversationId?: string
  /** 模型图像生成工具调用开关 (Q-2026-10-19-10) */
  imageGeneration?: boolean
  onDelta: (text: string) => void
  onReasoning?: (text: string) => void
  onCitations?: (citations: Citation[]) => void
  onSources?: (sources: KnowledgeSource[]) => void
  onToolCall?: (call: ToolCall) => void
  onToolResult?: (result: ToolResult) => void
  onModelSwitch?: (switchInfo: { from: string; to: string; reason?: string }) => void
  onUsage?: (usage: TokenUsage) => void
  onNotice?: (message: string) => void
  onImage?: (event: {
    images: { url?: string; dataUrl?: string; revisedPrompt?: string }[]
    prompt?: string
    model?: string
  }) => void
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
    onImage,
    webSearch,
    thinking,
    agent,
    tools,
    presetId,
    workspaceId,
    documentIds,
    parentId,
    conversationId,
    imageGeneration,
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
      documentIds: documentIds && documentIds.length > 0 ? documentIds : undefined,
      parentId: parentId || undefined,
      conversationId: conversationId || undefined,
      imageGeneration: !!imageGeneration,
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
  let receivedDone = false

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload) return
    let evt
    try {
      evt = JSON.parse(payload)
    } catch {
      // 忽略非 JSON 行，但回调异常必须交还调用方。
      return
    }
    if (!evt || typeof evt !== 'object') return
    if (evt.type === 'delta' && evt.content) onDelta(evt.content)
    else if (evt.type === 'reasoning' && evt.content) onReasoning?.(evt.content)
    else if (evt.type === 'citations' && Array.isArray(evt.citations)) onCitations?.(evt.citations)
    else if (evt.type === 'sources' && Array.isArray(evt.sources)) onSources?.(evt.sources)
    else if (evt.type === 'tool_call') onToolCall?.(evt)
    else if (evt.type === 'tool_result') onToolResult?.(evt)
    else if (evt.type === 'model_switch') onModelSwitch?.(evt)
    else if (evt.type === 'usage' && evt.usage) onUsage?.(evt.usage)
    else if (evt.type === 'notice' && evt.message) onNotice?.(evt.message)
    else if (evt.type === 'image') onImage?.(evt)
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
      streamError = evt.message || '服务端生成失败'
    } else if (evt.type === 'done') {
      receivedDone = true
    }
  }

  const consumeBuffer = (final = false) => {
    let idx
    while (!receivedDone && (idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trimEnd()
      buffer = buffer.slice(idx + 1)
      handleLine(line)
    }
    if (final && !receivedDone && buffer) {
      const line = buffer
      buffer = ''
      handleLine(line.trimEnd())
    }
  }

  try {
    while (!receivedDone) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
        result = await reader.read()
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw new DOMException('请求已取消', 'AbortError')
        }
        buffer += decoder.decode()
        consumeBuffer(true)
        throw new Error(streamError || `响应流意外中断：${err instanceof Error ? err.message : String(err)}`)
      }
      if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
      buffer += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true })
      consumeBuffer(result.done)
      if (result.done) break
    }
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
    if (streamError) throw new Error(streamError)
    if (!receivedDone) throw new Error('响应流意外中断：未收到完成标记，请重试')
  } finally {
    // done 是协议终点（usage 应先到达），不再等待连接 EOF 或处理后续事件。
    try {
      await reader.cancel()
    } catch {
      /* 已中断的底层连接无需再次报错 */
    } finally {
      reader.releaseLock()
    }
  }
}

export interface ProvidersResult {
  providers: ProviderInfo[]
  /** 服务端是否配置了联网搜索 */
  webSearch: boolean
}

export async function fetchProviders(): Promise<ProvidersResult> {
  let res: Response
  try {
    res = await fetch('/api/providers', {
      credentials: 'include',
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    })
  } catch {
    throw new Error('无法获取可用模型提供商（请求超时或网络错误）')
  }
  if (!res.ok) throw new Error('无法获取可用模型提供商')
  const json = await res.json()
  return { providers: json.providers ?? [], webSearch: !!json.webSearch }
}

/** 统一的写操作封装：后端错误统一在 json.error 里 */
async function postJson<T = Record<string, unknown>>(
  url: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal
): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
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
  let res: Response
  try {
    res = await fetch(url, {
      credentials: 'include',
      // 启动/翻页都是短请求：服务端接受连接却迟迟不回时，不能让界面无限转圈
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error('请求超时，请检查服务端是否正常')
    }
    throw err
  }
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
}, signal?: AbortSignal): Promise<string> {
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
    signal
  )
  return text.trim()
}

export async function fetchModelsCatalog(): Promise<ServerModelInfo[]> {
  try {
    const res = await fetch('/api/models', {
      credentials: 'include',
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    })
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
  model?: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const res = await postJson<{ title?: string }>('/api/tasks/title', { messages, provider, model }, 'POST', signal)
    return res.title || '新对话'
  } catch (err) {
    if (signal?.aborted) throw err
    const res = await fetch('/api/title', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, provider, model }),
      signal,
    })
    const json = await res.json().catch(() => ({}))
    return json.title || '新对话'
  }
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

export interface SyncResult {
  ok: boolean
  status?: number
  /** 网络错误、5xx、429 值得重试；4xx（未登录/参数错）重试也没用 */
  retryable: boolean
}

function syncResultOf(res: Response): SyncResult {
  return {
    ok: res.ok,
    status: res.status,
    retryable: !res.ok && (res.status === 429 || res.status >= 500),
  }
}

/** 删除服务端会话；失败信息交给重试队列判断是否值得再试 */
export async function deleteConversationFromServer(id: string): Promise<SyncResult> {
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    return syncResultOf(res)
  } catch {
    return { ok: false, retryable: true }
  }
}

/** 清空服务端当前用户的全部会话；与本地 clearAll 配套使用 */
export async function clearConversationsFromServer(): Promise<void> {
  await postJson('/api/conversations', { confirm: 'DELETE' }, 'DELETE')
}

export async function syncConversationToServer(conv: Conversation): Promise<SyncResult> {
  try {
    // 剥离附件大体积 base64 与缩略图，避免同步几 MB 冗余数据占用网络
    const sanitized: Conversation = {
      ...conv,
      messages: conv.messages.map((m) => {
        if (!m.attachments || m.attachments.length === 0) return m
        return {
          ...m,
          attachments: m.attachments.map((a) => {
            const { dataUrl: _d, thumbnail: _t, ...rest } = a
            return rest
          }),
        }
      }),
    }
    const res = await fetch('/api/conversations', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitized),
    })
    return syncResultOf(res)
  } catch {
    return { ok: false, retryable: true }
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
  // 密码只走请求头，不放 URL query：
  // query 会进浏览器历史、Referer、代理日志和访问日志，等于把分享密码写在明处。
  const headers: Record<string, string> = {}
  if (password) {
    headers['x-share-password'] = password
  }
  const res = await fetch(`/api/share/${encodeURIComponent(shareId)}`, {
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
    const err = new Error(json.error || '获取分享内容失败')
    ;(err as unknown as Record<string, unknown>).status = res.status
    throw err
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

/* =========================================================================
   会话文件夹与标签 API (Q-2026-10-19-05)
   ========================================================================= */

export async function fetchFolders(): Promise<{ items: ServerFolderItem[] }> {
  return await getJson<{ items: ServerFolderItem[] }>('/api/folders')
}

export async function createFolder(data: {
  name: string
  icon?: string
  sortIndex?: number
}): Promise<ServerFolderItem> {
  return await postJson<ServerFolderItem>('/api/folders', data)
}

export async function updateFolder(
  id: string,
  patch: Partial<{ name: string; icon: string; sortIndex: number }>
): Promise<ServerFolderItem> {
  return await postJson<ServerFolderItem>(`/api/folders/${encodeURIComponent(id)}`, patch, 'PATCH')
}

export async function deleteFolder(id: string): Promise<{ ok: boolean; moved: number }> {
  return await postJson<{ ok: boolean; moved: number }>(
    `/api/folders/${encodeURIComponent(id)}`,
    undefined,
    'DELETE'
  )
}

export async function moveConversationsToFolder(
  folderId: string,
  conversationIds: string[]
): Promise<{ ok: boolean; moved: number }> {
  return await postJson<{ ok: boolean; moved: number }>(
    `/api/folders/${encodeURIComponent(folderId)}/move`,
    { conversationIds }
  )
}

export async function fetchTags(): Promise<{ items: ServerTagItem[] }> {
  return await getJson<{ items: ServerTagItem[] }>('/api/tags')
}

export async function updateConversationMetadata(
  id: string,
  patch: { folderId?: string | null; tags?: string[]; summary?: string }
): Promise<{ ok: boolean }> {
  return await postJson<{ ok: boolean }>(
    `/api/conversations/${encodeURIComponent(id)}`,
    patch,
    'PATCH'
  )
}

/* =========================================================================
   小任务接口 API (Q-2026-10-19-06)
   ========================================================================= */

export async function fetchTasksInfo(): Promise<{ kinds: string[]; tones: TaskToneItem[] }> {
  return await getJson<{ kinds: string[]; tones: TaskToneItem[] }>('/api/tasks')
}

export async function generateTaskTitle(params: {
  text?: string
  messages?: { role: Role; content: string }[]
  maxChars?: number
  provider?: string
  model?: string
}): Promise<{ title: string }> {
  return await postJson<{ title: string }>('/api/tasks/title', params)
}

export async function generateTaskSummary(params: {
  text?: string
  messages?: { role: Role; content: string }[]
}): Promise<{ summary: string }> {
  return await postJson<{ summary: string }>('/api/tasks/summary', params)
}

export async function generateTaskSuggestions(params: {
  text?: string
  messages?: { role: Role; content: string }[]
}, signal?: AbortSignal): Promise<{ suggestions: string[] }> {
  return await postJson<{ suggestions: string[] }>('/api/tasks/suggest', params, 'POST', signal)
}

export async function generateTaskRewrite(params: {
  text: string
  tone: string
  instruction?: string
}): Promise<{ text: string }> {
  return await postJson<{ text: string }>('/api/tasks/rewrite', params)
}

/* =========================================================================
   限定文档检索与诊断视图 API (Q-2026-10-19-07)
   ========================================================================= */

export async function retrieveKnowledge(
  query: string,
  options?: {
    workspaceId?: string
    documentIds?: string[]
    debug?: boolean
    topK?: number
  }
): Promise<{
  chunks: KnowledgeSource[]
  timings?: { embedMs: number; searchMs: number; totalMs: number }
  debug?: RetrieveDebugResult
}> {
  return await postJson('/api/retrieve', { query, ...options })
}

/* =========================================================================
   个人访问令牌 PAT API (Q-2026-10-19-09)
   ========================================================================= */

export async function createApiToken(): Promise<{
  ok: boolean
  token: string
  hint: string
  baseUrl: string
}> {
  return await postJson('/api/auth/token', {})
}

export async function revokeApiToken(): Promise<{ ok: boolean }> {
  return await postJson('/api/auth/token', undefined, 'DELETE')
}

/* =========================================================================
   图像生成 API (Q-2026-10-19-10)
   ========================================================================= */

export async function fetchImageStatus(): Promise<ImageStatus> {
  return await getJson<ImageStatus>('/api/images/status')
}

export async function generateImageDirect(params: {
  prompt: string
  n?: number
  size?: string
}): Promise<{
  created: number
  data: { url?: string; b64_json?: string; revised_prompt?: string }[]
  provider?: string
  model?: string
  tookMs?: number
}> {
  return await postJson('/api/images/generations', params)
}

