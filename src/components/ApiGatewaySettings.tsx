import { useState } from 'react'
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Globe,
  Key,
  Loader2,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
} from 'lucide-react'
import { useAuthStore } from '../store/auth'
import { createApiToken, revokeApiToken } from '../api/client'

export default function ApiGatewaySettings() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const config = useAuthStore((s) => s.config)
  const user = useAuthStore((s) => s.user)
  const checkAuth = useAuthStore((s) => s.checkAuth)
  const [newToken, setNewToken] = useState<{ token: string; baseUrl: string; hint: string } | null>(null)
  const [loadingToken, setLoadingToken] = useState(false)

  const handleCreateToken = async () => {
    setLoadingToken(true)
    try {
      const res = await createApiToken()
      if (res.ok && res.token) {
        setNewToken(res)
        await checkAuth()
      }
    } catch (err: any) {
      alert(`生成令牌失败: ${err.message}`)
    } finally {
      setLoadingToken(false)
    }
  }

  const handleRevokeToken = async () => {
    if (!confirm('确定吊销该令牌吗？已连接的第三方客户端将无法继续访问。')) return
    setLoadingToken(true)
    try {
      await revokeApiToken()
      setNewToken(null)
      await checkAuth()
    } catch (err: any) {
      alert(`吊销令牌失败: ${err.message}`)
    } finally {
      setLoadingToken(false)
    }
  }

  const baseUrl = typeof window !== 'undefined' ? `${window.location.origin}/v1` : 'http://localhost:3001/v1'

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1500)
    })
  }

  const curlExample = `curl -X POST ${baseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \\
  -d '{
    "model": "deepseek-chat",
    "messages": [
      {"role": "user", "content": "你好，请写一段快速排序"}
    ],
    "stream": true
  }'`

  const pythonExample = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="YOUR_ACCESS_TOKEN", # 或在环境变量中设置 FLYCHAT_ACCESS_TOKEN
)

