import { useRef, useState } from 'react'
import { Check, Copy, Download, Globe, Image as ImageIcon, Link2, Sparkles } from 'lucide-react'
import { BrandIcon } from './ui/BrandLogo'
import Modal from './ui/Modal'
import Spinner from './ui/Spinner'
import { showToast } from './ui/Toast'
import { createShareLink } from '../api/client'
import type { Conversation, Message } from '../types'

interface ShareCardModalProps {
  open: boolean
  onClose: () => void
  userMessage?: Message | null
  assistantMessage?: Message | null
  conversationTitle?: string
  conversation?: Conversation | null
}

const GRADIENTS = [
  { id: 'dark', name: '深邃曜黑', bg: 'bg-[#0f172a] text-slate-100 border-slate-800' },
  { id: 'aurora', name: '极光渐变', bg: 'bg-gradient-to-br from-indigo-950 via-slate-900 to-purple-950 text-white border-indigo-900/50' },
  { id: 'minimal', name: '纯净纸白', bg: 'bg-white text-zinc-900 border-zinc-200' },
  { id: 'ocean', name: '深海流光', bg: 'bg-gradient-to-br from-blue-950 via-slate-900 to-cyan-950 text-white border-blue-900/50' },
]

export default function ShareCardModal({
  open,
  onClose,
  userMessage,
  assistantMessage,
  conversationTitle = 'FlyChat 智会',
  conversation,
}: ShareCardModalProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<'card' | 'link'>('card')
  const [gradient, setGradient] = useState(GRADIENTS[0])
  const [downloading, setDownloading] = useState(false)
  const [copied, setCopied] = useState(false)

  // 在线分享链接状态
  const [linkGenerating, setLinkGenerating] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [copiedLink, setCopiedLink] = useState(false)
  const [password, setPassword] = useState('')
  const [expiresInDays, setExpiresInDays] = useState<number>(7)
  const [linkError, setLinkError] = useState('')

  const handleExportPng = async () => {
    if (!cardRef.current || downloading) return
    setDownloading(true)
    try {
      const { toBlob } = await import('html-to-image')
      const blob = await toBlob(cardRef.current, {
        pixelRatio: 2.5,
        cacheBust: true,
      })
      if (!blob) throw new Error('生成图片失败')

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `FlyChat-${Date.now()}.png`
      a.click()
      URL.revokeObjectURL(url)
      showToast('已开始下载卡片图片', 'success')
    } catch {
      showToast('下载图片失败，建议使用截图工具截取预览卡片', 'error')
    } finally {
      setDownloading(false)
    }
  }

  const handleCopyImage = async () => {
    if (!cardRef.current) return
    try {
      const { toBlob } = await import('html-to-image')
      const blob = await toBlob(cardRef.current, { pixelRatio: 2 })
      if (!blob) throw new Error('生成图片失败')

      if (navigator.clipboard && 'write' in navigator.clipboard) {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob }),
        ])
        setCopied(true)
        showToast('已复制图片到剪贴板', 'success')
        setTimeout(() => setCopied(false), 2000)
      } else {
        showToast('当前浏览器不支持直接写入剪贴板图片', 'info')
      }
    } catch {
      showToast('复制失败，请尝试直接点击“保存卡片”', 'error')
    }
  }

  const handleGenerateLink = async () => {
    setLinkGenerating(true)
    setLinkError('')
    try {
      // 构造当前需要分享的快照
      const snapshot: Conversation = conversation ?? {
        id: 'snapshot-' + Date.now(),
        title: conversationTitle,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          ...(userMessage ? [userMessage] : []),
          ...(assistantMessage ? [assistantMessage] : []),
        ],
      }

      const res = await createShareLink(snapshot, password.trim() || undefined, expiresInDays)
      const fullUrl = `${window.location.origin}${res.url}`
      setShareUrl(fullUrl)
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : '生成分享链接失败')
    } finally {
      setLinkGenerating(false)
    }
  }

  const handleCopyShareUrl = () => {
    if (!shareUrl) return
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopiedLink(true)
      showToast('已复制公开在线链接', 'success')
      setTimeout(() => setCopiedLink(false), 2000)
    })
  }

  return (
    <Modal open={open} onClose={onClose} title="分享与导出">
      <div className="flex flex-col gap-5">
        {/* Tab 切换 */}
        <div className="flex items-center rounded-xl bg-hover p-1 text-xs">
          <button
            type="button"
            onClick={() => setTab('card')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 font-medium transition-all ${
              tab === 'card'
                ? 'bg-panel text-ink-1 shadow-sm'
                : 'text-ink-3 hover:text-ink-1'
            }`}
          >
            <ImageIcon size={14} />
            <span>精美社交卡片 (PNG)</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('link')}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 font-medium transition-all ${
              tab === 'link'
                ? 'bg-panel text-ink-1 shadow-sm'
                : 'text-ink-3 hover:text-ink-1'
            }`}
          >
            <Globe size={14} />
            <span>公开在线链接 (Web)</span>
          </button>
        </div>

        {tab === 'card' ? (
          <>
            {/* 样式选择器 */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-3">选择卡片主题风格</span>
              <div className="flex items-center gap-1.5">
                {GRADIENTS.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => setGradient(g)}
                    className={`h-6 rounded-full px-2.5 text-xs font-medium transition-all ${
                      gradient.id === g.id
                        ? 'bg-accent text-on-accent shadow-sm'
                        : 'bg-hover text-ink-2 hover:text-ink-1'
                    }`}
                  >
                    {g.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 卡片预览容器 */}
            <div className="overflow-auto max-h-[55vh] rounded-2xl bg-canvas/60 p-4 border border-rule/60 flex justify-center">
              <div
                ref={cardRef}
                className={`w-[440px] max-w-full rounded-2xl p-6 shadow-2xl border transition-all ${gradient.bg} flex flex-col gap-4 font-sans`}
              >
                {/* 卡片顶栏 */}
                <div className="flex items-center justify-between border-b border-current/10 pb-3">
                  <div className="flex items-center gap-2">
                    <BrandIcon size={24} glow />
                    <span className="text-sm font-bold tracking-tight">FlyChat</span>
                    <span className="text-[10px] opacity-60 uppercase tracking-wider font-mono">
                      SOTA AI
                    </span>
                  </div>
                  <span className="text-[11px] opacity-50">
                    {new Date().toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                  </span>
                </div>

                {/* 会话标题 */}
                <div className="text-xs font-medium opacity-60 flex items-center gap-1">
                  <Sparkles size={12} className="text-accent" />
                  <span>{conversationTitle}</span>
                </div>

                {/* 用户提问 */}
                {userMessage && (
                  <div className="rounded-xl bg-current/5 p-3.5 text-sm leading-relaxed border border-current/10">
                    <div className="text-[11px] font-semibold opacity-60 mb-1">PROMPT</div>
                    <div className="font-medium whitespace-pre-wrap line-clamp-3">
                      {userMessage.content}
                    </div>
                  </div>
                )}

                {/* 模型回答 */}
                {assistantMessage && (
                  <div className="text-sm leading-relaxed whitespace-pre-wrap line-clamp-8 opacity-95">
                    {assistantMessage.content}
                  </div>
                )}

                {/* 卡片底栏：品牌水印 */}
                <div className="mt-2 pt-3 border-t border-current/10 flex items-center justify-between text-[11px] opacity-50">
                  <span>由 FlyChat 智能驱动生成</span>
                  <span className="font-mono">flychat.ai</span>
                </div>
              </div>
            </div>

            {/* 操作栏 */}
            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-rule">
              <button
                type="button"
                onClick={onClose}
                className="press rounded-lg px-3.5 py-1.5 text-sm text-ink-2 hover:bg-hover hover:text-ink-1"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleCopyImage}
                className="press flex items-center gap-1.5 rounded-lg border border-rule px-3.5 py-1.5 text-sm font-medium text-ink-1 hover:bg-hover"
              >
                {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                <span>{copied ? '已复制到剪贴板' : '复制图片'}</span>
              </button>
              <button
                type="button"
                onClick={handleExportPng}
                disabled={downloading}
                className="press hover-lift flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover shadow-1 disabled:opacity-50"
              >
                {downloading ? <Spinner size={14} /> : <Download size={14} />}
                <span>保存卡片</span>
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <div className="text-xs text-ink-2 leading-relaxed">
              生成一个只读的在线公开对话链接。任何拥有链接的人都可以在浏览器中直接查看对话排版。
            </div>

            {linkError && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-danger">
                {linkError}
              </div>
            )}

            <div className="flex flex-col gap-3 rounded-xl border border-rule bg-canvas p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-2 font-medium">有效期</span>
                <select
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(Number(e.target.value))}
                  className="rounded-lg border border-rule bg-panel px-2.5 py-1 text-xs text-ink-1 outline-none"
                >
                  <option value={7}>7 天有效</option>
                  <option value={30}>30 天有效</option>
                  <option value={0}>永久有效</option>
                </select>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-2 font-medium">访问密码 (可选)</span>
                <input
                  type="password"
                  placeholder="留空即公开访问"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-40 rounded-lg border border-rule bg-panel px-2.5 py-1 text-xs text-ink-1 outline-none placeholder:text-ink-4"
                />
              </div>
            </div>

            {shareUrl ? (
              <div className="flex flex-col gap-2 rounded-xl border border-accent/20 bg-accent-soft p-3.5">
                <div className="text-xs font-semibold text-accent flex items-center gap-1.5">
                  <Link2 size={14} />
                  <span>在线链接已生成</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={shareUrl}
                    className="flex-1 rounded-lg border border-rule bg-panel px-2.5 py-1.5 text-xs text-ink-1 font-mono outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleCopyShareUrl}
                    className="press flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent"
                  >
                    {copiedLink ? <Check size={13} /> : <Copy size={13} />}
                    <span>{copiedLink ? '已复制' : '复制链接'}</span>
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGenerateLink}
                disabled={linkGenerating}
                className="press flex items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-sm font-medium text-on-accent hover:bg-accent-hover shadow-1 disabled:opacity-50"
              >
                {linkGenerating ? <Spinner size={15} /> : <Link2 size={15} />}
                <span>生成公开分享链接</span>
              </button>
            )}

            <div className="flex justify-end pt-2 border-t border-rule">
              <button
                type="button"
                onClick={onClose}
                className="press rounded-lg px-4 py-1.5 text-xs text-ink-2 hover:bg-hover hover:text-ink-1"
              >
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
