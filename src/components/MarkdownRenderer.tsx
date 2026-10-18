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
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code])

  if (isMermaid) return <Mermaid code={code} />

  return (
    <div className="group/code my-4 overflow-hidden rounded-xl bg-panel shadow-1 border border-rule/70 transition-shadow duration-200 ease-out hover:shadow-2">
      {/* 工具栏 */}
      <div className="flex items-center justify-between bg-hover-soft px-3 py-1.5 border-b border-rule/50">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-ink-3 uppercase">{language || 'text'}</span>
          {isPreviewable && (
            <div className="flex items-center rounded-lg bg-canvas p-0.5 border border-rule/60 text-[11px]">
              <button
                type="button"
                onClick={() => setViewMode('code')}
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 transition-all ${
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
                className={`flex items-center gap-1 rounded-md px-2 py-0.5 transition-all ${
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
                }}
                className="flex items-center gap-1 rounded-md px-2 py-0.5 text-accent font-medium hover:bg-accent/10 transition-all ml-0.5"
                title="在 Claude 风格右侧独立分屏工作台中运行与调试"
              >
                <Sparkles size={11} />
                <span className="hidden sm:inline">分屏</span>
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-0.5">
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
            onClick={() => downloadText(safeFileName(`code.${language || 'txt'}`), code)}
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
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      {viewMode === 'preview' && isPreviewable ? (
        <div className="p-4 bg-canvas/40 flex justify-center min-h-[140px] max-h-[500px] overflow-auto">
          {language === 'svg' || code.trim().startsWith('<svg') ? (
            <div
              className="flex justify-center max-w-full [&_svg]:max-w-full [&_svg]:h-auto"
              dangerouslySetInnerHTML={{ __html: code }}
            />
          ) : (
            <iframe
              title="Artifact Preview"
              srcDoc={code}
              sandbox="allow-scripts allow-modals"
              className="w-full h-80 rounded-lg border border-rule/80 bg-white"
            />
          )}
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

export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="markdown-body break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          pre: ({ children }) => <>{children}</>,
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
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto rounded-xl border border-rule">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-rule-strong bg-panel px-3 py-2 text-left text-[13px] font-medium text-ink-1">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-rule px-3 py-2 text-[13px] text-ink-2 transition-colors duration-150">
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
