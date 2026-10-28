// deslop-ignore-file 19 21 22 34 — 代码块：边框与圆角同框以包住溢出代码；等宽字体只用于代码
import { memo, useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { Check, ChevronDown, Code as CodeIcon, Copy, Download, Eye, Sparkles } from 'lucide-react'
import 'katex/dist/katex.min.css'
import { useChatStore } from '../store/chat'
import { useArtifactStore } from '../store/artifact'
import { downloadText, safeFileName } from '../lib/download'
import { showToast } from './ui/Toast'
import Spinner from './ui/Spinner'

function extractText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown } }).props
    return extractText(props?.children)
  }
  return ''
}

/** Mermaid 图表：按主题渲染，出错时回退为代码块 */
function Mermaid({ code }: { code: string }) {
  const theme = useChatStore((s) => s.settings.theme)
  const [svg, setSvg] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    setFailed(false)
    setSvg('')
    import('mermaid')
      .then(async (mod) => {
        const mermaid = mod.default
        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
          securityLevel: 'strict',
          fontFamily: 'inherit',
        })
        const id = 'mmd-' + Math.random().toString(36).slice(2)
        try {
          const { svg: out } = await mermaid.render(id, code)
          if (!cancelled) setSvg(out)
        } catch {
          if (!cancelled) setFailed(true)
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [code, theme])

  if (failed) {
    return (
      <pre className="overflow-x-auto rounded-xl border border-rule bg-panel p-3.5">
        <code className="text-[13px] leading-relaxed">{code}</code>
      </pre>
    )
  }
  if (!svg) {
    return (
      <div
        role="status"
        className="my-4 flex items-center gap-2 rounded-xl border border-rule bg-panel p-3.5 text-xs text-ink-3"
      >
        <Spinner size={13} />
        正在渲染图表…
      </div>
    )
  }
  return (
    <div
      className="my-4 overflow-x-auto rounded-xl border border-rule bg-panel p-3.5 [&_svg]:mx-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

const CodeBlock = memo(function CodeBlock({
  language,
  code,
  className,
  children,
}: {
  language?: string
  code: string
  className?: string
  children?: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [viewMode, setViewMode] = useState<'code' | 'preview'>('code')
  const openArtifact = useArtifactStore((s) => s.openArtifact)
  const lines = code.split('\n').length
  const collapsible = lines > 24
  const isMermaid = language === 'mermaid'
  const isPreviewable =
    language === 'html' ||
    language === 'svg' ||
    (code.trim().startsWith('<svg') && code.trim().endsWith('</svg>')) ||
    (code.trim().startsWith('<!DOCTYPE html>') || code.trim().startsWith('<html'))

  const copy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      showToast('代码已复制到剪贴板', 'success')
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code])

  if (isMermaid) return <Mermaid code={code} />

  return (
    <div className="group/code my-4 overflow-hidden rounded-xl bg-panel shadow-1 border border-rule/70 transition-shadow duration-200 ease-out hover:shadow-2">
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 bg-hover-soft px-3 py-1.5 border-b border-rule/50">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* macOS 终端三色控制点 */}
          <div className="flex items-center gap-1.5 select-none" aria-hidden="true">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80 inline-block" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80 inline-block" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80 inline-block" />
          </div>
          <span className="rounded bg-panel/80 px-1.5 py-0.5 text-[10px] font-mono font-medium text-ink-3 uppercase border border-rule/40 tracking-wider">
            {language || 'text'}
          </span>
          {isPreviewable && (
            // shrink-0 + whitespace-nowrap：分屏打开后聊天区被压窄，
            // 这组按钮会被压成「代/码」「预/览」逐字竖排（中文可在任意字符间断行）
            <div className="flex shrink-0 items-center whitespace-nowrap rounded-lg bg-canvas p-0.5 border border-rule/60 text-[11px]">
              <button
                type="button"
                onClick={() => setViewMode('code')}
                className={`press flex items-center gap-1 rounded-md px-2 py-0.5 transition-all ${
                  viewMode === 'code'
                    ? 'bg-panel font-medium text-ink-1 shadow-sm'
                    : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                <CodeIcon size={12} />
                <span>代码</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('preview')}
                className={`press flex items-center gap-1 rounded-md px-2 py-0.5 transition-all ${
                  viewMode === 'preview'
                    ? 'bg-accent text-on-accent font-medium shadow-sm'
                    : 'text-ink-3 hover:text-ink-1'
                }`}
              >
                <Eye size={12} />
                <span>预览</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openArtifact({
                    id: 'art-' + Math.random().toString(36).slice(2, 9),
                    messageId: 'msg-' + Date.now(),
                    title: (language || 'artifact').toUpperCase() + ' 构件',
                    type: language === 'svg' || code.trim().startsWith('<svg') ? 'svg' : 'html',
                    content: code,
                    language: language || 'html',
                    createdAt: Date.now(),
                  })
                  showToast('已在右侧分屏打开构件', 'info')
                }}
                className="press flex items-center gap-1 rounded-md px-2 py-0.5 text-accent font-medium hover:bg-accent/10 transition-all ml-0.5"
                title="在 Claude 风格右侧独立分屏工作台中运行与调试"
              >
                <Sparkles size={11} />
                <span className="hidden sm:inline">分屏</span>
              </button>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 whitespace-nowrap">
          {collapsible && viewMode === 'code' && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="r-sm flex items-center gap-1 px-2 py-1 text-xs text-ink-3 transition-ui press hover:bg-hover hover:text-ink-1"
            >
              <ChevronDown
                size={13}
                className={`transition-transform duration-200 ease-out ${expanded ? 'rotate-180' : ''}`}
              />
              {expanded ? '收起' : `${lines} 行`}
            </button>
          )}
          <button
            onClick={() => {
              downloadText(safeFileName(`code.${language || 'txt'}`), code)
              showToast('已下载代码文件', 'success')
            }}
            className="r-sm flex items-center gap-1 px-2 py-1 text-xs text-ink-3 transition-ui press hover:bg-hover hover:text-ink-1"
          >
            <Download size={13} />
            下载
          </button>
          <button
            onClick={copy}
            className="r-sm flex items-center gap-1 px-2 py-1 text-xs text-ink-3 transition-ui press hover:bg-hover hover:text-ink-1"
            aria-label="复制代码"
          >
            {copied ? <Check size={13} className="text-emerald-500 anim-bounce" /> : <Copy size={13} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      {viewMode === 'preview' && isPreviewable ? (
        <div className="p-4 bg-canvas/40 flex justify-center min-h-[140px] max-h-[500px] overflow-auto">
          <iframe
            title="Code Preview"
            srcDoc={
              language === 'svg' || code.trim().startsWith('<svg')
                ? `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:transparent;overflow:auto;}svg{max-width:100%;height:auto;}</style></head><body>${code}</body></html>`
                : code
            }
            sandbox="allow-scripts"
            className="w-full h-80 rounded-lg border border-rule/80 bg-white"
          />
        </div>
      ) : (
        <>
          <pre className={`overflow-x-auto p-3.5 ${collapsible && !expanded ? 'max-h-72' : ''}`}>
            <code className={className}>{children}</code>
          </pre>
          {collapsible && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="w-full bg-hover-soft py-1.5 text-xs text-ink-3 transition-ui hover:bg-hover hover:text-ink-1"
            >
              展开全部 {lines} 行
            </button>
          )}
        </>
      )}
    </div>
  )
})

/** 插件数组同样提到模块级：内联数组每次渲染都是新引用，会让 react-markdown 重跑一遍解析 */
const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [rehypeKatex, rehypeHighlight]

/**
 * Markdown 元素渲染表。
 *
 * 必须放在模块级：写成内联对象 + 内联箭头函数时，父组件每次重渲染都会产生新的组件类型，
 * React 会把这棵子树整个卸载重建 —— 代码块里已经切到「预览」的状态因此被重置回「代码」。
 * 实测回答结束后追问建议异步插入（触发一次 store 更新）时必现，用户看到预览自己跳回去。
 */
const MARKDOWN_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code: ((props: { className?: string; children?: React.ReactNode }) => {
    const { className, children } = props
    const match = /language-(\w+)/.exec(className || '')
    const raw = extractText(children)
    const isBlock = !!match || raw.includes('\n')
    if (!isBlock) {
      return (
        <code className="rounded bg-accent-soft px-1.5 py-0.5 text-[0.88em] text-ink-1">
          {children}
        </code>
      )
    }
    return (
      <CodeBlock language={match?.[1]} code={raw.replace(/\n$/, '')} className={className}>
        {children}
      </CodeBlock>
    )
  }) as never,
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-rule/80 bg-panel/40 shadow-xs">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-hover-soft/80 border-b border-rule">{children}</thead>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-3.5 py-2.5 text-left text-[12px] font-semibold text-ink-1 uppercase tracking-wider">
      {children}
    </th>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="border-b border-rule/40 hover:bg-hover/60 transition-colors duration-150 last:border-b-0">
      {children}
    </tr>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-3.5 py-2.5 text-[13px] text-ink-2">{children}</td>
  ),
}

export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="markdown-body break-words">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS as never}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
