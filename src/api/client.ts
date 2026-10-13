import type { Message, ProviderInfo, Settings } from '../types'

/** 调用后端流式聊天代理，通过回调逐段返回文本 */
export async function streamChat(
  params: {
    settings: Pick<Settings, 'provider' | 'model' | 'temperature' | 'systemPrompt'>
    messages: { role: Message['role']; content: string }[]
    onDelta: (text: string) => void
  },
  signal?: AbortSignal
): Promise<void> {
  const { settings, messages, onDelta } = params

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: settings.provider,
      model: settings.model,
      messages: messages.map(({ role, content }) => ({ role, content })),
      system: settings.systemPrompt || undefined,
      temperature: settings.temperature,
    }),
    signal,
  })

  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try {
      const json = await res.json()
      detail = json?.error || detail
    } catch { /* ignore */ }
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
        else if (evt.type === 'error') streamError = evt.message
      } catch { /* ignore */ }
    }
  }

  if (streamError) throw new Error(streamError)
}

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const res = await fetch('/api/providers')
  if (!res.ok) throw new Error('无法获取可用模型提供商')
  const json = await res.json()
  return json.providers ?? []
}
