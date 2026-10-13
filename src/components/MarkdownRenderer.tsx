// deslop-ignore-file 19 21 22 34 — 代码块：边框与圆角同框以包住溢出代码；等宽字体只用于代码
import { memo, useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import 'highlight.js/styles/github.css'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [text])
  return (
    <button
      onClick={copy}
      className="r-sm flex items-center gap-1 px-2 py-1 text-xs text-ink-3 transition-colors hover-bg-hover hover:text-ink-1"
      aria-label="复制代码"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}

function extractText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown } }).props
    return extractText(props?.children)
  }
  return ''
}

const CodeBlock = memo(function CodeBlock(props: { className?: string; children?: React.ReactNode }) {
  const { className, children } = props
  const match = /language-(\w+)/.exec(className || '')
  const code = extractText(children).replace(/\n$/, '')
  const isInline = !match && !className

  if (isInline) {
    return (
      <code className="rounded bg-accent-soft px-1.5 py-0.5 text-[0.88em] text-ink-1">{children}</code>
    )
  }

  return (
    <div className="group/code my-4 overflow-hidden rounded-xl border border-rule bg-panel">
      <div className="flex items-center justify-between border-b border-rule px-3 py-1.5">
        <span className="text-[11px] text-ink-3">{match?.[1] ?? 'text'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3.5">
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
})

export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="markdown-body break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: CodeBlock as never,
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-rule-strong px-3 py-2 text-left text-[13px] font-medium text-ink-1">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-rule px-3 py-2 text-[13px] text-ink-2">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
