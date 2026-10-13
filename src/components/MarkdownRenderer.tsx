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
      className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
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

/** 代码块：语言标签 + 复制按钮 + 高亮 */
const CodeBlock = memo(function CodeBlock(props: {
  className?: string
  children?: React.ReactNode
}) {
  const { className, children } = props
  const match = /language-(\w+)/.exec(className || '')
  const code = extractText(children).replace(/\n$/, '')
  const isInline = !match && !className

  if (isInline) {
    return (
      <code className="rounded bg-zinc-200/70 px-1.5 py-0.5 text-[0.9em] text-pink-600 dark:bg-zinc-700/60 dark:text-pink-400">
        {children}
      </code>
    )
  }

  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700/60">
      <div className="flex items-center justify-between bg-zinc-100 px-3 py-1.5 dark:bg-zinc-800">
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
          {match?.[1] ?? 'text'}
        </span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 !m-0">
        <code className={className}>{children}</code>
      </pre>
    </div>
  )
})

export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="markdown-body break-words text-[15px] leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: CodeBlock as never,
          a: (props) => (
            <a {...props} target="_blank" rel="noreferrer" className="text-blue-600 underline underline-offset-2 dark:text-blue-400" />
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-zinc-300 bg-zinc-100 px-3 py-1.5 text-left font-medium dark:border-zinc-600 dark:bg-zinc-800">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-zinc-300 px-3 py-1.5 dark:border-zinc-600">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