response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)`

  return (
    <div className="space-y-5 text-ink-1">
      <div>
        <h4 className="text-sm font-semibold text-ink-1 flex items-center gap-1.5">
          <Globe size={16} className="text-accent" />
          OpenAI 兼容 API 网关
        </h4>
        <p className="mt-1 text-xs text-ink-3 leading-relaxed">
          FlyChat 服务端内置标准 OpenAI 协议网关，支持第三方客户端（如 Chatbox、NextChat、沉浸式翻译、各类 Agent 框架）直接接入，复用统一配置的服务商和模型池。
        </p>
      </div>

      {/* 接口地址 */}
      <div className="space-y-3">
        <div className="rounded-xl border border-rule bg-panel p-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-medium text-ink-2">Base URL 基础地址</span>
            <button
              onClick={() => copyText('baseUrl', baseUrl)}
              className="flex items-center gap-1 text-[11px] text-accent hover:underline"
            >
              {copiedKey === 'baseUrl' ? <Check size={12} /> : <Copy size={12} />}
              <span>{copiedKey === 'baseUrl' ? '已复制' : '复制'}</span>
            </button>
          </div>
          <code className="block rounded-lg bg-canvas px-3 py-2 font-mono text-xs text-ink-1 select-all break-all border border-rule/50">
            {baseUrl}
          </code>
        </div>

        <div className="rounded-xl border border-rule bg-panel p-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-medium text-ink-2">认证方式 (Authentication)</span>
          </div>
          <div className="text-xs text-ink-3 space-y-1.5">
            <p>
              请求头附带：<code className="rounded bg-canvas px-1.5 py-0.5 font-mono text-ink-1 border border-rule/50">Authorization: Bearer &lt;TOKEN&gt;</code>
            </p>
            <p className="text-[11px] text-ink-4">
              注：在服务端可在 <code className="font-mono text-ink-2">server/.env</code> 中配置 <code className="font-mono text-ink-2">FLYCHAT_ACCESS_TOKEN</code>；在多用户模式下，请使用下方生成的个人访问令牌 (PAT)。
            </p>
          </div>
        </div>

        {/* 个人访问令牌 (PAT) 模块 (Q-2026-10-19-09) */}
        {config?.authMode === 'multi' && user && (
          <div className="rounded-xl border border-accent/30 bg-accent/5 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-1">
                <Key size={14} className="text-accent" />
                <span>个人访问令牌 (PAT)</span>
                <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">多用户专属</span>
              </div>
              <div className="flex items-center gap-2">
                {user.hasApiToken ? (
                  <>
                    <button
                      type="button"
                      disabled={loadingToken}
                      onClick={() => {
                        if (confirm('重新生成将立即作废旧令牌，所有已接入的第三方客户端需要更新 Token。是否继续？')) {
                          void handleCreateToken()
                        }
                      }}
                      className="flex items-center gap-1 text-[11px] text-ink-3 hover:text-accent transition-colors"
                    >
                      {loadingToken ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                      <span>重新生成</span>
                    </button>
                    <button
                      type="button"
                      disabled={loadingToken}
                      onClick={handleRevokeToken}
                      className="flex items-center gap-1 text-[11px] text-danger hover:underline transition-colors"
                    >
                      <Trash2 size={11} />
                      <span>吊销</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={loadingToken}
                    onClick={handleCreateToken}
                    className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {loadingToken ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                    <span>生成访问令牌</span>
                  </button>
                )}
              </div>
            </div>

            <p className="text-[11px] text-ink-3 leading-relaxed">
              用于 Cherry Studio、Cursor、沉浸式翻译等第三方客户端接入当前账号的模型配额与权限池。
            </p>

            {/* 令牌仅展示一次的警示卡片 */}
            {newToken && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2 anim-fade-in">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                  <AlertTriangle size={14} />
                  <span>令牌已生成（关闭后无法再次查看，请立即保存）</span>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-panel px-2.5 py-1.5 font-mono text-xs text-ink-1 break-all select-all border border-rule">
                    {newToken.token}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyText('pat', newToken.token)}
                    className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs text-white shrink-0"
                  >
                    {copiedKey === 'pat' ? <Check size={12} /> : <Copy size={12} />}
                    <span>{copiedKey === 'pat' ? '已复制' : '复制'}</span>
                  </button>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setNewToken(null)}
                    className="text-[11px] text-ink-4 hover:text-ink-2"
                  >
                    我已复制保存，关闭提示
                  </button>
                </div>
              </div>
            )}

            {!newToken && user.hasApiToken && (
              <div className="flex items-center justify-between rounded-lg bg-panel/60 border border-rule/50 px-3 py-1.5 text-xs">
                <span className="text-ink-2 font-mono text-[11px]">fcp_••••••••••••••••••••••••••••</span>
                <span className="text-[11px] text-success flex items-center gap-1">
                  <Check size={12} />
                  活跃可用
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 示例代码 */}
      <div className="space-y-3">
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="font-medium text-ink-2 flex items-center gap-1.5">
              <Terminal size={14} />
              cURL 调用示例
            </span>
            <button
              onClick={() => copyText('curl', curlExample)}
              className="flex items-center gap-1 text-[11px] text-accent hover:underline"
            >
              {copiedKey === 'curl' ? <Check size={12} /> : <Copy size={12} />}
              <span>{copiedKey === 'curl' ? '已复制' : '复制代码'}</span>
            </button>
          </div>
          <pre className="overflow-x-auto rounded-xl border border-rule/60 bg-canvas p-3 font-mono text-xs leading-5 text-ink-2">
            <code>{curlExample}</code>
          </pre>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="font-medium text-ink-2 flex items-center gap-1.5">
              <Code2 size={14} />
              Python (openai SDK) 示例
            </span>
            <button
              onClick={() => copyText('python', pythonExample)}
              className="flex items-center gap-1 text-[11px] text-accent hover:underline"
            >
              {copiedKey === 'python' ? <Check size={12} /> : <Copy size={12} />}
              <span>{copiedKey === 'python' ? '已复制' : '复制代码'}</span>
            </button>
          </div>
          <pre className="overflow-x-auto rounded-xl border border-rule/60 bg-canvas p-3 font-mono text-xs leading-5 text-ink-2">
            <code>{pythonExample}</code>
          </pre>
        </div>
      </div>
    </div>
  )
}
