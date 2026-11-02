import { Component, lazy, Suspense, type ReactNode } from 'react'

// react-markdown + KaTeX + highlight.js 合计数百 KB：只在真正要渲染消息时才加载，
// 首屏（空态/登录）不再为它付出下载与解析成本。
const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'))

interface BoundaryProps {
  content: string
  children: ReactNode
}

/**
 * 单条消息的兜底：动态 chunk 加载失败（断网、发版后旧 chunk 被删）时
 * 只把这条消息降级成纯文本，而不是让整页被顶层 ErrorBoundary 接管。
 */
class MarkdownBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    console.warn('[FlyChat] Markdown 渲染模块加载失败，已降级为纯文本：', error)
  }

  render() {
    if (this.state.failed) {
      return <div className="whitespace-pre-wrap break-words">{this.props.content}</div>
    }
    return this.props.children
  }
}

export default function LazyMarkdown({ content }: { content: string }) {
  return (
    <MarkdownBoundary content={content}>
      <Suspense fallback={<div className="whitespace-pre-wrap break-words">{content}</div>}>
        <MarkdownRenderer content={content} />
      </Suspense>
    </MarkdownBoundary>
  )
}
