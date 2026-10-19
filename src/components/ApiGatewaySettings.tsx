import { useState } from 'react'
import { Check, Code2, Copy, ExternalLink, Globe, KeyRound, Terminal } from 'lucide-react'
import { BUTTON_GHOST, ICON_BTN_SM } from '../lib/ui'

export default function ApiGatewaySettings() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

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
              注：在服务端可在 <code className="font-mono text-ink-2">server/.env</code> 中配置 <code className="font-mono text-ink-2">FLYCHAT_ACCESS_TOKEN</code>；若启用多用户模式，亦可使用用户的登录凭证令牌。
            </p>
          </div>
        </div>
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
